//go:build sourcelint

// Repo-wide AST gate (GDK-1144): lives behind the sourcelint tag so the
// default `go test ./...` never pays the whole-tree parse. Run with
// `bash tools/sourcelint.sh` — CI's Go-tests step runs exactly that.

package origin

import (
	"strings"
	"testing"
)

// TestNoDirectConfluenceNewOutsideOrigin is the structural lock: "this
// workspace's Confluence client" is built in this package only. A new
// confluence.New( in production code (outside internal/confluence and this
// package) fails this test.
//
// 2026-08-18 GDK-267: FAIL-first ran against the four production callers
// (cmd/gadak/api.go, internal/server/settings.go, internal/sync/confluence.go,
// internal/sync/one.go) before they were rewritten to origin.Wiki. Tests
// (*_test.go) may still call confluence.New to stand up httptest servers.
//
// The walk itself is the shared findPkgNewCallsOutside in
// direct_new_gate_test.go — only the import path and the allow-list differ.
func TestNoDirectConfluenceNewOutsideOrigin(t *testing.T) {
	hits := findPkgNewCallsOutside(t, "github.com/midagedev/gadak/internal/confluence", allowedConfluenceNewFile)
	if len(hits) > 0 {
		t.Fatalf("confluence.New must not be called from production code outside internal/origin (and its definition in internal/confluence):\n  %s",
			strings.Join(hits, "\n  "))
	}
}

func allowedConfluenceNewFile(rel string) bool {
	if strings.HasPrefix(rel, "internal/origin/") {
		return true
	}
	// The constructor itself (and any other file in that package).
	if strings.HasPrefix(rel, "internal/confluence/") {
		return true
	}
	return false
}
