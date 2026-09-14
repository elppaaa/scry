/*
 * GDK-1880: the dashboard load error must hold still.
 *
 * The defect being pinned. `checkVersion` runs on the 500ms focus tick while
 * a dashboard is open. On a version move it asked one question about the
 * open row — "is `this.row` null?" — and read a null row as "the initial
 * fetch is still in flight, so the landing row is fresh enough to render".
 * A row whose fetch FAILED is also null, so a showing 5xx error state
 * answered that question the same way and the poll force-refetched behind
 * the person's cursor. When that second fetch succeeded the error branch
 * unmounted, taking the Retry button with it.
 *
 * Measured, on the tree before the fix (probe run, e2e port 8075): the
 * GDK-1060 e2e paints the error state, and 264ms later — with no click —
 * the Retry node is removed from the DOM and never returns; the row route
 * was fetched twice (9ms, 282ms). Two controls isolate it: forcing a real
 * navigation before the second goto (so the app boots after the save and
 * its version baseline is current) gives one fetch and a Retry that stays,
 * and freezing the list route's `version` to the pre-save value gives the
 * same. CI run 34858323790 is the same thing on a slower runner, where the
 * click's actionability wait lost the race: "element was detached from the
 * DOM" — once, then the button never came back.
 *
 * The product rule this file holds: Retry is a person's gesture (GDK-1060 —
 * the dead id deliberately has no button because a retry cannot help it).
 * A failed load therefore stays failed until the person taps Retry or the
 * open id changes. The poll keeps every other job it had: it still closes a
 * dashboard that was deleted, and it still refetches a row that is
 * genuinely still in flight.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getDashboards: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  getDashboard: api.getDashboard,
  getDashboards: api.getDashboards,
  class_: null,
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))

const { dashboards } = await import('./dashboards.svelte')

const ID = 'dash-gdk1880'
const T1 = '2026-09-14T10:00:00.000Z'
const T2 = '2026-09-14T11:00:00.000Z'

const row = (updated_at: string) => ({
  id: ID,
  name: 'Ops',
  updated_at,
  config: { html: '<p>x</p>', datasources: {} },
})
const listed = (updated_at: string) => ({ id: ID, name: 'Ops', updated_at })

/** Let the un-awaited `void this.loadRow()` inside open() settle. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Every poll tick reports a moved counter — the state under test is the
 *  error, not the store's memory of the last version it saw. */
function listMoves(rows: { id: string; name: string; updated_at: string }[]): void {
  let v = 100
  api.getDashboards.mockImplementation(() => Promise.resolve({ dashboards: rows, version: ++v }))
}

beforeEach(() => {
  vi.clearAllMocks()
  dashboards.close()
  dashboards.row = null
  dashboards.error = null
  dashboards.list = []
  dashboards.loaded = true
  dashboards.version = -1
  dashboards.renderGen = 0
  api.getDashboards.mockResolvedValue({ dashboards: [], version: 1 })
  api.getDashboard.mockResolvedValue(row(T1))
})

describe('GDK-1880: the version poll and a showing load error', () => {
  test('a failed row load stays failed across version polls until Retry', async () => {
    api.getDashboard.mockRejectedValue(new Error('503 Service Unavailable'))
    dashboards.open(ID)
    await flush()
    expect(dashboards.error, 'precondition: the 5xx painted the error state').toBe('load_error')
    expect(dashboards.row).toBeNull()

    // The counter moves on every tick (another dashboard being saved), and
    // the row the poll could fetch would now succeed.
    listMoves([listed(T2)])
    api.getDashboard.mockResolvedValue(row(T2))
    const before = api.getDashboard.mock.calls.length

    for (let i = 0; i < 3; i++) await dashboards.checkVersion()

    // Red before the fix: the poll force-refetched, the row landed, and the
    // error branch — with the Retry button in it — unmounted on its own.
    expect(
      api.getDashboard.mock.calls.length - before,
      'the poll refetched the row behind a showing error state',
    ).toBe(0)
    expect(dashboards.error, 'the error state must survive the poll').toBe('load_error')
    expect(dashboards.row, 'no row may land without the person asking').toBeNull()
    expect(dashboards.renderGen, 'no frame swap may be scheduled either').toBe(0)
  })

  test('Retry is the way out, and it works', async () => {
    api.getDashboard.mockRejectedValue(new Error('503 Service Unavailable'))
    dashboards.open(ID)
    await flush()
    expect(dashboards.error).toBe('load_error')

    api.getDashboard.mockResolvedValue(row(T2))
    await dashboards.loadRow('retry')

    expect(dashboards.error).toBeNull()
    expect(dashboards.row?.updated_at).toBe(T2)
  })

  test('a row still in flight is not an error: the poll refetches it', async () => {
    // Nothing settles this — row stays null with no error, which is the
    // state the old null check was actually written for.
    api.getDashboard.mockReturnValue(new Promise(() => {}))
    dashboards.open(ID)
    await flush()
    expect(dashboards.row).toBeNull()
    expect(dashboards.error).toBeNull()

    listMoves([listed(T2)])
    api.getDashboard.mockResolvedValue(row(T2))
    await dashboards.checkVersion()

    expect(dashboards.row?.updated_at, 'a pending row must still be refetched').toBe(T2)
    expect(dashboards.renderGen).toBe(1)
  })

  test('a saved document still swaps the frame', async () => {
    dashboards.open(ID)
    await flush()
    expect(dashboards.row?.updated_at).toBe(T1)

    listMoves([listed(T2)])
    api.getDashboard.mockResolvedValue(row(T2))
    await dashboards.checkVersion()

    expect(dashboards.row?.updated_at).toBe(T2)
    expect(dashboards.renderGen).toBe(1)
  })

  test('a dashboard deleted while the error shows is still closed', async () => {
    api.getDashboard.mockRejectedValue(new Error('503 Service Unavailable'))
    dashboards.open(ID)
    await flush()
    expect(dashboards.error).toBe('load_error')

    // The id is gone from the list: holding the error state would leave the
    // column pointed at something that no longer exists.
    listMoves([])
    await dashboards.checkVersion()

    expect(dashboards.openId, 'a deleted dashboard closes even from an error state').toBeNull()
  })
})
