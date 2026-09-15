/*
 * The active sprint, as the phone reads it (GDK-1867).
 *
 * Pure: no fetch, no DOM, no store. The desk says the same facts on its
 * board strip (web/src/components/board/SprintStrip.svelte) and the phone
 * says them again in one line — same numbers, same days-left sentence, no
 * new design.
 *
 * One deliberate difference from the desk. The strip takes its counts from
 * the server (`SprintRow.issue_count` / `.done`), because a board narrowed
 * by a filter would otherwise report that filter's shape as the sprint's.
 * The phone holds the whole snapshot — the bootstrap is not a filtered pool
 * — and counts it here instead, so the line and the grouped list under it
 * are the same arithmetic over the same rows and cannot disagree. An
 * offline phone gets the counts of the snapshot it is showing, which is
 * what the cached banner above it already claims.
 *
 * Counting goes through `effectiveCategory`, never a raw
 * `status_category === 'done'`: the alias table is the desk's, and the
 * group headers below the line read the same function.
 */
import { calendarDay, localZone, type CalendarZone } from '../../../web/src/lib/calendar'
import { effectiveCategory } from './domain'
import type { IssueLite, SprintRow, SprintsResponse } from './types'

export interface SprintCounts {
  /** Issues in the snapshot carrying this sprint id. */
  total: number
  /** Of those, the ones in the done category. */
  done: number
  /** done/total as whole percent; 0 on an empty sprint (never NaN). */
  pct: number
}

/** How much of one sprint the held snapshot says is finished. */
export function sprintCounts(issues: IssueLite[], sprintId: number): SprintCounts {
  let total = 0
  let done = 0
  for (const issue of issues) {
    if (issue.sprint_id !== sprintId) continue
    total += 1
    if (effectiveCategory(issue) === 'done') done += 1
  }
  return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
}

/**
 * The one sprint the line is about, or nothing.
 *
 * `state`, never `name`: the wire's lowercase `active|future|closed` is the
 * axis, and a sprint called "Active" is not one. A workspace with several
 * boards can have several active at once — "the sprint" is then a question,
 * and the phone answers it with the one holding the most of the snapshot,
 * mirror order breaking a tie (the desk draws nothing at all in that case,
 * but the desk has a board scope beside it to ask with and the phone does
 * not).
 */
export function pickActiveSprint(rows: SprintRow[], issues: IssueLite[]): SprintRow | null {
  const active = rows.filter((r) => r.state === 'active')
  if (active.length === 0) return null
  if (active.length === 1) return active[0]
  let best = active[0]
  let bestTotal = sprintCounts(issues, best.id).total
  for (const row of active.slice(1)) {
    const total = sprintCounts(issues, row.id).total
    // Strict: the first row the mirror listed keeps a tie, so two equally
    // populated sprints do not swap places between syncs.
    if (total > bestTotal) {
      best = row
      bestTotal = total
    }
  }
  return best
}

/**
 * Whole days from today to the sprint's last day, in the reader's own zone.
 * Negative = the sprint is past its end; null = no end date to measure.
 *
 * Days, not hours: a sprint boundary is a calendar day, and `calendarDay` is
 * the mirror's one answer to "which day is this stamp" — so a sprint ending
 * at 04:29Z does not read a day early or late depending on where the reader
 * sits. The sentence this number becomes is the component's job; the five
 * `board.sprint*` catalog keys already hold it in three languages.
 */
export function sprintDaysLeft(
  endAt: string | null | undefined,
  now: Date,
  zone: CalendarZone = localZone(),
): number | null {
  const end = calendarDay(endAt, 'instant', zone)
  const today = calendarDay(now.toISOString(), 'instant', zone)
  if (!end || !today) return null
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/**
 * The rows of the sprint list screen (GDK-1827), in the order a person
 * reads them: what is running, what is coming, what is finished. The wire
 * answers in the same three bands (personal.go: active, then future, then
 * closed), but the phone owns its own ordering — the rows outlive the
 * answer that delivered them (the snapshot principle the counts follow), so
 * the order cannot be an accident of the last sync either.
 *
 * Within the bands: future by start_at ascending (the soonest first),
 * closed by end_at descending (the most recently finished first) — the same
 * directions the desk's sprint picker uses. A row with no date in its band
 * goes last; ties keep mirror order (the sort is stable), like the tie in
 * `pickActiveSprint` does. A state the three words do not know is neither
 * running nor coming nor finished, and goes after them, mirror order.
 *
 * Pure: returns a new array, never reorders the caller's.
 */
export function sortSprints(rows: SprintRow[]): SprintRow[] {
  const rank = (s: SprintRow): number =>
    s.state === 'active' ? 0 : s.state === 'future' ? 1 : s.state === 'closed' ? 2 : 3
  const time = (iso: string | null | undefined): number | null => {
    if (!iso) return null
    const ts = Date.parse(iso)
    return Number.isNaN(ts) ? null : ts
  }
  /** One comparator shape, both directions: undated last either way. (The
   *  descending case cannot just swap the two arguments — swapped, the null
   *  guards would put the undated row first, which is how this file's own
   *  test first caught it.) */
  const byTime = (a: number | null, b: number | null, dir: 1 | -1): number => {
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return (a - b) * dir
  }
  return [...rows].sort((x, y) => {
    const rx = rank(x)
    const ry = rank(y)
    if (rx !== ry) return rx - ry
    if (rx === 1) return byTime(time(x.start_at), time(y.start_at), 1)
    if (rx === 2) return byTime(time(x.end_at), time(y.end_at), -1)
    return 0
  })
}

/**
 * The sprint rows the origin answered with, or null when it did not answer.
 *
 * The two outcomes are different facts and the caller treats them
 * differently. A body — `[]` included — is the origin speaking: a workspace
 * that closed its last sprint says so with an empty list, and the line has
 * to go away. A throw is nobody speaking: `issues/sprints/` is a 0.22 route
 * (404 on an older serve), a Linear origin with no cycles can refuse it,
 * and a phone that lost the network throws too — in all three the caller
 * keeps whatever it already painted rather than blanking a good cache. The
 * request is the caller's (the store owns the transport); passing it in is
 * what makes the refusal path testable without one.
 */
export async function loadSprints(
  fetchSprints: () => Promise<SprintsResponse | null>,
): Promise<SprintRow[] | null> {
  try {
    const body = await fetchSprints()
    return body ? (body.sprints ?? []) : null
  } catch {
    return null
  }
}
