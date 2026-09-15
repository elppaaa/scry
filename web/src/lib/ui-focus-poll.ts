/*
 * The root shell's 500ms UI-focus poll (GDK-1926): one cadence, three jobs.
 * This used to live inline in App.svelte's onMount — a ~93-line callback the
 * no-component-interval sweep could not see, because the sweep named trees
 * and the root shell was in none of them. A data poll owns its cadence (the
 * clock module's rule), and this poll's honest home is a lib module the way
 * lib/clock.svelte.ts owns the wall tick.
 *
 * Each tick fetches ui-focus/ once and feeds three jobs, in order:
 *   reapplyRemoteConfig  — GDK-791, settings written elsewhere
 *   pullMirrorDelta      — GDK-1170, the mirror moved under this tab
 *   applyViewsFocus      — GDK-960, a `views open` focus hash
 * plus one explicit passenger, dashboards.checkVersion() (GDK-793). The
 * interval runs only while the tab is visible (visibilitychange starts and
 * stops it) and paints its state on <html data-ui-focus-poll>.
 */

import { pollUIFocus } from './api'
import { isHostedDemo, loadConfig } from './config'
import { pushHash } from './router.svelte'
import { showIssueList } from './show-issue-list'
import { parseView } from './view-config'
import { COLUMN_PARAM } from './place-dimension'
import {
  FOCUS_POLL_MS,
  decideMirrorPull,
  readLastFocusKey,
  rememberFocusKey,
  shouldApplyUIFocus,
  uiFocusKey,
} from './ui-focus'
import { applyUserTokens } from './user-tokens'
import { terminalSessions } from './terminal/sessions.svelte'
import { issues } from '../stores/issues.svelte'
import { filters } from '../stores/filters.svelte'
import { dashboards } from '../stores/dashboards.svelte'

/** The poll's cadence, re-exported for callers that already import this
 *  module; its owner is the leaf ui-focus.ts, which a node-side spec can
 *  import (GDK-1924). */
export { FOCUS_POLL_MS }

type FocusPoll = Awaited<ReturnType<typeof pollUIFocus>>

// configVersion this tab last saw (null = no baseline yet). See
// reapplyRemoteConfig.
let lastConfigVersion: string | null = null
// mirrorVersion this tab last pulled for (null = no baseline yet), and
// whether that pull is still in flight. See pullMirrorDelta.
let lastMirrorVersion: string | null = null
let mirrorPulling = false
// (at, hash) of the last applied focus payload. See applyViewsFocus.
let lastFocusKey: string | null = null

let focusTimer: ReturnType<typeof setInterval> | null = null

const markFocusPoll = (on: boolean) => {
  document.documentElement.dataset.uiFocusPoll = on ? 'on' : 'off'
}

/** GDK-791: settings written elsewhere (CLI `config set`, another tab)
 *  reach this open tab through configVersion on the same 500ms poll —
 *  refetch config.json and re-apply colors, never a reload. The first
 *  sighting is this boot's baseline, not a change. */
async function reapplyRemoteConfig(poll: FocusPoll): Promise<void> {
  if (poll.configVersion && poll.configVersion !== lastConfigVersion) {
    if (lastConfigVersion !== null) {
      const doc = await loadConfig()
      applyUserTokens(doc.ui)
    }
    lastConfigVersion = poll.configVersion
  }
}

/** GDK-1170: the mirror moved somewhere else — `gadak claim` in a terminal,
 *  another tab, the watch loop — so pull a delta on this 500ms tick instead
 *  of waiting out the issue store's 15s backstop. That backstop stays: this
 *  signal is absent on an older server, on a serve with no mirror, and on
 *  every failed poll. */
