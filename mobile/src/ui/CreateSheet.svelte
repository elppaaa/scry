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
  import { onDestroy, untrack } from 'svelte'
  import Sheet from './Sheet.svelte'
  import AttachChips, { type AttachChip } from './AttachChips.svelte'
  import { t, fieldLabel } from '../lib/i18n'
  import { ApiError, errorMessage } from '../lib/api'
  import { checkUploadable, uploadAttachment } from '../lib/attach'
  import { attachAll, createReady } from '../lib/create-attach'
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

  /*
   * A photo on a new issue (GDK-1879). This is the one place in the app where
   * a pick may NOT upload at once: the comment composer uploads on pick
   * because the issue already has a key, and here there is nothing to attach
   * to until the create lands. So the files are held client-side as chips and
   * the order on tap is create → upload each → open.
   *
   * Held in RAM only, and never drafted. `DraftKind` is unchanged on purpose:
   * storage can promise to restore a line of text, and cannot promise to
   * restore a photo out of the camera roll — a draft that says a picture is
   * coming and then files an issue without it is worse than no draft.
   */
  interface Picked {
    id: string
    file: File
    /** The object URL behind the 32px preview; revoked on remove and unmount. */
    thumb?: string
  }
  let picked = $state<Picked[]>([])
  /** Files still crossing the wire, after the create landed. No progress: the
   *  WebView reports nothing until the response head (lib/attach.ts). */
  let uploading = $state(0)
  /** The hidden picker, owned by the 'picker' instance below. */
  let pickerEl = $state<HTMLInputElement | null>(null)
  let seq = 0

  const chips = $derived<AttachChip[]>(
    picked.map((p) => ({
      id: p.id,
      name: p.file.name.trim() || t('detail.attachments'),
      ...(p.thumb ? { thumb: p.thumb } : {}),
    })),
  )

  function releasePicked(): void {
    for (const p of picked) if (p.thumb) URL.revokeObjectURL(p.thumb)
    picked = []
  }

  onDestroy(releasePicked)

  /**
   * A pick. `checkUploadable` runs here rather than after the create, so a
   * file that cannot be sent is refused before an issue exists to disappoint
   * — the refusal is the composer's sentence, in the sheet's own error slot.
   *
   * The thumbnail comes straight off the File. Nothing is fetched: unlike the
   * comment composer's chip, these bytes are already in this process.
   */
  function handleFiles(files: File[]): void {
    if (writesOff || creating || uploading > 0 || files.length === 0) return
    const refused = files.find((f) => !checkUploadable(f).ok)
    createError = refused ? t('write.attachFailed', { name: refused.name }) : null
    const next: Picked[] = []
    for (const file of files) {
      if (!checkUploadable(file).ok) continue
      seq += 1
      next.push({
        id: `p${seq}`,
        file,
        ...(file.type.startsWith('image/') ? { thumb: URL.createObjectURL(file) } : {}),
      })
    }
    picked = [...picked, ...next]
  }

  /** The × on a chip: nothing has been uploaded yet, so this really does
   *  drop the file — the one place in the app where it does. */
  function removePicked(id: string): void {
    const row = picked.find((p) => p.id === id)
    if (row?.thumb) URL.revokeObjectURL(row.thumb)
    picked = picked.filter((p) => p.id !== id)
  }

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
    if (!createReady(summary, uploading) || creating || writesOff) return
    // The drafts go to storage before the POST, not after: a refused create
    // must leave them there, and a landed one clears them below.
    flushDrafts()
    saveDraft('create-summary', subject, summary)
    saveDraft('create-description', subject, desc)
    creating = true
    createError = null
    let key: string
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
      key = res.issue.issue_key
    } catch (err) {
      if (err instanceof ApiError && err.code === 'credential_required') {
        writesOff = true
        writesOffSentence = errorMessage(err)
        cacheFor().refusedSentence = writesOffSentence
        return
      }
      createError = errorMessage(err)
      return
    } finally {
      creating = false
    }

    /*
     * The issue exists from here down, and nothing below may lose it.
     * lib/create-attach.ts's attachAll cannot throw — that is its contract —
     * so there is no branch out of this function that forgets the key.
     */
    clearDraft('create-summary', subject)
    clearDraft('create-description', subject)
    // The title and description stay on screen while the photos cross the
    // wire — a sheet showing only a chip and "Uploading… (1)" read as a
    // half-reset form in the vision pass. They clear once the uploads have
    // answered, below; createReady is false while uploading > 0, so the
    // still-visible title cannot arm a second create meanwhile.

    const files = picked.map((p) => p.file)
    let failed: { name: string }[] = []
    if (files.length > 0) {
      uploading = files.length
      const out = await attachAll(key, files, async (k, file) => {
        try {
          return await uploadAttachment(k, file)
        } finally {
          uploading -= 1
        }
      })
      failed = out.failed
    }
    releasePicked()
    summary = ''
    desc = ''
    void sync()

    if (failed.length > 0) {
      // The issue landed; only the picture did not. The sheet stays open with
      // the sentence in its error slot (z-index 30, above the detail layer's
      // 20) and the issue opens underneath, because the person's next move is
      // to attach it from Detail — where the picker uploads on pick. The
      // title is already cleared, so the create control is disabled and this
      // cannot become a second issue.
      createError = t('write.attachFailed', { name: failed[0].name })
      openIssue(key)
      return
    }
    onclose()
    openIssue(key)
  }
