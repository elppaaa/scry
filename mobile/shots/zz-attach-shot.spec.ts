/*
 * Captures for the GDK-1872 part-2 review round: the composer's picker, the
 * chip it makes, the Send button while bytes are in flight, the refusal on a
 * read-only serve, and — behind SHOTS_WRITES — a comment that actually lands
 * with the picture inside it.
 *
 * Two tests, two serves, and the split is the point (same shape as
 * zz-parentlabels-shot.spec.ts):
 *
 *  - `captures` runs against the bundled demo, which is credential-less: the
 *    store's writability probe says off there and every write control would
 *    ship disabled, so this arms GET credential/ the way the e2e specs do.
 *    The upload answers are routed too — a serve with no origin credential
 *    can only refuse, and a refusal photographs no chip.
 *  - `writes` is skipped unless SHOTS_WRITES=1, because it needs a serve that
 *    can actually write. Point it at a THROWAWAY built-in-tracker workspace
 *    (never `reviewdemo`, which is the App Store review origin):
 *
 *      GADAK_HOME=$HOME/.gadak <gate binary> --workspace wt1872 \
 *        migrate --from demo --skip-attachments
 *      GADAK_HOME=$HOME/.gadak <gate binary> --workspace wt1872 \
 *        serve --addr 127.0.0.1:7931 --no-sync --no-open
 *      SHOTS_WRITES=1 GADAK_MOBILE_E2E_PORT=5195 GADAK_MOBILE_API_PORT=7931 \
 *        npm run shots -- --grep attach
 *
 * The issue is discovered from the serve rather than spelled here: a migrated
 * mirror is not required to keep the demo's keys, and hierarchy_level is the
 * axis a standard row is picked on — never the type's display name.
 */
import { deflateSync } from 'node:zlib'
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'scratch', 'mobile-shots', 'attach')

/**
 * A real PNG with visible pixels — a 32×32 two-colour checkerboard, built
 * here with zlib so the bytes are always a valid stream. The committed base64
 * this replaced (2026-09-14) decoded to a truncated IDAT: WebKit painted it
 * as nothing, and the vision pass read "no photo anywhere" off captures whose
 * renderer was fine. A fixture that cannot be seen cannot prove a thumbnail.
 */
function checkerPng(size = 32, cell = 8): Buffer {
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc32 = (buf: Buffer): number => {
    let c = -1
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0 // filter none
    for (let x = 0; x < size; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      const o = y * (size * 3 + 1) + 1 + x * 3
      // 쪽빛 on paper — the app's own two colours, so the thumbnail reads as
      // a picture in both themes rather than a grey square.
      raw[o] = dark ? 0x2e : 0xf4
      raw[o + 1] = dark ? 0x45 : 0xef
      raw[o + 2] = dark ? 0x60 : 0xe4
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG = checkerPng()

function pick(): { name: string; mimeType: string; buffer: Buffer } {
  return { name: 'field.png', mimeType: 'image/png', buffer: PNG }
}

const UPLOADED = (key: string) => ({
  origin: 'built-in',
  attachments: [
    {
      id: '10021',
      filename: 'field.png',
      mime_type: 'image/png',
      size: PNG.length,
      media_id: '',
      is_image: true,
      is_video: false,
      content_url: `/api/v1/issues/${key}/attachments/10021/content/`,
    },
  ],
})

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

/** Search → row → detail, the one road that does not depend on a scope. */
async function openIssue(page: Page, key: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('nav.safe-bottom').waitFor()
  await page.locator('.pane:not(.off) button.row').first().waitFor()
  await page.locator('nav.safe-bottom button.tab').nth(1).click()
  await page.locator('.pane:not(.off) input').first().fill(key)
  const hit = page.locator('.pane:not(.off) button.row', { hasText: key }).first()
  await hit.waitFor()
  await hit.click()
  await page.locator('button.back').waitFor()
}

/** The serve's own answer for which row is a standard issue. */
async function pickKey(page: Page): Promise<string> {
  const res = await page.request.get('/api/v1/issues/bootstrap/')
  expect(res.ok(), 'bootstrap').toBeTruthy()
  const body = (await res.json()) as { issues: { issue_key: string; hierarchy_level?: number }[] }
  const row = body.issues.find((i) => i.hierarchy_level === 0)
  expect(row, 'a standard row in the mirror').toBeTruthy()
  console.log(`[attach] standard ${row!.issue_key}`)
  return row!.issue_key
}

async function armWrites(page: Page): Promise<void> {
  await page.route('**/api/v1/credential/', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ configured: true }),
    })
  })
}

