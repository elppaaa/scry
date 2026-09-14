// Attach a photo from the field (GDK-1872) — the transport half. This is the
// phone's one multipart verb, and it deliberately owns no UI: the picker, the
// composer chip and the Send button's upload state are part 2, built on top of
// what is here.
//
// The upload rides the same dial() as every JSON write (api.ts), which is the
// whole point: an out-of-scope endpoint, a dead pairing, a refused credential
// and a stale mirror all read here exactly as they read on a transition or a
// comment. There is no second refusal grammar for pictures.

import { ApiError, request, type ApiSession, type FetchLike } from './api'

/**
 * The server's cap, mirrored so a file can be refused before it is spent
 * (internal/server/write.go:38, `maxUpload = 64 << 20`).
 *
 * Not an exact twin, and the gap is on the safe side of nothing: write.go:693
 * wraps the *request body* in MaxBytesReader, so the multipart boundary and
 * the part headers are charged to the same budget. A file of exactly this
 * many bytes therefore overruns the reader and comes back 400 `file_required`
 * (r.FormFile fails; write.go:696), not 413. checkUploadable answers the
 * contract it was given — equal is allowed — and the margin is a product
 * decision for the composer, not one transport may make quietly.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * One row of the POST `<key>/attachments/` answer (write.go:713-722).
 *
 * `media_id` is always the empty string from this server — it is in the shape
 * for the desk's Jira-media embeds, and nothing on the phone may key on it.
 * `content_url` is a path under API_V1, which absoluteApiUrl() turns back into
 * something that survives being copied out of the app.
 */
export type UploadedAttachment = {
  id: string
  filename: string
  mime_type: string
  size: number
  media_id: string
  is_image: boolean
  is_video: boolean
  content_url: string
}

/**
 * The envelope body of POST `<key>/attachments/` (write.go:725). `origin` is
 * the write-origin label the serve logs alongside it; the desk's twin type
 * (web/src/lib/types.ts AttachmentUploadResponse) omits it because the desk
 * never reads it.
 *
 * Declared here rather than in types.ts on purpose this round — that file
 * belongs to the parallel round (GDK-1871); the lead folds this in on landing.
 */
export type AttachmentUploadResponse = {
  attachments: UploadedAttachment[]
  origin: string
}

/** Why a file cannot be sent. Both answers are knowable without dialing. */
export type UploadRefusal = 'too_large' | 'empty'

/**
 * Pure pre-flight, so the composer can refuse a file in the picker instead of
 * spending an upload on it. There is no type allowlist — Jira takes anything,
 * and inventing one here would refuse files the server would have accepted.
 *
 * Worth calling even though the server also checks: plugin-http hands the body
 * to Rust as a plain number array (index.js:68, `Array.from(new
 * Uint8Array(buffer))`), so a doomed 60 MB file is paid for twice over in the
 * WebView before the serve ever says no.
 */
export function checkUploadable(
  file: { size: number; type: string; name: string },
): { ok: true } | { ok: false; reason: UploadRefusal } {
  if (file.size <= 0) return { ok: false, reason: 'empty' }
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, reason: 'too_large' }
  return { ok: true }
}

/** Test seams, shaped like writes.ts's WriteOpts so the fold-in is a rename. */
export interface UploadOpts {
  session?: ApiSession
  fetchFn?: FetchLike
  signal?: AbortSignal
  /**
   * Reserved, and typed so it cannot be passed: there is no upload progress.
   * plugin-http's fetch takes the whole body across the IPC boundary in one
   * invoke (index.js:92) and reports nothing until the response head comes
   * back, so a percentage here would be a lie. The composer shows an
   * indeterminate state.
   */
  onProgress?: never
}

/**
 * POST `<key>/attachments/` — one file per request, multipart field `file`,
 * mirroring the desk's uploadCommentAttachment (web/src/lib/api.ts).
 *
 * A demo session refuses before any of this happens: request() hands the call
 * to demo.ts, which answers every non-GET with `credential_required` 409
 * (demo.ts:121-123), the same refusal the demo already gives a transition or a
 * comment. It is not given a second code here.
 *
 * A 502 `write_applied_mirror_stale` means the upload DID land and only the
 * mirror re-read failed (write.go:707-711) — the caller must not offer a
 * retry that would attach the picture twice.
 */
export async function uploadAttachment(
  issueKey: string,
  file: File,
  opts: UploadOpts = {},
): Promise<AttachmentUploadResponse> {
  const form = new FormData()
  form.append('file', file)
  const env = await request<AttachmentUploadResponse>(
    `issues/${encodeURIComponent(issueKey)}/attachments/`,
    {
      method: 'POST',
      form,
      session: opts.session,
      fetchFn: opts.fetchFn,
      signal: opts.signal,
    },
  )
  // Same grammar as writes.ts's unwrap(): a 2xx write carries its row back.
  if (env.body === null) throw new ApiError('bad_response', env.status)
  return env.body
}

/**
 * What the composer's chip says. The filename when there is one — a camera
 * roll pick can arrive without it, and then the mime subtype is the only
 * honest short word left (`image/jpeg` → `jpeg`).
 *
 * Answers '' when the row carries neither, which is the composer's cue to use
 * a catalog word: this module owns no copy and so cannot be the place a
 * user-visible English literal is born.
 */
export function attachmentLabel(a: UploadedAttachment): string {
  const name = a.filename.trim()
  if (name !== '') return name
  const type = a.mime_type.trim()
  const subtype = type.includes('/') ? type.slice(type.indexOf('/') + 1).trim() : ''
  return subtype !== '' ? subtype : type
}