</script>

{#if open}
  <!-- The project question appears only when the serve offers more than
       one project — one-project serves (and the fixture) file into the
       default without asking, and the type is always the server's default. -->
  <Sheet title={parent ? t('write.newChild') : t('write.newIssue')} {onclose}>
    <!-- Outside .create for the same reason it sits outside .composer on
         Detail: `.create input` is how e2e/a2-captures.spec.ts spells "the
         title field", and a Playwright locator is strict. -->
    <AttachChips part="picker" bind:picker={pickerEl} onpick={handleFiles} />
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
      <!-- The paperclip beside the create button, and the chips it makes on
           their own full-width row above the pair — the composer's layout,
           because it is the composer's dialect (ui/AttachChips.svelte). -->
      <div class="go-row">
        <AttachChips
          part="controls"
          {chips}
          picker={pickerEl}
          testid="create-attachments"
          disabled={writesOff || creating || uploading > 0}
          onremove={removePicked}
        />
        <button
          class="go"
          class:busy={creating || uploading > 0}
          disabled={!createReady(summary, uploading) || creating || writesOff}
          onclick={() => void create()}
        >
          <!-- State in the pressed control (DESIGN §3.5), the same three-way
               label the Send button wears while bytes are in flight. -->
          {#if creating}{t('common.creating')}{:else if uploading > 0}{t('write.uploading', { n: uploading })}{:else}{parent ? t('write.newChild') : t('write.newIssue')}{/if}
        </button>
      </div>
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
  /* The paperclip, the chip row and the create button share one wrapping
     flex line — the same shape .composer has on Detail, so .att-row's
     `flex: 1 0 100%` puts the chips on their own row above them. The 8px
     that used to be .go's margin-top is the row's now; nothing else moved. */
  .go-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }
  .go {
    flex: 1;
    min-height: var(--spacing-control);
    padding: 0 16px;
    border-radius: 6px;
    font-weight: 600;
    background: var(--color-accent);
    /* The shared on-accent ink, not bg-base: in dark, bg-base is near-black
       on the mid-blue accent (armed 2.75:1, busy 1.74:1 in the 2026-09-14
       GDK-1879 vision pass) — the same fix GDK-1872 gave Send and Save. */
    color: var(--color-on-accent);
  }
  .go:disabled {
    opacity: 0.45;
  }
  /* Waiting is neither idle nor armed, same as .send.busy on Detail. */
  .go.busy {
    opacity: 0.6;
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
