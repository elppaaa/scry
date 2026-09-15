//go:build !windows

package term

// The GDK-1192 instrument: catch the pty size reverting after a resize the
// session believed it applied, and pin down the two open axes — WHEN it
// reverts (immediately after the set, or later, e.g. after the child next
// touches the tty) and WHO (the child shell, or the kernel/pty layer).
//
// This is a probe, not a contract: a revert is the measurement, so the test
// never fails on one. It fails only when its own harness breaks (create,
// attach, resize). The runner that drives it across the shell × child-poll
// matrix, with and without background load, is tools/term-resize-probe.sh.
//
// Env knobs (all set by the runner, none by `go test` alone):
//
//	GADAK_RESIZE_PROBE=1          the on-switch; without it this skips
//	GADAK_RESIZE_PROBE_SHELL      which shell to run (default /bin/sh)
//	GADAK_RESIZE_PROBE_CHILD_POLL 1 to poll `stty size` every 2s the way the
//	                              desktop stream test does, 0 to leave the
//	                              child untouched after the resize
//	GADAK_RESIZE_PROBE_RUNS       runs (default 5)
//	GADAK_RESIZE_PROBE_WINDOW     how long each run watches the master
//	                              (default 30s)

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestResizeRevertProbe(t *testing.T) {
	if os.Getenv("GADAK_RESIZE_PROBE") != "1" {
		t.Skip("resize-revert probe is an on-demand instrument; set GADAK_RESIZE_PROBE=1")
	}

	shell := os.Getenv("GADAK_RESIZE_PROBE_SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	// Default on: the desktop flake always had the child being polled, so
	// that mode is the reproduction; poll=0 isolates the kernel axis.
	childPoll := os.Getenv("GADAK_RESIZE_PROBE_CHILD_POLL") != "0"
	if childPoll {
		if _, err := exec.LookPath("stty"); err != nil {
			t.Skipf("stty not found: child polling cannot run: %v", err)
		}
	}
	runs := 5
	if v := os.Getenv("GADAK_RESIZE_PROBE_RUNS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			t.Fatalf("bad GADAK_RESIZE_PROBE_RUNS %q", v)
		}
		runs = n
	}
	window := 30 * time.Second
	if v := os.Getenv("GADAK_RESIZE_PROBE_WINDOW"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			t.Fatalf("bad GADAK_RESIZE_PROBE_WINDOW %q", v)
		}
		window = d
	}

	reverts := 0
	for run := 1; run <= runs; run++ {
		res := probeRunOnce(t, run, shell, childPoll, window)
		if res.reverted {
			reverts++
		}
	}
	t.Logf("probe summary shell=%s childpoll=%v runs=%d reverts=%d", shell, childPoll, runs, reverts)
}

// probeResult is one run of the instrument.
type probeResult struct {
	run        int
	exit       string // Info().LastResizeExit right after the resize
	reverted   bool
	revertAtMs int64 // -1: the window passed with no revert
	revertCols int   // what the master read at the revert
	revertRows int
	polled     bool // a child poll landed between the resize and the revert
	ps         string
	post100    string // master size 100ms after the revert
	lastBefore string // child's last `stty size` answer before the revert
	firstAfter string // child's first answer after it
}

// probeAnswer is one `stty size` answer read back from the child.
type probeAnswer struct {
	at   time.Time
	size string // "ROWS COLS", the child's own words
}

// probeRunOnce is one create → attach → resize → watch cycle. It returns
// the measurement; it never fails the test on what the pty did.
func probeRunOnce(t *testing.T, run int, shell string, childPoll bool, window time.Duration) probeResult {
	t.Helper()
	m := testManager(t, Config{})
	s := shellSession(t, m, Options{Shell: shell, Cols: 80, Rows: 24})
	a, err := s.Attach()
	if err != nil {
		t.Fatalf("run %d: attach: %v", run, err)
	}
	res := probeResult{run: run, revertAtMs: -1}
	defer func() {
		// The machine-readable line, on every path out of the run.
		t.Logf("probe run=%d shell=%s childpoll=%v exit=%s revert_at_ms=%d reverted_to=%dx%d child_polled_before_revert=%v ps=%q",
			res.run, shell, childPoll, res.exit, res.revertAtMs, res.revertCols, res.revertRows, res.polled, res.ps)
		if res.reverted {
			t.Logf("probe run=%d detail post100=%s child_last_before=%q child_first_after=%q",
				res.run, res.post100, res.lastBefore, res.firstAfter)
		}
		_ = s.Close()
	}()

	// Wait for the shell's first prompt: read until a byte arrives, then
	// 300ms more so the prompt is whole before the resize races it.
	if !probeWaitFirstOutput(t, run, a) {
		return res
	}
	rd := &probeReader{a: a}

	resizeStart := time.Now()
	if err := s.Resize(132, 43); err != nil {
		t.Fatalf("run %d: resize: %v", run, err)
	}
	res.exit = s.Info().LastResizeExit
	if !strings.HasPrefix(res.exit, "matched") {
		t.Logf("probe run=%d finding: LastResizeExit=%q does not start with matched — harness finding, not a failure", run, res.exit)
	}

	// Child polls: one immediately (the answer nearest the resize), then
	// every 2s, the desktop stream test's cadence. Timestamped so a revert
	// can be placed before or after its nearest poll.
	var polls []time.Time
	poll := func() {
		if _, err := s.Write([]byte("stty size\n")); err != nil {
			t.Logf("probe run=%d finding: child poll write failed: %v", run, err)
		}
		polls = append(polls, time.Now())
	}
	if childPoll {
		poll()
	}

	master := time.NewTicker(100 * time.Millisecond)
	defer master.Stop()
	var childC <-chan time.Time
	if childPoll {
		child := time.NewTicker(2 * time.Second)
		defer child.Stop()
		childC = child.C
	}
	deadline := time.After(window)

	for {
		select {
		case <-a.Wake():
			rd.drain()
		case <-a.Done():
			t.Logf("probe run=%d finding: the shell's output stream ended (%+v) mid-window — recorded as no-revert", run, a.End())
			return res
		case <-master.C:
			cols, rows, err := s.TTYSize()
			if err != nil {
				t.Logf("probe run=%d finding: TTYSize failed mid-window: %v — recorded as no-revert", run, err)
				return res
			}
			if cols != 132 || rows != 43 {
				probeRevert(t, s, a, rd, &res, resizeStart, time.Now(), int(cols), int(rows), polls, childPoll)
				return res
			}
		case <-childC:
			poll()
		case <-deadline:
			return res // window passed, size held
		}
	}
}

