/*
 * Captures for the GDK-1879 review round: the create sheet's picker, the chip
 * it makes before anything has been uploaded, the create button while bytes
 * are in flight, the refusal on a read-only serve, and — behind SHOTS_WRITES
 * — an issue that actually lands with the photo on it.
 *
 * Two tests, two serves, and the split is the point (the shape
 * zz-attach-shot.spec.ts and zz-parentlabels-shot.spec.ts already have):
 *
 *  - `captures` runs against the bundled demo, which is credential-less. Two
 *    GETs are answered so the real controls ship enabled rather than
 *    disabled: `credential/` (the store's writability probe) and
 *    `create-meta/` (the sheet's own catalog read — measured 409
 *    credential_required on this fixture, which latches writesOff and would
 *    leave nothing to tap). The create POST and the upload are routed only
 *    for the "Uploading… (1)" frame, which cannot otherwise be photographed:
 *    the serve's refusal lands in single-digit milliseconds.
 *  - `writes` is skipped unless SHOTS_WRITES=1, because it needs a serve that
 *    can write. Point it at a THROWAWAY built-in-tracker workspace (never
 *    `reviewdemo`, which is the App Store review origin):
 *
 *      GADAK_HOME=$HOME/.gadak <gate binary> --workspace wt1879 \
 *        migrate --from demo --skip-attachments
 *      GADAK_HOME=$HOME/.gadak <gate binary> --workspace wt1879 \
 *        serve --addr 127.0.0.1:7939 --no-sync --no-open
 *      SHOTS_WRITES=1 GADAK_MOBILE_E2E_PORT=5200 GADAK_MOBILE_API_PORT=7939 \
 *        npm run shots -- --grep createattach
 *
 * The project is discovered from the serve rather than spelled here: a
 * migrated mirror is not required to keep the demo's keys.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// One generator for the fixture both attachment specs pick (GDK-1879).
import { CHECKER_PNG } from '../e2e/checker-png'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'scratch', 'mobile-shots', 'createattach')

const PNG = CHECKER_PNG

function pick(): { name: string; mimeType: string; buffer: Buffer } {
  return { name: 'field.png', mimeType: 'image/png', buffer: PNG }
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))
  })
  await page.waitForTimeout(400)
}

/** Light then dark, one scene, so the pair can be read side by side. */
async function shootPair(page: Page, name: string): Promise<void> {
  await settle(page)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  await page.emulateMedia({ colorScheme: 'dark' })
  await settle(page)
  await page.screenshot({ path: join(outDir, `${name}-dark.png`) })
  await page.emulateMedia({ colorScheme: 'light' })
  await settle(page)
}

async function armProbe(page: Page): Promise<void> {
  await page.route('**/api/v1/credential/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true }),
    })
  })
}

/** The Issues tab's + action opens the sheet; the demo's catalog is faked. */
async function openCreateSheet(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('h1 button.scope').waitFor()
  await page.locator('.pane:not(.off) button.row').first().waitFor()
  await page.locator('.head button.new').click()
  await page.locator('.create input#create-summary').waitFor()
}

