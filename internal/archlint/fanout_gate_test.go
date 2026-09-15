//go:build sourcelint

// Fanout ratchet (GDK-1922 ④): internal/server is where every product
// surface meets, so its internal-import count is the "everything meets
// here" number the v0.23 audit trended — 23 at the v0.22 baseline, 24
// during this cycle. This gate turns that trend into a ratchet, not a
// budget: going over the ceiling fails (and names the packages that
// entered since the recorded baseline), and dropping below it fails with
// "lower the ceiling" — the mobile/src/lib/screen-size.test.ts shape. A
// 25th import is not banned, it is priced: new join surfaces go through
// an owning package (parenthint, reflink own theirs), and raising the
// ceiling is a structural decision recorded here with a new baseline.
//
// Measured 2026-09-16 (GDK-1922) with:
//
//	go list -f '{{join .Imports "\n"}}' ./internal/server | grep -c '^github.com/midagedev/gadak/internal/'
//
// → 24. The gate recomputes that number with go/parser over the package's
// non-test files (no external commands, like the other sourcelint gates).
// Parity with go list holds because internal/server has no build-tagged
// files (IgnoredGoFiles is empty); a future GOOS-tagged import would make
// the parser count differ from go list per platform by design — the
// ratchet is on declared source.
package archlint

import (
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

const (
	serverInternalImportPrefix = "github.com/midagedev/gadak/internal/"

	// serverInternalImportCeiling is the ratchet ceiling: the measured
	// internal-import count of internal/server (GDK-1922, 2026-09-16).
	// It only moves down (a join surface left) or up with a structural
	// reason and a refreshed baseline list.
	serverInternalImportCeiling = 24

	// serverInternalImportBaseline records the package set behind the
	// 2026-09-16 measurement so an over-ceiling failure can name what
	// entered, not just count.
	serverInternalImportBaseline = "adf attachcache config config/tokencheck " +
		"confluence create dashboards fields jira jirafields jql linear " +
		"origin originbind pairing parenthint reflink retro statuscat store " +
		"sync term transition uifocus"
)

// TestServerInternalImportFanout keeps internal/server's internal-package
// fanout at its recorded level. internal/server files are parsed, never
// imported — write.go and friends belong to that package's own rounds.
func TestServerInternalImportFanout(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))

	seen := map[string]bool{}
	err := Walk(root, func(af *File) error {
		if !strings.HasPrefix(af.Rel, "internal/server/") ||
			!strings.HasSuffix(af.Rel, ".go") || strings.HasSuffix(af.Rel, "_test.go") {
			return nil
		}
		f, _, err := af.AST()
		if err != nil {
			t.Fatalf("parse %s: %v", af.Rel, err)
		}
		for _, spec := range f.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			if strings.HasPrefix(path, serverInternalImportPrefix) {
				seen[strings.TrimPrefix(path, serverInternalImportPrefix)] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)

	if n := len(names); n > serverInternalImportCeiling {
		baseline := strings.Fields(serverInternalImportBaseline)
		var fresh, known []string
		for _, name := range names {
			if slicesContains(baseline, name) {
				known = append(known, name)
			} else {
				fresh = append(fresh, name)
			}
		}
		t.Fatalf("internal/server imports %d internal packages, ceiling is %d (GDK-1922 fanout ratchet)\n"+
			"new since baseline: %s\nall imports: %s\n"+
			"a new join surface belongs to an owning package (parenthint, reflink own theirs), not to the %dth import;\n"+
			"raising the ceiling is a structural decision — record it here with a refreshed baseline",
			n, serverInternalImportCeiling, orNone(fresh), strings.Join(names, ", "), n)
	}
	if n := len(names); n < serverInternalImportCeiling {
		t.Fatalf("internal/server imports %d internal packages, ceiling is still %d — lower the ceiling (GDK-1922 fanout ratchet):\n"+
			"a join surface left; the ceiling follows it down so the count cannot drift back up unnoticed\nimports now: %s",
			n, serverInternalImportCeiling, strings.Join(names, ", "))
	}
}

func slicesContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func orNone(names []string) string {
	if len(names) == 0 {
		return "(none — the baseline itself exceeds this ceiling; refresh both together)"
	}
	return strings.Join(names, ", ")
}
