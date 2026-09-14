import { describe, it, expect, afterEach } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  attachmentLabel,
  checkUploadable,
  uploadAttachment,
  type UploadedAttachment,
} from './attach'
import { setDemoSession } from './demo'
import type { FetchLike } from './api'

const session = { endpoint: '', token: 'NMB-token' }

function fakeFetch(status: number, body: unknown): {
  fn: FetchLike
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }
  return { fn, calls }
}

function row(over: Partial<UploadedAttachment> = {}): UploadedAttachment {
  return {
    id: '10021',
    filename: 'field.jpg',
    mime_type: 'image/jpeg',
    size: 1024,
    media_id: '',
    is_image: true,
    is_video: false,
    content_url: '/api/v1/issues/NMB-1/attachments/10021/content/',
    ...over,
  }
}

// The module-level demo flag is shared by every test in this file; a leak
// would silently route the others through demo.ts's refusal.
afterEach(() => setDemoSession(false))

describe('checkUploadable', () => {
  it('refuses an empty file without naming it too large', () => {
    expect(checkUploadable({ size: 0, type: 'image/jpeg', name: 'a.jpg' })).toEqual({
      ok: false,
      reason: 'empty',
    })
  })

  it('allows exactly the server cap', () => {
    expect(checkUploadable({ size: MAX_UPLOAD_BYTES, type: 'image/jpeg', name: 'a.jpg' })).toEqual({
      ok: true,
    })
  })

  it('refuses one byte over the cap', () => {
    expect(
      checkUploadable({ size: MAX_UPLOAD_BYTES + 1, type: 'image/jpeg', name: 'a.jpg' }),
    ).toEqual({ ok: false, reason: 'too_large' })
  })

  it('mirrors the server constant exactly (write.go:38 maxUpload = 64 << 20)', () => {
    expect(MAX_UPLOAD_BYTES).toBe(64 << 20)
  })

  it('keeps no type allowlist — Jira takes anything', () => {
    expect(checkUploadable({ size: 12, type: 'application/x-weird', name: 'a.bin' })).toEqual({
      ok: true,
    })
    expect(checkUploadable({ size: 12, type: '', name: 'noext' })).toEqual({ ok: true })
  })
})

describe('uploadAttachment', () => {
  it('posts the file as multipart field `file` on the issue attachments path', async () => {
    const { fn, calls } = fakeFetch(200, { attachments: [row()], origin: 'built-in' })
    const file = new File(['bytes'], 'field.jpg', { type: 'image/jpeg' })
    const res = await uploadAttachment('NMB-1', file, { session, fetchFn: fn })

    expect(calls[0].url).toBe('/api/v1/issues/NMB-1/attachments/')
    expect(calls[0].init.method).toBe('POST')
    const sent = calls[0].init.body as FormData
    expect(sent).toBeInstanceOf(FormData)
    const part = sent.get('file') as File
    expect(part).toBeInstanceOf(File)
    expect(part.name).toBe('field.jpg')
    expect(part.type).toBe('image/jpeg')
    // One file per request (write.go handleUpload reads a single "file").
    expect(sent.getAll('file')).toHaveLength(1)
    expect(res.attachments[0].id).toBe('10021')
    expect(res.origin).toBe('built-in')
  })

  it('never declares a Content-Type — only the runtime knows the boundary', async () => {
    const { fn, calls } = fakeFetch(200, { attachments: [], origin: 'built-in' })
    await uploadAttachment('NMB-1', new File(['b'], 'a.jpg', { type: 'image/jpeg' }), {
      session,
      fetchFn: fn,
    })
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('escapes a key that would otherwise reshape the path', async () => {
    const { fn, calls } = fakeFetch(200, { attachments: [], origin: 'built-in' })
    await uploadAttachment('NM B/1', new File(['b'], 'a.jpg'), { session, fetchFn: fn })
    expect(calls[0].url).toBe('/api/v1/issues/NM%20B%2F1/attachments/')
  })

  it('refuses a demo session through the existing write refusal, without dialing', async () => {
    // demo.ts:121-123 answers every non-GET credential_required 409 — the same
    // refusal a demo transition or comment gets. No second code for pictures.
    setDemoSession(true)
    const { fn, calls } = fakeFetch(200, { attachments: [], origin: 'built-in' })
    await expect(
      uploadAttachment('NMB-1', new File(['b'], 'a.jpg', { type: 'image/jpeg' }), {
        session,
        fetchFn: fn,
      }),
    ).rejects.toMatchObject({ code: 'credential_required', status: 409 })
    expect(calls).toHaveLength(0)
  })

  it('surfaces the stale-mirror 502 by its code, since the upload did land', async () => {
    const { fn } = fakeFetch(502, { error: 'write_applied_mirror_stale' })
    await expect(
      uploadAttachment('NMA-7', new File(['b'], 'a.jpg'), { session, fetchFn: fn }),
    ).rejects.toMatchObject({ code: 'write_applied_mirror_stale', status: 502 })
  })

  it('calls a 2xx with no row back bad_response, not an empty success', async () => {
    const fn: FetchLike = async () => new Response('not json', { status: 200 })
    await expect(
      uploadAttachment('NMA-7', new File(['b'], 'a.jpg'), { session, fetchFn: fn }),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('attachmentLabel', () => {
  it('prefers the filename', () => {
    expect(attachmentLabel(row({ filename: 'roof-crack.heic' }))).toBe('roof-crack.heic')
  })

  it('falls back to the mime subtype for an unnamed camera pick', () => {
    expect(attachmentLabel(row({ filename: '' }))).toBe('jpeg')
    expect(attachmentLabel(row({ filename: '   ' }))).toBe('jpeg')
  })

  it('gives a non-image the same treatment rather than nothing', () => {
    expect(
      attachmentLabel(row({ filename: '', mime_type: 'application/pdf', is_image: false })),
    ).toBe('pdf')
  })

  it('does not break on a type with no slash, and answers empty when there is nothing to say', () => {
    expect(attachmentLabel(row({ filename: '', mime_type: 'binary' }))).toBe('binary')
    // '' is the composer's cue to use a catalog word: this module owns no copy.
    expect(attachmentLabel(row({ filename: '', mime_type: '' }))).toBe('')
  })
})
