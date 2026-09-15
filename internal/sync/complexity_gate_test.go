//go:build sourcelint

// Repo-wide AST gate (GDK-1144): lives behind the sourcelint tag so the
// default `go test ./...` never pays the whole-tree parse. Run with
// `bash tools/sourcelint.sh` — CI's Go-tests step runs exactly that.

package sync

import (
	"fmt"
	"go/ast"
	"go/token"
	"go/types"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/midagedev/gadak/internal/archlint"
)

// cyclomaticCeil is the complexity ceiling for one production function in
// internal/sync, counted the gocyclo way (github.com/fzipp/gocyclo): 1 plus
// every if, for and range, every non-default case and comm clause, and every
// && and || — nested func literals included, so a function cannot hide its
// branches inside a closure. That hiding is the incident this gate is for:
// runConfluencePass measured 97 that way at GDK-1920 (+36 in the v0.23 cycle
// alone), five inline closures sharing about twelve captured variables, and
// no gate saw any of it grow.
//
// 2026-09-15 GDK-1920: FAIL-first ran against the pre-decomposition tree
// (runConfluencePass 97 red under this ceiling) before the pass was split
// onto confluencePass methods and needsBody's duplicate halves folded into
// compareChildSet. The ceiling is the worst function that round shipped
// plus 5 of headroom: runConfluencePass 28, reconcileScan 23, needsBody 23
// → 33.
const cyclomaticCeil = 33

// cyclomaticCap is one ratchet entry: a pre-existing function still above
// cyclomaticCeil, held at the value it measured when the gate was pinned.
type cyclomaticCap struct {
	max    int
	reason string
}

// cyclomaticRatchet holds the functions that predate the ceiling. An entry
// is a cap, not a license: growing past max fails, and once a function
// measures at or under cyclomaticCeil the entry is stale and must be
// deleted — the ratchet only tightens. Decomposing a listed function is the
// way off the list; re-pinning a max upward needs a dated reason here.
var cyclomaticRatchet = map[string]cyclomaticCap{
	"internal/sync/sync.go:runJiraPass":     {67, "Jira pass, same closure-web shape the Confluence pass had (GDK-1920 sibling)"},
	"internal/sync/linear.go:runLinearPass": {42, "Linear pass, same closure-web shape (GDK-1920 sibling)"},
	"internal/sync/run.go:runSource":        {34, "shared runSource skeleton — defer bookkeeping plus setup/pass callbacks"},
}

func TestSyncFuncCyclomaticCeiling(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))

	type row struct {
		key string
		loc string
		n   int
	}
	var rows []row
	err := archlint.Walk(root, func(af *archlint.File) error {
		if !strings.HasPrefix(af.Rel, "internal/sync/") || strings.HasSuffix(af.Rel, "_test.go") {
			return nil
		}
		f, fset, err := af.AST()
		if err != nil {
			t.Fatalf("parse %s: %v", af.Rel, err)
		}
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			pos := fset.Position(fd.Pos())
			rows = append(rows, row{
				key: af.Rel + ":" + funcDisplayName(fd),
				loc: af.Rel + ":" + strconv.Itoa(pos.Line),
				n:   cyclomatic(fd),
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	var problems []string
	seen := map[string]bool{}
	for _, r := range rows {
		cap, ok := cyclomaticRatchet[r.key]
		if ok {
			seen[r.key] = true
			if r.n > cap.max {
				problems = append(problems, fmt.Sprintf("%s measures %d, past its ratchet cap %d — decompose or re-pin with a dated reason", r.loc, r.n, cap.max))
			} else if r.n <= cyclomaticCeil {
				problems = append(problems, fmt.Sprintf("ratchet entry %s measures %d, at or under the ceiling %d — delete the entry", r.key, r.n, cyclomaticCeil))
			}
			continue
		}
		if r.n > cyclomaticCeil {
			problems = append(problems, fmt.Sprintf("%s (%s) measures %d, over the ceiling %d", r.key, r.loc, r.n, cyclomaticCeil))
		}
	}
	var gone []string
	for key := range cyclomaticRatchet {
		if !seen[key] {
			gone = append(gone, key)
		}
	}
	if len(gone) > 0 {
		sort.Strings(gone)
		problems = append(problems, "ratchet entries that no longer exist — delete them:\n  "+strings.Join(gone, "\n  "))
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		t.Fatalf("internal/sync cyclomatic ceiling %d:\n  %s", cyclomaticCeil, strings.Join(problems, "\n  "))
	}
}

// funcDisplayName names a function the gocyclo way — "(Recv).Name" for a
// method, plain "Name" otherwise — so ratchet keys read like tool output.
// ExprString renders any receiver shape (value, pointer, generic) without a
// printer.
func funcDisplayName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || fd.Recv.NumFields() == 0 {
		return fd.Name.Name
	}
	return "(" + types.ExprString(fd.Recv.List[0].Type) + ")." + fd.Name.Name
}

// cyclomatic counts one function's complexity, closures included: a branch
// is a branch no matter how deeply it nests, which is what let
// runConfluencePass read as "one function" at 97.
func cyclomatic(fn ast.Node) int {
	n := 1
	ast.Inspect(fn, func(node ast.Node) bool {
		switch v := node.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
			n++
		case *ast.CaseClause:
			if v.List != nil { // default case adds no path
				n++
			}
		case *ast.CommClause:
			if v.Comm != nil { // default case adds no path
				n++
			}
		case *ast.BinaryExpr:
			if v.Op == token.LAND || v.Op == token.LOR {
				n++
			}
		}
		return true
	})
	return n
}
