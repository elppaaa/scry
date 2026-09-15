/*
 * Navigation helpers for the phone suite (GDK-902, 2026-09-15).
 *
 * Every spec used to reach a screen by clicking `nav.safe-bottom button.tab`
 * and to know the app was up by waiting for that nav. The tab bar is gone
 * (DESIGN.md §2), so the road to each surface is defined once here instead
 * of twenty-five times across e2e/ and shots/ — the next navigation change
 * is one edit, not a grep.
 *
 * `waitPaired` is the single "the app is showing its owner" signal: the
 * heading control exists (the palette's trigger, always present on the
 * list) and the first row is painted.
 */
import { expect, type Page } from '@playwright/test'

/** The list is up and has rows. Replaces every `nav.safe-bottom` wait. */
export async function waitPaired(page: Page): Promise<void> {
  await page.locator('h1 button.scope').waitFor()
  await page.locator('.pane:not(.off) button.row').first().waitFor()
}

/** Taps the heading and waits for the field the tap focuses. */
export async function openPalette(page: Page): Promise<void> {
  await page.locator('h1 button.scope').click()
  await expect(page.locator('.palette-field input')).toBeVisible()
}

/** Opens the Settings push layer from the gear. */
export async function openSettings(page: Page): Promise<void> {
  await page.locator('button.gear').click()
  await page.locator('.settings-layer button.back').waitFor()
}

/** Closes the Settings layer by its own back control. */
export async function closeSettings(page: Page): Promise<void> {
  await page.locator('.settings-layer button.back').click()
  await expect(page.locator('.settings-layer')).toHaveCount(0)
}
