package retro

// The sprint-membership rows (GDK-1846), on the demo fixture. The defect this
// round closes: every row of the --by-sprint table is a time interval, so a
// column headed "Sprint 42" answered with the whole tracker's numbers (the
// 0.22 promo clip read 144 in progress and 38 closed under a sprint whose
// board filter says 4 and 6). The two rows this file pins are membership
// counts — issues carrying the sprint, by status now — and they must coexist
// with, and stay distinct from, the interval rows beside them.
//
// The report clock is anchored inside the sprint's own window, read from the
// fixture's sprints table — the fixtureNow pattern (GDK-1881): a static
// fixture's numbers are only meaningful against a clock the fixture carries,
// never the wall.

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/midagedev/gadak/internal/store"
)

// sprintFixtureNow is the report instant for a named sprint's column: one
// third into the sprint's own window, so the sprint is live (the partial,
// running column) whatever the calendar says outside the test.
func sprintFixtureNow(t *testing.T, db *sql.DB, name string) time.Time {
	t.Helper()
	var start, end string
	if err := db.QueryRow(`SELECT start_at, COALESCE(end_at,'') FROM sprints WHERE name = ?`, name).Scan(&start, &end); err != nil {
		t.Fatalf("read sprint %q: %v", name, err)
	}
	s, ok := parseTime(start)
	if !ok {
		t.Fatalf("sprint %q start %q does not parse", name, start)
	}
	span := 3 * 24 * time.Hour
	if e, ok := parseTime(end); ok {
		if d := e.Sub(s); d > 0 && d/3 < span {
			span = d / 3
		}
	}
	return s.Add(span)
}

