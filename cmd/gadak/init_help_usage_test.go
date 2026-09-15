package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
)

// `gadak init` documents every flag twice: the FlagSet registration in
// cmdInit (what `gadak init --help` renders through VisitAll) and the manual
// options list on helps["init"] (what `gadak help init` renders). The two
// were hand-kept copies that could drift — --token's "not accepted; use
// GADAK_TOKEN…" existed verbatim in both with nothing comparing them
// (GDK-1922 ⑦). Both surfaces now read the initUsage* constants; this test
// is the comparison. It parses the real registrations out of cmdInit instead
// of rebuilding a lookalike FlagSet, so a usage the constants do not reach
// fails here. FAIL-first verified in the round that added it: one
// deliberately corrupted desc went red, then green on restore.
//
// The contract is prefix-shaped, not equality: the helps entry may append a
// qualifier the one-line flag form omits — site, email, projects add
// "; env …", spaces adds "; omit to leave unchanged". Two pairing flags
// diverge past a shared head on purpose (the helps entries say what the
// offer binds and name the secret); those are held to the head constant
// only.
//
// Coverage gap, deliberate: cmdInit registers --server, but helps["init"]'s
// options list has never listed it (it shipped with GDK-1635 that way;
// initHelpUnlistedFlags holds the exemption). Adding the row would change
// `gadak help init` output, which the GDK-1922 ⑦ round is forbidden to do.

// initHelpUnlistedFlags are cmdInit registrations helps["init"].options
// carries no row for. A flag joining this table needs a reason the way
// server's does — and that reason cannot be "nobody noticed".
var initHelpUnlistedFlags = map[string]string{
	// server joined the list the commit after this gate landed (GDK-1922);
	// the table is empty on purpose and stays as the place a reason goes.
}

func TestInitHelpOptionsMatchFlagSetUsage(t *testing.T) {
	consts := map[string]string{}
	var cmdInit *ast.FuncDecl
	for _, name := range []string{"init.go", "help.go"} {
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.GenDecl:
				if d.Tok != token.CONST {
					continue
				}
				for _, spec := range d.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, id := range vs.Names {
						if i < len(vs.Values) {
							if s, ok := evalStringExpr(vs.Values[i], consts); ok {
								consts[id.Name] = s
							}
						}
					}
				}
			case *ast.FuncDecl:
				if d.Name.Name == "cmdInit" {
					cmdInit = d
				}
			}
		}
	}
	if cmdInit == nil {
		t.Fatal("cmdInit not found in init.go — update this gate if the function was renamed")
	}

	registered := map[string]bool{}
	usage := map[string]string{}
	ast.Inspect(cmdInit.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		recv, ok := sel.X.(*ast.Ident)
		if !ok || recv.Name != "fs" || (sel.Sel.Name != "String" && sel.Sel.Name != "Bool") {
			return true
		}
		if len(call.Args) != 3 {
			return true
		}
		nameLit, ok := call.Args[0].(*ast.BasicLit)
		if !ok || nameLit.Kind != token.STRING {
			return true
		}
		flagName, err := strconv.Unquote(nameLit.Value)
		if err != nil {
			return true
		}
		registered[flagName] = true
		if s, ok := evalStringExpr(call.Args[2], consts); ok {
			usage[flagName] = s
		}
		return true
	})

	// Heads the two pairing flags share; their tails diverge on purpose.
	pairHeads := map[string]string{
		"pairing-code":       initUsagePairingCode,
		"pairing-code-stdin": initUsagePairingCodeStdin,
	}

	for _, opt := range helps["init"].options {
		if !registered[opt.name] {
			t.Errorf("helps[\"init\"] lists --%s, but cmdInit registers no such flag", opt.name)
			continue
		}
		u, ok := usage[opt.name]
		if !ok {
			t.Errorf("--%s: the FlagSet usage is not a plain string expression (constant or literal, possibly + concatenated); this drift test cannot read it", opt.name)
			continue
		}
		if head, exempt := pairHeads[opt.name]; exempt {
			if !strings.HasPrefix(u, head) || !strings.HasPrefix(opt.desc, head) {
				t.Errorf("--%s drifted from its shared head %q:\n  FlagSet: %q\n  helps:   %q", opt.name, head, u, opt.desc)
			}
			continue
		}
		if u == "" {
			t.Errorf("--%s: the FlagSet usage evaluated empty — the prefix comparison would pass vacuously", opt.name)
			continue
		}
		if !strings.HasPrefix(opt.desc, u) {
			t.Errorf("--%s desc drifted from the FlagSet usage (GDK-1922 ⑦):\n  FlagSet: %q\n  helps:   %q\nthe helps entry may append a qualifier (\"; env …\") but must start with the shared sentence; both surfaces should read one initUsage* constant", opt.name, u, opt.desc)
		}
	}

	for name := range registered {
		listed := false
		for _, opt := range helps["init"].options {
			if opt.name == name {
				listed = true
				break
			}
		}
		if !listed && initHelpUnlistedFlags[name] == "" {
			t.Errorf("cmdInit registers --%s but helps[\"init\"].options has no row for it — a flag documented on one surface only is the drift this gate exists for", name)
		}
	}
}

// evalStringExpr evaluates the string expressions flag usages are built
// from: a string literal, a package-level string constant already collected,
// or a + concatenation of those. Anything else (a function call, a non-string
// constant) is reported as unevaluable rather than guessed at.
func evalStringExpr(e ast.Expr, consts map[string]string) (string, bool) {
	switch e := e.(type) {
	case *ast.BasicLit:
		if e.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(e.Value)
		if err != nil {
			return "", false
		}
		return s, true
	case *ast.Ident:
		if v, ok := consts[e.Name]; ok {
			return v, true
		}
		return "", false
	case *ast.BinaryExpr:
		if e.Op != token.ADD {
			return "", false
		}
		lhs, ok := evalStringExpr(e.X, consts)
		if !ok {
			return "", false
		}
		rhs, ok := evalStringExpr(e.Y, consts)
		if !ok {
			return "", false
		}
		return lhs + rhs, true
	}
	return "", false
}
