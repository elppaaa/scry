/*
 * The one decision the desk's comment composer makes about Submit
 * (GDK-1877): may this comment be sent.
 *
 * Pure on purpose, and the single owner of that answer. It used to be
 * decided twice — once in the footer button's `disabled=` and once in
 * submit()'s early return — and the two seats are how a keyboard submit
 * (⌘/Ctrl+Enter) slips past a greyed-out button.
 */

/**
 * May Submit fire.
 *
 * `uploading === 0` is the half the desk and the phone always agreed on: a
 * file still crossing the wire has no id yet, so a comment sent now cannot
 * carry it.
 *
 * The text half is the fix. The composer used to arm on attachments alone,
 * but **the server refuses a text-less comment**:
 * internal/server/write.go:615 answers 400 `text_required` on
 * `strings.TrimSpace(body.Text) == ""`, unconditionally, before
 * `attachment_ids` is read at all. An armed Submit there is a control whose
 * only outcome is a failure toast — and `text_required` is not in
 * i18n/errors.ts's map, so it is the generic sentence at that. Nothing is
 * lost by the stricter rule: the upload already attached the files to the
 * issue; the comment only embeds them.
 *
 * `attachments` is taken and ignored so this asks the same three questions
 * in the same order as the phone's sendReady
 * (mobile/src/lib/composer-attach.ts) — the count here rather than the list,
 * which is all a pure predicate needs — and so the switch, if the server
 * ever accepts ids with empty text, is one expression in each place:
 * `(text.trim() !== '' || attachments > 0) && uploading === 0`.
 *
 * `busy` and the restriction guard are deliberately NOT here: they are the
 * composer's own transient state, not the readiness of what was typed.
 */
export function commentReady(text: string, attachments: number, uploading: number): boolean {
  void attachments
  return text.trim() !== '' && uploading === 0
}
