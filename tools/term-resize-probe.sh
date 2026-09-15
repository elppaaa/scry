#!/usr/bin/env bash
# The GDK-1192 runner: drives internal/term's TestResizeRevertProbe across a
# shell × child-poll matrix, optionally under background load, and collects
# the numbers the instrument emits.
#
# A revert is a measurement, not a failure: this script exits 0 whether or
# not anything reverted. It exits non-zero only when a cell's go test itself
# errored (harness failure — create/attach/resize).
#
# Usage:
#   bash tools/term-resize-probe.sh [--load] [--runs N] [--window 30s] [--out DIR]
#
#   --load    start two background go test loops (the recipe that reproduced
#             the flake was other Go test trees on the same machine)
#   --runs    probe runs per cell (default 5)
#   --window  how long each run watches the master (default 30s)
#   --out     output directory (default scratch/resize-probe/<timestamp>/)
#
# No set -e on purpose: a cell that errors is recorded and the matrix goes
# on, so one bad cell cannot cost the whole run's evidence.
set -u

runs=5
window=30s
load=0
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --load) load=1; shift ;;
    --runs)
      [ $# -ge 2 ] || { echo "--runs needs a value" >&2; exit 64; }
      runs=$2; shift 2 ;;
    --window)
      [ $# -ge 2 ] || { echo "--window needs a value" >&2; exit 64; }
      window=$2; shift 2 ;;
    --out)
      [ $# -ge 2 ] || { echo "--out needs a value" >&2; exit 64; }
      out=$2; shift 2 ;;
    *)
      echo "usage: $0 [--load] [--runs N] [--window 30s] [--out DIR]" >&2
      exit 64 ;;
  esac
done

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$root" || exit 1
command -v go >/dev/null 2>&1 || { echo "go is not on PATH" >&2; exit 1; }

[ -n "$out" ] || out="scratch/resize-probe/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"

# --- load: two background go test loops -------------------------------------
# Each loop is a subshell that re-runs `go test -count=3` over the tree's
# SQLite-hammering packages until killed. The pid in load-<i>.pid is the
# subshell's, taken from $! — the only pid we may signal (a pgrep -f pattern
# matches this script's own command line; /proc-style walks find our own
# ssh and shell). The subshell's TERM trap kills its in-flight go test, so
# killing the pid stops the whole loop.
loadpids=""
start_load() {
  i=1
  while [ "$i" -le 2 ]; do
    (
      child=0
      trap 'kill "$child" 2>/dev/null; exit 0' TERM INT
      while :; do
        go test -count=3 ./internal/sync/ ./internal/store/ ./internal/server/ >/dev/null 2>&1 &
        child=$!
        wait "$child"
      done
    ) &
    echo $! >"$out/load-$i.pid"
    i=$((i + 1))
  done
  loadpids=$(cat "$out"/load-*.pid | tr '\n' ' ')
}

stop_load() {
  # Idempotent: the EXIT trap calls this again after an explicit stop.
  [ -z "$loadpids" ] && return 0
  for p in $loadpids; do
    kill "$p" 2>/dev/null
  done
  # Bounded wait on exactly the pids we started, by pid — never a
  # `until ! pgrep -f` loop (that matches this script's own shell).
  i=0
  while [ "$i" -lt 100 ]; do
    alive=0
    for p in $loadpids; do
      kill -0 "$p" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 0 ] && break
    i=$((i + 1))
    sleep 0.2
  done
  if [ "$alive" -eq 1 ]; then
    echo "warning: load processes still alive after 20s: $loadpids" >&2
  fi
  loadpids=""
}
trap 'stop_load' EXIT
trap 'stop_load; exit 129' INT TERM

# --- witness: what else the machine was doing --------------------------------
# macOS has no /proc; the load witness is sysctl -n vm.loadavg plus ps on
# the load pids themselves, recorded around every cell.
witness() { # <cell> <start|end>
  cell=$1
  phase=$2
  w="$out/witness-$cell-$phase.txt"
  {
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "loadavg: $(sysctl -n vm.loadavg 2>/dev/null || echo unavailable)"
    if [ -n "$loadpids" ]; then
      p="${loadpids% }"
      p="${p// /,}"
      ps -o pid,%cpu,command -p "$p" 2>/dev/null
    else
      echo "ps: no load processes (quiet run)"
    fi
  } >"$w"
}

