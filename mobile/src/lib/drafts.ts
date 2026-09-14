// Composer drafts (GDK-1863) — the single owner of "what you typed on the
// phone survives closing the app". Detail.svelte has three composers (the
// comment line, the summary inline edit, the description editor); every one
// of them used to live in component state only, so an app switch, a host
// switch, a token refresh or a crash dropped the text. This module keeps
// them in one host-scoped localStorage document, namespaced exactly like
// the other session documents (host-keys.ts DRAFTS_KEY), so unpair /
// removeRosterHost / the B2 rename already cover it.
//
// Storage follows hosts.ts's guarded quiet-cache stance: every read and
// write is try/catch-quiet — a draft is a convenience, never a requirement.
// A doc whose schema this build does not speak reads as no drafts and is
// never overwritten by a read; unparseable bytes also read as no drafts,
// and the next save replaces them (one corrupt write must not brick drafts
// for that host forever).
//
// The bundled demo has a no-persistence contract (store.enterDemo): while a
// demo session is active nothing here reads or writes storage — a read
// would surface a real host's drafts into the demo screen.

import { isDemoSession } from './demo'
import { DRAFTS_KEY, hostKey } from './host-keys'
import { getActiveHostId } from './hosts'

/**
 * The three composers on the issue detail. This union stays exactly three
 * wide: Detail.svelte builds `Record<DraftKind, …>` tables over it, and a
 * fourth member there would be a missing property on that screen, not a
 * feature. A composer on another screen joins StoredDraftKind instead.
 */
export type DraftKind = 'comment' | 'summary' | 'description'

/**
 * Every composer this module stores. `'page-comment'` (GDK-1873) is the
 * comment line on a wiki page detail; its key is the page id the server
 * wants, not an issue key — the same second argument, a different namespace,
 * so a page and an issue that share a string never share a draft.
 */
export type StoredDraftKind = DraftKind | 'page-comment'

export interface DraftRow {
  kind: StoredDraftKind
  /** The composer's subject: an issue key, or a page id for 'page-comment'. */
  issueKey: string
  text: string
  /** ISO timestamp of the last save; eviction order. */
  updatedAt: string
}

/** Most drafts kept per host; the oldest by updatedAt is evicted first. */
export const MAX_DRAFTS = 50

const SCHEMA = 1

interface DraftsDoc {
  schema: number
  drafts: DraftRow[]
}

/**
 * The runtime half of StoredDraftKind — `isDraftRow` filters every read
 * through it, so a kind missing here saves and never comes back. A build
 * that does not know a kind drops those rows on its next save; the schema
 * is not bumped for an added kind, because a dropped draft is a lost
 * convenience and a refused document would be a lost one for every kind.
 */
const KINDS: readonly StoredDraftKind[] = ['comment', 'summary', 'description', 'page-comment']

function isDraftRow(value: unknown): value is DraftRow {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  return (
    typeof d.kind === 'string' &&
    (KINDS as readonly string[]).includes(d.kind) &&
    typeof d.issueKey === 'string' &&
    typeof d.text === 'string' &&
    typeof d.updatedAt === 'string'
  )
}

function storageKey(): string {
  return hostKey(DRAFTS_KEY, getActiveHostId())
}

function emptyDoc(): DraftsDoc {
  return { schema: SCHEMA, drafts: [] }
}

function readDoc(): DraftsDoc {
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return emptyDoc()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return emptyDoc()
    const doc = parsed as Record<string, unknown>
    if (doc.schema !== SCHEMA || !Array.isArray(doc.drafts)) return emptyDoc()
    return { schema: SCHEMA, drafts: doc.drafts.filter(isDraftRow) }
  } catch {
    return emptyDoc()
  }
}

/**
 * Writes the doc unless a *parseable* doc of a foreign schema sits at the
 * address — an older build must not flatten a newer schema's drafts.
 * Unparseable bytes are replaced: they hold nothing this or any build reads.
 */
function writeDoc(doc: DraftsDoc): void {
  try {
    const key = storageKey()
    const raw = localStorage.getItem(key)
    if (raw) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
      if (typeof parsed === 'object' && parsed !== null) {
        if ((parsed as Record<string, unknown>).schema !== SCHEMA) return
      }
    }
    if (doc.drafts.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(doc))
  } catch {
    // Over-quota or unavailable: a draft is a convenience, never a requirement.
  }
}

/** The saved text for a composer on an issue, or null when there is none. */
export function loadDraft(kind: StoredDraftKind, issueKey: string): string | null {
  if (isDemoSession()) return null
  const row = readDoc().drafts.find((d) => d.kind === kind && d.issueKey === issueKey)
  return row ? row.text : null
}

/**
 * Saves the text for a composer on an issue. Text that trims to nothing is
 * a clear, not a save — an emptied composer has no draft to come back to.
 * Replaces in place for the same (kind, issueKey); past MAX_DRAFTS the
 * oldest by updatedAt (insertion order breaking ties) is evicted.
 */
export function saveDraft(kind: StoredDraftKind, issueKey: string, text: string): void {
  if (isDemoSession()) return
  if (text.trim() === '') {
    clearDraft(kind, issueKey)
    return
  }
  const doc = readDoc()
  const drafts = doc.drafts.filter((d) => !(d.kind === kind && d.issueKey === issueKey))
  drafts.push({ kind, issueKey, text, updatedAt: new Date().toISOString() })
  while (drafts.length > MAX_DRAFTS) {
    let oldest = 0
    for (let i = 1; i < drafts.length; i++) {
      if (drafts[i].updatedAt < drafts[oldest].updatedAt) oldest = i
    }
    drafts.splice(oldest, 1)
  }
  writeDoc({ schema: SCHEMA, drafts })
}

/** Forgets a composer's draft on an issue. Quiet no-op when there is none. */
export function clearDraft(kind: StoredDraftKind, issueKey: string): void {
  if (isDemoSession()) return
  const doc = readDoc()
  const drafts = doc.drafts.filter((d) => !(d.kind === kind && d.issueKey === issueKey))
  if (drafts.length === doc.drafts.length) return
  writeDoc({ schema: SCHEMA, drafts })
}

/** Every draft under the active host, newest first. */
export function listDrafts(): { kind: StoredDraftKind; issueKey: string; updatedAt: string }[] {
  if (isDemoSession()) return []
  return readDoc()
    .drafts.map(({ kind, issueKey, updatedAt }) => ({ kind, issueKey, updatedAt }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}
