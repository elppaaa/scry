/*
 * The label set the phone can offer, as pure functions (GDK-1871).
 *
 * The phone has no labels catalog to ask for — the server serves none — so
 * the picker's rows are the labels this workspace already uses, read off the
 * snapshot the phone is holding anyway. That is the same source the desk's
 * own label autocomplete reads (web NewIssueDialog's `labelFreq` walks
 * `issues.allIssues`), which is why a label typed on the desk shows up as a
 * row here without either side knowing about the other.
 *
 * Sorted, deduped, trimmed — and pure, so the cases a capture cannot reach
 * (a row cached before labels were parsed, a label that is only whitespace,
 * two rows that disagree on case) are pinned in vitest.
 */

/** Rows whose `labels` this reads; anything with the field will do. */
interface HasLabels {
  labels?: string[] | null
}

/**
 * Every distinct label across the given rows, trimmed and sorted. Case is
 * preserved and NOT folded: Jira treats `Papercut` and `papercut` as two
 * labels, and a picker that merged them would file the wrong one.
 */
export function knownLabels(issues: readonly HasLabels[] | null | undefined): string[] {
  if (!issues) return []
  const seen = new Set<string>()
  for (const row of issues) {
    const list = row?.labels
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const label = raw.trim()
      if (label) seen.add(label)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/**
 * What one line of typing means. Jira refuses a label containing a space and
 * the server only trims and dedupes (write.go normalizeLabels), so the split
 * has to happen here: whitespace separates labels rather than sitting inside
 * one. Nothing typed is dropped — "quick win" files two labels, not none and
 * not one the origin will reject.
 */
export function splitLabelInput(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean)
}

/** True when two sets hold the same labels, order ignored — the armed test. */
export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((v, i) => v === right[i])
}