mode=$([ "$load" -eq 1 ] && echo "loaded" || echo "quiet")
if [ "$load" -eq 1 ]; then
  start_load
  echo "load started: $loadpids"
fi

# --- README (after load start, so it can name the load pids) ------------------
{
  echo "GDK-1192 resize-revert probe"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)  host: $(hostname -s)  mode: $mode"
  echo "matrix: '/bin/sh /bin/bash /bin/zsh' x child-poll '1 0'  runs per cell: $runs  window: $window  go: $(go version)"
  echo "load witness: sysctl -n vm.loadavg AND ps -o pid,%cpu,command -p <load pids>, recorded per cell in witness-<cell>-{start,end}.txt"
  if [ -n "$loadpids" ]; then
    echo "load pids: $loadpids"
  fi
} >"$out/README.txt"

{
  echo "# GDK-1192 resize-revert probe — $mode run"
  echo
  echo "- date: $(date -u +%Y-%m-%dT%H:%M:%SZ), host: $(hostname -s)"
  echo "- runs per cell: $runs, window: $window, go: $(go version)"
  echo "- load: $mode$([ "$load" -eq 1 ] && echo ", two go test loops (pids in README.txt)" || echo "")"
  echo
  echo "| shell | childpoll | load | runs | reverts | median revert_at_ms | last_resize_exit |"
  echo "|---|---|---|---|---|---|---|"
} >"$out/SUMMARY.md"

# --- matrix --------------------------------------------------------------------
errors=0
for shell in /bin/sh /bin/bash /bin/zsh; do
  if [ ! -x "$shell" ]; then
    echo "skip $shell: not present on this machine"
    continue
  fi
  base=$(basename "$shell")
  for poll in 1 0; do
    cell="$base-poll$poll"
    log="$out/$cell.log"
    echo "cell $cell: starting $(date -u +%H:%M:%S)"
    witness "$cell" start
    GADAK_RESIZE_PROBE=1 \
      GADAK_RESIZE_PROBE_SHELL="$shell" \
      GADAK_RESIZE_PROBE_CHILD_POLL=$poll \
      GADAK_RESIZE_PROBE_RUNS=$runs \
      GADAK_RESIZE_PROBE_WINDOW=$window \
      go test ./internal/term/ -run TestResizeRevertProbe -count=1 -v >"$log" 2>&1
    rc=$?
    witness "$cell" end
    echo "cell $cell: go test exit $rc $(date -u +%H:%M:%S)"
    if [ "$rc" -ne 0 ]; then
      errors=$((errors + 1))
      echo "cell $cell: go test errored (exit $rc); log: $log" >&2
    fi

    # Parse the cell's numbers from the captured log — never from a pipe.
    sum=$(grep -m1 'probe summary' "$log")
    cellruns=$(printf '%s\n' "$sum" | sed -n 's/.*runs=\([0-9]*\).*/\1/p')
    cellrev=$(printf '%s\n' "$sum" | sed -n 's/.*reverts=\([0-9]*\).*/\1/p')
    [ -n "$cellruns" ] || cellruns=err
    [ -n "$cellrev" ] || cellrev=err
    median=$(grep -oE 'revert_at_ms=-?[0-9]+' "$log" | cut -d= -f2 \
      | awk '$1>=0' | sort -n \
      | awk '{a[NR]=$1} END { if (NR==0) print "-"; else if (NR%2==1) print a[(NR+1)/2]; else print (a[NR/2]+a[NR/2+1])/2 }')
    exits=$(grep -oE 'exit=[^ ]+' "$log" | sed 's/^exit=//' | sort -u \
      | awk 'NR>1{printf ","} {printf "%s",$0}')
    [ -n "$exits" ] || exits=-
    la=$(sed -n 's/^loadavg: //p' "$out/witness-$cell-start.txt")
    [ -n "$la" ] || la=unavailable
    if [ -n "$loadpids" ]; then
      loadcell="yes ($la)"
    else
      loadcell="no"
    fi
    echo "| $shell | $poll | $loadcell | $cellruns | $cellrev | $median | $exits |" >>"$out/SUMMARY.md"
  done
done

if [ "$load" -eq 1 ]; then
  stop_load
  echo "load stopped"
fi

echo "summary: $out/SUMMARY.md"
if [ "$errors" -gt 0 ]; then
  echo "$errors cell(s) had a go test error" >&2
  exit 1
fi
exit 0
