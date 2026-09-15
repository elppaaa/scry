package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/midagedev/gadak/internal/jira"
	"github.com/midagedev/gadak/internal/origin"
	"github.com/midagedev/gadak/internal/store"
	"github.com/midagedev/gadak/internal/sync"
)

// The credential surface — GET/PUT/DELETE the stored token, plus the two
// re-read-only resyncs (one issue, one wiki page) that share the credential
// gate without writing anything. Split from write.go (GDK-1922).

func (s *server) handleGetCredential(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, credential(s.config()))
}

func (s *server) handlePutCredential(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JiraEmail      string `json:"jira_email"`
		APIToken       string `json:"api_token"`
		TokenExpiresAt string `json:"token_expires_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "invalid_body")
		return
	}
	body.JiraEmail, body.APIToken = strings.TrimSpace(body.JiraEmail), strings.TrimSpace(body.APIToken)
	// GDK-455: on a configured workspace an empty field means "keep the stored
	// value" — parity with `gadak init`. The empty check below still guards the
	// unconfigured case, where empty can only mean missing.
	cur := s.config()
	tokenReplaced := body.APIToken != ""
	if body.APIToken == "" && cur.Token != "" {
		body.APIToken = cur.Token
	}
	if body.JiraEmail == "" && cur.Email != "" {
		body.JiraEmail = cur.Email
	}
	if body.JiraEmail == "" || body.APIToken == "" {
		fail(w, http.StatusBadRequest, "email_and_token_required")
		return
	}
	next := *cur
	if next.Site == "" {
		// Nothing to verify against: the site comes from settings, not from here.
		fail(w, http.StatusBadRequest, "site_required")
		return
	}
	// Verify before storing, so a typo never becomes the stored credential.
	me, err := origin.Connected(next.Site, body.JiraEmail, body.APIToken).Myself(r.Context())
	if err != nil {
		if errors.Is(err, jira.ErrAuth) {
			fail(w, http.StatusUnauthorized, "credential_rejected")
			return
		}
		failJira(w, r, s.config(), err)
		return
	}
	next.Email, next.Token = body.JiraEmail, body.APIToken
	next.TokenOwner, next.TokenVerifiedAt = me.DisplayName, store.Now()
	next.AccountID = me.AccountID
	if err := next.ApplyTokenExpiryIfNeeded(body.TokenExpiresAt, next.TokenVerifiedAt, tokenReplaced); err != nil {
		fail(w, http.StatusBadRequest, "invalid_token_expires")
		return
	}
	if err := next.Save(); err != nil {
		serverError(w, r, err)
		return
	}
	s.cfg.Store(&next)
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, credential(&next))
}

func (s *server) handleDeleteCredential(w http.ResponseWriter, r *http.Request) {
	next := *s.config()
	next.Email, next.Token, next.TokenOwner, next.TokenVerifiedAt, next.AccountID = "", "", "", "", ""
	next.ClearTokenExpiry()
	if err := next.Save(); err != nil {
		serverError(w, r, err)
		return
	}
	s.cfg.Store(&next)
	s.gen.Add(1)
	writeJSON(w, http.StatusOK, credential(&next))
}

// handleResync re-fetches one issue from Jira into the mirror and answers with
// the refreshed IssueLite. Same shape as mutate after the write step is skipped.
func (s *server) handleResync(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	_, cfg, src, ok := s.keyWriter(w, r, key)
	if !ok {
		return
	}
	if err := sync.RefreshIssue(r.Context(), cfg, s.db, key, src); err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	s.respondIssue(w, r, key, nil)
}

// handlePageResync re-fetches one Confluence page into the mirror. Success is
// 204: the client reloads detail separately. Must not advance the confluence
// watermark (see sync.SyncPage).
func (s *server) handlePageResync(w http.ResponseWriter, r *http.Request) {
	_, cfg, ok := s.client(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if err := sync.SyncPage(r.Context(), cfg, s.db, id); err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
