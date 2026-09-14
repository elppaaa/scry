<script lang="ts" module>
  import type { CreateMetaProject } from '../lib/types'
  import { getActiveHostId } from '../lib/hosts'

  /*
   * The create catalog, cached for the session and keyed by the host it was
   * read from (GDK-1871).
   *
   * The sheet is mounted when it opens and dropped when it closes — that is
   * what makes the draft restore an initializer rather than an $effect
   * watching `open` (GDK-692). The cost of that choice is that per-instance
   * state cannot remember the catalog between two opens, which is why this
   * sits at module scope instead: before the extraction, Issues.svelte kept
   * `projects`/`metaLoaded` for the life of the screen and asked the serve
   * once. The host id is part of the key because pairing with another home
   * is a different catalog, and a stale project list there would offer to
   * file into a project that workspace does not have.
   */
  interface MetaCache {
    /** null is the demo/unpaired session, which is a cache slot of its own. */
    hostId: string | null
    projects?: CreateMetaProject[]
    /** The credential_required sentence, latched: this serve cannot write. */
    refusedSentence?: string
  }
  let metaCache: MetaCache = { hostId: getActiveHostId() }

  function cacheFor(): MetaCache {
    const hostId = getActiveHostId()
    if (metaCache.hostId !== hostId) metaCache = { hostId }
    return metaCache
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import Sheet from './Sheet.svelte'
  import { t, fieldLabel } from '../lib/i18n'
  import { ApiError, errorMessage } from '../lib/api'
  import { createIssue, getCreateMeta } from '../lib/writes'
  import { openIssue, sync } from '../lib/store.svelte'
  import { CREATE_DRAFT_SUBJECT, clearDraft, loadDraft, saveDraft } from '../lib/drafts'

  /*
   * The create sheet (GDK-1497 A2), extracted from Issues.svelte so a second
   * screen can open it (GDK-1871). Two callers, one sheet:
   *  - the Issues tab's + action files a top-level issue, asking which
   *    project only when the serve offers more than one;
   *  - an epic's detail files a CHILD of that epic, and then the project is
   *    not a question at all — it is the parent's, and the POST carries
   *    `parent`. The control that opens it exists only on a
   *    `hierarchy_level === 1` row, because the server resolves the issue
   *    type independently of the parent and Jira refuses a standard type
   *    that names one.
   *
   * `open` is the sheet's own guard; both callers also mount it inside their
   * `{#if}`, which is what makes construction the restore point for the
   * drafts below — no $effect assigns state here (GDK-692).
   */
  let {
    open,
    onclose,
    parent,
  }: {
    open: boolean
    onclose: () => void
    parent?: { key: string; projectKey: string; summary: string }
  } = $props()

  /*
   * The drafts (GDK-1863's discipline, GDK-1871's two new kinds). The
   * subject is the epic when one is being filed under, and a constant
   * otherwise: keying the tab's own draft on the picked project would
   * strand the text the moment the picker moved, and on a one-project serve
   * that key would be the empty string anyway.
   */
  const subject = untrack(() => parent?.key ?? CREATE_DRAFT_SUBJECT)
  const summaryDraft = loadDraft('create-summary', subject)
  const descDraft = loadDraft('create-description', subject)

  let summary = $state(summaryDraft ?? '')
  let desc = $state(descDraft ?? '')
  /** One muted line, dismissed by the first keystroke in either field. */
  let restored = $state(summaryDraft !== null || descDraft !== null)

  const cache = cacheFor()
  let projects = $state<CreateMetaProject[]>(cache.projects ?? [])
  let metaLoaded = $state(cache.projects !== undefined)
  let writesOff = $state(cache.refusedSentence !== undefined)
  let writesOffSentence = $state<string | null>(cache.refusedSentence ?? null)
  let project = $state('')
  let createError = $state<string | null>(null)
  let creating = $state(false)

  /** Projects the sheet may file under — subtask-only projects cannot take
   *  a top-level create, and the phone never asks for an issue type (the
   *  server resolves the default). */
  const creatable = $derived(projects.filter((p) => (p.issue_types ?? []).some((ty) => !ty.subtask)))
  /** The project question is asked only when it is a question: never under
   *  a parent (the child is filed where the parent lives) and never on a
   *  serve with one project. */
  const asksProject = $derived(!parent && metaLoaded && creatable.length > 1)

  loadMeta()

  function loadMeta(): void {
    if (metaLoaded || writesOff) return
    void (async () => {
      try {
        const res = await getCreateMeta()
        projects = res.projects
        cacheFor().projects = res.projects
        const list = projects.filter((p) => (p.issue_types ?? []).some((ty) => !ty.subtask))
        if (!parent && list.length > 1) project = list[0].key
        metaLoaded = true
      } catch (err) {
        if (err instanceof ApiError && err.code === 'credential_required') {
          // The same sentence the Detail composer shows; the sheet stays
          // readable — the person can still read what they meant to file.
          writesOff = true
          writesOffSentence = errorMessage(err)
          cacheFor().refusedSentence = writesOffSentence
          return
        }
        // A serve whose catalog cannot be read still creates: with one
        // project (the common case) there is nothing to ask.
        metaLoaded = true
      }
    })()
  }

  /* ── Draft debounce. Plain lets, not $state: nothing renders them, and
   *  the effect's teardown must read them after the last render. Same pair
   *  of handles, same 250 ms, as Detail.svelte and PageDetail.svelte. */
  let summaryTimer: ReturnType<typeof setTimeout> | null = null
  let summaryOwed: string | null = null
  let descTimer: ReturnType<typeof setTimeout> | null = null
  let descOwed: string | null = null

  function onSummaryInput(next: string): void {
    restored = false
    summaryOwed = next
    if (summaryTimer) clearTimeout(summaryTimer)
    summaryTimer = setTimeout(() => {
      summaryTimer = null
      summaryOwed = null
      saveDraft('create-summary', subject, next)
    }, 250)
  }

  function onDescInput(next: string): void {
    restored = false
    descOwed = next
    if (descTimer) clearTimeout(descTimer)
    descTimer = setTimeout(() => {
      descTimer = null
      descOwed = null
      saveDraft('create-description', subject, next)
    }, 250)
  }

  /** Writes what the debounces still owe, now. Storage is synchronous, so
   *  this is safe from an effect teardown and from a create's first line. */
  function flushDrafts(): void {
    const owedSummary = summaryOwed
    const owedDesc = descOwed
    if (summaryTimer) clearTimeout(summaryTimer)
    if (descTimer) clearTimeout(descTimer)
    summaryTimer = descTimer = null
    summaryOwed = descOwed = null
    if (owedSummary !== null) saveDraft('create-summary', subject, owedSummary)
    if (owedDesc !== null) saveDraft('create-description', subject, owedDesc)
  }

  $effect(() => {
    /*
     * An app switch is not a teardown — iOS freezes the webview with the
     * sheet still mounted, so a 250 ms debt would die there. pagehide is the
     * one event this webview is guaranteed before that (and before a
     * reload); visibilitychange catches the background that never unloads.
     * Same reasoning, same pair, as the other two composers.
     */
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushDrafts()
    }
    window.addEventListener('pagehide', flushDrafts)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flushDrafts)
      document.removeEventListener('visibilitychange', onHidden)
      flushDrafts()
    }
  })

  async function create(): Promise<void> {
    const title = summary.trim()
    if (title === '' || creating || writesOff) return
    // The drafts go to storage before the POST, not after: a refused create
    // must leave them there, and a landed one clears them below.
    flushDrafts()
    saveDraft('create-summary', subject, summary)
    saveDraft('create-description', subject, desc)
    creating = true
    createError = null
    try {
      const res = await createIssue({
        summary: title,
        ...(desc.trim() !== '' ? { description_text: desc } : {}),
        // A child goes where its parent lives. The project key is empty only
        // on a row cached before the field existed; the server then resolves
        // its default, which is the same road the tab's own create takes.
        ...(parent ? { parent: parent.key } : {}),
        ...(parent && parent.projectKey !== '' ? { project_key: parent.projectKey } : {}),
        ...(!parent && project !== '' ? { project_key: project } : {}),
      })
      clearDraft('create-summary', subject)
      clearDraft('create-description', subject)
      summary = ''
      desc = ''
      onclose()
      void sync()
      openIssue(res.issue.issue_key)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'credential_required') {
        writesOff = true
        writesOffSentence = errorMessage(err)
        cacheFor().refusedSentence = writesOffSentence
        return
      }
      createError = errorMessage(err)
    } finally {
      creating = false
    }
  }
