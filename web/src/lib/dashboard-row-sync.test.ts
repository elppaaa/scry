/*
 * The decision table behind the dashboards version poll (GDK-1880).
 *
 * The store-level red that filed this lives in stores/dashboards.test.ts —
 * a 5xx error state that the 500ms poll cleared on its own, unmounting the
 * Retry button under a click. This file is the same rule stated as a table,
 * so the four inputs are enumerated rather than reached through a store.
 */
import { describe, expect, test } from 'vitest'
import { decideRowSync, type RowSyncInput } from './dashboard-row-sync'

const base: RowSyncInput = {
  listed: true,
  error: null,
  rowUpdatedAt: '2026-09-14T10:00:00.000Z',
  listedUpdatedAt: '2026-09-14T10:00:00.000Z',
}
const at = (s: RowSyncInput['rowUpdatedAt']) => s

describe('decideRowSync', () => {
  test('the counter moved for someone else: nothing to do here', () => {
    expect(decideRowSync(base)).toBe('idle')
  })

  test('this document was saved: refetch and swap', () => {
    expect(decideRowSync({ ...base, listedUpdatedAt: at('2026-09-14T11:00:00.000Z') })).toBe(
      'refetch',
    )
  })

  test('the first fetch has not landed yet: refetch, the in-flight one may be stale', () => {
    expect(decideRowSync({ ...base, rowUpdatedAt: null })).toBe('refetch')
  })

  test('GDK-1880: a failed load is not a pending one — it holds until the person acts', () => {
    // Exactly the shape the old inline check read as "still in flight".
    expect(decideRowSync({ ...base, rowUpdatedAt: null, error: 'load_error' })).toBe('idle')
    // And it holds even when the document really did move underneath.
    expect(
      decideRowSync({
        ...base,
        rowUpdatedAt: null,
        error: 'load_error',
        listedUpdatedAt: at('2026-09-14T11:00:00.000Z'),
      }),
    ).toBe('idle')
  })

  test('a dashboard that is gone closes, error state or not', () => {
    expect(decideRowSync({ ...base, listed: false, listedUpdatedAt: null })).toBe('close')
    expect(
      decideRowSync({
        ...base,
        listed: false,
        listedUpdatedAt: null,
        rowUpdatedAt: null,
        error: 'load_error',
      }),
    ).toBe('close')
    expect(
      decideRowSync({ ...base, listed: false, listedUpdatedAt: null, error: 'not_found' }),
    ).toBe('close')
  })
})
