// The sprint list screen (GDK-1827) at 402×874, against `gadak demo` — the
// same fixture every other spec here uses. `examples/demo.db` was not
// touched: Sprint 42 is the one active sprint (41 closed, 43 future) with
// 20 issues, 6 of them done.
//
// What this file is for: the ordering is asserted in src/lib/sprint.test.ts
// over the same rows, with no browser. This is the effect confirmed — the
// palette row exists, the screen it opens holds the sprints the route
// answered, its numbers are the sprint line's numbers, and the active row's
// tap does the line's tap. Nothing here asserts the days-left sentence or
// the date range: the one moves with the wall clock, the other with the
// locale's month-day form.
//
// One conflict this spec resolves by following the screen contract's own
// rule ("the same function the sprint line's tap calls — do not force-change
// the scope model"): tapping the active row lands on the sprint *scope*,
// whose name is the desk's `board.scopeActive` ("Active sprint") with the
// sprint's row count beside it — not the sprint's own name. Per-sprint scope
// ids are a scope-model change this screen deliberately does not make;
// sprintline.spec.ts asserts the same landing for the line's tap.
//
// The words are read from the desk's catalog, not typed here (§3.6, the
// settings.spec rule): a spec that hardcoded "Sprints" would stay green
// through a rename of the key.
import { expect, test } from './helpers'
import { openPalette, waitPaired } from './nav'
import { en } from '../../web/src/lib/i18n/catalog'
import { SERVE_ORIGIN } from '../playwright.config'

const TITLE = en['sprints.title']
const LINE = '[data-testid="sprint-line"]'
const ROW = '[data-testid="sprints-row"]'

test('the palette offers the sprint list, and the screen holds the route’s answer', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  // The row gates on sprints existing, so wait for the line (the sprint
  // answer is in) before opening the palette — the same precondition
  // sprintline.spec.ts states for the scope row's count.
  await page.locator(`.pane:not(.off) ${LINE}`).waitFor()

  await openPalette(page)
  const row = page.locator('button.palette-row', { hasText: TITLE })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.locator('.palette-field input').waitFor({ state: 'detached' })

  // The screen is the owner: its heading, and rows — one per sprint the
  // route answered, no more and no fewer. The count comes from the demo
  // server's own /api/v1/issues/sprints/ (the registered path under the
  // /api/v1/issues/ base, internal/server/server.go), not from a constant.
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
  const res = await fetch(`${SERVE_ORIGIN}/api/v1/issues/sprints/`)
  const body = (await res.json()) as { sprints?: { id: number }[] }
  await expect(page.locator(`.pane:not(.off) ${ROW}`)).toHaveCount(body.sprints?.length ?? -1)

  // The reading order, over the fixture's three bands: the active one
  // first, the future one second, the closed one last.
  await expect(page.locator(`.pane:not(.off) ${ROW} .name`)).toHaveText([
    'Sprint 42',
    'Sprint 43',
    'Sprint 41',
  ])
})

test('the active row’s numbers are the sprint line’s numbers', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await page.locator(`.pane:not(.off) ${LINE}`).waitFor()

  // The line says "6 / 20 · 30%" — the snapshot's arithmetic over Sprint 42.
  const lineCount = await page.locator(`.pane:not(.off) ${LINE} .count`).textContent()
  expect(lineCount).toBe('6 / 20 · 30%')

  await openPalette(page)
  await page.locator('button.palette-row', { hasText: TITLE }).click()
  await page.getByRole('heading', { name: TITLE }).waitFor()

  // Same function, same rows: the screen's active row must say what the
  // line says. A different number here means the screen counted something
  // else (server totals, a stale pool) — the defect this test exists for.
  const active = page.locator(`.pane:not(.off) ${ROW}`, { hasText: 'Sprint 42' })
  await expect(active.locator('.count')).toHaveText(lineCount ?? '')
})

test('tapping the active row scopes the queue to that sprint', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await page.locator(`.pane:not(.off) ${LINE}`).waitFor()

  await openPalette(page)
  await page.locator('button.palette-row', { hasText: TITLE }).click()
  await page.getByRole('heading', { name: TITLE }).waitFor()

  await page.locator(`.pane:not(.off) ${ROW}`, { hasText: 'Sprint 42' }).click()

  // Back on the list, wearing the sprint scope: the desk's own name for it
  // and the 20 rows the sprint holds, done ones included — the same landing
  // the line's tap makes (sprintline.spec.ts asserts this same pair).
  const heading = page.locator('.pane:not(.off) h1 button.scope')
  await expect(heading.locator('.name')).toHaveText('Active sprint')
  await expect(heading.locator('.count')).toHaveText('·20')
  // The row that was tapped is marked as where the queue is. Unscoped from
  // the visible pane on purpose: the sprints pane stays mounted hidden
  // (`.off`), which is exactly why this mark is still readable in the DOM.
  await expect(page.locator(`${ROW}[aria-current='true']`)).toHaveCount(1)
})

test('the screen’s back control and system back both come home to the list', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await page.locator(`.pane:not(.off) ${LINE}`).waitFor()

  await openPalette(page)
  await page.locator('button.palette-row', { hasText: TITLE }).click()
  await page.getByRole('heading', { name: TITLE }).waitFor()

  // The header control is the owner's one exit.
  await page.locator('.pane:not(.off) button.back').click()
  await expect(page.locator('.pane:not(.off) h1 button.scope .name')).toBeVisible()

  // And the gesture is the same edge: re-enter, then history back — the
  // settings.spec pair, for an owner instead of a layer.
  await openPalette(page)
  await page.locator('button.palette-row', { hasText: TITLE }).click()
  await page.getByRole('heading', { name: TITLE }).waitFor()
  await page.goBack()
  await expect(page.locator('.pane:not(.off) h1 button.scope .name')).toBeVisible()
})
