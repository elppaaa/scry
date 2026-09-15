/*
 * The palette's pure decisions (GDK-902, DESIGN.md §2).
 *
 * The palette is not a screen: it is what the list body becomes when the
 * heading is tapped. Two rankings live here — the empty-query one (the
 * owner list: recents, then the desk's own sections, then the shell) and
 * the typed one (matching owners, issues, pages) — plus the threshold
 * between them.
 *
 * Why a module and not the component: the ordering rules are the contract
 * DESIGN.md writes down, and a rule asserted through a rendered tree is a
 * rule asserted through whatever the tree happened to do. The I/O — the
 * debounce, the request generation, the focus — stays in Palette.svelte,
 * where it can be read as I/O.
 *
 * The section headings come from the desktop catalog without exception
 * (§3.6): the phone owns none of the vocabulary here.
 */
import type { MessageKey } from './i18n'
import type { Scope, ScopeSection } from './domain'
import type { IssueLite, VisitedRow } from './types'

/** Which ranking the body draws. */
export type PaletteMode = 'empty' | 'short' | 'query'

/**
 * Below two characters a query is not yet a query: one letter matches most
 * of a mirror, and the server round trip it would start is wasted. The
 * empty field is a different state entirely — it draws the owner list — so
 * the three are named rather than inferred from `length`.
 */
export const QUERY_MIN = 2

export function paletteMode(query: string): PaletteMode {
  const q = query.trim()
  if (q === '') return 'empty'
  return q.length < QUERY_MIN ? 'short' : 'query'
}

/* ── the owner list (empty query) ── */

/**
 * The desk's own two stance rows inside the built-in section (THEORY.md
 * "Two stances", SidebarNav): what do I do now, and what is the team's
 * flow. Carried over from ScopeSheet unchanged — without them the section
 * runs five unrelated names together under a heading that is itself a
 * view's name (GDK-1495 ④).
 */
export const STANCE: Record<'mine' | 'team', MessageKey> = {
  mine: 'sidebar.stanceMine',
  team: 'sidebar.stanceTeam',
}

/** Section order and headings — the desk's, in the desk's order. */
export const SECTION_ORDER: ScopeSection[] = ['builtin', 'views', 'filters', 'docs']
export const SECTION_HEADING: Record<ScopeSection, MessageKey> = {
  builtin: 'sidebar.builtinViews',
  views: 'sidebar.myViews',
  filters: 'sidebar.jiraFilters',
  docs: 'sidebar.docs',
}

/** UX_PRINCIPLES §6: a list is capped, not infinite — eight and one way to the rest. */
export const CAP = 8

export type ScopeGroup = {
  section: ScopeSection
  headingKey: MessageKey
  /** The rows to draw now — capped unless this section is expanded. */
  rows: Scope[]
  /** How many the section holds in total; > rows.length means "show all N". */
  total: number
}

/**
 * The owner list's scope half.
 *
 * The saved-views group is the one that survives having no rows (GDK-1874):
 * authoring a view is desk-only, and zero saved views is exactly the state
 * in which someone goes looking for where one is made. Every other section
 * is absent when empty — it has nothing to say the desk row does not.
 */
export function scopeGroups(
  scopes: Scope[],
  expanded: ReadonlySet<ScopeSection> = new Set(),
  cap = CAP,
): ScopeGroup[] {
  return SECTION_ORDER.map((section) => {
    const rows = scopes.filter((s) => s.section === section)
    return {
      section,
      headingKey: SECTION_HEADING[section],
      rows: expanded.has(section) ? rows : rows.slice(0, cap),
      total: rows.length,
    }
  }).filter((g) => g.total > 0 || g.section === 'views')
}

/**
 * The visit ledger joined to the pool, newest first (GDK-875): the ledger's
 * order wins, a key the pool no longer carries skips silently, and the cap
 * is the five the query recents already take, so the plate is one grammar.
 */
export function recentIssueRows(
  visits: VisitedRow[],
  issues: IssueLite[],
  cap = 5,
): IssueLite[] {
  const byKey = new Map(issues.map((i) => [i.issue_key, i]))
  return visits
    .map((v) => byKey.get(v.key))
    .filter((row): row is IssueLite => row !== undefined)
    .slice(0, cap)
}

/**
 * Whether the palette offers the shell (DESIGN.md §10). Absence, not a
 * greyed-out row — the same stance PairGate takes toward an unpaired app.
 * A one-line rule with a name, because it is the contract the tab bar's
 * count used to assert.
 */
export function offersTerminal(terminal: unknown): boolean {
  return terminal !== null && terminal !== undefined
}

/* ── the typed query ── */

/**
 * Owners whose name matches. Case-insensitive substring, the same shape the
 * desk's command palette uses on its own owner list — not a fuzzy ranker:
 * a phone list of eight is read, not scored, and a fuzzy match that puts an
 * unrelated view first is the failure mode worth avoiding.
 */
export function matchScopes(scopes: Scope[], query: string): Scope[] {
  const q = query.trim().toLowerCase()
  if (q.length < QUERY_MIN) return []
  return scopes.filter((s) => s.name.toLowerCase().includes(q))
}