function pullMirrorDelta(poll: FocusPoll): void {
  switch (decideMirrorPull(poll.mirrorVersion, lastMirrorVersion, mirrorPulling)) {
    case 'baseline':
      lastMirrorVersion = poll.mirrorVersion
      break
    case 'pull': {
      const seen = poll.mirrorVersion
      mirrorPulling = true
      // GDK-1182: the same write that moved the mirror may have renamed
      // a terminal session (claim). The strip rides this tick too,
      // instead of waiting out its own 2s roster grid.
      terminalSessions.nudge()
      // Not awaited: the focus half of this tick (a `views open` hash)
      // must not queue behind a delta round trip. The baseline moves
      // only if the sync actually ran — coalesced into one already in
      // flight, it may not carry this write, and the next tick retries.
      void issues
        .refresh()
        .then((ran) => {
          if (ran) lastMirrorVersion = seen
        })
        .catch(() => {
          /* #sync swallows its own failures; the 15s poll retries */
        })
        .finally(() => {
          mirrorPulling = false
        })
      break
    }
    // 'wait' keeps the old baseline on purpose so the next tick pulls.
    // 'ignore' is no signal, or a mirror that has not moved.
  }
}

/** GDK-960: a `views open` payload is applied once per tab (memory, then
 *  sessionStorage so a refresh inside MaxAge does not bounce the list). */
function applyViewsFocus(poll: FocusPoll): void {
  const hash = poll.hash
  if (!hash) return
  // GDK-981: keyed on (at, hash) — `at` alone repeats when two writes land
  // in the same second, and the second one would vanish.
  const remembered = readLastFocusKey(lastFocusKey)
  if (!shouldApplyUIFocus(poll.at, hash, remembered)) return
  if (poll.at) {
    lastFocusKey = uiFocusKey(poll.at, hash)
    rememberFocusKey(lastFocusKey)
  }
  const q = hash.startsWith('#/?')
    ? hash.slice(3)
    : hash.startsWith('?')
      ? hash.slice(1)
      : hash
  // A dash= focus opens the dashboard and stops there: parseView on a
  // dash-only query would hand the list a default config nobody chose, and
  // `dashboards open` has no opinion about the issue list at all.
  const focusParams = new URLSearchParams(q)
  const dashId = focusParams.get(COLUMN_PARAM.dash)
  if (dashId) {
    // Taking the column is dashboards.open's own move (GDK-821 union) —
    // whatever full-column surface was up, feed included, is released.
    dashboards.open(dashId)
    pushHash(q ? `#/?${q}` : '#/')
    return
  }
  // Column latches first (showIssueList → applyConfig). Then the CLI's
  // literal hash, so ks=A,B stays unescaped — through the router, which
  // syncs its own state on the spot (a raw `location.hash =` left it a
  // task stale, and the column binding's flush rebuilt the hash from
  // that) and folds this push into applyConfig's: one arrival, one entry.
  const focused = parseView(new URLSearchParams(q))
  showIssueList(focused.config)
  filters.notifyKeysCapped(focused.keys)
  pushHash(q ? `#/?${q}` : '#/')
}

async function applyFocus(): Promise<void> {
  if (isHostedDemo()) return
  try {
    const poll = await pollUIFocus()
    await reapplyRemoteConfig(poll)
    pullMirrorDelta(poll)
    applyViewsFocus(poll)
  } catch {
    /* serve without the endpoint, or offline */
  }
}

const startFocusPoll = () => {
  if (focusTimer !== null) return
  focusTimer = setInterval(() => {
    void applyFocus()
    // Live authoring updates (GDK-793): the same 500ms tick that serves
    // `views open` also watches the dashboards change counter — only while
    // one is open, so a closed dashboard costs nothing. A named passenger
    // of the tick, not a fourth job of the focus payload.
    void dashboards.checkVersion()
  }, FOCUS_POLL_MS)
  markFocusPoll(true)
}

const stopFocusPoll = () => {
  if (focusTimer === null) return
  clearInterval(focusTimer)
  focusTimer = null
  markFocusPoll(false)
}

const onVis = () => {
  if (document.visibilityState === 'visible') {
    void applyFocus()
    startFocusPoll()
  } else {
    stopFocusPoll()
  }
}

/**
 * Install the poll for this tab: one immediate focus pass and the 500ms
 * interval while visible, stopped and cleared by the returned uninstall.
 * The root shell calls this from its onMount.
 */
export function installUiFocusPoll(): () => void {
  if (document.visibilityState === 'visible') {
    void applyFocus()
    startFocusPoll()
  } else {
    markFocusPoll(false)
  }
  document.addEventListener('visibilitychange', onVis)
  return () => {
    stopFocusPoll()
    document.removeEventListener('visibilitychange', onVis)
  }
}
