import { describe, expect, it } from 'vitest'
import { commentBody, sendReady } from './composer-attach'
import type { UploadedAttachment } from './types'

function row(over: Partial<UploadedAttachment> = {}): UploadedAttachment {
  return {
    id: '10021',
    filename: 'field.jpg',
    mime_type: 'image/jpeg',
    size: 2048,
    media_id: '',
    is_image: true,
    is_video: false,
    content_url: '/api/v1/issues/NMB-1/attachments/10021/content/',
    ...over,
  }
}

describe('GDK-1872 sendReady', () => {
  it('arms on typed text with nothing uploading', () => {
    expect(sendReady('one line', [], 0)).toBe(true)
    expect(sendReady('one line', [row()], 0)).toBe(true)
  })

  it('stays disarmed while an upload is in flight', () => {
    expect(sendReady('one line', [], 1)).toBe(false)
    expect(sendReady('one line', [row()], 2)).toBe(false)
  })

  it('stays disarmed on whitespace alone', () => {
    expect(sendReady('   ', [row()], 0)).toBe(false)
    expect(sendReady('\n\t', [], 0)).toBe(false)
  })

  it('does NOT arm on attachments alone — write.go:615 answers 400 text_required', () => {
    // Deliberate divergence from the desk (CommentComposer.svelte:357 arms on
    // `text.trim().length > 0 || attachments.length > 0`). handleComment
    // refuses `strings.TrimSpace(body.Text) == ""` before it reads
    // attachment_ids, so the desk's armed Send posts a comment the server
    // rejects. Measured against a write-capable serve — see the round report.
    expect(sendReady('', [row()], 0)).toBe(false)
    expect(sendReady('', [row(), row({ id: '10022' })], 0)).toBe(false)
  })
})

describe('GDK-1872 commentBody', () => {
  it('omits the array entirely when nothing is attached', () => {
    const body = commentBody('one line', [])
    expect(body).toEqual({ text: 'one line' })
    expect('attachment_ids' in body).toBe(false)
  })

  it('carries the ids in pick order', () => {
    expect(commentBody('look', [row({ id: 'a' }), row({ id: 'b' })])).toEqual({
      text: 'look',
      attachment_ids: ['a', 'b'],
    })
  })

  it('drops an id-less row rather than sending an empty string', () => {
    // write.go skips `id == ""` too; not sending it keeps the wire honest
    // about how many files the comment claims to embed.
    expect(commentBody('look', [row({ id: '' }), row({ id: 'b' })])).toEqual({
      text: 'look',
      attachment_ids: ['b'],
    })
    expect(commentBody('look', [row({ id: '' })])).toEqual({ text: 'look' })
  })

  it('passes the text through untouched — trimming is the caller’s', () => {
    expect(commentBody('  padded  ', [])).toEqual({ text: '  padded  ' })
  })
})
