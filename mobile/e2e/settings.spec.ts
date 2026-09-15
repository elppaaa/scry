/*
 * Settings is a screen with its own name (GDK-902 2026-09-15, DESIGN.md §2).
 *
 * The entry/exit table gives this screen one row: enter from the gear in the
 * heading (44pt), exit by the back button (top-left, 44pt) → the list, and
 * system back is the same edge. It is *not* an owner, so it never survives
 * a Detail: the two share the layer's z-order and only one is ever open
 * (store.svelte.ts openSettings).
 *
 * The heading text is read from the desk's catalog, not typed here — §3.6
 * says the desktop catalog is the single owner of the word, and a spec that
 * hardcodes "Settings" would stay green through a rename of the key.
 *
 * FAIL-first (this file against the tree before the rename, 2026-09-15):
 * see scratch/gdk-902r2/failfirst-settings.log — the heading-text
 * assertions fail because the screen still says "Pairing".
 */
import { expect, test } from './helpers'
import { closeSettings, openSettings, waitPaired } from './nav'
import { en } from '../../web/src/lib/i18n/catalog'

/** The one word this screen is allowed to wear (DESIGN.md §3.6). */
const TITLE = en['settings.title']

test('the gear opens Settings and its back control returns the list', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)

  await openSettings(page)
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await closeSettings(page)
  // Not just "the layer is gone": the exit lands on the list, which is the
  // cell the entry/exit table names. A goBack that left the app entirely
  // would satisfy the count alone.
  await expect(page.locator('h1 button.scope')).toBeVisible()
})

test('system back closes Settings the same way the back control does', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)

  await openSettings(page)
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()

  await page.goBack()
  await expect(page.locator('.settings-layer')).toHaveCount(0)
  await expect(page.locator('h1 button.scope')).toBeVisible()
})

test('Settings does not open while a Detail is up', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)

  await page.locator('.pane:not(.off) button.row').first().click()
  await page.locator('.detail-layer').waitFor()

  // The gear is behind the layer, so a user click cannot reach it — which
  // is why the assertion is a *synthetic* click straight at the control.
  // It measures the store's refusal (`if (app.detail !== null) return`),
  // not the fact that something is painted over the button.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button.gear')?.click()
  })
  await expect(page.locator('.settings-layer')).toHaveCount(0)
  // The Detail is still the thing on screen: the refused open moved nothing.
  await expect(page.locator('.detail-layer')).toHaveCount(1)
})

test('the gear names the screen it opens', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)

  // One word for one screen: the label a screen reader reads on the door is
  // the heading behind it. Two words for one surface is the §3.6 defect.
  await expect(page.locator('button.gear')).toHaveAttribute('aria-label', TITLE)

  await openSettings(page)
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible()
})
