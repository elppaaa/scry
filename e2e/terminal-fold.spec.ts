/*
 * The cell where a line folds keeps its glyph (GDK-1844).
 *
 * Reported against docs/media/terminal-hero.ja.mp4: in the clip's last
 * frame a full-width `作` and an ASCII `n` are both missing at the same x,
 * each one character past the right edge of a line. The round that measured
 * it found the pane innocent — at the clip's own geometry the PTY, xterm and
 * the painted grid all said 144 — and the TUI in the frame had laid its text
 * out to column 145. What survives here is the half that is ours: the three
 * widths must agree, and a glyph that lands in the last cell must be in the
 * buffer *and* on the screen.
 *
 * Geometry is part of the contract. The defect was latent for one take and
 * appeared in the next because the earlier one never touched the boundary,
 * so this runs at the recording rig's viewport (1440x900 @ DPR 2,
 * e2e/demo/terminal-claude.config.ts) and in `ja`, where the CJK metric
 * faces (GDK-1597) are the ones in play.
 *
 * Both reads, always. `readTerm` walks xterm's buffer, which can hold a
 * glyph the DOM renderer clips or drifts off the row; the painted rows are
 * the other owner, and a buffer-only assertion cannot tell them apart.
 *
 * Not FAIL-first: there is no unfixed source for it to be red against. The
 * three-width assertion passed the moment it was written — that measurement
 * is what cleared the pane — so this pins current behaviour rather than
 * closing a defect. It is the axis that was missing, not a fix.
 */
import { type Page } from '@playwright/test'
import { test, expect } from './helpers'
import { forceLocale, readTerm } from './helpers'
import { DEBUG_ATTRS_KEY } from '../web/src/lib/debug-attrs'

// The recording rig's three, together (e2e/demo/terminal-claude.config.ts).
// colorScheme is part of it even though the dock is dark under a light app
// theme by default (GDK-1357): what the rig set is what the clip measured,
// and a later theme change to the pane must not quietly move this geometry.
test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
})

/*
 * The buffer read is `readTerm` from e2e/term-read.ts and nothing else
 * (GDK-1567 holds that with a lint). Stitching is the right behaviour here,
 * not a compromise: a line that folds is one line the shell wrote, so the
 * glyph in the folding cell has to come back inside it — if the fold ate the
 * character, the stitched line is the thing that is missing it.
 */

/** What the DOM renderer actually put on the screen. */
async function paintedText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector('.xterm-rows')
    if (!host) return ''
    return Array.from(host.children)
      .map((el) => el.textContent ?? '')
      .join('')
  })
}

/** Write raw bytes into the VT and wait for xterm's parser to drain — write()
 *  is asynchronous, so reading the buffer without the callback reads the
 *  state before the payload. */
async function vtWrite(page: Page, data: string): Promise<void> {
  await page.evaluate(async (s: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (window as any).__gadakTerm
    await new Promise<void>((res) => t.write(s, () => res()))
  }, data)
}

async function openPane(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* blocked storage is off, not a throw */
    }
  }, DEBUG_ATTRS_KEY)
  await forceLocale(page, 'ja')
  await page.goto('/')
  await expect(page.getByTestId('issue-layout')).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Control+Backquote')
  await expect(page.getByTestId('terminal-pane')).toHaveAttribute('data-attached', 'true', {
    timeout: 20_000,
  })
  // The cell size IS the font metrics, and the CJK faces land late on a cold
  // serve; settleResize's own tail is 3s (web/src/lib/terminal/resize.ts).
  await page.waitForTimeout(3500)
  await page.evaluate(() => (document as unknown as { fonts: FontFaceSet }).fonts.ready)
}

function lastStty(text: string): string | null {
  const m = [...text.matchAll(/(\d+)\s+(\d+)/g)]
  return m.length ? m[m.length - 1][0] : null
}