// probeWaitFirstOutput reads until the attachment yields its first byte,
// then gives the shell 300ms to finish drawing and drains. False means the
// run is over without a prompt (already logged).
func probeWaitFirstOutput(t *testing.T, run int, a *Attachment) bool {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case <-a.Wake():
			_ = a.Take()
			time.Sleep(300 * time.Millisecond)
			_ = a.Take()
			return true
		case <-a.Done():
			t.Logf("probe run=%d finding: the shell ended before its first output (%+v)", run, a.End())
			return false
		case <-deadline:
			t.Logf("probe run=%d finding: no output within 10s — the shell never drew a prompt", run)
			return false
		}
	}
}

// probeRevert is the instant a revert is caught: capture the child, the
// master's answer 100ms later, and — with polling on — the child's own
// last answer before and first answer after. These four together are the
// who/when evidence: a child that answers 43 132 while the master reads
// 80x24 did not do the reverting.
func probeRevert(t *testing.T, s *Session, a *Attachment, rd *probeReader, res *probeResult,
	resizeStart, at time.Time, cols, rows int, polls []time.Time, childPoll bool) {
	t.Helper()
	res.reverted = true
	res.revertAtMs = at.Sub(resizeStart).Milliseconds()
	res.revertCols, res.revertRows = cols, rows
	for _, p := range polls {
		if p.After(resizeStart) && !p.After(at) {
			res.polled = true
		}
	}
	info := s.Info()
	res.ps = probePS(info.PID)
	if childPoll {
		if _, err := s.Write([]byte("stty size\n")); err != nil {
			t.Logf("probe run=%d finding: post-revert poll write failed: %v", res.run, err)
		}
	}
	time.Sleep(100 * time.Millisecond)
	if c2, r2, err := s.TTYSize(); err != nil {
		res.post100 = fmt.Sprintf("err %v", err)
	} else {
		res.post100 = fmt.Sprintf("%dx%d", c2, r2)
	}
	if childPoll {
		// The answer to the poll written at the revert instant — the
		// child's first word on a tty the kernel says shrank.
		answerDeadline := time.After(3 * time.Second)
	waitAnswer:
		for {
			select {
			case <-a.Wake():
				rd.drain()
				for _, an := range rd.ans {
					if an.at.After(at) {
						break waitAnswer
					}
				}
			case <-answerDeadline:
				break waitAnswer
			}
		}
	}
	for i := len(rd.ans) - 1; i >= 0; i-- {
		if !rd.ans[i].at.After(at) {
			res.lastBefore = rd.ans[i].size
			break
		}
	}
	for _, an := range rd.ans {
		if an.at.After(at) {
			res.firstAfter = an.size
			break
		}
	}
}

// probePS snapshots the shell at the revert instant: state (S sleeping, R
// running), wchan — what the kernel says it is waiting on — and the
// command, so a wrapper or a respawned shell cannot hide.
func probePS(pid int) string {
	if pid <= 0 {
		return ""
	}
	out, err := exec.Command("ps", "-o", "pid,stat,wchan,command", "-p", strconv.Itoa(pid)).CombinedOutput()
	if err != nil {
		return fmt.Sprintf("ps error: %v", err)
	}
	return string(out)
}

// probeReader drains the attachment and keeps the child's `stty size`
// answers with the moment each was read.
type probeReader struct {
	a    *Attachment
	buf  []byte
	scan int
	ans  []probeAnswer
}

// drain takes everything pending. Take-based, not Wake-based: a select on
// Wake here would consume the very token the caller's select just consumed
// to get here, hit default, and return with the bytes still pending — the
// Wake channel is the prompt, Take is the truth.
func (r *probeReader) drain() {
	for {
		b := r.a.Take()
		if len(b) == 0 {
			return
		}
		r.buf = append(r.buf, b...)
		r.parse()
	}
}

// parse consumes complete lines, keeping those that are exactly two
// integer fields — the shape `stty size` answers with. A prompt or the
// echoed command never matches fully (a worktree path has digits, but not
// digits-space-digits alone on a line), so no answer is invented.
func (r *probeReader) parse() {
	for r.scan < len(r.buf) {
		i := bytes.IndexByte(r.buf[r.scan:], '\n')
		if i < 0 {
			break
		}
		line := strings.TrimSpace(string(r.buf[r.scan : r.scan+i]))
		r.scan += i + 1
		if f := strings.Fields(line); len(f) == 2 {
			if _, err := strconv.Atoi(f[0]); err == nil {
				if _, err := strconv.Atoi(f[1]); err == nil {
					r.ans = append(r.ans, probeAnswer{at: time.Now(), size: f[0] + " " + f[1]})
				}
			}
		}
	}
	// Bound the buffer: only complete lines are ever behind the scan
	// offset, so dropping them loses nothing.
	if r.scan > 1<<16 {
		r.buf = append([]byte{}, r.buf[r.scan:]...)
		r.scan = 0
	}
}
