import { describe, expect, it, vi } from 'vitest'
import { customValue, fieldRows, type FieldRow } from './fields'
import type { FieldSpec, IssueLite } from './types'

/*
 * GDK-1870 — the Fields section, decided here so a capture does not have to
 * decide it. The demo fixture ships `field_specs: []`, so every custom-field
 * case below is reachable only from a test; that is why they are here and not
 * in the walk.
 */

/** A row the mirror could have answered with. Fields under test are set per case. */
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

const aliases = (rows: FieldRow[]): string[] => rows.map((r) => r.alias)
const byAlias = (rows: FieldRow[], alias: string): FieldRow | undefined =>
  rows.find((r) => r.alias === alias)

describe('fieldRows — the system half', () => {
  it('answers no rows when the issue carries no field at all', () => {
    // The section's absence is a contract, not a styling accident: an issue
    // with nothing filed must not draw a heading over six empty rows.
    expect(fieldRows(row())).toEqual([])
    expect(fieldRows(null)).toEqual([])
    expect(fieldRows(undefined, [spec({ alias: 'cf_1' })])).toEqual([])
  })

  it('reads a snapshot cached before the arrays existed without throwing', () => {
    // An older phone's localStorage rows have no `labels` key at all, even
    // though the owner declares it required.
    const stale = { ...row(), parent_key: 'NMB-194' } as Record<string, unknown>
    delete stale.labels
    delete stale.components
    delete stale.fix_versions
    expect(aliases(fieldRows(stale as unknown as IssueLite))).toEqual(['parent'])
  })

  it('puts the system fields in reading order and drops the empty ones', () => {
    const rows = fieldRows(
      row({
        parent_key: 'NMB-194',
        epic_key: 'NMB-900',
        sprint_id: 12,
        sprint_name: 'Sprint 7',
        duedate: '2026-09-30',
        labels: ['papercut'],
        components: ['Dashboard'],
        fix_versions: ['2026.8.0', '2026.9.0'],
      }),
    )
    expect(aliases(rows)).toEqual([
      'parent',
      'epic',
      'sprint',
      'labels',
      'components',
      'fix_versions',
    ])
    expect(byAlias(rows, 'parent')).toMatchObject({ kind: 'key', value: 'NMB-194' })
    expect(byAlias(rows, 'fix_versions')).toMatchObject({
      kind: 'list',
      value: ['2026.8.0', '2026.9.0'],
    })
    // No due row: the header meta already carries the due date, and the
    // section never repeats what the screen above it says (lead, 2026-09-14).
    expect(byAlias(rows, 'duedate')).toBeUndefined()
  })

  it('hides the epic when it is the parent', () => {
    // A story filed straight under its epic carries the same key twice; two
    // rows would read as two different places to go.
    const rows = fieldRows(row({ parent_key: 'NMB-194', epic_key: 'NMB-194' }))
    expect(aliases(rows)).toEqual(['parent'])
    const apart = fieldRows(row({ parent_key: 'NMB-110', epic_key: 'NMB-194' }))
    expect(aliases(apart)).toEqual(['parent', 'epic'])
  })

  it('keys the sprint row on sprint_id, never on the name alone', () => {
    expect(aliases(fieldRows(row({ sprint_id: null, sprint_name: 'Sprint 7' })))).toEqual([])
    expect(aliases(fieldRows(row({ sprint_id: 12, sprint_name: 'Sprint 7' })))).toEqual(['sprint'])
  })
})

