import { describe, it, expect } from 'vitest'
import { knownLabels, sameLabels, splitLabelInput } from './labels'

/*
 * The label picker's rows (GDK-1871). The serve has no labels catalog, so
 * the rows are read off the snapshot the phone already holds — which makes
 * this the module that decides what a person can tap, and these the cases a
 * capture cannot reach.
 */

describe('knownLabels — the distinct set across the snapshot', () => {
  it('dedupes across rows and sorts', () => {
    expect(
      knownLabels([
        { labels: ['regression', 'papercut'] },
        { labels: ['papercut'] },
        { labels: ['accessibility'] },
      ]),
    ).toEqual(['accessibility', 'papercut', 'regression'])
  })

  it('trims, drops blanks, and skips a row cached before labels were parsed', () => {
    // `labels` is non-optional on the owner, but a snapshot an older phone
    // wrote predates the field — every read here coalesces, exactly as
    // fields.ts does.
    expect(
      knownLabels([
        { labels: ['  spaced  ', '   ', ''] },
        {},
        { labels: null },
        { labels: undefined },
      ]),
    ).toEqual(['spaced'])
  })

  it('keeps case apart: Jira treats Papercut and papercut as two labels', () => {
    expect(knownLabels([{ labels: ['Papercut', 'papercut'] }])).toHaveLength(2)
  })

  it('answers nothing for nothing', () => {
    expect(knownLabels([])).toEqual([])
    expect(knownLabels(null)).toEqual([])
    expect(knownLabels(undefined)).toEqual([])
  })
})

describe('splitLabelInput — whitespace separates labels, it does not sit inside one', () => {
  it('splits a typed line into labels rather than one Jira will refuse', () => {
    expect(splitLabelInput('quick win')).toEqual(['quick', 'win'])
  })
  it('trims the ends and collapses runs', () => {
    expect(splitLabelInput('  a \t\n b  ')).toEqual(['a', 'b'])
  })
  it('answers nothing for a line of whitespace', () => {
    expect(splitLabelInput('   ')).toEqual([])
    expect(splitLabelInput('')).toEqual([])
  })
})

describe('sameLabels — the armed test on the Save', () => {
  it('ignores order', () => {
    expect(sameLabels(['b', 'a'], ['a', 'b'])).toBe(true)
  })
  it('sees an addition, a removal and a swap', () => {
    expect(sameLabels(['a'], ['a', 'b'])).toBe(false)
    expect(sameLabels(['a', 'b'], ['a'])).toBe(false)
    expect(sameLabels(['a', 'b'], ['a', 'c'])).toBe(false)
  })
  it('two empty sets are the same set', () => {
    expect(sameLabels([], [])).toBe(true)
  })
})
