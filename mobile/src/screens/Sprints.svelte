<script lang="ts">
  import Screen from '../ui/Screen.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import { t } from '../lib/i18n'
  import { app, setOwner, setScope } from '../lib/store.svelte'
  import { folioDate, SCOPE_ACTIVE_SPRINT } from '../lib/domain'
  import { sprintCounts, sprintDaysLeft, sortSprints } from '../lib/sprint'
  import type { SprintRow } from '../lib/types'

  /*
   * The sprint list as a screen of its own (GDK-1827), the phone surface for
   * sprint data the mirror has held since 0.22: which sprints exist, what
   * state each is in, its window, how much of it is done, what it is for.
   * The sprint line under the Issues heading (GDK-1867) answers that for one
   * sprint — the active one — and only while it is active. This screen is the
   * same reading over every row, and the past ones stay readable after they
   * close.
   *
   * Read-only, and the only thing a row does is what the line's tap does:
   * scope the queue to a sprint. The scope model has exactly one sprint scope
   * — the active one (`builtin:active-sprint`, built from the sprint the
   * picker picks) — so only the active row is a control; a closed or future
   * row is a fact, drawn as data not as a disabled promise (the DeskRow
   * dialect says where a thing went; this one says where it already is).
   * Widening that to per-sprint scope ids is a scope-model change this screen
   * deliberately does not make.
   *
   * No fetch of its own (DESIGN.md §5): the rows are the snapshot the store
   * already holds, counted with the same `sprintCounts` the line uses, so the
   * two surfaces are the same arithmetic over the same rows and cannot
   * disagree.
   */
  const rows = $derived(sortSprints(app.sprints))
  const scopedHere = $derived(app.scopeId === SCOPE_ACTIVE_SPRINT)

  // The badge vocabulary, in the catalog's own words (§3.6): three states,
  // keyed on `state` — never on the sprint's name.
  const STATE_LABEL = {
    active: 'sprints.state.active',
    closed: 'sprints.state.closed',
    future: 'sprints.state.future',
  } as const

  function stateLabel(s: SprintRow): string {
    return s.state === 'active' || s.state === 'closed' || s.state === 'future'
      ? t(STATE_LABEL[s.state])
      : ''
  }

  /** The window on one line, start–end, in the folio's own month-day form. */
  function range(s: SprintRow): string {
    const a = folioDate(s.start_at)
    const b = folioDate(s.end_at)
    return a && b ? `${a}–${b}` : a || b
  }

  /* The remaining-days sentence, from the same number over the same five
   * keys the sprint line renders (GDK-1867) — the branches are the line's,
   * copied rather than re-derived, because the line is not this file's to
   * refactor and a second spelling of the ladder is how the two drift. */
  function days(s: SprintRow): string {
    const n = sprintDaysLeft(s.end_at, app.now)
    if (n == null) return ''
    if (n === 0) return t('board.sprintEndsToday')
    if (n === 1) return t('board.sprintOneDayLeft')
    if (n > 1) return t('board.sprintDaysLeft', { n })
    if (n === -1) return t('board.sprintEndedYesterday')
    return t('board.sprintEndedAgo', { n: -n })
  }

  /* The row's one verb: the line's own tap (setScope on the active sprint's
   * scope id), then home to the queue it just narrowed. */
  function pick(): void {
    setScope(SCOPE_ACTIVE_SPRINT)
    setOwner('list')
  }
</script>

{#snippet card(s: SprintRow, counts: { total: number; done: number; pct: number })}
  <span class="line1">
    <span class="name">{s.name}</span>
    {#if stateLabel(s)}
      <span class="badge">{stateLabel(s)}</span>
    {/if}
  </span>
  <span class="line2">
    {#if range(s)}
      <span class="range">{range(s)}</span>
    {/if}
    {#if counts.total > 0}
      <span class="sep" aria-hidden="true">·</span>
      <span
        class="count"
        aria-label={t('board.sprintProgress', { done: counts.done, total: counts.total })}
        >{counts.done} / {counts.total} · {counts.pct}%</span
      >
    {/if}
    {#if s.state === 'active' && days(s)}
      <span class="days">{days(s)}</span>
    {/if}
  </span>
  {#if s.goal}
    <span class="goal">{s.goal}</span>
  {/if}
{/snippet}

<Screen>
  {#snippet header()}
    <div class="head">
      <!-- The list is the column's root, so this screen's exit is this
           control — same glyph, same corner, same word as the Shell's own
           back (DESIGN.md §2): the owner's one way home, and system back is
           the same edge through closeTop(). -->
      <button class="back" onclick={() => setOwner('list')} aria-label={t('app.back')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <h1 class="type-subject">{t('sprints.title')}</h1>
    </div>
  {/snippet}

  {#if rows.length === 0}
    <!-- The palette only offers this screen while sprints exist, so an empty
         column here means the cache emptied while the screen was already
         entered — the state is said, not blanked. -->
    <EmptyState title={t('sprints.none')} />
  {:else}
    {#each rows as s (s.id)}
      {@const counts = sprintCounts(app.issues, s.id)}
      {#if s.state === 'active'}
        <button
          class="sprintcard"
          data-testid="sprints-row"
          aria-current={scopedHere ? 'true' : undefined}
          onclick={pick}
        >
          {@render card(s, counts)}
        </button>
      {:else}
        <div class="sprintcard" data-testid="sprints-row">
          {@render card(s, counts)}
        </div>
      {/if}
    {/each}
    <div class="foot" aria-hidden="true"></div>
  {/if}
</Screen>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    min-width: 0;
  }
  /* The owner's exit, the Shell's own control verbatim: a 44pt square — the
     height is the global button floor's, the width has to be said here —
     glyph alone, pulled to the screen's left edge the same way. */
  .back {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--spacing-control);
    margin-left: -12px;
    color: var(--color-accent-text);
  }
  .back svg {
    width: 22px;
    height: 22px;
  }
  /* The row grammar the sprint line already wears (GDK-1867): two lines at
     most — facts, then the goal under them when there is one — each clamped
     to one line, because a block that grows pushes the rows it describes off
     the screen. The inert rows are `div`s, not disabled buttons: the class is
     `sprintcard`, deliberately not `row` (the DeskRow rule — specs open the
     first issue through `.pane:not(.off) button.row`). */
  .sprintcard {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    width: 100%;
    /* A window without a goal is one row; the tap target still owes 44pt,
       and the inert rows keep the same rhythm. */
    min-height: var(--spacing-control);
    padding: 4px 16px;
    text-align: left;
    border-bottom: 1px solid var(--color-border-subtle);
    min-width: 0;
  }
  button.sprintcard:active {
    background: var(--color-bg-hover);
  }
  .sprintcard[aria-current='true'] .name {
    font-weight: 600;
    color: var(--color-accent-text);
  }
  .line1 {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body);
    color: var(--color-text-primary);
  }
  .badge {
    flex: none;
    font-size: var(--text-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .line2 {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .range {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .sep {
    flex: none;
  }
  .count {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .days {
    flex: none;
    margin-left: auto;
    white-space: nowrap;
  }
  .goal {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .foot {
    height: 24px;
  }
</style>
