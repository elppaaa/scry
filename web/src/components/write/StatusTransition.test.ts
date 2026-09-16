/*
 * StatusTransition menu shape (GDK-PRDCT UX parity with Jira's own menu).
 *
 * vitest cannot mount the component (no svelte plugin in the unit project —
 * see vitest.config.ts), so this pins the derivation contract in source, the
 * same convention as NewIssueDialog.test.ts. Behavior is exercised end to end
 * by the transition specs in e2e/.
 *
 * Contract:
 *  1. Rows are keyed on the TARGET STATUS (to_status), never the workflow's
 *     transition name. Jira translates transition names per account; PRDCT's
 *     "완료" transition lands on "진행 중" and must read "진행 중".
 *  2. Self-loop edges (to_id === the issue's current status_id) are dropped:
 *     Jira's UI hides them, and firing one only re-posts the same state.
 *  3. The stable to_id (not the localized to_status string) is the dedupe key.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'StatusTransition.svelte'), 'utf8')

describe('StatusTransition target-status rows', () => {
  test('renders to_status, never the transition name as the row label', () => {
    expect(SRC).toContain('{t.to_status}')
    // The old label — the workflow's transition name — must be gone from the
    // row markup, and with it the "→ target" suffix that guessed at it.
    expect(SRC).not.toContain('<span class="min-w-0 flex-1 truncate">{t.name}</span>')
    expect(SRC).not.toContain('→ {t.to_status}')
  })

  test('drops self-loop edges by stable status id, not by display name', () => {
    expect(SRC).toContain('issue.status_id')
    expect(SRC).toMatch(/t\.to_id\s*&&\s*t\.to_id\s*===\s*curId/)
    // Name-based comparison would mis-fire on translated statuses; the id is
    // the stable key. No status-name equality check may exist.
    expect(SRC).not.toMatch(/t\.to_status\s*===\s*issue\.status/)
  })

  test('dedupes rows on to_id so two transitions to one status render once', () => {
    expect(SRC).toContain('const byTarget = new Map<string, Transition>()')
    expect(SRC).toMatch(/byTarget\.has\(k\)/)
    // to_id first: the localized to_status string is only a cache-era fallback.
    expect(SRC).toMatch(/t\.to_id\s*\|\|\s*t\.to_status/)
  })
})
