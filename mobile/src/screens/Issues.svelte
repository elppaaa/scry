<script lang="ts">
  import Screen from '../ui/Screen.svelte'
  import Row from '../ui/Row.svelte'
  import DocRow from '../ui/DocRow.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import GlanceStrip from '../ui/GlanceStrip.svelte'
  import Skeleton from '../ui/Skeleton.svelte'
  import ScopeSheet from '../ui/ScopeSheet.svelte'
  import CreateSheet from '../ui/CreateSheet.svelte'
  import SprintLine from '../ui/SprintLine.svelte'
  import { t } from '../lib/i18n'
  import {
    app,
    dismissSessionStrip,
    issuesBootKind,
    setScope,
    showOfflineBanner,
    sync,
    switchTab,
  } from '../lib/store.svelte'
  import {
    buildList,
    buildScopes,
    hasIdentity,
    relTime,
    resolveScope,
    scopeCount,
    scopePages,
    sessionLine,
    SCOPE_ACTIVE_SPRINT,
    SCOPE_ALL_OPEN,
    SCOPE_MY_WORK,
    type Scope,
  } from '../lib/domain'
  import { pickActiveSprint } from '../lib/sprint'

  // The desktop has no name for its list screen: its main column is titled by
  // the current view's name. The phone adopts that — the tab is the object
  // (Issues), the heading is the current scope, and the heading is the
  // control that changes it (DESIGN.md §2, GDK-885).
  let pickerOpen = $state(false)

  /* ── Create sheet (GDK-1497 A2), a component of its own since GDK-1871:
   *  an epic's detail opens the same sheet to file a child, so this screen
   *  owns only the flag that says it is open. It is mounted inside the
   *  `{#if}` below, which is what makes each open a fresh restore of the
   *  drafts it holds (no $effect watching a prop — GDK-692). */
  let createOpen = $state(false)

  /*
   * The sprint line's subject (GDK-1867), and the scope row that goes with
   * it — one derivation, so the line and the picker row can never name two
   * different sprints. Null on a kanban workspace, between sprints, or on a
   * serve that has no `issues/sprints/` route: then neither exists.
   */
  const activeSprint = $derived(pickActiveSprint(app.sprints, app.issues))
  const scopes = $derived(buildScopes(app.views, app.sources, app.me, app.pages, activeSprint))
  const scope = $derived<Scope>(
    resolveScope(scopes, app.scopeId, app.me) ?? {
      id: SCOPE_ALL_OPEN,
      section: 'builtin',
      kind: 'issues',
      name: t('view.allOpen.name'),
      filters: null,
      unsupported: [],
    },
  )
  const isDocs = $derived(scope.kind === 'pages')
  const docRows = $derived(isDocs ? scopePages(app.pages, scope) : [])
  const view = $derived(isDocs
    ? { sections: [], total: docRows.length, scopeId: scope.id, fellBack: false }
    : buildList(app.issues, app.me, scope))
  // The heading must never wear a name the list is not showing: when the
  // fallback fires it says All open, and the note below says why.
  const heading = $derived(view.fellBack ? t('view.allOpen.name') : scope.name)

  // GDK-886: counts are one pass per row, taken when the sheet opens — never
  // on the list's scroll path.
  let counts = $state(new Map<string, number | null>())
  function openPicker(): void {
    counts = new Map(scopes.map((s) => [s.id, scopeCount(app.issues, app.me, s, app.pages)]))
    pickerOpen = true
  }
  function pick(id: string): void {
    setScope(id)
    pickerOpen = false
  }

  /*
   * The session strip (GDK-1495 ①): one quiet line saying what changed since
   * the previous session — the first thing above the list, before the glance
   * strip, because it is the reading the return itself is for. Everything it
   * decides lives in the store (the latch and its snapshot) and in the
   * desktop's own rules; this is the line and the tap.
   *
   * Absence is the design: no boundary, no changes, or dismissed → nothing
   * renders and there is no empty state. The tap dismisses. The desk's strip
   * also *arranges* — it turns the changed keys into a view — but the phone
   * has no keys view to turn them into yet, and a control that pretends to
   * one would be the lie the picker's disabled rows exist to avoid.
   *
   * It may run to two lines on a 402px phone rather than truncate its own
   * second half; see the .session rule below.
   */
  const sessionText = $derived(
    app.session.delta && !app.session.dismissed && app.session.boundary
      ? sessionLine(app.session.delta, relTime(app.session.boundary, app.now), app.me)
      : '',
  )

  const syncLabel = $derived(
    app.syncing ? 'syncing' : app.lastSyncAt ? relTime(app.lastSyncAt.toISOString(), app.now) : '—',
  )
  const bootKind = $derived(
    issuesBootKind({
      loaded: app.loaded,
      offline: app.offline,
      issueCount: app.issues.length,
      pageCount: app.pages.length,
      lastSyncAt: app.lastSyncAt,
    }),
  )
  const offlineBanner = $derived(
    showOfflineBanner({
      offline: app.offline,
      issueCount: app.issues.length,
      pageCount: app.pages.length,
      lastSyncAt: app.lastSyncAt,
    }),
  )
</script>

