package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
)

// TestMigrateV52LeavesCommentParentNULL is the v52 migration gate: a v51
// mirror holding a wiki comment row must open at v52 with the row's new
// parent_id column NULL — "parent unknown", not top-level. The migration
// deliberately does no backfill: no origin-side thread parent is knowable
// from the mirror alone, and the reconcile scan's comments-backfill fetch is
// the single owner of healing it. A NULL that silently read as an empty
// parent (known top-level) would strand pre-v52 reply rows as fake top-level
// comments forever, because nothing would ever ask the origin again.
func TestMigrateV52LeavesCommentParentNULL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gadak.db")
	mirrorAt(t, path, 51)

	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	seed := []string{
		`INSERT INTO sources (id, kind) VALUES ('confluence','confluence')`,
		`INSERT INTO items (id, source_id, kind, external_id, key, title, created_at, updated_at, synced_at)
		  VALUES ('confluence:77', 'confluence', 'page', '77', '77', 'Old page', '2026-01-01', '2026-02-01', '2026-02-01')`,
		`INSERT INTO pages (item_id, space_key, version, status, body_adf) VALUES ('confluence:77', 'ENG', 1, 'current', '{}')`,
		`INSERT INTO comments (id, item_id, external_id, author, author_id, body_text, created_at, updated_at)
		  VALUES ('confluence:c1', 'confluence:77', 'c1', 'Bob Example', 'acc-2', 'pre-v52 row', '2026-08-01T11:00:00.000Z', '')`,
	}
	for _, q := range seed {
		if _, err := raw.Exec(q); err != nil {
			raw.Close()
			t.Fatalf("seed %q: %v", q, err)
		}
	}
	raw.Close()

	db, err := Open(path)
	if err != nil {
		t.Fatalf("open a v51 mirror at head: %v", err)
	}
	defer db.Close()
	if db.SchemaVersion() < 52 {
		t.Fatalf("schema version = %d, want ≥ 52 (the v52 migration did not run)", db.SchemaVersion())
	}

	conn, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var parent sql.NullString
	if err := conn.QueryRow(`SELECT parent_id FROM comments WHERE id = 'confluence:c1'`).Scan(&parent); err != nil {
		t.Fatalf("read parent_id: %v", err)
	}
	if parent.Valid {
		t.Fatalf("parent_id = %q, want NULL — the migration adds the column, the reconcile heals it", parent.String)
	}
}

// pageCommentFixture is one page carrying a top-level comment and its reply,
// plus a second page with no comments at all — the two comparable shapes the
// reconcile scan asks about. Same shape as pageAttFixture (pages_test.go).
func pageCommentFixture(t *testing.T) *DB {
	t.Helper()
	db := openTemp(t)
	if err := db.UpsertSource(context.Background(), Source{ID: "confluence", Kind: "confluence"}); err != nil {
		t.Fatal(err)
	}
	_, err := db.UpsertPages(context.Background(), []PageRecord{{
		Item: Item{
			ID: "confluence:77", SourceID: "confluence", Kind: "page", ExternalID: "77",
			Key: "77", Title: "Design doc", CreatedAt: ago(2), UpdatedAt: ago(1),
		},
		Page: Page{SpaceKey: "ENG", Version: 1, Status: "current", BodyADF: json.RawMessage(`{"type":"doc","version":1,"content":[]}`)},
		Comments: []Comment{{
			ID: "confluence:c-top", ExternalID: "c-top", Author: "Bob", AuthorID: "acc-2",
			BodyText: "top", CreatedAt: ago(1), UpdatedAt: ago(1), ParentID: strPtr(""),
		}, {
			ID: "confluence:c-rep", ExternalID: "c-rep", Author: "Ada", AuthorID: "acc-1",
			BodyText: "reply", CreatedAt: ago(1), UpdatedAt: ago(1), ParentID: strPtr("c-top"),
		}},
	}, {
		Item: Item{
			ID: "confluence:88", SourceID: "confluence", Kind: "page", ExternalID: "88",
			Key: "88", Title: "Other page", CreatedAt: ago(2), UpdatedAt: ago(1),
		},
		Page: Page{SpaceKey: "ENG", Version: 1, Status: "current", BodyADF: json.RawMessage(`{"type":"doc","version":1,"content":[]}`)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return db
}

// TestPageTopCommentIDs is the GDK-1888 comment-half read gate, the mirror of
// TestPageAttachmentIDs: one space's mirrored pages → their top-level comment
// external-id sets, plus the unknown flag. Every mirrored page of the space
// has a top entry (an empty set is "no top-level comments", not absence);
// replies stay outside the set — the expansion only lists top-level ids, so a
// reply in the set would make every reply-bearing page compare unequal
// forever; and any NULL parent row flags the page unknown, which is the
// scan's cue to heal the column with one fetch rather than guess.
func TestPageTopCommentIDs(t *testing.T) {
	db := pageCommentFixture(t) // page 77: c-top (top) + c-rep (reply); page 88: none — space ENG
	top, unknown, err := db.PageTopCommentIDs(context.Background(), "confluence", "ENG")
	if err != nil {
		t.Fatal(err)
	}
	if len(top) != 2 {
		t.Fatalf("pages = %v, want exactly 77 and 88", top)
	}
	if len(top["77"]) != 1 || !top["77"]["c-top"] {
		t.Errorf("page 77 top set = %v, want exactly c-top (the reply stays out)", top["77"])
	}
	if top["88"] == nil || len(top["88"]) != 0 {
		t.Errorf("page 88 top set = %v, want a present empty set (mirrored, no comments)", top["88"])
	}
	if len(unknown) != 0 {
		t.Errorf("unknown = %v, want none (every row has a known parent)", unknown)
	}
	other, _, err := db.PageTopCommentIDs(context.Background(), "confluence", "XXS")
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Errorf("foreign space rows = %v, want none", other)
	}
	// Degenerate args answer empty, not error — same contract as
	// PageAttachmentIDs.
	if m, _, err := db.PageTopCommentIDs(context.Background(), "", "ENG"); err != nil || len(m) != 0 {
		t.Errorf("empty source = %v %v, want an empty map", m, err)
	}
	if m, _, err := db.PageTopCommentIDs(context.Background(), "confluence", ""); err != nil || len(m) != 0 {
		t.Errorf("empty space = %v %v, want an empty map", m, err)
	}

	// The pre-v52 shape: a NULL parent on any of the page's rows makes the
	// page unknown — its top set can no longer be trusted, and the scan must
	// re-fetch the page once to heal both rows.
	if _, err := db.sql.Exec(`UPDATE comments SET parent_id = NULL WHERE id = 'confluence:c-top'`); err != nil {
		t.Fatal(err)
	}
	top, unknown, err = db.PageTopCommentIDs(context.Background(), "confluence", "ENG")
	if err != nil {
		t.Fatal(err)
	}
	if len(top["77"]) != 0 {
		t.Errorf("page 77 top set with a NULL parent = %v, want empty (unknown, not compared)", top["77"])
	}
	if !unknown["77"] {
		t.Errorf("unknown = %v, want page 77 flagged (a NULL parent row)", unknown)
	}
	if unknown["88"] {
		t.Errorf("unknown = %v, page 88 must stay known (no rows at all)", unknown)
	}
}
