//go:build sourcelint

// Repo-wide text gate (GDK-1906): lives behind the sourcelint tag so the
// default `go test ./...` never pays the whole-tree walk. Run with
// `bash tools/sourcelint.sh` — CI's Go-tests step runs exactly that.

package store

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// TestLocalClassTablesAreNamedQualified is the half TestMirrorSchemaHasNo-
// LocalOrAuthoredTables does not see. That gate reads which file CREATEs a
// table; this one reads which file the SQL then talks to.
//
// The two are different failures and the second one actually happened. When
// api_usage moved to local.db, every read and write in internal/store followed
// it — and `e2e/serve.sh` kept seeding `INSERT INTO api_usage`, unqualified.
// SQLite resolved that against main, so the seed landed in the mirror's frozen
// leftover, the settings panel read an empty local.api_usage, and one
// Playwright spec went red with nothing in the Go tree to explain it. A copy
// migration leaves the old table in place on purpose (the crash window), which
// is exactly what makes an unqualified name keep working while meaning the
// wrong file.
//
// So: SQL that names a scopeLocal or scopeAuthored table must say `local.`.
// The rule is deliberately narrow — only the four positions where a name is a
// table reference (FROM / JOIN / INTO / UPDATE), so JSON keys, doc comments,
// Go identifiers and error strings that merely mention a table are not
// matched. It reads text rather than SQL because the writers are not all Go:
// the one that broke was a shell heredoc.
//
// FAIL-first, measured 2026-09-16 against e2e/serve.sh before the seed moved:
//
//	e2e/serve.sh:290: `INTO api_usage`
//	without the `local.` schema — SQLite resolves it against the mirror
func TestLocalClassTablesAreNamedQualified(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))

	// The tables whose home is local.db. Read from originScopedTables rather
	// than listed here, so adding a scopeLocal table cannot forget this gate.
	var names []string
	for _, r := range originScopedTables {
		if r.scope == scopeLocal || r.scope == scopeAuthored {
			names = append(names, regexp.QuoteMeta(r.table))
		}
	}
	if len(names) == 0 {
		t.Fatal("originScopedTables has no local- or authored-class rows")
	}
	// Uppercase only, and that is the discriminator rather than a style
	// preference: every SQL statement in this repo's .sh/.sql/.go writes its
	// verbs uppercase (checked 2026-09-16 — a lowercase `^\s*(insert|select|
	// update|delete)\s` sweep of e2e/ and tools/ finds none), while English
	// prose about these tables writes "read into sessions" and "renders from
	// api_usage" in lower case. Matching case-insensitively turned a gate with
	// one real finding into one with ten, nine of them doc comments — and a
	// gate you have to squint past is a gate you stop reading. The cost is
	// honest: lowercase SQL slips through, and that is the trade.
	ref := regexp.MustCompile(`\b(FROM|JOIN|INTO|UPDATE)\s+(` + strings.Join(names, "|") + `)\b`)
	// `sqlite3 <file>` — the capture is the argument, so the walk below knows
	// which database the statements that follow are aimed at.
	sqliteTarget := regexp.MustCompile(`sqlite3\s+("[^"]+"|'[^']+'|\S+)`)

	// Files that legitimately name the mirror side.
	exempt := func(rel string) bool {
		switch {
		case strings.HasPrefix(rel, "internal/store/schema.go"):
			// The copy migrations read the mirror's own rows by definition.
			return true
		case strings.HasPrefix(rel, "internal/store/local"), strings.HasPrefix(rel, "tools/seed-local/"):
			// These run against a connection whose main IS local.db (see
			// seed.py's sqlite3.connect(local_path)), so unqualified is not
			// just allowed there, it is the correct form.
			return true
		case strings.HasPrefix(rel, "internal/snapshot/"):
			// The portable snapshot strips these from a copy of the mirror —
			// it is scrubbing the frozen leftover, not reading live state.
			return true
		case strings.Contains(rel, "_test.go"):
			// Tests assert on both sides on purpose (the upgrade tests read
			// the mirror row to prove the copy left it behind).
			return true
		}
		return false
	}

	var bad []string
	walk := func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Same skip list as internal/archlint: every dot-prefixed
			// directory (.git, .claude agent worktrees — whole stale copies
			// of the tree that made this gate red locally on 2026-09-16
			// while CI, which has none, was green), plus the build,
			// dependency and scratch trees.
			if strings.HasPrefix(d.Name(), ".") && path != root {
				return filepath.SkipDir
			}
			switch d.Name() {
			case "node_modules", "dist", "test-results", "scratch", "artifacts":
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".go", ".sh", ".py", ".sql", ".ts":
		default:
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || exempt(rel) {
			return nil
		}
		src, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil
		}
		// Which database the statements below are talking to. A shell script
		// hands sqlite3 a file and then feeds it a heredoc, so the target sits
		// lines above the statement — checking only the matched line said
		// `INTO api_usage` was wrong in a block already aimed at local.db.
		onLocal := false
		for i, line := range strings.Split(string(src), "\n") {
			if m := sqliteTarget.FindStringSubmatch(line); m != nil {
				onLocal = strings.Contains(m[1], "local.db")
			}
			m := ref.FindStringSubmatch(line)
			if m == nil || onLocal {
				continue
			}
			// `FROM local.x` is the correct form; the regex matches from the
			// verb and so cannot see the prefix, hence the explicit look.
			if strings.Contains(line, "local."+m[2]) {
				continue
			}
			bad = append(bad, fmt.Sprintf("%s:%d: `%s`", rel, i+1, strings.TrimSpace(m[0])))
		}
		return nil
	}
	if err := filepath.WalkDir(root, walk); err != nil {
		t.Fatal(err)
	}
	if len(bad) > 0 {
		t.Errorf("SQL names a local- or authored-class table without the `local.` schema,\n"+
			"so SQLite resolves it against the mirror — where a copy migration's frozen\n"+
			"leftover makes it keep working while meaning the wrong file (GDK-1906):\n  %s",
			strings.Join(bad, "\n  "))
	}
}