test.describe('the terminal pane keeps the glyph in the folding cell (GDK-1844)', () => {
  /*
   * The three widths, at the geometry the clip was recorded at.
   *
   * GDK-1154 already holds PTY == xterm from the first prompt. What it does
   * not measure is the third number — the painted grid — and that is the one
   * the report accused: `renderer.ts` open() forces
   * `term.element.style.width = '100%'`, which is 41px wider than the fitted
   * grid here. Measured: the slack is unused space to the right of the last
   * column, not a column xterm believes in and cannot paint.
   */
  test('the PTY, xterm and the painted grid agree about the width', async ({ page }) => {
    test.setTimeout(120_000)
    await openPane(page)

    const pane = page.getByTestId('terminal-pane')
    const host = pane.locator('[data-gadak-editable]')
    await host.first().click({ position: { x: 24, y: 24 } })
    await page.evaluate(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="terminal-pane"] textarea')
        ?.focus()
    })
    await page.keyboard.type('stty size', { delay: 12 })
    await page.keyboard.press('Enter')
    await expect.poll(async () => lastStty(await readTerm(page))).toMatch(/\d+\s+\d+/)
    const stty = lastStty(await readTerm(page))
    const [ptyRows, ptyCols] = (stty ?? '').split(/\s+/).map(Number)

    const drawn = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const t = (window as any).__gadakTerm
      const dims = t?._core?._renderService?.dimensions
      const cell = dims?.css?.cell?.width ?? 0
      const screen = document.querySelector('.xterm-screen') as HTMLElement | null
      const w = screen?.getBoundingClientRect().width ?? 0
      return { cols: t?.cols ?? 0, rows: t?.rows ?? 0, cell, screenWidth: w }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    })

    // A laid-out pane, not the 10x5 floor a zero rect gives (GDK-1154).
    expect(ptyCols, `stty said "${stty}"`).toBeGreaterThan(20)
    expect(ptyRows, `stty said "${stty}"`).toBeGreaterThan(5)
    expect(drawn.cell, 'the render service reported no cell width').toBeGreaterThan(0)

    expect(
      ptyCols,
      `the PTY and xterm disagree: stty "${stty}" vs xterm ${JSON.stringify(drawn)}`,
    ).toBe(drawn.cols)

    // The painted grid, to the cell. Whole columns, not a fraction: a grid
    // that paints 143.6 columns is one whose last cell is clipped, which is
    // exactly the shape the report described.
    const renderedCols = drawn.screenWidth / drawn.cell
    expect(
      renderedCols,
      `xterm believes ${drawn.cols} columns but paints ${renderedCols.toFixed(2)} ` +
        `(screen ${drawn.screenWidth}px / cell ${drawn.cell}px)`,
    ).toBeCloseTo(drawn.cols, 1)

    // And the same three numbers where the next report can read them without
    // a debugger.
    const attr = await page.locator('html').getAttribute('data-term-widths')
    expect(attr, 'the termWidths debug attribute is missing').not.toBeNull()
    const [attrPty, attrXterm, attrRendered] = (attr ?? '').split('/').map(Number)
    expect({ pty: attrPty, xterm: attrXterm }, `data-term-widths="${attr}"`).toEqual({
      pty: drawn.cols,
      xterm: drawn.cols,
    })
    expect(attrRendered, `data-term-widths="${attr}"`).toBeCloseTo(drawn.cols, 1)
  })

  /*
   * The boundary itself, in the buffer and on the screen.
   *
   * Three shapes, because the report had two of them at one x: an ASCII tail
   * in the last cell, a full-width tail occupying the last two, and the
   * mixed row that produced the `n` — CJK for most of the line and Latin
   * running into the edge, where the CJK advance correction (GDK-1597) has
   * had the whole row to accumulate a drift.
   */
  test('a glyph that lands in the last cell survives, ASCII and full-width', async ({ page }) => {
    test.setTimeout(120_000)
    await openPane(page)

    const cols = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__gadakTerm?.cols ?? 0,
    )
    expect(cols, 'the renderer hook is missing or the pane is unlaid').toBeGreaterThan(40)

    const cjkFill = Math.floor(cols / 2)
    const mixCjk = Math.max(1, cjkFill - 3)
    const mixTail = cols - mixCjk * 2

    const cases = [
      { name: 'ascii filling the row', payload: 'x'.repeat(cols - 1) + 'Z', tail: 'Z' },
      { name: 'full-width filling the row', payload: '作'.repeat(cjkFill - 1) + '弐', tail: '弐' },
      {
        name: 'full-width row with an ascii tail in the last cell',
        payload: '作'.repeat(mixCjk) + 'y'.repeat(Math.max(0, mixTail - 1)) + 'n',
        tail: 'n',
      },
    ]

    for (const c of cases) {
      const mark = `FOLD${c.tail}`
      await vtWrite(page, `\r\n${mark}\r\n${c.payload}\r\n`)
      const buf = await readTerm(page)
      const paint = await paintedText(page)
      const bufAfter = buf.slice(buf.lastIndexOf(mark) + mark.length)
      const paintAfter = paint.slice(paint.lastIndexOf(mark) + mark.length)
      expect(
        bufAfter.includes(c.tail),
        `${c.name}: the buffer lost ${c.tail} at column ${cols} — tail ` +
          JSON.stringify(bufAfter.replace(/\s+$/, '').slice(-16)),
      ).toBe(true)
      expect(
        paintAfter.includes(c.tail),
        `${c.name}: the screen lost ${c.tail} at column ${cols} — painted tail ` +
          JSON.stringify(paintAfter.replace(/\s+$/, '').slice(-16)),
      ).toBe(true)
    }
  })

  /*
   * The redraw path, which is the one a TUI takes.
   *
   * Claude Code wraps its own text and repaints the block on every stream
   * chunk, so the cell at the fold is written and then written over. Erase
   * line with the cursor parked on the last cell, and Ink's "up one, erase,
   * rewrite" — the sequence that destroys an auto-wrapped character — are
   * the two that a plain `printf` never reaches.
   */
  test('a full row survives a TUI-style erase and rewrite', async ({ page }) => {
    test.setTimeout(120_000)
    await openPane(page)

    const cols = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__gadakTerm?.cols ?? 0,
    )
    const full = 'x'.repeat(cols - 1) + 'Z'

    const cases = [
      { mark: 'REDRAW1', payload: `${full}\x1b[K` },
      { mark: 'REDRAW2', payload: `${full}\r\nshort\r\x1b[2K\x1b[1A\x1b[2K\x1b[G${full}` },
      { mark: 'REDRAW3', payload: `${full}\rabc` },
    ]
    for (const c of cases) {
      await vtWrite(page, `\r\n${c.mark}\r\n${c.payload}\r\n`)
      const buf = await readTerm(page)
      const paint = await paintedText(page)
      const bufAfter = buf.slice(buf.lastIndexOf(c.mark) + c.mark.length)
      const paintAfter = paint.slice(paint.lastIndexOf(c.mark) + c.mark.length)
      expect(
        bufAfter.includes('Z'),
        `${c.mark}: the buffer lost the last-cell glyph — tail ` +
          JSON.stringify(bufAfter.replace(/\s+$/, '').slice(-20)),
      ).toBe(true)
      expect(
        paintAfter.includes('Z'),
        `${c.mark}: the screen lost the last-cell glyph — painted tail ` +
          JSON.stringify(paintAfter.replace(/\s+$/, '').slice(-20)),
      ).toBe(true)
    }
  })
})
