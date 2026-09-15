package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/midagedev/gadak/internal/config"
	"github.com/midagedev/gadak/internal/create"
	"github.com/midagedev/gadak/internal/fields"
	"github.com/midagedev/gadak/internal/jira"
	"github.com/midagedev/gadak/internal/jirafields"
	"github.com/midagedev/gadak/internal/origin"
	"github.com/midagedev/gadak/internal/parenthint"
	"github.com/midagedev/gadak/internal/store"
	"github.com/midagedev/gadak/internal/sync"
)

// Issue creation and its metadata surfaces — handleCreate, the custom-field
// resolution the create dialog feeds, create-meta / create-fields catalogs,
// and the boot-time write meta cache. Split from write.go (GDK-1922).

// failCreate maps shared create-resolution errors onto stable wire codes.
// Need* errors are surface-neutral; CLI flag names stay in cmd/gadak.
// Pairing/dial failures are not Need* — handleCreate probes before calling this.
func failCreate(w http.ResponseWriter, err error) {
	var np *create.NeedProjectError
	if errors.As(err, &np) {
		fail(w, http.StatusBadRequest, "project_required")
		return
	}
	var nt *create.NeedTypeError
	if errors.As(err, &nt) {
		fail(w, http.StatusBadRequest, "issue_type_required")
		return
	}
	var npri *create.NeedPriorityError
	if errors.As(err, &npri) {
		fail(w, http.StatusBadRequest, "priority_required")
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
}

// failCreateOrPairing is handleCreate's Need* path. NeedProject/NeedType are
// local config ambiguity; probe the origin so a pairing/dial failure is not
// relabeled as project_required / issue_type_required (CLI createOne, GDK-453).
// failCreate stays a pure mapping function. The probe is CreateMeta (on
// origin.Writer) rather than Jira Projects: Writer has no Projects verb,
// and a pairing/dial failure surfaces on either call.
func failCreateOrPairing(w http.ResponseWriter, r *http.Request, wr origin.Writer, cfg *config.Config, err error) {
	var np *create.NeedProjectError
	var nt *create.NeedTypeError
	if (errors.As(err, &np) || errors.As(err, &nt)) && wr != nil {
		catalog, perr := wr.CreateMeta(r.Context(), cfg.Projects)
		if perr != nil && origin.IsPairingFailure(perr) {
			failJira(w, r, cfg, perr)
			return
		}
		if errors.As(err, &np) && len(np.Configured) == 0 && perr == nil {
			err = create.FillNeedProject(err, catalog)
		}
	}
	failCreate(w, err)
}

func (s *server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var p struct {
		ProjectKey        string   `json:"project_key"`
		IssueType         string   `json:"issue_type"`
		Summary           string   `json:"summary"`
		DescriptionText   string   `json:"description_text"`
		AssigneeAccountID *string  `json:"assignee_account_id"`
		PriorityID        string   `json:"priority_id"`
		Labels            []string `json:"labels"`
		Duedate           string   `json:"duedate"`
		Parent            string   `json:"parent"`
		// CustomFields carries the fields the dialog filled from
		// create-meta/fields/, keyed by field id with the editor's raw value
		// (an option id, a string, a date) — the server does the kind
		// wrapping, exactly as it does for the CLI (GDK-533).
		CustomFields map[string]json.RawMessage `json:"custom_fields"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		fail(w, http.StatusBadRequest, "invalid_body")
		return
	}
	if err := origin.RefuseBodyPlaceholders(s.config(), p.DescriptionText); err != nil {
		failMsg(w, http.StatusConflict, "placeholder", err.Error())
		return
	}
	// Only the summary is required now that project and type resolve to
	// defaults below. The code keeps its old name: callers and the i18n
	// catalog key on it (web/src/lib/i18n/en.ts), and renaming a wire code to
	// tidy it would break them for no gain in what the reader is told.
	if strings.TrimSpace(p.Summary) == "" {
		fail(w, http.StatusBadRequest, "project_issue_type_and_summary_required")
		return
	}
	c, cfg, src, ok := s.createWriter(w, r, p.ProjectKey)
	if !ok {
		return
	}
	proj, err := create.Project(p.ProjectKey, cfg)
	if err != nil {
		failCreateOrPairing(w, r, c, cfg, err)
		return
	}
	// An issue filed outside the mirrored projects would never come back from the
	// re-read, so refuse it here rather than answering with a stale-mirror error.
	// The empty-list semantics ("no explicit scope", not deny-all) live in
	// Config.ProjectMirrored — the one owner shared with the CLI pre-check.
	if !cfg.ProjectMirrored(proj.Value) {
		// GDK-973: same wording axis as the CLI refusal — the verdict is
		// config scope ("not in the projects config"), not mirror presence;
		// the wire code keeps its contract name project_not_mirrored.
		log.Printf("server: create refused project %q: not in the projects config (%d configured)", proj.Value, len(cfg.Projects))
		fail(w, http.StatusBadRequest, "project_not_mirrored")
		return
	}
	meta, err := c.CreateMeta(r.Context(), []string{proj.Value})
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	metaProj, types, err := create.MetaForWithCatalog(r.Context(), c, meta, proj.Value, cfg)
	if err != nil {
		failCreateOrPairing(w, r, c, cfg, err)
		return
	}
	typ, err := create.Type(p.IssueType, types, cfg, proj.Value)
	if err != nil {
		failCreateOrPairing(w, r, c, cfg, err)
		return
	}

	// The due date is validated before payload assembly: the map below is
	// named fields and would shadow the package for the check.
	duedate := strings.TrimSpace(p.Duedate)
	if duedate != "" && !fields.DateOnlyLiteral(duedate) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("duedate %q is not a date (want YYYY-MM-DD)", p.Duedate),
		})
		return
	}
	parent := strings.TrimSpace(p.Parent)
	parentKey := strings.ToUpper(parent)
	if parent != "" && !fields.IssueKeyLiteral(parentKey) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("parent %q is not a Jira key (want ABC-123)", p.Parent),
		})
		return
	}

	// GDK-533: custom fields the dialog filled, keyed by field id (what
	// create-meta/fields/ answers). Resolved against the same createmeta
	// list the CLI's create --field consults and wrapped by the same
	// fields.FieldValue encoder, so both clients send the origin one payload
	// shape. Computed before the fields map below — that local shadows the
	// package, same as the duedate check above.
	custom, ok := s.resolveCreateCustomFields(w, r, c, metaProj.Key, typ.Value, p.CustomFields)
	if !ok {
		return
	}

	fields := map[string]any{
		// map[string]any so Linear CreateIssue can read project.key
		// (map[string]string fails that type assert).
		"project": map[string]any{"key": metaProj.Key},
		"summary": p.Summary,
	}
	// Linear CreateIssue refuses issuetype; CLI createLinearOne omits it.
	if src != "linear" {
		fields["issuetype"] = map[string]string{"id": typ.Value}
	}
	// Optional fields are omitted, never sent as "". Empty string is "no
	// value" (resolve / skip), not "set this field to empty".
	if strings.TrimSpace(p.DescriptionText) != "" {
		// The body value is the origin's (GDK-1637): ADF doc here, the raw
		// string on a Jira Server origin whose description field is wiki
		// markup carried verbatim.
		fields["description"] = origin.BodyValue(cfg, p.DescriptionText, jira.Doc(p.DescriptionText, nil))
	}
	if id := deref(p.AssigneeAccountID); id != "" {
		fields["assignee"] = map[string]string{"accountId": id}
	}
	if id := strings.TrimSpace(p.PriorityID); id != "" {
		fields["priority"] = create.PriorityField(id)
	}
	if labels := normalizeLabels(p.Labels); len(labels) > 0 {
		fields["labels"] = labels
	}
	if duedate != "" {
		fields["duedate"] = duedate
	}
	if parentKey != "" {
		fields["parent"] = map[string]string{"key": parentKey}
	}
	for id, v := range custom {
		fields[id] = v
	}

	key, err := c.CreateIssue(r.Context(), fields)
	if err != nil {
		failJira(w, r, s.config(), parenthint.Wrap(err, parentKey, s.db))
		return
	}
	if err := sync.RefreshIssue(r.Context(), cfg, s.db, key, src); err != nil {
		failMirrorStale(w, key, err)
		return
	}
	label := writeOriginLabel(src)
	log.Printf("server: write %s origin=%s", key, label)
	s.respondIssue(w, r, key, map[string]any{
		"origin": label,
		"resolved": map[string]any{
			"project":    proj,
			"issue_type": typ,
		},
	})
}

// createFixedFields are the ids handleCreate's own parameters assemble.
// A custom_fields entry naming one is a conflict, not an override: the
// dialog only offers ids it fetched from create-meta/fields/, which never
// includes these, so anything here is a bug or a probe.
var createFixedFields = map[string]bool{
	"project": true, "issuetype": true, "summary": true, "description": true,
	"assignee": true, "priority": true, "labels": true, "duedate": true, "parent": true,
}

// resolveCreateCustomFields wraps the dialog's custom field values into the
// origin payload (GDK-533). Same two owners the CLI's create --field uses:
// jirafields.ResolveEditable for the kind (over the createmeta list) and
// fields.FieldValue for the wrapping. An id the list does not carry, one of
// the endpoint's fixed fields, or a value the kind rejects is a 400 naming
// the field — never a silent drop, and never a call to the origin.
func (s *server) resolveCreateCustomFields(
	w http.ResponseWriter, r *http.Request, c origin.Writer, projectKey, issueTypeID string,
	raws map[string]json.RawMessage,
) (map[string]any, bool) {
	if len(raws) == 0 {
		return nil, true
	}
	cf, err := origin.AsCreateFieldCatalog(c)
	if err != nil {
		failJira(w, r, s.config(), err)
		return nil, false
	}
	list, err := cf.CreateFields(r.Context(), projectKey, issueTypeID)
	if err != nil {
		failJira(w, r, s.config(), err)
		return nil, false
	}
	meta := make(map[string]jira.FieldMeta, len(list))
	for _, f := range list {
		meta[f.FieldID] = jirafields.FieldMetaFromCreate(f)
	}
	out := make(map[string]any, len(raws))
	for id, raw := range raws {
		if createFixedFields[id] {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("custom field %q conflicts with a field this endpoint sets directly", id),
			})
			return nil, false
		}
		_, kind, ok := jirafields.ResolveEditable([]string{id}, meta, "")
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("custom field %q is not available for this project and type", id),
			})
			return nil, false
		}
		// Empty is omit, never "set to empty" — the rule the fixed optional
		// fields above already follow.
		trimmed := strings.TrimSpace(string(raw))
		if trimmed == "" || trimmed == "null" || trimmed == `""` {
			continue
		}
		v, err := fields.FieldValue(kind, raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("custom field %q: %v", id, err),
			})
			return nil, false
		}
		out[id] = v
	}
	return out, true
}

func (s *server) handleCreateMeta(w http.ResponseWriter, r *http.Request) {
	c, cfg, ok := s.client(w)
	if !ok {
		return
	}
	projects, err := c.CreateMeta(r.Context(), cfg.Projects)
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": createMeta(projects)})
}

// handleCreateFields is the create-time field list for one project+type
// (GDK-254). The server does not decide which fields to warn about: it
// returns every field the origin listed. Not a boot path — missing
// credential is 409, same as create-meta/. Origin errors go through
// failJira so they stay 4xx/502, never 500.
func (s *server) handleCreateFields(w http.ResponseWriter, r *http.Request) {
	project := strings.TrimSpace(r.URL.Query().Get("project"))
	issueType := strings.TrimSpace(r.URL.Query().Get("issue_type"))
	if project == "" || issueType == "" {
		fail(w, http.StatusBadRequest, "project_and_issue_type_required")
		return
	}
	c, _, ok := s.client(w)
	if !ok {
		return
	}
	list, err := c.CreateFields(r.Context(), project, issueType)
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	// The same interpreter the CLI's create --field resolves through
	// (editKind over FieldMetaFromCreate), so the dialog and the CLI cannot
	// disagree about what a field accepts (GDK-533). kind/options are
	// omitted when unknown — an older client keeps the warn-only behavior.
	meta := make(map[string]jira.FieldMeta, len(list))
	for _, f := range list {
		meta[f.FieldID] = jirafields.FieldMetaFromCreate(f)
	}
	out := make([]map[string]any, 0, len(list))
	for _, f := range list {
		row := map[string]any{
			"field_id":    f.FieldID,
			"name":        f.Name,
			"required":    f.Required,
			"has_default": f.HasDefaultValue,
			"type":        f.Schema.Type,
		}
		if _, kind, ok := jirafields.ResolveEditable([]string{f.FieldID}, meta, ""); ok {
			row["kind"] = kind
		}
		if len(f.AllowedValues) > 0 {
			// Same {id,value} collapse handleEditMeta serves, so the client
			// renders one option idiom for editmeta and createmeta alike.
			options := make([]map[string]string, 0, len(f.AllowedValues))
			for _, v := range f.AllowedValues {
				label := v.Value
				if label == "" {
					label = v.Name
				}
				options = append(options, map[string]string{"id": v.ID, "value": label})
			}
			row["options"] = options
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"fields": out})
}

func createMeta(projects []jira.CreateMetaProject) []map[string]any {
	out := make([]map[string]any, 0, len(projects))
	for _, p := range projects {
		types := make([]map[string]any, 0, len(p.IssueTypes))
		for _, t := range p.IssueTypes {
			row := map[string]any{"id": t.ID, "name": t.Name}
			// Same omitempty as jira.CreateMetaIssueType: false/0 stay
			// off the wire so older clients see the previous shape.
			if t.Subtask {
				row["subtask"] = true
			}
			if t.HierarchyLevel != 0 {
				row["hierarchyLevel"] = t.HierarchyLevel
			}
			types = append(types, row)
		}
		out = append(out, map[string]any{"key": p.Key, "name": p.Name, "issue_types": types})
	}
	return out
}

// handleWriteMeta is the boot-time cache for the write UI. The transition map is
// empty on purpose: filling it costs one Jira call per project and status, and the
// client already falls back to fetching an issue's transitions when it opens the
// menu. An unconfigured credential answers 200 with nothing rather than an error,
// because this runs on every boot.
//
// ponytail: no precomputed transitions. Fill it if opening the status menu ever
// feels slow.
func (s *server) handleWriteMeta(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"transitions": map[string]any{},
		"create_meta": map[string]any{"projects": []map[string]any{}},
		"updated_at":  nil,
	}
	cfg := s.config()
	if !cfg.HasCredential() {
		writeJSON(w, http.StatusOK, body)
		return
	}
	c, err := origin.Client(cfg)
	if err != nil {
		log.Printf("server: meta/write: %v", err)
		writeJSON(w, http.StatusOK, body)
		return
	}
	projects, err := c.CreateMeta(r.Context(), cfg.Projects)
	if err != nil {
		// Degrade rather than block the boot: every surface this feeds has a fallback.
		log.Printf("server: meta/write: %v", err)
		writeJSON(w, http.StatusOK, body)
		return
	}
	body["create_meta"] = map[string]any{"projects": createMeta(projects)}
	body["updated_at"] = store.Now()
	writeJSON(w, http.StatusOK, body)
}
