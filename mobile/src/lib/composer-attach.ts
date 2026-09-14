/*
 * The two decisions the comment composer makes once a photo is in it
 * (GDK-1872 part 2): may Send fire, and what does the POST carry.
 *
 * Pure on purpose. Both answers are one boolean and one object, and both are
 * exactly the kind of thing a screen gets subtly wrong — an armed Send while
 * an upload is still in flight posts a comment that names no picture, and an
 * `attachment_ids: []` on every ordinary comment is a wire change nobody
 * asked for. Detail.svelte paints what these answer.
 */

import type { UploadedAttachment } from './types'

/**
 * May Send fire.
 *
 * `uploading === 0` is the half the desk and the phone agree on: a file still
 * crossing the wire has no id yet, so a comment sent now cannot carry it.
 *
 * The text half is where the phone deliberately differs from
 * web/src/components/write/CommentComposer.svelte:357, which arms on
 * attachments alone. **The server refuses a text-less comment**:
 * internal/server/write.go:615 answers 400 `text_required` on
 * `strings.TrimSpace(body.Text) == ""`, unconditionally, before
 * `attachment_ids` is read at all. Arming Send there would offer a control
 * whose only outcome is a refusal the phone has no sentence for
 * (`text_required` is not in api.ts's errorMessage map, so it would print
 * the generic one). Nothing is lost by the stricter rule: the upload already
 * attached the file to the issue — the comment only embeds it.
 *
 * If the server ever accepts ids with empty text, this becomes
 * `(text.trim() !== '' || attachments.length > 0) && uploading === 0` and
 * nothing else on the screen changes.
 */
export function sendReady(
  text: string,
  attachments: readonly UploadedAttachment[],
  uploading: number,
): boolean {
  void attachments
  return text.trim() !== '' && uploading === 0
}

/** The POST body of `issues/<key>/comment/`. */
export interface CommentBody {
  text: string
  attachment_ids?: string[]
}

/**
 * What the comment carries. The ids render the files inline in the body; the
 * files are attached to the issue either way (write.go:598).
 *
 * The array is omitted, never sent empty: an ordinary comment's body on this
 * screen must stay byte-identical to what it was before this round, so the
 * one test that can tell the two apart is the server's own handler.
 */
export function commentBody(
  text: string,
  attachments: readonly UploadedAttachment[],
): CommentBody {
  const ids = attachments.map((a) => a.id).filter((id) => id !== '')
  return ids.length > 0 ? { text, attachment_ids: ids } : { text }
}
