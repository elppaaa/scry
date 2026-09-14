/*
 * What the dashboards version poll may do to the open row (GDK-1880).
 *
 * The poll (500ms focus tick → stores/dashboards checkVersion) watches the
 * server's change counter while a dashboard is open. On a move it has to
 * decide one thing: leave the screen alone, refetch the row, or close a
 * dashboard that is gone. That decision used to be three inline conditions
 * reading store fields directly, and one of them asked the wrong question —
 * "is `this.row` null?" as a stand-in for "is the first fetch still in
 * flight?". A row whose fetch FAILED is null too, so a showing 5xx error
 * state matched the in-flight branch and the poll refetched behind the
 * person's cursor; when that fetch succeeded the error branch unmounted and
 * took the Retry button with it mid-click.
 *
 * So the question is asked here, once, with the error passed in explicitly —
 * the shape that makes "no row" and "failed" impossible to conflate again.
 * Pure on purpose: no runes, no store import, table-tested.
 *
 * The rule: a failed load is the person's to clear. Retry is a gesture
 * (GDK-1060 gives the dead-id state no button precisely because a retry
 * cannot help it), so an error survives every poll until the person taps
 * Retry or the open id changes. The poll keeps its other two jobs intact.
 */

/** Why a row fetch is happening — the poll, the person, or opening. */
export type RowLoadReason = 'open' | 'retry' | 'version'

export type RowSyncAction =
  /** The open id is gone from the server's list: release the column. */
  | 'close'
  /** Fetch the row again and swap the frame. */
  | 'refetch'
  /** Leave the screen exactly as it is. */
  | 'idle'

export interface RowSyncInput {
  /** Did the list the poll just fetched still name the open id. */
  listed: boolean
  /** The store's load error for the open id: null when the last load worked. */
  error: string | null
  /** `updated_at` of the row the store is holding, null when it holds none. */
  rowUpdatedAt: string | null
  /** `updated_at` the list just reported for the open id. */
  listedUpdatedAt: string | null
}

export function decideRowSync({
  listed,
  error,
  rowUpdatedAt,
  listedUpdatedAt,
}: RowSyncInput): RowSyncAction {
  // Deleted wins over everything, an error state included: holding a failed
  // load open would point the column at a dashboard that no longer exists.
  if (!listed) return 'close'
  // A failed load is not a pending one. This is the GDK-1880 line.
  if (error !== null) return 'idle'
  // No row and no error: the first fetch is genuinely still running, and a
  // fetch that started before the save would land the old document.
  if (rowUpdatedAt === null) return 'refetch'
  // The counter moved for some other dashboard's save; this document did not.
  if (listedUpdatedAt === rowUpdatedAt) return 'idle'
  return 'refetch'
}
