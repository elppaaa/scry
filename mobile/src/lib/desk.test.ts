import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasCustomFieldRow, SYSTEM_FIELD_ALIASES } from './desk'
import { fieldRows } from './fields'
import { stripComments } from './source-scan'
import type { FieldSpec, IssueLite } from './types'

/*
 * GDK-1874 — "what stays on the desk says so where you look for it".
 *
 * Two halves, both of which a capture would miss.
 *
 * The predicate half: the demo fixture ships `field_specs: []` (measured —
 * `internal/server/read.go` fieldSpecsOut projects workspace config, and the
 * demo workspace configures none), so the browser gate can only ever confirm
 * that the Fields desk row is ABSENT. The present case — a site that did
 * configure a field — exists only here.
 *
 * The placement half: five call sites, one component. A source scan rather
 * than a render, because what must not regress is not how one row looks but
 * that no sixth spelling of "open on the desktop" appears next to it. The
 * scanner strips comments through lib/source-scan.ts (one owner since
 * GDK-1872 part 2 — a local regex ate 34 KB of Detail.svelte at
 * `accept="image/*"` and the gates around it stayed green while blind).
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|svelte)$/.test(entry.name)) out.push(path)
    }
  }
  walk(srcDir)
  return out.filter((p) => !p.endsWith('.test.ts'))
}

/** Source with comments removed — prose about the rule is not the rule. */
function code(path: string): string {
  return stripComments(readFileSync(path, 'utf8'))
}

/** The five places a person looks, and the component each must use. */
const CALL_SITES = [
  'screens/PageDetail.svelte',
  'screens/Detail.svelte',
  // GDK-902 2026-09-15: the scope sheet became the palette's body, in
  // place of the list's rows (DESIGN.md §2). Same rows, same dialect.
  'ui/Palette.svelte',
  'ui/SprintLine.svelte',
] as const

function row(over: Partial<IssueLite> = {}): IssueLite {
  return {
    issue_key: 'NMB-105',
    summary: 'Legend overlaps the axis labels',
    project_key: 'NMB',
    issue_type: 'Bug',
    status: 'In Progress',
    status_category: 'inprogress',
    priority: 'Medium',
    priority_rank: 3,
    assignee: null,
    assignee_email: null,
    reporter: null,
    reporter_email: null,
    created_at: '2026-08-05T12:58:05.178Z',
    updated_at: '2026-09-04T12:21:53.705Z',
    comment_count: 2,
    reopen_count: 0,
    status_changed_at: null,
    labels: [],
    components: [],
    fix_versions: [],
    parent_key: null,
    epic_key: null,
    ...over,
  } as IssueLite
}

function spec(over: Partial<FieldSpec> & { alias: string }): FieldSpec {
  return { label: '', role: 'plain', ...over }
}

describe('GDK-1874 the Fields desk row is owed by a custom field, not by a system one', () => {
  it('owes nothing for the six system rows, however many of them the issue carries', () => {
    const lite = row({
      parent_key: 'NMB-100',
      epic_key: 'NMB-9',
      sprint_id: 42,
      sprint_name: 'Sprint 42',
      labels: ['charts'],
      components: ['web'],
      fix_versions: ['0.23.0'],
    })
    const rows = fieldRows(lite)
    // Every alias fields.ts emits without specs is a system one — if that
    // set ever grows, this is where the two lists stop agreeing.
    expect(rows.map((r) => r.alias).sort()).toEqual([...SYSTEM_FIELD_ALIASES].sort())
    expect(hasCustomFieldRow(rows)).toBe(false)
  })

  it('owes one row as soon as the site configured a field the issue carries', () => {
    const lite = row({ labels: ['charts'] })
    ;(lite as unknown as Record<string, unknown>).story_points = 5
    const rows = fieldRows(lite, [spec({ alias: 'story_points', label: 'Story points' })])
    expect(rows.map((r) => r.alias)).toContain('story_points')
    expect(hasCustomFieldRow(rows)).toBe(true)
  })

  it('owes nothing for a configured field the issue does not carry', () => {
    // fields.ts drops an empty value before it becomes a row, so the desk
    // row follows the rows on screen and not the site's configuration.
    const rows = fieldRows(row({ labels: ['charts'] }), [spec({ alias: 'story_points' })])
    expect(hasCustomFieldRow(rows)).toBe(false)
  })

  it('owes nothing on an issue with no fields at all', () => {
    expect(hasCustomFieldRow(fieldRows(row()))).toBe(false)
  })
})