test('captures — the sheet picker, the chip, the uploading word and the refusal', async ({
  page,
}) => {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  await armProbe(page)
  await page.route('**/api/v1/issues/create-meta/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        projects: [
          { key: 'NMA', name: 'Northwind Mobile', issue_types: [{ id: '10001', name: 'Task' }] },
        ],
      }),
    })
  })

  /* 01 — the sheet at rest, with the paperclip beside the create button. */
  await openCreateSheet(page)
  await expect(page.locator('.create .go-row button.attach')).toBeVisible()
  await shootPair(page, '01-create-sheet-idle')

  /* 02 — one chip picked, with a title typed beside it. Nothing has been
     uploaded: there is no key yet, which is what this screen is about. */
  await page.locator('.sheet input[type="file"]').setInputFiles(pick())
  await page.locator('[data-testid="create-attachments"]').waitFor()
  await page.locator('.create .att-thumb').waitFor()
  await page.locator('.create input#create-summary').fill('Reproduced in the field — photo attached.')
  await shootPair(page, '02-chip-picked')

  /* 04 — the same pick on a serve that cannot write: the create itself is
     refused, so nothing is uploaded and the sheet recedes with the credential
     sentence in its own slot.

     The refusal is ROUTED rather than left to the serve, the way
     zz-attach-shot.spec.ts routes its own: this file is also run against the
     write-capable wt1879 serve (one `--grep createattach` covers both tests),
     and there an unrouted create would land a real issue and photograph the
     wrong thing. The code is the serve's own — 409 credential_required is
     what a credential-less `gadak demo` answers every non-GET (measured on
     this fixture, 2026-09-15).

     Shot BEFORE the uploading frame on purpose: a refused create leaves the
     app exactly where it was, while the frame below ends by opening an issue
     key that exists only in a route handler. Cheap order, no recovery step. */
  await page.route('**/api/v1/issues/create/', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'credential_required' }),
    })
  })
  await page.locator('.create button.go').click()
  await page.locator('.create .off-note').waitFor()
  await shootPair(page, '04-refused-on-demo')

  /* 03 — the create button in "Uploading… (1)". The create is answered at
     once and the upload is held open, so the frame between them can be
     photographed; a real upload of this size is gone before a shutter.

     A reload first: `writesOff` above latched the sheet, and the catalog
     cache that holds it is module scope for the life of the page
     (CreateSheet.svelte's `metaCache`), so only a fresh document clears it. */
  await page.unroute('**/api/v1/issues/create/')
  await page.route('**/api/v1/issues/create/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ origin: 'built-in', issue: { issue_key: 'NMA-900' } }),
    })
  })
  let release: (() => void) | null = null
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/v1/issues/*/attachments/', async (route) => {
    await held
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'credential_required' }),
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openCreateSheet(page)
  await page.locator('.sheet input[type="file"]').setInputFiles(pick())
  await page.locator('[data-testid="create-attachments"]').waitFor()
  await page.locator('.create input#create-summary').fill('Reproduced in the field — photo attached.')
  await page.locator('.create button.go').click()
  await expect(page.locator('.create button.go')).toHaveText(/\(1\)/)
  await shootPair(page, '03-create-uploading')
  release!()
})

test('writes — the issue lands with the photo on it', async ({ page }) => {
  test.skip(
    !process.env.SHOTS_WRITES,
    'needs a write-capable serve: SHOTS_WRITES=1 GADAK_MOBILE_API_PORT=<serve port>',
  )
  mkdirSync(outDir, { recursive: true })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('h1 button.scope').waitFor()
  await page.locator('.pane:not(.off) button.row').first().waitFor()

  await page.locator('.head button.new').click()
  await page.locator('.create input#create-summary').waitFor()

  // Nothing routed here: the bytes cross the wire, the serve writes the issue
  // and then the file to the origin, and the detail the app lands on is read
  // back out of it.
  await page.locator('.sheet input[type="file"]').setInputFiles(pick())
  await page.locator('[data-testid="create-attachments"]').waitFor()
  await page.locator('.create .att-thumb').waitFor()

  const title = `From the phone, with a photo — ${new Date().toISOString()}`
  await page.locator('.create input#create-summary').fill(title)

  // The key comes from the create's own response, not from the markup: that
  // is the value the screen itself used, and it cannot drift with a class
  // name. Registered before the click so the response cannot be missed.
  const created = page.waitForResponse('**/api/v1/issues/create/')
  await page.locator('.create button.go').click()
  const key = ((await (await created).json()) as { issue: { issue_key: string } }).issue.issue_key
  console.log(`[createattach] created ${key}`)

  // The sheet closes only when every upload landed — a refusal would keep it
  // open with the sentence in its error slot, which is the branch
  // src/lib/create-attach.test.ts measures.
  await page.locator('.sheet').waitFor({ state: 'hidden', timeout: 60_000 })
  const subject = page.locator('.detail-layer h1.type-subject').last()
  await expect(subject).toHaveText(title, { timeout: 60_000 })
  await shootPair(page, '05-landed-with-attachment')

  /*
   * The origin's own answer, quoted in the round report rather than trusted
   * from the screen — and here that is not a preference but the only
   * evidence there is. The phone's Detail has no attachments SECTION: the
   * only place attachment bytes reach this screen is inline inside an ADF
   * body (AdfBody, given detail.attachments to resolve media nodes with), and
   * a freshly created issue whose description names no media node has none.
   * So the picture is on the issue and the screen cannot say so. Reported to
   * the lead as a DESIGN.md §1 gap ("whatever the mirror holds, the phone
   * shows"), not patched here — a new section is a round of its own.
   */
  const detail = await page.request.get(`/api/v1/issues/${key}/detail/`)
  expect(detail.ok(), 'detail readback').toBeTruthy()
  const doc = (await detail.json()) as {
    issue_key?: string
    attachments?: { id: string; filename: string; is_image: boolean }[]
  }
  console.log(`[createattach] readback key=${JSON.stringify(doc.issue_key)}`)
  console.log(`[createattach] readback attachments=${JSON.stringify(doc.attachments ?? [])}`)
  // `summary` is not on this endpoint — measured 2026-09-15, the detail
  // payload's keys are attachments/bodies/comments/deploy/description_adf/
  // description_md/development_opinion/format_loss/history/issue_key/key/
  // last_visited_at/linked_issues/linked_prs/qa_context. The title is proved
  // on screen above; what only the origin can prove is the file.
  expect(doc.issue_key).toBe(key)
  expect((doc.attachments ?? []).some((a) => a.filename === 'field.png')).toBe(true)
})