// TestSprintMembershipRows is the FAIL-first gate of the membership round:
// against the pre-change source it does not compile (the fields do not exist),
// and against a compute that quietly made the interval rows count membership
// the Closed/InProg assertions go red instead.
func TestSprintMembershipRows(t *testing.T) {
	_, db := demoFixture(t, true)
	now := sprintFixtureNow(t, db, "Sprint 42")

	rep, err := Compute(context.Background(), db, store.FeedIdentity{}, 14*24*time.Hour, now, Options{BySprint: true})
	if err != nil {
		t.Fatalf("Compute by sprint: %v", err)
	}
	var col *Bucket
	names := make([]string, len(rep.Buckets))
	for i := range rep.Buckets {
		names[i] = rep.Buckets[i].Name
		if rep.Buckets[i].Name == "Sprint 42" {
			col = &rep.Buckets[i]
		}
	}
	if col == nil {
		t.Fatalf("no Sprint 42 column; buckets = %v", names)
	}

	// The two membership counts. 6 and 4 are the fixture's own rows
	// (issues carrying sprint 42, by status category now) — the same numbers
	// the board filter reads on the promo clip that surfaced the gap.
	if col.SprintDone == nil || *col.SprintDone != 6 {
		t.Errorf("in sprint · done = %v, want 6", col.SprintDone)
	}
	if col.SprintInProg == nil || *col.SprintInProg != 4 {
		t.Errorf("in sprint · in progress = %v, want 4", col.SprintInProg)
	}
	if len(col.SprintDoneKeys) != 6 {
		t.Errorf("in sprint · done has %d keys, want 6", len(col.SprintDoneKeys))
	}
	if len(col.SprintInProgKeys) != 4 {
		t.Errorf("in sprint · in progress has %d keys, want 4", len(col.SprintInProgKeys))
	}
	if !sortedKeys(col.SprintDoneKeys) || !sortedKeys(col.SprintInProgKeys) {
		t.Errorf("membership keys not sorted: %v / %v", col.SprintDoneKeys, col.SprintInProgKeys)
	}

	// The keys are the fixture's own membership, read straight off the live
	// columns the way a hand query would (RECIPES.md) — status_category,
	// never a display name.
	wantDone := sprintMembershipQuery(t, db, "Sprint 42", store.CategoryDone)
	wantProg := sprintMembershipQuery(t, db, "Sprint 42", store.CategoryInProgress)
	if strings.Join(col.SprintDoneKeys, ",") != strings.Join(wantDone, ",") {
		t.Errorf("in sprint · done keys = %v, want %v", col.SprintDoneKeys, wantDone)
	}
	if strings.Join(col.SprintInProgKeys, ",") != strings.Join(wantProg, ",") {
		t.Errorf("in sprint · in progress keys = %v, want %v", col.SprintInProgKeys, wantProg)
	}

	// The interval rows of the same column are the whole tracker at the
	// window's edge — the numbers that read wrong under a sprint heading.
	// They must stay interval rows: this is the assertion that catches a fix
	// that converges the two families instead of adding the membership pair.
	if col.Closed == nil || *col.Closed == 6 {
		t.Errorf("closed of the same column = %v, want a value other than the membership 6", col.Closed)
	}
	if col.InProg == nil || *col.InProg == 4 {
		t.Errorf("in progress of the same column = %v, want a value other than the membership 4", col.InProg)
	}

	// The week cut has neither row: no field, no table row, no definition —
	// not a dash row, which would read as "no membership data this week".
	weekRep, err := Compute(context.Background(), db, store.FeedIdentity{}, 8*7*24*time.Hour, now, Options{})
	if err != nil {
		t.Fatalf("Compute by week: %v", err)
	}
	for i, b := range weekRep.Buckets {
		if b.SprintDone != nil || b.SprintInProg != nil || b.SprintDoneKeys != nil || b.SprintInProgKeys != nil {
			t.Fatalf("week bucket %d carries a sprint-membership field", i)
		}
	}
	if s := weekRep.Table(); strings.Contains(s, "in sprint") {
		t.Errorf("week table carries a sprint row:\n%s", s)
	}
	for _, d := range weekRep.Definitions() {
		if d[0] == "in sprint · done" || d[0] == "in sprint · in progress" {
			t.Errorf("week definitions carry %q", d[0])
		}
	}

	// The sprint cut prints both rows directly under closed, in that order,
	// and defines them in the footer.
	lines := strings.Split(rep.Table(), "\n")
	at := func(row string) int {
		for i, l := range lines {
			if strings.HasPrefix(l, row+" ") || strings.TrimSpace(l) == row || strings.HasPrefix(l, row+"  ") {
				return i
			}
		}
		return -1
	}
	closedAt, doneAt, progAt, cycleAt := at("closed"), at("in sprint · done"), at("in sprint · in progress"), at("cycle p50")
	if doneAt < 0 || progAt < 0 {
		t.Fatalf("sprint table lacks a membership row:\n%s", rep.Table())
	}
	if !(closedAt < doneAt && doneAt < progAt && progAt < cycleAt) {
		t.Errorf("membership rows not under closed: closed=%d done=%d prog=%d cycle=%d", closedAt, doneAt, progAt, cycleAt)
	}
	defs := rep.Definitions()
	hasDef := func(name string) bool {
		for _, d := range defs {
			if d[0] == name {
				return true
			}
		}
		return false
	}
	if !hasDef("in sprint · done") || !hasDef("in sprint · in progress") {
		t.Errorf("sprint definitions lack the membership rows: %v", defs)
	}

	// JSON carries the four fields under the sprint cut and none of them
	// under weeks, where the rows do not exist.
	raw, err := json.Marshal(rep.JSON())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"sprint_done":6`, `"sprint_in_progress":4`, `"sprint_done_keys"`, `"sprint_in_progress_keys"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("sprint JSON lacks %s", want)
		}
	}
	rawWeek, err := json.Marshal(weekRep.JSON())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rawWeek), "sprint_done") || strings.Contains(string(rawWeek), "sprint_in_progress") {
		t.Errorf("week JSON carries a sprint-membership field:\n%s", rawWeek)
	}
}

// sprintMembershipQuery is the hand query behind the two rows (RECIPES.md):
// the issue keys carrying one sprint, in one status category, by key order.
func sprintMembershipQuery(t *testing.T, db *sql.DB, sprint, category string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT it.key
		FROM issues i JOIN items it ON it.id = i.item_id
		WHERE i.sprint_id = (SELECT id FROM sprints WHERE name = ?) AND i.status_category = ?
		ORDER BY it.key`, sprint, category)
	if err != nil {
		t.Fatalf("membership query: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatal(err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// sortedKeys is the C2 rule for the two new slices: a count is the length of
// its slice, and the slice reads in key order.
func sortedKeys(keys []string) bool {
	for i := 1; i < len(keys); i++ {
		if keys[i-1] > keys[i] {
			return false
		}
	}
	return true
}
