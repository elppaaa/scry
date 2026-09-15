import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// GDK-1894 — the phone-side counterpart of the Go suite's fixture-clock rule
// (internal/snapshot/fixture_flow_test.go: `fixtureNow` = MAX(updated_at), and
// a source scan that forbids reading the wall clock in a fixture contract).
// The capture specs photograph surfaces on the static `examples/demo.db`
// fixture, whose newest updated_at is frozen at generation time. A spec that
// anchors on `Date.now()` — e.g. a session boundary at "three days ago" —
// decays one calendar day per day until zero rows qualify and the spec hangs
// on a waitFor that can never pass (a4, 2026-09-13: from three days after the
// fixture's newest row the strip had nothing to say and the waitFor at the
// old :180 hung; during the hang the 60s sync timer's 304 killed the still-
// registered route handler at res.json()). Same class as GDK-1859/GDK-1881.
//
// The rule, kept deliberately simple: in a *-captures.spec.ts, any line
// spelling `Date.now()` or `new Date()` must derive from the fixture's own
// clock (`fixtureNow`) or carry an explicit escape hatch on the same line:
//   `// capture-clock: ok — <reason>`
//
// FAIL-first, run against the unmodified a4 spec (2026-09-15): expected the
// boundary line `const boundary = new Date(Date.now() - …).toISOString()`
// to fail with neither fixtureNow nor a trailer on the line.

const e2eDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e')

/** Lines that may spell the wall clock without deriving it from the fixture.
 *  Named entries, not silent: each one is a decision the lead has to re-read.
 *  Keyed by file basename + a stable fragment of the line, so line drift in
 *  the spec does not orphan the entry. */
const PENDING: Array<{ file: string; fragment: string; why: string }> = [
  // a7 synthesizes a comment row the fixture does not carry — the timestamp
  // is the payload being manufactured, not a comparison against fixture
  // timestamps, so it does not decay with the fixture's age. Out of this
  // round's file whitelist; left for its owning round. // GDK-1894 pending
  {
    file: 'a7-captures.spec.ts',
    fragment: 'created_at: new Date().toISOString()',
    why: 'a7 manufactures a comment row (created_at is the payload, not a fixture comparison) — GDK-1894 pending its owning round',
  },
]

describe('GDK-1894 capture specs anchor on the fixture clock, not the wall clock', () => {
  const specs = readdirSync(e2eDir).filter((f) => f.endsWith('-captures.spec.ts'))
  expect(specs.length).toBeGreaterThan(0)

  for (const file of specs) {
    it(`${file}: no wall-clock line without fixtureNow or a capture-clock trailer`, () => {
      const lines = readFileSync(join(e2eDir, file), 'utf8').split('\n')
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /Date\.now\(\)|new Date\(\)/.test(line))
        .filter(({ line }) => !/fixtureNow/.test(line))
        .filter(({ line }) => !/capture-clock: ok/.test(line))
        .filter(
          ({ line }) =>
            !PENDING.some(
              (p) => p.file === file && line.includes(p.fragment),
            ),
        )
      expect(
        offenders.map(({ n }) => `${file}:${n}`),
        offenders.length
          ? 'wall clock over a static fixture — derive from fixtureNow or annotate // capture-clock: ok — <reason>'
          : '',
      ).toEqual([])
    })
  }

  it('every PENDING entry still names a real line (a dropped spec must drop its allowlist)', () => {
    for (const p of PENDING) {
      const text = readFileSync(join(e2eDir, p.file), 'utf8')
      expect(text, `${p.file} no longer carries: ${p.fragment}`).toContain(p.fragment)
    }
  })
})