test('captures — the picker, the chip, the uploading word and the refusal', async ({ page }) => {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  await armWrites(page)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.pane:not(.off) button.row').first().waitFor()
  const key = await pickKey(page)

  /* 01 — the composer at rest, with the picker beside the field. */
  await openIssue(page, key)
  await expect(page.locator('.composer button.attach')).toBeVisible()
  await shootPair(page, '01-composer-idle')

  /* 03 — Send in "Uploading… (1)". The request is held open so the state can
     be photographed; a real upload of this size is gone before a shutter. */
  let release: (() => void) | null = null
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/v1/issues/*/attachments/', async (route) => {
    await held
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(UPLOADED(key)),
    })
  })
  await page.route(`**/api/v1/issues/${key}/attachments/10021/content/`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  await page.locator('.composer-slab input[type="file"]').setInputFiles(pick())
  await expect(page.locator('.composer button.send')).toHaveText(/\(1\)/)
  await shootPair(page, '03-send-uploading')

  /* 02 — the chip row, thumbnail and all, with a line typed beside it. */
  release!()
  await page.locator('[data-testid="composer-attachments"]').waitFor()
  await page.locator('.composer .att-thumb').waitFor()
  await page.locator('.composer input').fill('Reproduced in the field — photo attached.')
  await shootPair(page, '02-chip-row')

  /* 04 — the same pick on a serve that cannot write: the refusal latches and
     the composer recedes, with the sentence on the status row. */
  await page.unroute('**/api/v1/issues/*/attachments/')
  await page.route('**/api/v1/issues/*/attachments/', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'credential_required' }),
    })
  })
  await openIssue(page, key)
  await page.locator('.composer-slab input[type="file"]').setInputFiles(pick())
  await page.locator('.composer.off').waitFor()
  await shootPair(page, '04-refused-on-demo')
})

test('writes — the photo goes with the comment and lands inline', async ({ page }) => {
  test.skip(
    !process.env.SHOTS_WRITES,
    'needs a write-capable serve: SHOTS_WRITES=1 GADAK_MOBILE_API_PORT=<serve port>',
  )
  mkdirSync(outDir, { recursive: true })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('.pane:not(.off) button.row').first().waitFor()
  const key = await pickKey(page)

  await openIssue(page, key)
  // Nothing routed here: the bytes cross the wire, the serve writes them to
  // the origin, and the chip's thumbnail is fetched back out of it.
  await page.locator('.composer-slab input[type="file"]').setInputFiles(pick())
  await page.locator('[data-testid="composer-attachments"]').waitFor()
  await page.locator('.composer .att-thumb').waitFor()

  const line = `From the phone, with a photo — ${new Date().toISOString()}`
  await page.locator('.composer input').fill(line)
  await page.locator('.composer button.send').click()

  // The comment is in the thread, and the picture is in the comment: AdfBody
  // renders the media node the server embedded from the attachment id.
  const landed = page.locator('.comment', { hasText: 'From the phone, with a photo' }).last()
  await expect(landed).toBeVisible({ timeout: 30_000 })
  await expect(landed.locator('.adf img')).toHaveCount(1)
  // The chips are gone: those files are on the issue and in the comment now.
  await expect(page.locator('[data-testid="composer-attachments"]')).toHaveCount(0)
  await landed.scrollIntoViewIfNeeded()
  await shootPair(page, '05-landed-with-image')

  // The origin's own answer, quoted in the round report rather than trusted
  // from the screen: the attachment is on the issue and the comment names it.
  const detail = await page.request.get(`/api/v1/issues/${key}/detail/`)
  expect(detail.ok(), 'detail readback').toBeTruthy()
  const doc = (await detail.json()) as {
    attachments?: { id: string; filename: string; is_image: boolean }[]
    comments?: { body?: string; raw_body?: string | null }[]
  }
  console.log(
    `[attach] readback attachments=${JSON.stringify(doc.attachments?.slice(-2) ?? [])}`,
  )
  const last = (doc.comments ?? []).at(-1)
  console.log(`[attach] readback last comment=${JSON.stringify(last)?.slice(0, 600)}`)
  expect((doc.attachments ?? []).some((a) => a.filename === 'field.png')).toBe(true)
})
