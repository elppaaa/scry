package server

import (
	"net/http"

	"github.com/midagedev/gadak/internal/jira"
)

// The Jira-shaped catalog GETs — workspace-wide and per-key priority and
// user-search listings. These stay on s.client()/keyWriter because the
// contracts are Jira-shaped; each caller is named on
// TestWriteHandlersDoNotCallClient's allowlist with a reason (GDK-681).
// Split from write.go (GDK-1922).

func writePriorityCatalog(w http.ResponseWriter, list []jira.NamedID) {
	out := make([]map[string]string, 0, len(list))
	for _, p := range list {
		if p.ID == "" {
			continue
		}
		out = append(out, map[string]string{"id": p.ID, "name": p.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"priorities": out})
}

func (s *server) handlePriorities(w http.ResponseWriter, r *http.Request) {
	c, _, ok := s.client(w)
	if !ok {
		return
	}
	list, err := c.PriorityCatalog(r.Context())
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	writePriorityCatalog(w, list)
}

func (s *server) handleKeyPriorities(w http.ResponseWriter, r *http.Request) {
	c, _, _, ok := s.keyWriter(w, r, r.PathValue("key"))
	if !ok {
		return
	}
	list, err := c.PriorityCatalog(r.Context())
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	writePriorityCatalog(w, list)
}

func writeUserCatalog(w http.ResponseWriter, users []jira.User) {
	out := make([]map[string]any, 0, len(users))
	for _, u := range users {
		row := map[string]any{
			// The REST field name is the wire contract; the value is the
			// origin's own user axis — accountId on Cloud, the username on
			// Server (GDK-1638).
			"account_id": u.ID(), "display_name": u.DisplayName, "email": u.Email,
			"avatar_url": u.Avatar(), "active": u.Active,
		}
		// The bot axis (GDK-590), so a picker can de-emphasize bots without
		// guessing from names. Omitted when the origin sent no accountType.
		if u.AccountType != "" {
			row["account_type"] = u.AccountType
			row["is_bot"] = jira.IsBotAccountType(u.AccountType)
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func (s *server) handleUsers(w http.ResponseWriter, r *http.Request) {
	c, _, ok := s.client(w)
	if !ok {
		return
	}
	users, err := c.SearchUsers(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	writeUserCatalog(w, users)
}

func (s *server) handleKeyUsers(w http.ResponseWriter, r *http.Request) {
	c, _, _, ok := s.keyWriter(w, r, r.PathValue("key"))
	if !ok {
		return
	}
	users, err := c.SearchUsers(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		failJira(w, r, s.config(), err)
		return
	}
	writeUserCatalog(w, users)
}
