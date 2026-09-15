#!/usr/bin/env bash
# Does this push change a CI job's build inputs? (GDK-1912)
#
# The staticcheck job's inline gofilter (ci.yml) proved the shape: most pushes
# touch no Go at all, yet every unfiltered tier re-ran — the census measured
# 31 of 127 commits in one cycle touching only CHANGELOG*/CLAUDE.md/docs/specs/
# artifacts/contrib, each billing ~3,201 s of race + browser + mobile +
# desktop compute. This script is that filter, generalized: name a subject,
# get run/skip.
#
# It fails OPEN, and that is the contract (same words as the gofilter): a
# forced push whose before is unreachable, a first push (all-zero before),
# workflow_dispatch, an empty event base, or any diff error runs the job. A
# gate skipped by mistake is the failure mode that matters; a gate run for
# nothing is minutes.
#
# Subject inputs are what the job actually checks out and builds, read off
# .github/workflows/ci.yml — not a guess. Each row cites its evidence:
#
#   go      the race tier compiles ./internal/server/ + ./internal/workspace/
#           from the root module (imports reach the whole tree — GDK-270's
#           leaked goroutine came from an import, not an edit under
#           internal/server): **/*.go, go.mod, go.sum; non-Go bytes Go itself
#           reads at build/test time (internal/ testdata fixtures and the
#           //go:embed json catalogs in internal/config/tokencheck/); tools/
#           (race-partition.sh owns the deal, this filter owns the skip — a
#           change here can rewrite the gate itself); scripts/ and examples/
#           kept from the census's conservative starting table; and
#           .github/workflows/ (the job definitions).
#
#   e2e     e2e/serve.sh — the webServer playwright waits on — builds the
#           gadak binary AND `npm run build` before seeding the committed
#           fixtures: **/*.go, go.mod, go.sum, web/, e2e/, package.json,
#           package-lock.json, examples/ (demo.db + demo-linear.db, GDK-672),
#           tools/ (e2e-partition.sh + this filter), .nvmrc (setup-node),
#           .github/workflows/.
#
#   mobile  mobile/ (own src, e2e, package-lock.json, tauri) plus the two
#           web/src slices it imports (lib/i18n/, lib/terminal/); the root
#           package.json/package-lock.json (Playwright lives at the root);
#           docs/media/logo.png (check-brand-icons.sh diffs the phone icons
#           against the mark); internal/pairing/testdata/ (offer-vectors.json
#           is half
#           of a contract whose other half is Go); **/*.go, go.mod, go.sum
#           (gate-serve.sh builds and runs `gadak demo`); tools/
#           (check-brand-icons.sh + this filter); .nvmrc;
#           .github/workflows/.
#
#   desktop desktop/ (own module, Info.plist, windows-app.manifest, msix/,
#           pack scripts) plus the root module every pack script compiles —
#           build-app.sh / build-linux.sh / build-windows.ps1 each build
#           ./cmd/gadak so dist/app stays embedded: **/*.go, go.mod, go.sum,
#           web/, package.json, package-lock.json; tools/
#           (check-desktop-tidy.sh, windows-manifest.sh, this filter);
#           .nvmrc; .github/workflows/.
#
# Visibility: a filter that never says anything is its own defect, so every
# decision — run or skip — prints one line naming the subject, the verdict,
# and why (how many paths changed, which pattern matched). Those lines are
# what the run ledger reads.
#
# Usage:
#   tools/ci-filter.sh <subject>              CI mode: env EVENT_NAME/BEFORE/
#                                             BASE_SHA/SHA, git fetch+diff
#   tools/ci-filter.sh <subject> --files <f>  decide from a path list (one
#                                             per line; '-' = stdin) — the
#                                             test harness's way in
#
# Output: `run=true|false` on stdout (and into $GITHUB_OUTPUT when set),
#         plus the reason line. Exit 0 for both verdicts, 2 = usage error.
#
# Bash 3.2 on purpose (still the /bin/bash on macOS), same as the scripts
# beside it: no mapfile, no associative arrays.
set -euo pipefail

SELF="ci-filter"

usage() {
  cat >&2 <<'EOF'
usage:
  tools/ci-filter.sh <subject>              subject: go | e2e | mobile | desktop
  tools/ci-filter.sh <subject> --files <f>  decide from a path list ('-' = stdin)
EOF
  exit 2
}

# ── the input tables ────────────────────────────────────────────────────────
# One pattern per line; a changed path matches a subject when it matches any
# line. Three shapes, and only these:
#   dir:<d>/    directory prefix — everything under it
#   suffix:<s>  filename suffix (extension-class matches)
#   exact:<f>   one file (matched against the whole path)
subject_patterns() { # $1 = subject; unknown subject → stderr + exit 2
  case "$1" in
    go)
      cat <<'EOF'
