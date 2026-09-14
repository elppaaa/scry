/*
 * The Detail screen's Fields section (GDK-1870), as one pure function.
 *
 * DESIGN.md §1, rewritten 2026-09-14: *whatever the mirror holds, the phone
 * shows*. The bootstrap payload has carried labels, components, fix versions,
 * parent, epic and every configured custom field since v0.1 — the phone
 * simply never read them, which is the loudest class of complaint about the
 * Jira app it replaces ("the app is a subset of the web and you find out by
 * searching"). This module is where a row becomes visible; Detail.svelte only
 * paints what it returns.
 *
 * Pure on purpose. The rows are decided here and asserted in vitest, so the
 * cases a capture cannot reach — a site with custom fields, an epic that is
 * not the parent, a user-shaped value — are pinned without a browser. The
 * browser gate confirms the effect once.
 *
 * Two rules this module owns and Detail.svelte must not re-decide:
 *  - An empty value is no row. A section of "Labels —" repeated six times is
 *    the Jira app's own noise; a field the issue does not carry says nothing.
 *  - Vocabulary comes from the desk's catalog, never from here. `fieldLabel`
 *    answers for the aliases the catalog knows and the Jira display name from
 *    `field_specs` covers the rest, which is already in the account's
 *    language (DESIGN.md §3.6 — the phone never authors a word).
 */

import { fieldLabel, t } from './i18n'
import type { FieldSpec, IssueLite } from './types'

/** `key` is an issue key the row navigates to; `list` renders comma-joined. */
export type FieldKind = 'text' | 'list' | 'key'

export interface FieldRow {
  /** Stable row id: a system field's name, or the spec's alias. */
  alias: string
  label: string
  kind: FieldKind
  value: string | string[]
}

/**
 * Spec roles that become a row. `body` is a document section on the desk
 * (DetailPanel renders it as prose, not as a row) and this round does not
 * render it at all — a field the phone cannot lay out is better absent than
 * truncated into a line.
 */
const ROW_ROLES: readonly string[] = ['facet', 'plain', 'user']

/**
 * A custom field's value off the row. The server spreads configured fields as
 * TOP-LEVEL keys named by their alias (`cf_10015`, `story_points`) — they are
 * not nested under a `custom` object — so the read is by name and the cast is
 * unavoidable. It lives here, once, rather than as an index signature on
 * `IssueLite`: an index signature would make every misspelled field access in
 * the app typecheck.
 */
export function customValue(lite: IssueLite, alias: string): unknown {
  return (lite as unknown as Record<string, unknown>)[alias]
}

/**
 * Jira values arrive in their raw API shapes: option `{value}`, version and
 * component `{name}`, user `{displayName}`, arrays of any of those, plain
 * strings, numbers, booleans. Everything becomes display strings, and an
 * object that carries none of those names becomes nothing — which is how a
 * `user`-role value the phone cannot name is skipped rather than printed as
 * `[object Object]`.
 */
function displayStrings(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap(displayStrings)
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (typeof value === 'number') return Number.isFinite(value) ? [String(value)] : []
  if (typeof value === 'boolean') return [String(value)]
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    for (const k of ['value', 'name', 'display_name', 'displayName']) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return [v.trim()]
    }
    return []
  }
  return []
}

/** Label: the shared catalog's word when it has one, else the site's own. */
function specLabel(spec: FieldSpec): string {
  const viaCatalog = fieldLabel(spec.alias)
  if (viaCatalog !== spec.alias) return viaCatalog
  return spec.label?.trim() || spec.alias
}

/** A wire string that is present and not blank, else ''. */
function text(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A wire string array, tolerating a snapshot cached before the field existed. */
function list(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => text(v)).filter(Boolean)
}

/**
 * Every field the mirror holds for this row, in reading order: where the
 * issue sits (parent, epic, sprint), when it is wanted (due), how it is filed
 * (labels, components, fix versions), then whatever the site added, in the
 * order the site's own catalog lists it.
 *
 * `lite` may be a row cached by a phone built before GDK-1870, so the array
 * fields can be missing at runtime even though the owner declares them
 * required — every read below coalesces.
 */
export function fieldRows(
  lite: IssueLite | null | undefined,
  specs: readonly FieldSpec[] = [],
): FieldRow[] {
  if (!lite) return []
  const rows: FieldRow[] = []

  const parent = text(lite.parent_key)
  if (parent) rows.push({ alias: 'parent', label: fieldLabel('parent'), kind: 'key', value: parent })

  // The epic is the nearest hierarchy-level-1 ancestor and the parent is the
  // direct one; on a story filed straight under its epic they are the same
  // key, and naming it twice would read as two different places to go.
  const epic = text(lite.epic_key)
  if (epic && epic !== parent) {
    rows.push({ alias: 'epic', label: t('common.epic'), kind: 'key', value: epic })
  }

  // `sprint_id` is the axis, never the name: a name with no id is a row the
  // mirror cannot place, and display names are not something logic keys on.
  const sprint = text(lite.sprint_name)
  if (lite.sprint_id != null && sprint) {
    rows.push({ alias: 'sprint', label: fieldLabel('sprint'), kind: 'text', value: sprint })
  }

  // The due date is not a row: the header meta line already says it
  // (Detail.svelte `.m-item.due`), and the same fact printed twice on one
  // screen is the noise this section exists to remove (lead, 2026-09-14).

  const labels = list(lite.labels)
  if (labels.length) rows.push({ alias: 'labels', label: fieldLabel('labels'), kind: 'list', value: labels })

  const components = list(lite.components)
  if (components.length) {
    rows.push({ alias: 'components', label: fieldLabel('components'), kind: 'list', value: components })
  }

  const fixVersions = list(lite.fix_versions)
  if (fixVersions.length) {
    rows.push({
      alias: 'fix_versions',
      label: fieldLabel('fix_versions'),
      kind: 'list',
      value: fixVersions,
    })
  }

  const taken = new Set(rows.map((r) => r.alias))
  for (const spec of specs) {
    if (!ROW_ROLES.includes(spec.role)) continue
    // A site may configure a field under an alias a system row already owns.
    // One row wins — the system one, which is the value the rest of the app
    // reads — rather than the same fact printed twice.
    if (taken.has(spec.alias)) continue
    const raw = customValue(lite, spec.alias)
    const values = displayStrings(raw)
    if (values.length === 0) continue
    taken.add(spec.alias)
    rows.push(
      Array.isArray(raw)
        ? { alias: spec.alias, label: specLabel(spec), kind: 'list', value: values }
        : { alias: spec.alias, label: specLabel(spec), kind: 'text', value: values.join(', ') },
    )
  }

  return rows
}
