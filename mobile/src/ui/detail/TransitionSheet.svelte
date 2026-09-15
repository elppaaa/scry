<script lang="ts">
  import Sheet from '../Sheet.svelte'
  import { t } from '../../lib/i18n'
  import type { TransitionDoc } from '../../lib/types'

  /*
   * The status sheet (GDK-1925), extracted from Detail.svelte as a
   * presentation component on purpose: its error sentence is not private to
   * the sheet — the status row under it paints the same `transitionError`
   * when writes go off (the .status-err line), so the state stays with the
   * screen and this component only renders what it is handed and lifts the
   * one gesture that matters, the pick. The screen keeps openTransitions'
   * catalog (one ask per issue) and applyTransition's POST.
   */
  let {
    transitions,
    error,
    applying,
    failedId,
    onclose,
    onpick,
  }: {
    /** null while the screen's one-per-issue ask is still crossing. */
    transitions: TransitionDoc[] | null
    error: string | null
    /** The transition id being applied (null = idle). */
    applying: string | null
    /** The row whose apply was refused, for its own error line. */
    failedId: string | null
    onclose: () => void
    onpick: (doc: TransitionDoc) => void
  } = $props()
</script>

<Sheet title={t('write.moveStatus')} {onclose}>
  <div class="t-list">
    {#if !transitions && !error}
      <p class="none">{t('write.askingServer')}</p>
    {:else if transitions}
      {#each transitions as tr (tr.id)}
        {@const blocked = (tr.fields?.length ?? 0) > 0}
        <button class="t-row" disabled={blocked || applying !== null} onclick={() => onpick(tr)}>
          <span class="dot dot-{tr.to_category}" aria-hidden="true"></span>
          <span class="t-text">
            <span class="t-name">{applying === tr.id ? t('common.applying') : tr.name}</span>
            <!-- The built-in tracker names a transition after its target,
                 so "Done / → Done" said everything twice; the arrow line
                 stays only when it adds a word. -->
            {#if blocked || tr.to_status !== tr.name}
              <span class="t-to">→ {tr.to_status}{blocked ? ' · ' + t('write.transitionNeedsFields') : ''}</span>
            {/if}
            {#if failedId === tr.id && error}
              <span class="t-err">{error}</span>
            {/if}
          </span>
        </button>
      {/each}
      {#if transitions.length === 0}
        <p class="none">{t('write.noTransitionsFrom')}</p>
      {/if}
    {:else if error}
      <p class="error">{error}</p>
    {/if}
  </div>
</Sheet>

<style>
  /* also in Detail.svelte — same tokens, GDK-1925 */
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    flex: none;
  }
  .dot-new {
    background: var(--color-status-new);
  }
  .dot-inprogress {
    background: var(--color-status-inprogress);
  }
  .dot-done {
    background: var(--color-status-done);
  }
  .dot-reopen {
    background: var(--color-status-reopen);
  }
  /* also in Detail.svelte — same tokens, GDK-1925 */
  .none {
    margin: 4px 0 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  /* also in Detail.svelte — same tokens, GDK-1925 */
  .error {
    margin: 8px 0;
    font-size: var(--text-micro);
    color: var(--color-status-reopen);
  }
  .t-list {
    overflow-y: auto;
    padding: 4px 8px 8px;
  }
  /* also in the other pick sheets — same tokens, GDK-1925 */
  .t-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    min-height: var(--spacing-control);
    padding: 6px 8px;
    border-radius: 6px;
    text-align: left;
  }
  .t-row:active:not(:disabled) {
    background: var(--color-bg-hover);
  }
  .t-row:disabled {
    opacity: 0.5;
  }
  .t-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .t-name {
    color: var(--color-text-primary);
    font-weight: 600;
  }
  .t-to {
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .t-err {
    font-size: var(--text-micro);
    font-weight: 400;
    color: var(--color-status-reopen);
  }
</style>
