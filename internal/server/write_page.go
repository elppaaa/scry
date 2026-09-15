package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/midagedev/gadak/internal/adf"
	"github.com/midagedev/gadak/internal/jira"
	"github.com/midagedev/gadak/internal/sync"
)

// Wiki page writes through origin.Wiki (GDK-380/381/382): edit one page,
// create a page, comment on a page. The wiki gate is wikiWriter
// (write.go); the mirror catch-up is failMirrorStale, same as issues.
// Split from write.go (GDK-1922).

// handlePageEdit PUTs one wiki page through the owning origin: connected
// Confluence or the in-process issuetap (origin.Wiki owns that choice).
// Body: {"title": ...} and/or {"adf": "<ADF JSON string>"} and/or
// {"text": ...} — text is built into a fresh ADF doc and REPLACES the whole
// body, so callers editing rich pages should send adf. Omitted parts keep
// the origin's current value. Optional "version" is the caller's base
// (optimistic lock: that value+1, origin 409 if stale). Omitted version is
// last-write-wins from origin HEAD+1. "force": true skips the format_loss
// gate on a text replace of a non-simple origin ADF.
func (s *server) handlePageEdit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title   string  `json:"title"`
		ADF     string  `json:"adf"`
		Text    *string `json:"text"`
		Version *int    `json:"version"`
		Force   bool    `json:"force"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if body.Title == "" && body.ADF == "" && body.Text == nil {
		fail(w, http.StatusBadRequest, "nothing_to_edit")
		return
	}
	wc, cfg, ok := s.wikiWriter(w)
	if !ok {
		return
	}
	if body.ADF != "" && !validADF(body.ADF) {
		fail(w, http.StatusBadRequest, "invalid_adf")
		return
	}
	id := r.PathValue("id")
	cur, err := wc.Page(r.Context(), id)
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	title := cur.Title
	if body.Title != "" {
		title = body.Title
	}
	// doc, not adf: the package name is adf, and shadowing it here is what
	// kept the richness judgment a private copy in this file (GDK-682).
	doc := ""
	if cur.Body.AtlasDocFormat != nil {
		doc = cur.Body.AtlasDocFormat.Value
	}
	switch {
	case body.ADF != "":
		doc = body.ADF
	case body.Text != nil:
		// GDK-1396: placeholders in the text put the page's preserved nodes
		// back; none over a body that has them is the plain replace force
		// exists for.
		kept := adf.Preserved(json.RawMessage(doc))
		switch {
		case len(kept) == 0 && adf.HasPlaceholders(*body.Text):
			failMsg(w, http.StatusConflict, "placeholder", "the current body has no preserved nodes — drop the markers")
			return
		case len(kept) > 0 && adf.HasPlaceholders(*body.Text):
			next, _, err := adf.FromMarkdownWith(*body.Text, json.RawMessage(doc))
			if err != nil {
				failMsg(w, http.StatusConflict, "placeholder", err.Error())
				return
			}
			doc = string(next)
		case len(kept) > 0 && !body.Force:
			fail(w, http.StatusConflict, "format_loss")
			return
		default:
			doc = string(jira.Doc(*body.Text, nil))
		}
	}
	next := cur.Version.Number + 1
	if body.Version != nil {
		next = *body.Version + 1
	}
	if _, err := wc.UpdatePage(r.Context(), id, title, doc, next); err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	if err := sync.RefreshPage(r.Context(), cfg, s.db, id); err != nil {
		failMirrorStale(w, id, err)
		return
	}
	detail, err := s.db.PageDetail(r.Context(), id)
	if err != nil || detail == nil {
		failMirrorStale(w, id, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": detail})
}

// handlePageCreate POSTs a new wiki page through the owning origin (GDK-382).
// Body: {"space": KEY, "title": ..., "adf"?: "<ADF JSON string>", "text"?: ...,
// "parent"?: page id}. Responds with the mirrored PageDetail.
func (s *server) handlePageCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Space  string `json:"space"`
		Title  string `json:"title"`
		ADF    string `json:"adf"`
		Text   string `json:"text"`
		Parent string `json:"parent"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if body.ADF == "" {
		if err := adf.RefusePlaceholders(body.Text); err != nil {
			failMsg(w, http.StatusConflict, "placeholder", err.Error())
			return
		}
	}
	if body.Space == "" || strings.TrimSpace(body.Title) == "" {
		fail(w, http.StatusBadRequest, "space_and_title_required")
		return
	}
	wc, cfg, ok := s.wikiWriter(w)
	if !ok {
		return
	}
	adf := body.ADF
	if adf == "" {
		adf = string(jira.Doc(body.Text, nil))
	} else if !validADF(adf) {
		fail(w, http.StatusBadRequest, "invalid_adf")
		return
	}
	created, err := wc.CreatePage(r.Context(), body.Space, body.Title, adf, body.Parent)
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	if err := sync.RefreshPage(r.Context(), cfg, s.db, created.ID); err != nil {
		failMirrorStale(w, created.ID, err)
		return
	}
	detail, err := s.db.PageDetail(r.Context(), created.ID)
	if err != nil || detail == nil {
		failMirrorStale(w, created.ID, nil)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"page": detail})
}

// handlePageComment POSTs a top-level comment on one wiki page through the
// owning origin (GDK-381). Body: {"adf": "<ADF JSON string>"} or {"text": ...}.
func (s *server) handlePageComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ADF  string `json:"adf"`
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if body.ADF == "" {
		if err := adf.RefusePlaceholders(body.Text); err != nil {
			failMsg(w, http.StatusConflict, "placeholder", err.Error())
			return
		}
	}
	wc, cfg, ok := s.wikiWriter(w)
	if !ok {
		return
	}
	adf := body.ADF
	if adf == "" {
		if strings.TrimSpace(body.Text) == "" {
			fail(w, http.StatusBadRequest, "empty_comment")
			return
		}
		adf = string(jira.Doc(body.Text, nil))
	} else if !validADF(adf) {
		fail(w, http.StatusBadRequest, "invalid_adf")
		return
	}
	id := r.PathValue("id")
	if _, err := wc.AddPageComment(r.Context(), id, adf); err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	if err := sync.RefreshPage(r.Context(), cfg, s.db, id); err != nil {
		failMirrorStale(w, id, err)
		return
	}
	detail, err := s.db.PageDetail(r.Context(), id)
	if err != nil || detail == nil {
		failMirrorStale(w, id, nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": detail})
}
