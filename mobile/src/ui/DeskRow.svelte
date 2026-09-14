<script lang="ts">
  import { t } from '../lib/i18n'

  /*
   * One thing that stays on the desk, said on the spot (GDK-1874).
   *
   * mobile/DESIGN.md §1, third clause: whatever needs a form, a layout or an
   * editor stays on the desk — and the phone says so where a person looks
   * for it, never silently. The loudest complaint class about the app this
   * one replaces is "it is a subset of the web and you find out by
   * searching"; an absence that is never named is exactly that search.
   *
   * Not a new grammar. ScopeSheet has drawn a blocked scope this way since
   * GDK-1704 — the row stays a row, its name on the left and the desk's own
   * `sidebar.scopeOpenDesktop` on the right, dimmed and inert — and this
   * component is that dialect lifted out so five more places can wear it
   * without a second spelling of the same idea. ScopeSheet's blocked branch
   * renders this too, value for value, so the sheet is unchanged.
   *
   * The class is `desk-row`, deliberately NOT `row`: the gate and several
   * specs open the first issue by clicking `.pane:not(.off) button.row`
   * first(), and a disabled row that answered that selector would hang every
   * one of them. It is also why the viewport gate's rows-per-screen median
   * is untouched by construction — these rows are not counted as list rows.
   *
   * Inert on purpose: no click, no deep link, no `gadak open`. The row is a
   * fact about where the work lives, and a control that promised to take you
   * there would have to be able to.
   */
  let {
    label,
    testid,
  }: {
    /** The noun for the verb that stays on the desk — a catalog word, never
     *  authored here (DESIGN.md §3.6). */
    label: string
    testid?: string
  } = $props()
</script>

<button class="desk-row" data-testid={testid} disabled aria-disabled="true">
  <span class="name">{label}</span>
  <span class="why">{t('sidebar.scopeOpenDesktop')}</span>
</button>

<style>
  /* The ScopeSheet blocked-row values, moved here unchanged: the flex row,
     its 10px gap and 6px/8px padding, the 6px radius, and the 0.5 a blocked
     row has worn since GDK-1704. The 44pt floor is app.css's one owner on
     `button` (GDK-867) — not restated, so it cannot drift. */
  .desk-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 6px;
    text-align: left;
    min-width: 0;
    opacity: 0.5;
  }
  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-primary);
  }
  .why {
    flex: none;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
</style>