describe('fieldRows — the discovered half', () => {
  it('renders the value shapes Jira actually sends', () => {
    const lite = row() as unknown as Record<string, unknown>
    lite.cf_text = 'Regression'
    lite.story_points = 8
    lite.cf_multi = ['alpha', 'beta']
    lite.cf_option = { value: 'High' }
    lite.cf_version = { name: '2026.9.0' }
    lite.cf_user = { display_name: 'Dana Whitfield' }
    lite.cf_person = { displayName: 'Alex Kim' }
    const rows = fieldRows(lite as unknown as IssueLite, [
      spec({ alias: 'cf_text', label: 'Root cause' }),
      spec({ alias: 'story_points', label: 'Story point estimate' }),
      spec({ alias: 'cf_multi', label: 'Squads', role: 'facet' }),
      spec({ alias: 'cf_option', label: 'Impact', role: 'facet' }),
      spec({ alias: 'cf_version', label: 'Found in' }),
      spec({ alias: 'cf_user', label: 'Reviewer', role: 'user' }),
      spec({ alias: 'cf_person', label: 'Tester', role: 'user' }),
    ])
    expect(rows).toEqual([
      { alias: 'cf_text', label: 'Root cause', kind: 'text', value: 'Regression' },
      { alias: 'story_points', label: 'Story point estimate', kind: 'text', value: '8' },
      { alias: 'cf_multi', label: 'Squads', kind: 'list', value: ['alpha', 'beta'] },
      { alias: 'cf_option', label: 'Impact', kind: 'text', value: 'High' },
      { alias: 'cf_version', label: 'Found in', kind: 'text', value: '2026.9.0' },
      { alias: 'cf_user', label: 'Reviewer', kind: 'text', value: 'Dana Whitfield' },
      { alias: 'cf_person', label: 'Tester', kind: 'text', value: 'Alex Kim' },
    ])
  })

  it('skips body specs, empty values and an object it cannot name', () => {
    const lite = row() as unknown as Record<string, unknown>
    lite.cf_doc = { type: 'doc', content: [] }
    lite.cf_blank = ''
    lite.cf_none = null
    lite.cf_empty = []
    lite.cf_opaque = { id: '10201', self: 'https://example.invalid/x' }
    const rows = fieldRows(lite as unknown as IssueLite, [
      spec({ alias: 'cf_doc', label: 'Acceptance criteria', role: 'body' }),
      spec({ alias: 'cf_blank', label: 'Blank' }),
      spec({ alias: 'cf_none', label: 'Unset' }),
      spec({ alias: 'cf_empty', label: 'None picked', role: 'facet' }),
      spec({ alias: 'cf_opaque', label: 'Opaque', role: 'user' }),
      spec({ alias: 'cf_missing', label: 'Never sent' }),
    ])
    expect(rows).toEqual([])
  })

  it('lets a system row win when a spec claims the same alias', () => {
    const rows = fieldRows(row({ labels: ['papercut'] }), [
      spec({ alias: 'labels', label: 'Etiquetas', role: 'facet' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toEqual(['papercut'])
  })

  it('keeps the site catalog order', () => {
    const lite = row() as unknown as Record<string, unknown>
    lite.cf_a = 'A'
    lite.cf_b = 'B'
    const forward = fieldRows(lite as unknown as IssueLite, [
      spec({ alias: 'cf_b', label: 'B' }),
      spec({ alias: 'cf_a', label: 'A' }),
    ])
    expect(aliases(forward)).toEqual(['cf_b', 'cf_a'])
  })

  it('falls back to the alias when the site sent no display name', () => {
    const lite = row() as unknown as Record<string, unknown>
    lite.cf_10015 = 'Yes'
    const rows = fieldRows(lite as unknown as IssueLite, [spec({ alias: 'cf_10015', label: '  ' })])
    expect(rows[0]!.label).toBe('cf_10015')
  })
})

describe('customValue', () => {
  it('reads a spread custom field off the top level, not from a nested object', () => {
    // The server spreads configured fields as top-level keys named by their
    // alias; a `custom` object is the shape this must NOT assume.
    const lite = { ...row(), story_points: 5 } as unknown as IssueLite
    expect(customValue(lite, 'story_points')).toBe(5)
    expect(customValue(lite, 'absent')).toBeUndefined()
  })
})

describe('labels come from the desk catalog, in whatever locale is set', () => {
  it('uses the Korean catalog word for a well-known alias and the site word otherwise', async () => {
    // Same shape as vocabulary.test.ts: a fresh module graph with
    // gadak_locale=ko, because web/src/lib/i18n runs initLocale() at import.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'gadak_locale' ? 'ko' : null),
      setItem: () => {},
      removeItem: () => {},
    })
    vi.resetModules()
    try {
      const { fieldRows: ko } = await import('./fields')
      const lite = {
        ...row({
          parent_key: 'NMB-194',
          epic_key: 'NMB-900',
          labels: ['papercut'],
          components: ['Dashboard'],
          fix_versions: ['2026.8.0'],
          sprint_id: 12,
          sprint_name: 'Sprint 7',
        }),
      } as unknown as Record<string, unknown>
      lite.cf_10015 = 'Regression'
      const rows = ko(lite as unknown as IssueLite, [
        // A site name the catalog has no word for: the Jira display name is
        // already in the account's language, so it is used verbatim.
        { alias: 'cf_10015', label: '재현 경로', role: 'plain' },
      ])
      expect(rows.map((r) => r.label)).toEqual([
        '상위 항목',
        '에픽',
        '스프린트',
        '라벨',
        '컴포넌트',
        '수정 버전',
        '재현 경로',
      ])
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})
