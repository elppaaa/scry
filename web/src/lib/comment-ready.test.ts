/*
 * GDK-1877: the desk composer used to arm Submit on attachments alone, and
 * the server refuses a text-less comment (400 text_required, write.go:615)
 * before it ever reads attachment_ids. So a picture-only comment was a
 * control whose only outcome was a failure toast.
 *
 * The predicate is the single owner of "may this be submitted"; the two
 * seats that read it (the footer button's disabled=, submit()'s early
 * return) are pinned in CommentComposer.test.ts, and the journey in
 * e2e/comment-visibility.spec.ts.
 */
import { describe, expect, test } from 'vitest'
import { commentReady } from './comment-ready'

describe('commentReady (GDK-1877)', () => {
  test('attachments alone never arm Submit', () => {
    // The bug: 1 attachment, no text was `true`, and the POST it sent came
    // back 400 with the files already on the issue.
    expect(commentReady('', 1, 0)).toBe(false)
    expect(commentReady('   \n  ', 3, 0)).toBe(false)
  })

  test('text alone arms it', () => {
    expect(commentReady('x', 0, 0)).toBe(true)
    expect(commentReady('  hi  ', 0, 0)).toBe(true)
  })

  test('empty text never arms it', () => {
    expect(commentReady('', 0, 0)).toBe(false)
    expect(commentReady('\t \n', 0, 0)).toBe(false)
  })

  test('an upload still in flight disarms it however much was typed', () => {
    // A file crossing the wire has no id yet, so the comment cannot carry it.
    expect(commentReady('a picture follows', 0, 1)).toBe(false)
    expect(commentReady('a picture follows', 2, 1)).toBe(false)
    expect(commentReady('a picture follows', 2, 0)).toBe(true)
  })
})