</script>

{#if open}
  <!-- The project question appears only when the serve offers more than
       one project — one-project serves (and the fixture) file into the
       default without asking, and the type is always the server's default. -->
  <Sheet title={parent ? t('write.newChild') : t('write.newIssue')} {onclose}>
    <div class="create">
      {#if parent}
        <!-- Where this is going, in one line and in the catalog's own word
             for the field: the phone never authors a noun (DESIGN.md §3.6). -->
        <p class="under" data-testid="create-parent">
          {fieldLabel('parent')}: {parent.key} · {parent.summary}
        </p>
      {/if}
      {#if writesOffSentence}
        <p class="off-note">{writesOffSentence}</p>
      {/if}
      <label class="lbl" for="create-summary">{t('write.issueTitle')}</label>
      <input
        id="create-summary"
        bind:value={summary}
        oninput={(e) => onSummaryInput(e.currentTarget.value)}
        placeholder={t('write.issueTitle')}
        enterkeyhint="next"
        disabled={writesOff}
      />
      <label class="lbl" for="create-desc">{t('detail.description')}</label>
      <textarea
        id="create-desc"
        bind:value={desc}
        oninput={(e) => onDescInput(e.currentTarget.value)}
        placeholder={t('write.descriptionPlain')}
        disabled={writesOff}
      ></textarea>
      {#if asksProject}
        <label class="lbl" for="create-project">{t('common.project')}</label>
        <select id="create-project" bind:value={project} disabled={writesOff}>
          {#each creatable as p (p.key)}
            <option value={p.key}>{p.key}{p.name && p.name !== p.key ? ` · ${p.name}` : ''}</option>
          {/each}
        </select>
      {/if}
      <button
        class="go"
        disabled={creating || summary.trim() === '' || writesOff}
        onclick={() => void create()}
      >
        {creating ? t('common.creating') : parent ? t('write.newChild') : t('write.newIssue')}
      </button>
      {#if restored}
        <p class="draft-note">{t('write.draftRestored')}</p>
      {/if}
      {#if createError}
        <p class="err">{createError}</p>
      {/if}
    </div>
  </Sheet>
{/if}

<style>
  .create {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 16px 16px;
  }
  .lbl {
    margin: 6px 0 0;
    font-size: var(--text-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .create input,
  .create textarea,
  .create select {
    min-height: var(--spacing-control);
    padding: 6px 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font: inherit;
  }
  .create textarea {
    min-height: 96px;
  }
  .create input:disabled,
  .create textarea:disabled,
  .create select:disabled {
    opacity: 0.45;
  }
  .go {
    min-height: var(--spacing-control);
    margin-top: 8px;
    padding: 0 16px;
    border-radius: 6px;
    font-weight: 600;
    background: var(--color-accent);
    color: var(--color-bg-base);
  }
  .go:disabled {
    opacity: 0.45;
  }
  .err {
    margin: 6px 0 0;
    font-size: var(--text-micro);
    color: var(--color-status-reopen);
  }
  .off-note {
    margin: 2px 0 0;
    font-size: var(--text-micro);
    color: var(--color-status-stale);
  }
  /* The parent line and the restored-draft caption are the same muted
     register the other sheets use for a fact about the sheet itself. */
  .under {
    margin: 2px 0 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .draft-note {
    margin: 6px 0 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
</style>