describe('GDK-1874 one component owns the desk row, and five places use it', () => {
  it('keeps the desktop sentence inside DeskRow.svelte and the artifact ledger row alone', () => {
    // 2026-09-15 (GDK-1897 R3-lite): a second wearer, deliberately. An HTML
    // attachment the desk renders as an artifact is a ledger line on the
    // phone, and that line is a <div> beside the plain file line — not a
    // DeskRow, which is a disabled <button> the attachment markup test
    // forbids in that lane. The sentence is still the catalog's one; what
    // this pins is that no third file borrows it. FAIL-first: the R3-lite
    // tree went red here before this line changed (scratch/r3lite/gate1).
    const referrers = sourceFiles()
      .filter((p) => code(p).includes('sidebar.scopeOpenDesktop'))
      .map((p) => relative(srcDir, p))
      .sort()
    expect(referrers).toEqual(['ui/AttachmentGrid.svelte', 'ui/DeskRow.svelte'])
  })

  it('draws the row from the shared component at every call site', () => {
    for (const rel of CALL_SITES) {
      expect(code(join(srcDir, rel)), `${rel} renders <DeskRow`).toContain('<DeskRow')
      expect(code(join(srcDir, rel)), `${rel} imports DeskRow`).toMatch(
        /import DeskRow from '\.\.?\/(ui\/)?DeskRow\.svelte'/,
      )
    }
  })

  it('names all five verbs — the sheet carries three of them', () => {
    const count = (rel: string) => (code(join(srcDir, rel)).match(/<DeskRow/g) ?? []).length
    // The palette is four (GDK-902 2026-09-15, was three in the sheet): a
    // blocked scope in the owner list — the dialect's origin — view
    // authoring at the end of the saved views, dashboards at the end, and
    // the same blocked-scope row again in the typed ranking, which draws
    // matching owners and must refuse the same ones.
    expect(count('ui/Palette.svelte')).toBe(4)
    expect(count('screens/PageDetail.svelte')).toBe(1)
    expect(count('screens/Detail.svelte')).toBe(1)
    expect(count('ui/SprintLine.svelte')).toBe(1)
  })

  it('takes every label from the catalog, never a literal', () => {
    // DESIGN.md §3.6 — the phone authors no word. A label= that is not a
    // t() call is a phone-authored noun wearing a shared component.
    for (const rel of CALL_SITES) {
      for (const m of code(join(srcDir, rel)).matchAll(/<DeskRow[^>]*\slabel=\{([^}]*)\}/g)) {
        expect(m[1].trim(), `${rel} label`).toMatch(/^(t\(|scope\.name$)/)
      }
    }
  })

  it('leaves the five inert — a desk row promises nothing it cannot do', () => {
    const deskRow = code(join(srcDir, 'ui/DeskRow.svelte'))
    expect(deskRow).not.toMatch(/onclick|deeplink|gadak open|href/)
    expect(deskRow).toMatch(/aria-disabled="true"/)
    expect(deskRow).toMatch(/\bdisabled\b/)
  })

  it('does not answer the list-row selector the gate clicks first', () => {
    // `.pane:not(.off) button.row` first() is how viewport.spec.ts and the
    // shots walk open an issue. A disabled row that answered it would hang
    // them, so the class is desk-row and the dialect is the CSS values.
    const deskRow = code(join(srcDir, 'ui/DeskRow.svelte'))
    expect(deskRow).toMatch(/class="desk-row"/)
    // A bare `row` token in the class list, not the substring — `desk-row`
    // contains it and is the whole point.
    expect(deskRow).not.toMatch(/class="(?:[^"]*\s)?row(?:\s[^"]*)?"/)
  })
})