<Screen>
  {#snippet header()}
    <div class="head">
      <h1>
        <button class="scope" onclick={openPicker} aria-haspopup="dialog" aria-expanded={pickerOpen}>
          <span class="name type-subject">{heading}</span>
          <span class="count">·{view.total}</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h1>
      <span class="spacer"></span>
      <button
        class="new"
        onclick={() => (createOpen = true)}
        aria-label={t('write.newIssue')}
        aria-haspopup="dialog"
        aria-expanded={createOpen}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </button>
      <button class="fresh" onclick={() => void sync()} aria-label={t('sync.now')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class:spin={app.syncing} aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.6-6.3" /><path d="M21 3v6h-6" />
        </svg>
        <span>{syncLabel}</span>
      </button>
    </div>
    {#if offlineBanner}
      <p class="offline">{t('app.offlineBanner')}</p>
    {:else if view.fellBack && hasIdentity(app.me) && scope.id === SCOPE_MY_WORK}
      <p class="note">{t('list.nothingOpenAssigned')}</p>
    {:else if view.fellBack}
      <p class="note">{t('list.noIdentityFilter')}</p>
    {/if}
  {/snippet}

  {#if sessionText}
    <button class="session" data-testid="session-strip" onclick={dismissSessionStrip}>
      {sessionText}
    </button>
  {/if}

  <!-- GDK-1867: the current sprint as one line, under the heading and above
       the queue it describes. Inside the scroller, like every band here —
       a band in the header would cost the list a row of density
       (mobile/e2e/viewport.spec.ts floors it at 9). Tapping it scopes the
       list to that sprint; absent when there is no active one. -->
  {#if !isDocs}
    <!-- Issue data: under a documents scope the line described a list that
         was not on screen (review 2026-09-14, capture 06). -->
    <SprintLine
      sprint={activeSprint}
      issues={app.issues}
      now={app.now}
      current={scope.id === SCOPE_ACTIVE_SPRINT}
      onpick={() => setScope(SCOPE_ACTIVE_SPRINT)}
    />
  {/if}

  <!-- GDK-871: the glance strip — the last band before the plates, and the
       only scope-independent one (the feed is a person's, not a scope's).
       It gates itself on unread counts and renders nothing otherwise. -->
  <GlanceStrip />

  {#if bootKind === 'skeleton'}
    <Skeleton />
  {:else if bootKind === 'failed'}
    <EmptyState title={t('list.renderFailedTitle')}>
      <button class="link" onclick={() => void sync()}>{t('list.renderFailedRetry')}</button>
    </EmptyState>
  {:else if isDocs}
    {#if docRows.length === 0}
      <EmptyState title={t('docs.recentEmpty')} />
    {:else}
      {#each docRows as page (page.key)}
        <DocRow {page} showSpace={!scope.spaceKey} />
      {/each}
      <div class="foot" aria-hidden="true"></div>
    {/if}
  {:else if view.total === 0}
    <EmptyState
      title={app.issues.length === 0 ? t('list.emptyTitle') : t('list.noMatchTitle')}
      body={app.issues.length === 0 ? t('list.emptyHint') : t('list.noMatchHint')}
    >
      <button class="link" onclick={() => switchTab('search')}>{t('palette.entryLabel')}</button>
    </EmptyState>
  {:else}
    {#each view.sections as section (section.rank)}
      <div class="section">
        <span class="label">{section.label}</span>
        <span class="n">{section.issues.length}</span>
      </div>
      {#each section.issues as issue (issue.issue_key)}
        <Row {issue} showAssignee={view.scopeId !== SCOPE_MY_WORK} />
      {/each}
    {/each}
    <div class="foot" aria-hidden="true"></div>
  {/if}
</Screen>

{#if pickerOpen}
  <ScopeSheet
    {scopes}
    {counts}
    current={scope.id}
    onpick={pick}
    onclose={() => (pickerOpen = false)}
  />
{/if}

{#if createOpen}
  <CreateSheet open={createOpen} onclose={() => (createOpen = false)} />
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    /* The heading is a 44pt control now, so the padding that used to carry
       the header's height moved into the button itself (§3.3 still needs
       12+ rows below it). */
    padding: 4px 0;
    min-width: 0;
  }
  h1 {
    margin: 0;
    min-width: 0;
  }
  .scope {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 0;
    min-width: 0;
    max-width: 100%;
    color: var(--color-text-primary);
  }
  .name {
    font-size: var(--text-heading);
    line-height: var(--text-heading--line-height);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-title);
    color: var(--color-text-muted);
  }
  .chev {
    flex: none;
    align-self: center;
    width: 16px;
    height: 16px;
    color: var(--color-text-muted);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .fresh {
    align-self: center;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    color: var(--color-text-muted);
    font-size: var(--text-micro);
    font-variant-numeric: tabular-nums;
  }
  .fresh svg {
    width: 14px;
    height: 14px;
  }
  /* The create action (GDK-1497 A2): a 44pt square beside the sync state,
     drawn heavier than .fresh because it acts on the tracker, not the
     mirror. */
  .new {
    flex: none;
    align-self: center;
    width: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-primary);
  }
  .new svg {
    width: 20px;
    height: 20px;
  }

  .fresh svg.spin {
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .offline,
  .note {
    margin: 0 0 8px;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .offline {
    color: var(--color-status-stale);
  }
  .section {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 10px 16px 4px;
    background: var(--color-bg-base);
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .label {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .n {
    font-family: var(--font-mono);
  }
  .link {
    color: var(--color-accent-text);
    font-size: var(--text-body);
    min-height: var(--spacing-control);
    padding: 0 16px;
  }
  /* Two lines at most, one whenever it fits (vision FIX 2026-09-07). The
     desk's one-line rule was written for a panel three times this wide; on
     402px it cut "1 of them assigned to you" off at the ellipsis, losing the
     most specific fact in the sentence. A block above the list still reads
     as chrome — so the clamp is 2, not none. */
  .session {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    width: 100%;
    padding: 6px 16px;
    text-align: left;
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--text-micro);
    color: var(--color-text-muted);
    overflow: hidden;
  }
  .session:active {
    background: var(--color-bg-hover);
  }
  .foot {
    height: 24px;
  }
</style>
