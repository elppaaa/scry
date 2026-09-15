/*
 * The phone's terminal font-size setting (GDK-901 2026-09-15).
 *
 * GDK-900 measured ~40 columns at the 13px token on a 402pt screen and left
 * no user escape; this is the escape. Four sizes, one owner
 * (lib/termprefs.ts), applied as the --text-terminal inline override the
 * renderer already reads at creation — and re-applied live through
 * renderer.setFontSize when a pane is already mounted.
 *
 * The spec speaks structure, never copy: the label key is the desk's catalog
 * (DESIGN.md §3.6) and no assertion reads it. What is asserted is the three
 * surfaces the preference owns — the CSS variable, the persisted key, and
 * the live xterm options object — plus the one deletion rule that keeps 13
 * the token's own value rather than a stored duplicate.
 */
import { type Page } from '@playwright/test'
import { expect, test } from './helpers'
import { SERVE_ORIGIN } from './serve'
import { closeSettings, openPalette, openSettings, waitPaired } from './nav'

const FONT_SIZE_KEY = 'gadak.terminal.fontSize'

function makeTerminalOffer(label: string): string {
  const doc = JSON.stringify({
    v: 1,
    endpoint: `${SERVE_ORIGIN}`,
    token: crypto.randomUUID(),
    expires_at: '',
    label,
  })
  return Buffer.from(doc).toString('base64url')
}

/** Pairs the shell through Settings — the only road to it (DESIGN.md §2). */
async function pairShell(page: Page, label = 'This Mac (dev)'): Promise<void> {
  await openSettings(page)
  await page.locator('#term-offer').fill(makeTerminalOffer(label))
  await page.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(page.locator('#term-offer')).toHaveCount(0)
  await closeSettings(page)
}

/** One size button inside the radiogroup, addressed by its number. */
function sizeButton(page: Page, px: number) {
  return page.locator(`[data-testid="terminal-font-size"] button[role="radio"]`, {
    hasText: String(px),
  })
}

/** The --text-terminal value on the document root, as the renderer reads it. */
function terminalCssVar(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--text-terminal').trim(),
  )
}

test('tapping a size applies the variable, persists it, and survives a reload', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await pairShell(page)

  await openSettings(page)
  await sizeButton(page, 17).click()
  await expect(sizeButton(page, 17)).toHaveAttribute('aria-checked', 'true')
  expect(await terminalCssVar(page)).toBe('17px')
  expect(await page.evaluate((k) => localStorage.getItem(k), FONT_SIZE_KEY)).toBe('17')

  // A relaunch is the real test of boot(): the stored preference must be
  // re-applied before any pane is created, and the control must show it.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  expect(await terminalCssVar(page)).toBe('17px')
  await openSettings(page)
  await expect(sizeButton(page, 17)).toHaveAttribute('aria-checked', 'true')
  await closeSettings(page)
})

test('the shell the palette opens carries the chosen size', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await pairShell(page)

  await openSettings(page)
  await sizeButton(page, 17).click()
  await expect(terminalCssVar(page)).resolves.toBe('17px')
  await closeSettings(page)

  await openPalette(page)
  await page.locator('button.palette-row', { hasText: 'Terminal' }).click()
  await expect(page.getByTestId('terminal-pane')).toBeVisible()
  await expect(page.getByTestId('terminal-pane')).toHaveAttribute('data-attached', 'true', {
    timeout: 20_000,
  })
  // The renderer reads --text-terminal at creation; a pane opened after the
  // change must be created at 17, not resized to it.
  expect(await page.evaluate(() => (window as { __gadakTerm?: { options?: { fontSize?: number } } }).__gadakTerm?.options?.fontSize)).toBe(17)
})

test('choosing 13 again removes the stored key — the token owns the default', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await pairShell(page)

  await openSettings(page)
  await sizeButton(page, 15).click()
  expect(await page.evaluate((k) => localStorage.getItem(k), FONT_SIZE_KEY)).toBe('15')

  await sizeButton(page, 13).click()
  await expect(sizeButton(page, 13)).toHaveAttribute('aria-checked', 'true')
  expect(await terminalCssVar(page)).toBe('13px')
  expect(await page.evaluate((k) => localStorage.getItem(k), FONT_SIZE_KEY)).toBeNull()
})