dir:internal/
dir:tools/
dir:scripts/
dir:examples/
dir:.github/workflows/
suffix:.go
exact:go.mod
exact:go.sum
EOF
      ;;
    e2e)
      cat <<'EOF'
dir:web/
dir:e2e/
dir:examples/
dir:tools/
dir:.github/workflows/
suffix:.go
exact:go.mod
exact:go.sum
exact:package.json
exact:package-lock.json
exact:.nvmrc
EOF
      ;;
    mobile)
      cat <<'EOF'
dir:mobile/
dir:web/src/lib/i18n/
dir:web/src/lib/terminal/
exact:docs/media/logo.png
dir:internal/pairing/testdata/
dir:tools/
dir:.github/workflows/
suffix:.go
exact:go.mod
exact:go.sum
exact:package.json
exact:package-lock.json
exact:.nvmrc
EOF
      ;;
    desktop)
      cat <<'EOF'
dir:desktop/
dir:web/
dir:tools/
dir:.github/workflows/
suffix:.go
exact:go.mod
exact:go.sum
exact:package.json
exact:package-lock.json
exact:.nvmrc
EOF
      ;;
    *)
      echo "$SELF: unknown subject '$1' (go | e2e | mobile | desktop)" >&2
      exit 2
      ;;
  esac
}

# Does one changed path match one pattern? [[ == ]] is a glob match, and the
# trailing '/' in a dir: pattern keeps dir:web/ from matching a top-level
# file named web-thing. Runs once per (path, pattern) and diff lists are
# short, so no subshell per path.
pat_match() { # $1 = pattern, $2 = path
  case "$1" in
    'dir:'*) [[ "$2" == "${1#dir:}"* ]] ;;
    'suffix:'*) [[ "$2" == *"${1#suffix:}" ]] ;;
    'exact:'*) [[ "$2" == "${1#exact:}" ]] ;;
    *) return 1 ;;
  esac
}

verdict() { # $1 = run|skip, $2 = reason; $subject comes from the caller
  local out
  if [[ "$1" = run ]]; then out=true; else out=false; fi
  echo "run=$out"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'run=%s\n' "$out" >> "$GITHUB_OUTPUT"
  fi
  echo "$SELF: $subject: $1 — $2"
}

# ── the verdict from a path list ────────────────────────────────────────────
# Changed paths on stdin, one per line. Never fails: an empty list is a
# decision (skip — nothing changed), and the CI-mode callers have already
# failed open on every error path before getting here.
decide() { # $1 = subject
  local subject="$1" path p n=0 hit="" first_hit=""
  local pats
  pats=""
  pats="$(subject_patterns "$subject")"
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    n=$((n + 1))
    if [[ -z "$first_hit" ]]; then
      while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        if pat_match "$p" "$path"; then
          first_hit="$p matched $path"
          break
        fi
      done <<<"$pats"
    fi
  done
  if [[ -n "$first_hit" ]]; then
    verdict run "$n changed path(s); $first_hit"
  else
    verdict skip "$n changed path(s); none touch $subject inputs"
  fi
}

# ── argument parsing ────────────────────────────────────────────────────────
[[ $# -ge 1 ]] || usage
subject="$1"
shift
[[ "$subject" != -* ]] || usage
subject_patterns "$subject" >/dev/null # validates the subject (exits 2 if unknown)

files_from=""
if [[ $# -gt 0 ]]; then
  [[ "$1" = "--files" && $# -eq 2 ]] || usage
  files_from="$2"
fi

# ── mode: explicit path list (the test harness) ─────────────────────────────
if [[ -n "$files_from" ]]; then
  if [[ "$files_from" = "-" ]]; then
    decide "$subject"
  else
    [[ -f "$files_from" ]] || {
      echo "$SELF: no such file: $files_from" >&2
      exit 2
    }
    decide "$subject" < "$files_from"
  fi
  exit 0
fi

# ── mode: CI — the same base resolution and fail-open ladder as the gofilter
EVENT_NAME="${EVENT_NAME:-}"
BEFORE="${BEFORE:-}"
BASE_SHA="${BASE_SHA:-}"
SHA="${SHA:-}"

case "$EVENT_NAME" in
  pull_request) base="$BASE_SHA" ;;
  push) base="$BEFORE" ;;
  *)
    verdict run "event '$EVENT_NAME' has no before — fail open"
    exit 0
    ;;
esac
if [[ -z "$base" ]] || printf '%s' "$base" | grep -Eq '^0+$'; then
  verdict run "no usable base sha (first push, forced push, or tag push) — fail open"
  exit 0
fi
if ! git fetch --no-tags --depth=1 origin "$base" 2>/dev/null; then
  verdict run "base $base not fetchable — fail open"
  exit 0
fi
if ! changed="$(git diff --name-only "$base" "$SHA")"; then
  verdict run "git diff failed — fail open"
  exit 0
fi
decide "$subject" <<<"$changed"
