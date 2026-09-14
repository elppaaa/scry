<script lang="ts">
  import { t } from '../lib/i18n'
  import { sprintCounts, sprintDaysLeft } from '../lib/sprint'
  import type { IssueLite, SprintRow } from '../lib/types'

  /*
   * The current sprint, as one line (GDK-1867).
   *
   * The desk has said these facts since 0.22 on the board's sprint strip
   * (web/src/components/board/SprintStrip.svelte). This is the same reading
   * on a 402px screen: which sprint, how much of it is done, how long is
   * left, and what it is for. Not a new design — no bar, no burn-up, no
   * points. The bar is what the desk gives its spare width to and this line
   * has none; the count beside it was always the reading, and the bar was
   * the picture of the count.
   *
   * Read-only, and the only thing it does is change scope. Eighteen of the
   * collected phone complaints are board/sprint *reads* — "the board exists
   * but there is no way to get to it" — and none of them asked for
   * drag-and-drop on a phone.
   *
   * Absent, never empty: no active sprint (kanban, or between sprints), a
   * serve older than `issues/sprints/`, an origin with no cycles — the
   * parent passes null and nothing renders. A stale snapshot shows the
   * counts of the snapshot it is showing; the offline banner above already
   * says the data is cached.
   */
  let {
    sprint,
    issues,
    now,
    current,
    onpick,
  }: {
    /** The one active sprint, or null — then this draws nothing. */
    sprint: SprintRow | null
    /** The held snapshot: the counts are taken from it, not from the wire's
     *  server-side totals, so the line and the list under it are the same
     *  arithmetic over the same rows (lib/sprint.ts). */
    issues: IssueLite[]
    /** The app clock, so days-left ticks with every other relative time. */
    now: Date
    /** Whether the list is already scoped to this sprint. */
    current: boolean
    onpick: () => void
  } = $props()

  const counts = $derived(sprint ? sprintCounts(issues, sprint.id) : null)
  const daysLeft = $derived(sprint ? sprintDaysLeft(sprint.end_at, now) : null)

  /* A sentence, not a "D-6" — the desk's own five keys and the desk's own
   * reason: the abbreviation is a Korean office idiom that neither English
   * nor Japanese reads. */
  const days = $derived.by(() => {
    const n = daysLeft
    if (n == null) return ''
    if (n === 0) return t('board.sprintEndsToday')
    if (n === 1) return t('board.sprintOneDayLeft')
    if (n > 1) return t('board.sprintDaysLeft', { n })
    if (n === -1) return t('board.sprintEndedYesterday')
    return t('board.sprintEndedAgo', { n: -n })
  })
</script>

{#if sprint && counts}
  <button
    class="sprint"
    data-testid="sprint-line"
    aria-current={current ? 'true' : undefined}
    onclick={onpick}
  >
    <span class="top">
      <span class="name">{sprint.name}</span>
      {#if counts.total > 0}
        <span class="count" aria-label={t('board.sprintProgress', { done: counts.done, total: counts.total })}
          >{counts.done} / {counts.total} · {counts.pct}%</span
        >
      {/if}
      {#if days}
        <span class="days">{days}</span>
      {/if}
    </span>
    {#if sprint.goal}
      <!-- The goal has been in the mirror since sprints became rows and no
           phone surface read it. One line; the sprint scope is one tap away
           for the rows it describes. -->
      <span class="goal">{sprint.goal}</span>
    {/if}
  </button>
{/if}

<style>
  /* Two rows at most on a 402px phone: the facts line, and the goal under
     it when there is one. Both clamp to one line each rather than wrapping
     — this is chrome above the queue, and a block that grows pushes the
     rows it describes off the screen. */
  .sprint {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    width: 100%;
    /* A sprint without a goal is one row (~30pt); the tap target still owes
       44pt — the same token KeyBar and the sheet rows read. */
    min-height: var(--spacing-control);
    padding: 4px 16px;
    text-align: left;
    border-bottom: 1px solid var(--color-border-subtle);
    min-width: 0;
  }
  .sprint:active {
    background: var(--color-bg-hover);
  }
  .top {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
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
  .sprint[aria-current='true'] .name {
    font-weight: 600;
    color: var(--color-accent-text);
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
</style>
