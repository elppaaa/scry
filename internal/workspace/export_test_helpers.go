package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/midagedev/gadak/internal/config"
	"github.com/midagedev/gadak/internal/store"
)

// SeedProfile is the profile fixture writer this package's tests and the
// cmd/gadak workspace tests share (it used to exist byte-identically in
// both): it writes config.json and a one-issue gadak.db under GADAK_HOME for
// the named profile ("" = default root), with a distinct issue key per
// profile so bootstrap proves a request hit the right mirror. It returns an
// error instead of taking a *testing.T because no non-test file in this repo
// imports testing — test files wrap it with t.Fatal.
func SeedProfile(name string, cfg *config.Config) error {
	dir, err := config.DirFor(name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// LoadFor-style dir so Save targets this profile even if global profile differs.
	loaded, err := config.LoadFor(name)
	if err != nil {
		return err
	}
	loaded.Site = cfg.Site
	loaded.Email = cfg.Email
	loaded.Token = cfg.Token
	loaded.Projects = cfg.Projects
	if err := loaded.Save(); err != nil {
		return err
	}
	db, err := store.Open(filepath.Join(dir, "gadak.db"))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	// Distinct issue so bootstrap proves we hit the right mirror.
	key := "AAA-1"
	if name != "" && name != "default" {
		key = "BBB-1"
	}
	if err := db.UpsertSource(context.Background(), store.Source{ID: "jira", Kind: "jira", BaseURL: cfg.Site}); err != nil {
		return err
	}
	_, err = db.UpsertIssues(context.Background(), store.Batch{
		Categories: map[string]string{"1": "new"},
		Records: []store.IssueRecord{{
			Item: store.Item{
				ID: "jira:" + key, SourceID: "jira", ExternalID: key, Key: key,
				Title: "fixture " + key, CreatedAt: "2026-07-01T00:00:00.000Z", UpdatedAt: "2026-07-01T00:00:00.000Z",
			},
			Issue: store.Issue{ProjectKey: strings.Split(key, "-")[0], Status: "To Do", StatusID: "1", StatusCategory: "new"},
		}},
	})
	return err
}
