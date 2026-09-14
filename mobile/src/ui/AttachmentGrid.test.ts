import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isImageAttachment,
  mimeSubtype,
  partitionAttachments,
  type CellStatus,
} from './AttachmentGrid.svelte'
import type { DetailAttachment } from '../lib/types'

/*
 * GDK-1882 — the Attachments section, as contracts.
 *
 * Same style as this directory's other component tests (GlanceStrip,
 * KeyBar): real calls into the pure half, plus source contracts over the
 * .svelte for the few promises that live in markup and CSS and have no
 * function to call. There is no DOM mount harness under mobile/src; the
 * rendered half is measured in mobile/e2e/detail-attachments.spec.ts, which
 * is where the bytes, the viewer and the "nothing embeds it" case are.
 */

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'AttachmentGrid.svelte'), 'utf8')

/*
 * The two halves scanned separately, because the whole file is the wrong
 * unit for either: prose about a 118px cell is not a declared size, and a
 * comment explaining why there is no download verb is not one. A contract
 * test that reads its own explanation is a test that goes red when someone
 * writes a better comment.
 */
const styles = source.slice(source.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '')
const markup = source
  .slice(source.lastIndexOf('</script>'), source.indexOf('<style>'))
  .replace(/<!--[\s\S]*?-->/g, '')

function row(over: Partial<DetailAttachment> = {}): DetailAttachment {
  return {
    id: 'jira:1',
    filename: 'a.png',
    mime_type: 'image/png',
    size: 1024,
    media_id: '',
    media_collection: '',
    is_image: true,
    is_video: false,
    cache_status: 'ready',
    created_at: null,
    content_url: '/api/v1/issues/NMB-1/attachments/1/',
    ...over,
  }
}

describe('isImageAttachment', () => {
  it('takes the server flag', () => {
    expect(isImageAttachment({ is_image: true, mime_type: '' })).toBe(true)
    expect(isImageAttachment({ is_image: false, mime_type: 'application/pdf' })).toBe(false)
  })

  it('falls back to the mime prefix when the flag was never computed', () => {
    // An upload response and an older serve can both hand back a row with
    // is_image unset; a picture drawn as a ledger line is the worse answer.
    expect(isImageAttachment({ is_image: false, mime_type: 'image/jpeg' })).toBe(true)
    expect(isImageAttachment({ is_image: false, mime_type: ' IMAGE/PNG ' })).toBe(true)
  })

  it('does not read a video or a name that merely contains the word', () => {
    expect(isImageAttachment({ is_image: false, mime_type: 'video/mp4' })).toBe(false)
    expect(isImageAttachment({ is_image: false, mime_type: 'text/image-notes' })).toBe(false)
  })
})

describe('partitionAttachments', () => {
  const img = row({ id: 'i1' })
  const pdf = row({ id: 'f1', filename: 'spec.pdf', mime_type: 'application/pdf', is_image: false })

  it('puts pictures in the grid and everything else in the ledger', () => {
    const split = partitionAttachments([img, pdf], () => 'ready')
    expect(split.thumbs.map((a) => a.id)).toEqual(['i1'])
    expect(split.rows.map((a) => a.id)).toEqual(['f1'])
  })

  it('keeps an unresolved picture in the grid — the cell is the loading state', () => {
    const split = partitionAttachments([img], () => 'loading')
    expect(split.thumbs.map((a) => a.id)).toEqual(['i1'])
    expect(split.rows).toEqual([])
  })

  it('demotes a failed picture to a filename row, never an empty cell', () => {
    const split = partitionAttachments([img, pdf], (a) => (a.id === 'i1' ? 'failed' : 'ready'))
    expect(split.thumbs).toEqual([])
    expect(split.rows.map((a) => a.id)).toEqual(['i1', 'f1'])
  })

  it('keeps the response order inside each half', () => {
    const rows = [row({ id: 'a' }), pdf, row({ id: 'b' }), row({ id: 'c' })]
    const status = (a: DetailAttachment): CellStatus => (a.id === 'b' ? 'failed' : 'ready')
    const split = partitionAttachments(rows, status)
    expect(split.thumbs.map((a) => a.id)).toEqual(['a', 'c'])
    expect(split.rows.map((a) => a.id)).toEqual(['f1', 'b'])
  })
})

describe('mimeSubtype', () => {
  it('is the half after the slash, quietly', () => {
    expect(mimeSubtype('application/pdf')).toBe('pdf')
    expect(mimeSubtype('IMAGE/PNG')).toBe('png')
  })

  it('answers the empty string rather than inventing a word', () => {
    expect(mimeSubtype('')).toBe('')
    expect(mimeSubtype('   ')).toBe('')
  })

  it('keeps a type with no subtype whole', () => {
    expect(mimeSubtype('application')).toBe('application')
  })
})

describe('the markup promises the pure half cannot hold', () => {
  it('draws three square cells per row with the gap and radius the spec fixed', () => {
    expect(source).toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/)
    expect(source).toMatch(/aspect-ratio:\s*1/)
    expect(source).toMatch(/gap:\s*8px/)
    expect(source).toMatch(/border-radius:\s*6px/)
    expect(source).toMatch(/object-fit:\s*cover/)
  })

  it('paints an unresolved cell on the panel token, never a broken image', () => {
    expect(source).toContain('background: var(--color-bg-panel)')
    // The <img> appears only once bytes have arrived; there is no eager src
    // for the browser to fail on its own.
    expect(source).toMatch(/\{#if cells\[a\.id\]\?\.url\}/)
  })

  it('carries no mobile hex and no px outside the four the spec fixed', () => {
    // DESIGN.md §3.1: web tokens are the single owner of colour. The three
    // lengths are the spec's two (8px gap, 6px radius) plus the house
    // hairline §3.3 names; nothing else may be authored here.
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    const px = [...styles.matchAll(/(\d+)px/g)].map((m) => m[1])
    expect([...new Set(px)].sort()).toEqual(['1', '6', '8'])
  })

  it('leaves a non-image row inert — no download verb the phone cannot keep', () => {
    const file = markup.slice(markup.indexOf('data-testid="attachment-file"'))
    expect(file).not.toContain('<button')
    expect(markup).not.toMatch(/download|href=/i)
  })

  it('reuses the one URL join and the one viewer instead of a second copy', () => {
    expect(source).toContain("from '../lib/attach'")
    expect(source).toContain('attachmentPath(a.content_url)')
    expect(source).toContain("import AttachmentViewer from './AttachmentViewer.svelte'")
    expect(source).toContain('requestBlob(path)')
  })

  it('revokes its object URLs, and drops the viewer before it does', () => {
    const teardown = source.slice(source.indexOf('onDestroy('))
    expect(teardown.indexOf('viewer = null')).toBeLessThan(teardown.indexOf('revokeObjectURL'))
  })

  it('reaches the catalog only through lib/i18n (DESIGN.md §3.6)', () => {
    expect(source).toContain("import { t } from '../lib/i18n'")
    expect(source).not.toContain('web/src/lib/i18n')
  })
})
