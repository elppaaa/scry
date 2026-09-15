/*
 * GDK-1882 — the Attachments section on the phone's Detail.
 *
 * The defect this measures is an absence, so a unit cannot see it: until
 * this round the phone drew attachment bytes *only* where an ADF body
 * referenced them (AdfBody's prime pass), which means a file nobody embedded
 * was on the phone and invisible on it. DESIGN.md §1: "Whatever the mirror
 * holds, the phone shows."
 *
 * The demo fixture carries the exact shape the bug needs, which is why the
 * assertion can be specific rather than a count:
 *
 *   NMB-110 (jira:10315) has three attachments —
 *     nimbus-error.png          ← referenced by a comment's media node
 *     cache-key-sketch.png      ← referenced by a comment's media node
 *     latency-before-after.png  ← referenced by nothing
 *
 * So the last one is the regression's whole subject: it must appear in the
 * section, and it must still appear nowhere in the rendered body. If the
 * section is ever deleted or stops rendering non-embedded rows, the second
 * test here goes red naming that filename.
 */
import { type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './helpers'
import { openPalette, waitPaired } from './nav'

const ISSUE = 'NMB-110'

/** The attachment on this issue that no body embeds — the defect's subject. */
const ORPHAN = 'latency-before-after.png'

/** Every attachment row the fixture holds for NMB-110, all images. */
const ALL = ['nimbus-error.png', 'cache-key-sketch.png', ORPHAN]

/**
 * Captures happen only when a round asks for them (GDK-1570, e2e/
 * capture-guard.unit.ts): `GDK1882_SHOT_DIR=<dir>` on the gate command. An
 * unset var leaves this a behaviour spec that photographs nothing, which is
 * what CI wants — nobody consumes a PNG CI took on its own.
 */
async function capture(page: Page, name: string): Promise<void> {
  const dir = process.env.GDK1882_SHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name) })
}

/**
 * Palette → row → detail, the pane's own road to any key. GDK-902
 * 2026-09-15: written against the tab bar the same day it was removed; the
 * road is now the heading's palette with the key as the query (nav.ts).
 */
async function openIssue(page: Page, key: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await waitPaired(page)
  await openPalette(page)
  await page.locator('.palette-field input').fill(key)
  const row = page.locator('.pane:not(.off) button.row', { hasText: key }).first()
  await row.waitFor()
  await row.click()
  await page.locator('button.back').waitFor()
}

test('an issue with attachments shows the section, thumbnails resolved', async ({ page }) => {
  await openIssue(page, ISSUE)

  const section = page.locator('[data-testid="detail-attachments"]')
  await expect(section).toBeVisible()

  // The heading carries the count in the same mono folio the comments
  // heading uses (DESIGN.md §3.2), so the number is readable as text.
  await expect(page.locator('[data-testid="detail-attachments-count"]')).toHaveText(
    String(ALL.length),
  )

  const thumbs = section.locator('[data-testid="attachment-thumb"]')
  await expect(thumbs).toHaveCount(ALL.length)

  // Bytes arrive through requestBlob (bearer included), so a resolved cell
  // holds an object URL. A cell that never resolved would keep no src at
  // all and this is what separates "the grid is drawn" from "the grid
  // shows the picture".
  for (const name of ALL) {
    const cell = thumbs.filter({ has: page.locator(`img[alt="${name}"]`) })
    await expect(cell).toHaveCount(1)
    const img = cell.locator('img')
    await expect(img).toHaveAttribute('src', /^blob:/)
    // Decoded, not merely assigned: a blob the fetch got wrong still becomes
    // an object URL, and only naturalWidth knows the difference.
    expect(
      await img.evaluate((el: HTMLImageElement) => el.naturalWidth),
      `${name} decoded`,
    ).toBeGreaterThan(0)
  }

  await section.scrollIntoViewIfNeeded()
  await capture(page, 'detail-attachments.png')
})

test('an attachment no body embeds is visible in the section', async ({ page }) => {
  await openIssue(page, ISSUE)

  // Half one: the rendered bodies reference two of the three. The renderer
  // puts the filename in the <img alt> of every media node it resolves
  // (web/src/lib/adf.ts renderAttachment), so its absence there is the
  // "not embedded" proof and not an assumption about the fixture's prose.
  const embedded = page.locator(`.adf-media-image img[alt="${ORPHAN}"]`)
  await expect(embedded).toHaveCount(0)

  // Half two: it is on the screen anyway. This pair is the regression —
  // before GDK-1882 the first assertion passed and the second could not.
  const cell = page
    .locator('[data-testid="detail-attachments"] [data-testid="attachment-thumb"]')
    .filter({ has: page.locator(`img[alt="${ORPHAN}"]`) })
  await expect(cell).toHaveCount(1)
  await expect(cell).toBeVisible()
})

test('a thumbnail opens the full-screen viewer, and back closes the viewer', async ({ page }) => {
  await openIssue(page, ISSUE)

  const cell = page
    .locator('[data-testid="detail-attachments"] [data-testid="attachment-thumb"]')
    .filter({ has: page.locator(`img[alt="${ORPHAN}"]`) })
  await cell.click()

  const viewer = page.locator('[data-testid="attachment-viewer"]')
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveAttribute('aria-label', ORPHAN)

  // The viewer registers with lib/back, so the detail underneath stays put.
  await page.goBack()
  await expect(viewer).toHaveCount(0)
  await expect(page.locator('button.back')).toBeVisible()
})
