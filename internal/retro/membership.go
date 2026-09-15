package retro

// Sprint membership: the two rows the --by-sprint table was
// missing. Every other row of that table is a time interval — "at bucket
// end", "during the bucket" — so a column headed "Sprint 42" answered with
// the whole tracker's numbers: the 0.22 promo clip read 144 in progress and
// 38 closed under a sprint whose board filter says 4 and 6. These rows
// answer the question the heading asks — what is in this sprint — from
// issues.sprint_id, the mirror's live column, keyed to sprints.id the way
// bucketSurprises already reads it (materials.go).
//
// "Now" is the load-bearing word. Interval rows need the changelog to place
// a moment inside a window; membership is a current-state column answer, so
// it survives on origins that keep no history — Linear has none, interval
// rows die there, and these two live. Categories come from status_category
// (new|inprogress|done), never from a display name: a Korean account where
// no status is called "In Progress" still counts.

import (
	"context"
	"database/sql"
	"fmt"
	"sort"

	"github.com/midagedev/gadak/internal/store"
)

// loadSprintIssues reads the sprint each issue carries now: sprint id to the
// item ids under it. Sprintless issues map to 0 and are dropped — they are
// nobody's membership.
func loadSprintIssues(ctx context.Context, db *sql.DB) (map[int64][]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT COALESCE(sprint_id, 0), item_id FROM issues`)
	if err != nil {
		return nil, fmt.Errorf("retro: read sprint membership: %w", err)
	}
	defer rows.Close()
	out := make(map[int64][]string)
	for rows.Next() {
		var sprint int64
		var item string
		if err := rows.Scan(&sprint, &item); err != nil {
			return nil, err
		}
		if sprint == 0 {
			continue
		}
		out[sprint] = append(out[sprint], item)
	}
	return out, rows.Err()
}

// fillSprintMembership fills the two membership rows of every sprint column:
// done-now and in-progress-now counts, with the keys behind them. Items the
// mirror no longer holds an items row for are skipped — a count whose key
// list could not name its members would not be a count of anything
// addressable. Week buckets (SprintID 0) are left untouched, which is what
// keeps the two rows out of the week cut entirely: no dash row, no field, no
// definition — a week has no members.
func fillSprintMembership(buckets []Bucket, itemByID map[string]item, issCategory map[string]string, sprintItems map[int64][]string) {
	for i := range buckets {
		b := &buckets[i]
		if b.SprintID == 0 {
			continue
		}
		var doneKeys, progKeys []string
		for _, id := range sprintItems[b.SprintID] {
			it, ok := itemByID[id]
			if !ok {
				continue
			}
			switch issCategory[id] {
			case store.CategoryDone:
				doneKeys = append(doneKeys, it.key)
			case store.CategoryInProgress:
				progKeys = append(progKeys, it.key)
			}
		}
		sort.Strings(doneKeys)
		sort.Strings(progKeys)
		done, prog := len(doneKeys), len(progKeys)
		b.SprintDone, b.SprintInProg = &done, &prog
		b.SprintDoneKeys, b.SprintInProgKeys = doneKeys, progKeys
	}
}

// sprintMembershipDefinitions is the pair only the sprint cut prints, wedged
// after the closed row they stand beside. Each sentence says both halves:
// what membership counts, and why the number beside it is different — the
// closed row is everything that finished inside the window, the in progress
// row is the whole tracker at the window's end, and neither is a statement
// about this sprint's members.
func sprintMembershipDefinitions() [][2]string {
	return [][2]string{
		{"in sprint · done", "issues carrying this sprint whose status is done now (membership, not the interval; the closed row above counts everything that finished inside the window)"},
		{"in sprint · in progress", "issues carrying this sprint that are in progress now (membership, not the interval; the in progress row above is the whole tracker at the window's end)"},
	}
}
