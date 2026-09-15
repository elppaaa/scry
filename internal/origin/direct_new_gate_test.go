//go:build sourcelint

// Repo-wide AST gate (GDK-1144): lives behind the sourcelint tag so the
// default `go test ./...` never pays the whole-tree parse. Run with
// `bash tools/sourcelint.sh` — CI's Go-tests step runs exactly that.

package origin

import (
	"go/ast"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/midagedev/gadak/internal/archlint"
)

// TestNoDirectJiraNewOutsideOrigin is the structural lock: "this workspace's
// Jira client" is built in this package only. A new jira.New( in production
// code (outside internal/jira and this package) fails this test.
//
// Tests (*_test.go) may still call jira.New to stand up httptest servers.
func TestNoDirectJiraNewOutsideOrigin(t *testing.T) {
	hits := findPkgNewCallsOutside(t, "github.com/midagedev/gadak/internal/jira", allowedJiraNewFile)
	if len(hits) > 0 {
		t.Fatalf("jira.New must not be called from production code outside internal/origin (and its definition in internal/jira):\n  %s",
			strings.Join(hits, "\n  "))
	}
}

func allowedJiraNewFile(rel string) bool {
	if strings.HasPrefix(rel, "internal/origin/") {
		return true
	}
	// The constructor itself.
	if rel == "internal/jira/client.go" {
		return true
	}
	return false
}

// findPkgNewCallsOutside walks every production file and returns file:line
// for each call of the package's New constructor, where the package is
// identified by its import path (import aliases handled: the local bound
// name is what calls must use). Shared by the Jira and Confluence locks —
// the two walks were byte-identical except for the import path and the
// allow-list, which is exactly the duplication this helper owns.
func findPkgNewCallsOutside(t *testing.T, importPath string, allowed func(rel string) bool) []string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))

	var hits []string
	err := archlint.Walk(root, func(af *archlint.File) error {
		if strings.HasSuffix(af.Rel, "_test.go") || allowed(af.Rel) {
			return nil
		}
		hits = append(hits, findPkgNewCalls(t, af, importPath)...)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return hits
}

// findPkgNewCalls returns the <local>.New( call sites in one file. The
// default local name is the import path's last segment.
func findPkgNewCalls(t *testing.T, af *archlint.File, importPath string) []string {
	t.Helper()
	f, fset, err := af.AST()
	if err != nil {
		t.Fatalf("parse %s: %v", af.Rel, err)
		return nil
	}
	pkgName := importPath[strings.LastIndexByte(importPath, '/')+1:]
	for _, imp := range f.Imports {
		if strings.Trim(imp.Path.Value, `"`) != importPath {
			continue
		}
		if imp.Name != nil {
			pkgName = imp.Name.Name
		}
	}
	if pkgName == "" || pkgName == "_" {
		return nil
	}
	var hits []string
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel == nil || sel.Sel.Name != "New" {
			return true
		}
		id, ok := sel.X.(*ast.Ident)
		if !ok || id.Name != pkgName {
			return true
		}
		pos := fset.Position(call.Pos())
		hits = append(hits, filepath.ToSlash(af.Rel)+":"+strconv.Itoa(pos.Line))
		return true
	})
	return hits
}
