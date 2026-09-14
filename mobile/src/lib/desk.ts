/*
 * Which desk rows the issue detail owes (GDK-1874), as one pure predicate.
 *
 * The Fields section names one desk row and only one: editing a configured
 * custom field needs the desk's field editor, and the row says so after the
 * last field rather than beside each of them — six rows each repeating "Open
 * on the desktop" is the Jira app's own noise, which is what this whole
 * round exists to remove rather than add.
 *
 * The system rows are excluded because none of them is desk-only: parent,
 * epic and sprint are places to go, labels already open a set on the phone
 * (GDK-1871), and components and fix versions are reads. Only a spec'd field
 * — a row lib/fields.ts built from `field_specs` — is a thing the phone can
 * show and cannot change.
 *
 * Pure and here rather than in fields.ts: fields.ts decides which rows exist
 * and this decides what their existence owes, and the split keeps the cases
 * a capture cannot reach (a site with custom fields) pinned without a
 * browser. The demo fixture configures none, so the browser gate can only
 * confirm the absent half — the present half is asserted here.
 */

import type { FieldRow } from './fields'

/**
 * The aliases lib/fields.ts assigns to its own system rows, in the order it
 * emits them. A spec'd field that collides with one of these never reaches a
 * row (fields.ts drops it), so membership here is exactly "not custom".
 */
export const SYSTEM_FIELD_ALIASES: readonly string[] = [
  'parent',
  'epic',
  'sprint',
  'labels',
  'components',
  'fix_versions',
]

/** True when at least one row came from the site's own `field_specs`. */
export function hasCustomFieldRow(rows: readonly Pick<FieldRow, 'alias'>[]): boolean {
  return rows.some((row) => !SYSTEM_FIELD_ALIASES.includes(row.alias))
}
