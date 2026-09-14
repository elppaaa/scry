<script lang="ts">
  import Screen from '../ui/Screen.svelte'
  import { onDestroy, untrack } from 'svelte'
  import Sheet from '../ui/Sheet.svelte'
  import CreateSheet from '../ui/CreateSheet.svelte'
  import AdfBody from '../ui/AdfBody.svelte'
  import { app, closeIssue, openIssue, sync } from '../lib/store.svelte'
  import {
    dueDateLabel,
    overlayComments,
    pendingComment,
    relTime,
    resumeChanges,
    resumeLine,
    resumeSince,
    spineToken,
  } from '../lib/domain'
  import { request, requestBlob, errorMessage, ApiError } from '../lib/api'
  import {
    attachmentLabel,
    attachmentPath,
    checkUploadable,
    uploadAttachment,
  } from '../lib/attach'
  import { commentBody, sendReady } from '../lib/composer-attach'
  import {
    setDescription,
    setAssignee,
    setDuedate,
    setLabels,
    setPriority,
    setSummary,
    getPriorities,
    searchUsers,
  } from '../lib/writes'
  import { fieldRows, type FieldRow } from '../lib/fields'
  import { knownLabels, sameLabels, splitLabelInput } from '../lib/labels'
  import { keyboardInset } from '../lib/keyboard'
  import { clearDraft, loadDraft, saveDraft, type DraftKind } from '../lib/drafts'
  import { t, fieldLabel } from '../lib/i18n'
  import { showToast } from '../lib/toast.svelte'
  import { buildSharePayload, shareIssue, ShareRefused } from '../lib/share'
  import type {
    DetailComment,
    DetailResponse,
    IssueLite,
    PriorityDoc,
    TransitionDoc,
    UploadedAttachment,
    UserDoc,
  } from '../lib/types'

  let { issueKey }: { issueKey: string } = $props()

  /** The last issue a write on this screen brought back (GDK-1497 A2). */
  let written = $state<IssueLite | null>(null)

  // The header paints the freshest lite it has: the mirror row, overlaid by
  // the last write's own answer. A sync lands a newer row and wins on
  // updated_at; until it does, the write response holds the header.
  const lite = $derived.by<IssueLite | undefined>(() => {
    const row = app.issues.find((i) => i.issue_key === issueKey)
    if (row && written && (written.updated_at ?? '') > (row.updated_at ?? '')) return written
    return row ?? written ?? undefined
  })

  let detail = $state<DetailResponse | null>(null)
  let detailError = $state<string | null>(null)

  /*
   * Every field the mirror holds for this row (GDK-1870, DESIGN.md §1).
   * Decided by lib/fields.ts, not here: which rows exist, in what order and
   * under which word is a contract pinned in vitest, and this screen only
   * paints the answer. Empty — a row with no labels, no component, no parent
   * — takes the whole section away rather than drawing an empty heading.
   */
  const fields = $derived(fieldRows(lite, app.fieldSpecs))

  /*
   * The three one-line edits this screen gained (GDK-1871, DESIGN.md §1:
   * what is one line to say, the phone writes).
   *
   * Labels get one exception to fields.ts's "an empty value is no row": with
   * writes on, an issue carrying no labels still draws the row, because the
   * row is the affordance and there is no other way to reach the sheet. The
   * exception lives here and not in fieldRows(), which stays pure and
   * write-agnostic — it decides what the mirror holds, not what can be
   * edited. The synthetic row takes labels' own place in that order (before
   * components / fix versions / the site's own fields) rather than being
   * appended, so the section reads the same whether the issue has labels
   * or not.
   */
  /** The rows fields.ts orders BEFORE labels — everything else comes after,
   *  so the first row that is none of these is where the empty one goes. */
  const BEFORE_LABELS: readonly string[] = ['parent', 'epic', 'sprint']
  const fieldViews = $derived.by<FieldRow[]>(() => {
    if (writesOff || fields.some((f) => f.alias === 'labels')) return fields
    const empty: FieldRow = {
      alias: 'labels',
      label: fieldLabel('labels'),
      kind: 'list',
      value: [],
    }
    const at = fields.findIndex((f) => !BEFORE_LABELS.includes(f.alias))
    return at === -1 ? [...fields, empty] : [...fields.slice(0, at), empty, ...fields.slice(at)]
  })

  /** Only an epic may take a child: the server resolves the issue type from
   *  the project default independently of `parent`, and Jira refuses a
   *  standard type that names one (write.go handleCreate). */
  const isEpic = $derived(lite?.hierarchy_level === 1)
  let childOpen = $state(false)

  let labelsOpen = $state(false)
  /** The set being edited; the row's own set until a toggle moves it. */
  let labelDraft = $state<string[]>([])
  let labelInput = $state('')
  /** Labels typed in this sitting. Kept apart from the draft so one that is
   *  added and then turned back off stays on screen as an unchecked row
   *  rather than vanishing from a list it was never in. */
  let labelAdded = $state<string[]>([])
  let labelsSaving = $state(false)
  let labelsError = $state<string | null>(null)
  const currentLabels = $derived<string[]>(lite?.labels ?? [])
  /** Every label this workspace uses, plus any this row carries that the
   *  snapshot has not caught up with, plus whatever was just typed in. */
  const labelChoices = $derived(
    [
      ...new Set([...knownLabels(app.issues), ...currentLabels, ...labelDraft, ...labelAdded]),
    ].sort((a, b) => a.localeCompare(b)),
  )
  const labelsArmed = $derived(!sameLabels(labelDraft, currentLabels))

  let dueOpen = $state(false)
  /** `<input type="date">` speaks YYYY-MM-DD and so does the server. */
  let dueDraft = $state('')
  let dueSaving = $state(false)
  let dueError = $state<string | null>(null)
  const currentDue = $derived((lite?.duedate ?? '').slice(0, 10))
  const dueArmed = $derived(dueDraft !== '' && dueDraft !== currentDue)

  let sheetOpen = $state(false)
  let transitions = $state<TransitionDoc[] | null>(null)
  let transitionError = $state<string | null>(null)
  let applying = $state<string | null>(null)
  /**
   * Writability, one verdict with two roads (GDK-952): the store's probe of
   * GET credential/ (sync's cycle — settled by the first paint), or this
   * screen's own 409 latch for a credential that disappeared mid-session.
   * The screen never assigns the verdict — a refusal here only latches, so
   * the store stays the single owner of what "writable" means.
   */
  let refused = $state(false)
  const writesOff = $derived(app.writes === 'off' || refused)
  let failedId = $state<string | null>(null)

  /*
   * Share the key (GDK-877): "<KEY> <summary>" plus the origin's page when
   * the row has an absolute one. navigator.share when this webview exposes
   * it (unverified in WKWebView on device as of 2026-09-11 — the fallback
   * is the road until a device says otherwise), else a clipboard copy
   * announced with the same toast a link tap uses. lib/share.ts owns the
   * payload and refuses anything offer-shaped (DESIGN.md §5): a refusal
   * here is a bug, not a user error, so it says nothing and shares nothing.
   */
  async function share(): Promise<void> {
    if (!lite) return
    let payload
    try {
      payload = buildSharePayload({ issue_key: lite.issue_key, summary: lite.summary, url: lite.url })
    } catch (err) {
      if (err instanceof ShareRefused) return
      throw err
    }
    const nav = typeof navigator === 'undefined' ? undefined : navigator
    await shareIssue(payload, {
      share: typeof nav?.share === 'function' ? (d) => nav.share(d) : undefined,
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      onCopied: () => showToast(t('detail.linkCopied'), 'success'),
      onCopyFailed: () => showToast(t('clipboard.copyFailed'), 'error'),
    })
  }

  /* ── A2 header writes: assignee, priority, summary, description ── */
  let assigneeOpen = $state(false)
  let priorityOpen = $state(false)
  /** In-flight row id across both pick sheets (null = idle). */
  let applyingId = $state<string | null>(null)
  let rowError = $state<string | null>(null)
  let failedRow = $state<string | null>(null)
  let userQuery = $state('')
  let users = $state<UserDoc[]>([])
  let searching = $state(false)
  /** Search debounce handle + staleness guard: results land only for the
   *  newest keystroke, and the previous request is aborted, not just ignored. */
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchAbort: AbortController | null = null
  let searchSeq = 0
  /** Per-key catalog, kept for this screen's life once it loads. */
  let priorities = $state<PriorityDoc[] | null>(null)
  let prioritiesError = $state<string | null>(null)
  let prioritiesLoading = $state(false)
  let summaryEditing = $state(false)
  let summaryDraft = $state('')
  let summaryError = $state<string | null>(null)
  let summarySaving = $state(false)
  let descOpen = $state(false)
  let descDraft = $state('')
  let descSaving = $state(false)
  let descError = $state<string | null>(null)
  /** 409 format_loss answered: the next save re-PUTs with force. */
  let descForceAsk = $state(false)

  // What you were typing here last time (GDK-1863). Read once at mount —
  // App.svelte remounts this screen per key ({#key}), so the initializer is
  // the per-issue reset and no $effect has to assign it (GDK-692).
  const commentDraft = loadDraft('comment', untrack(() => issueKey))
  let comment = $state(commentDraft ?? '')
  let sending = $state(false)
  let sendError = $state<string | null>(null)
  /** RAM-only overlay (DESIGN.md §5). Never written to the snapshot cache. */
  let pending = $state<DetailComment | null>(null)

  /*
   * A photo goes with the comment (GDK-1872). lib/attach.ts owns the
   * transport and lib/composer-attach.ts the two decisions; what lives here
   * is the picker, the chips and the object URLs behind their thumbnails.
   *
   * The rows are NOT drafted. A pick uploads at once, the way the desk's
   * composer does (web/src/components/write/CommentComposer.svelte ~204), so
   * by the time a chip exists the file is already attached to the issue —
   * server state, not something storage should promise to restore. A restored
   * text draft is unchanged by any of this.
   */
  let attachments = $state<UploadedAttachment[]>([])
  /** Files still crossing the wire. Send reads it; there is no progress. */
  let uploading = $state(0)
  /** id → object URL for the chip thumbnails, the half the screen paints. */
  let thumbs = $state<Record<string, string>>({})
  /** The same URLs as a plain map, so teardown can revoke them after the
   *  last render (the shape AdfBody's blobUrls uses, and for the reason). */
  const thumbUrls = new Map<string, string>()
  /** The hidden picker. A plain let: nothing renders it. */
  let fileInput: HTMLInputElement | null = null

  function releaseThumb(id: string): void {
    const url = thumbUrls.get(id)
    if (url === undefined) return
    URL.revokeObjectURL(url)
    thumbUrls.delete(id)
  }

  /** Every object URL this sitting made. Called on a landed comment and on
   *  teardown — a revoke under a painted <img> would leave a broken frame,
   *  so both callers drop the chips in the same breath. */
  function releaseThumbs(): void {
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url)
    thumbUrls.clear()
  }

  onDestroy(releaseThumbs)

  /**
   * The chip's 32px preview, fetched through the same bearer road AdfBody's
   * inline images take. A failure is silent on purpose: the chip keeps its
   * name, and the file is on the issue either way — a second error line for
   * a thumbnail would say nothing the person can act on.
   */
  async function loadThumb(a: UploadedAttachment): Promise<void> {
    const path = attachmentPath(a.content_url)
    if (path === null) return
    try {
      const blob = await requestBlob(path)
      const url = URL.createObjectURL(blob)
      thumbUrls.set(a.id, url)
      thumbs = { ...thumbs, [a.id]: url }
    } catch {
      // Name-only chip. Nothing to retry: the upload already landed.
    }
  }

  /**
   * The × on a chip takes the file out of the COMMENT, not off the issue —
   * the upload attached it there and there is no un-attach in this screen's
   * vocabulary. The desk's composer does exactly the same (CommentComposer
   * ~239 drops the row and never calls a delete).
   */
  function removeAttachment(id: string): void {
    attachments = attachments.filter((a) => a.id !== id)
    releaseThumb(id)
    const next = { ...thumbs }
    delete next[id]
    thumbs = next
  }

  /**
   * A pick. Every file is pre-flighted before a byte is spent
   * (checkUploadable), then the survivors upload in parallel — one request
   * each, which is the endpoint's shape.
   *
   * Only one refusal sentence can be on screen at a time, so a multi-file
   * pick whose first two files are refused names the first: the line is a
   * report that something was skipped, not a log.
   */
  async function handleFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    // Cleared before anything can await: picking the same photo twice is a
    // real pick, and a browser fires no change event when value is unchanged.
    input.value = ''
    if (writesOff || sending || files.length === 0) return
    const usable = files.filter((f) => checkUploadable(f).ok)
    const refusedFile = files.find((f) => !checkUploadable(f).ok)
    sendError = refusedFile ? t('write.attachFailed', { name: refusedFile.name }) : null
    await Promise.all(
      usable.map(async (file) => {
        uploading += 1
        try {
          const res = await uploadAttachment(issueKey, file)
          attachments = [...attachments, ...res.attachments]
          for (const a of res.attachments) if (a.is_image) void loadThumb(a)
        } catch (err) {
          // The 409 takes the same latch send() takes: one refusal road for
          // the whole screen, and the sentence goes to the status row (the
          // GDK-933 rule that .send-error hides once writes are off).
          if (!refuseWrite(err)) {
            sendError = t('write.attachFailed', { name: file.name })
          }
        } finally {
          uploading -= 1
        }
      }),
    )
  }

  const thread = $derived(overlayComments(detail?.comments ?? [], pending))

  /*
   * Composer drafts (GDK-1863). Three composers on this screen used to live
   * in component state alone, so an app switch, a host switch, a token
   * refresh or a crash dropped whatever was half-typed. lib/drafts.ts owns
   * the storage; this screen owns only when to restore, save and forget.
   *
   * The debounce handles are plain lets, not $state: nothing renders them,
   * and the effect's teardown must be able to read them after the last
   * render. `draftPending` is what a timer still owes storage — flushed on
   * teardown (a back-tap inside the debounce window must not lose a word)
   * and before any write that may fail.
   */
  const draftTimers: Record<DraftKind, ReturnType<typeof setTimeout> | null> = {
    comment: null,
    summary: null,
    description: null,
  }
  const draftPending: Record<DraftKind, string | null> = {
    comment: null,
    summary: null,
    description: null,
  }
  /** One muted line per composer, dismissed by the first keystroke. */
  let commentRestored = $state(commentDraft !== null)
  let summaryRestored = $state(false)
  let descRestored = $state(false)

  function queueDraft(kind: DraftKind, key: string, text: string): void {
    draftPending[kind] = text
    const running = draftTimers[kind]
    if (running) clearTimeout(running)
    draftTimers[kind] = setTimeout(() => {
      draftTimers[kind] = null
      draftPending[kind] = null
      saveDraft(kind, key, text)
    }, 250)
  }

  function cancelDraft(kind: DraftKind): void {
    const running = draftTimers[kind]
    if (running) clearTimeout(running)
    draftTimers[kind] = null
    draftPending[kind] = null
  }

  /** Writes what the debounce still owes, now. Storage is synchronous, so
   *  this is safe from an effect teardown and from a send's first line. */
  function flushDraft(kind: DraftKind, key: string): void {
    const text = draftPending[kind]
    cancelDraft(kind)
    if (text !== null) saveDraft(kind, key, text)
  }

  const DRAFT_KINDS: readonly DraftKind[] = ['comment', 'summary', 'description']

  function onCommentInput(next: string): void {
    commentRestored = false
    queueDraft('comment', issueKey, next)
  }

  function onSummaryInput(next: string): void {
    summaryRestored = false
    queueDraft('summary', issueKey, next)
  }

  function onDescInput(next: string): void {
    descRestored = false
    queueDraft('description', issueKey, next)
  }

  /*
   * Resume card (GDK-1495 ③) — a tinted card above the thread saying what
   * changed since this issue was last opened. Rides the detail response
   * already loaded: no fetch of its own, one pass, the desk's own diff
   * (lib/domain resumeSince/resumeChanges → web resume-card).
   *
   * Rendered only when the serve knows of a previous read AND something
   * happened after it. No previous visit → no card; nothing changed → no
   * card; and no empty state either — the absence is the reading. The phone
   * feeds this itself now (GDK-1538: store.recordVisit posts every open on
   * the desk's own route), so a workspace nobody opens at a desk gets the
   * card from its second visit on.
   *
   * Dismissal is local to this screen, and explicit: the desk's card is a
   * button whose click reveals the change log, and the phone has no change
   * log to reveal — so the card is not a button at all, and carries its own
   * × instead of quietly swallowing a tap on its sentence.
   */
  let resumeDismissed = $state(false)
  const resumeSinceAt = $derived(detail ? resumeSince(detail) : null)
  const resumeDelta = $derived(detail ? resumeChanges(detail, resumeSinceAt) : null)
  const resumeText = $derived(
    resumeDelta && resumeSinceAt && !resumeDismissed
      ? resumeLine(resumeDelta, relTime(resumeSinceAt, app.now))
      : '',
  )
  /** Accent fill only when this control can send (GDK-934). Empty, writes-off
   *  or an upload still in flight recedes (GDK-1872: sendReady owns the rule). */
  const sendArmed = $derived(
    !writesOff && (sendReady(comment, attachments, uploading) || sending),
  )

  /** The clearing rows are "current" only when the issue really carries no
   *  value — an empty id is the mirror's "unknown", not "none" (types.ts:39
   *  pins that contract for priority_id), so an id-less row marks nothing. */
  const unassignedNow = $derived(!lite?.assignee_id)
  const priorityNone = $derived(Boolean(lite) && !lite?.priority_id && !lite?.priority)

  /** Assignee sheet rows beyond the clearing one: me, the current assignee,
   *  then what the search brought — deduped by account id. */
  const assigneeCandidates = $derived.by<
    Array<{ id: string; accountId: string | null; label: string; sub: string | null }>
  >(() => {
    const out: Array<{ id: string; accountId: string | null; label: string; sub: string | null }> = []
    const seen = new Set<string>()
    const me = app.me
    const meId = me?.account_id ?? null
    if (me && meId) {
      seen.add(meId)
      out.push({
        id: 'me',
        accountId: meId,
        label: me.name || me.email || t('common.me'),
        sub: t('common.me'),
      })
    }
    const currentId = lite?.assignee_id ?? null
    if (currentId && !seen.has(currentId)) {
      seen.add(currentId)
      out.push({
        id: 'current',
        accountId: currentId,
        label: lite?.assignee ?? currentId,
        sub: null,
      })
    }
    for (const u of users) {
      if (seen.has(u.account_id)) continue
      seen.add(u.account_id)
      out.push({
        id: 'user-' + u.account_id,
        accountId: u.account_id,
        label: u.display_name,
        sub: u.email,
      })
    }
    return out
  })

  function isCredentialRequired(err: unknown): boolean {
    return err instanceof ApiError && err.code === 'credential_required'
  }

  // The A2 write states are NOT reset here: GDK-692 bans $state assigns in
  // effect bodies, and the app already owns this — App.svelte remounts the
  // whole screen per key ({#key}), so every control above starts clean on
  // a new issue. Only the search plumbing (plain lets, not $state) needs
  // an explicit teardown, and that rides this effect's cleanup.
  $effect(() => {
    const key = issueKey
    detail = null
    detailError = null
    sheetOpen = false
    sendError = null
    pending = null
    transitions = null
    applying = null
    failedId = null
    if (!writesOff) transitionError = null
    void (async () => {
      try {
        const res = await request<DetailResponse>(`issues/${key}/detail/`)
        if (key === issueKey) detail = res.body
      } catch (err) {
        if (key !== issueKey) return
        detailError =
          err instanceof ApiError && err.code === 'not_found'
            ? t('detail.notFound')
            : errorMessage(err)
      }
    })()
    /*
     * The debounce's owed text, written now. The captured key, not the live
     * prop: this runs on teardown too, which also fires when the screen
     * moves to another issue, and the debt belongs to the old one.
     *
     * An app switch is not a teardown — iOS freezes the webview with the
     * screen still mounted, so a 250 ms debt would die there. pagehide is
     * the one event this webview is guaranteed before that (and before a
     * reload); visibilitychange catches the background that never unloads.
     * Both are synchronous and localStorage is synchronous, so the write
     * completes inside the handler. Measured (e2e/drafts.spec.ts, a reload
     * inside the window): without this the last keystroke was lost. The
     * iOS background is the reasoned half — pagehide is what that webview
     * gets — not a device measurement.
     */
    const flushAllDrafts = () => {
      for (const kind of DRAFT_KINDS) flushDraft(kind, key)
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushAllDrafts()
    }
    window.addEventListener('pagehide', flushAllDrafts)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      searchSeq++
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = null
      searchAbort?.abort()
      searchAbort = null
      window.removeEventListener('pagehide', flushAllDrafts)
      document.removeEventListener('visibilitychange', onHidden)
      flushAllDrafts()
    }
  })

  // One owner (GDK-906): header chip is data (DESIGN.md §4); this is the control.
  async function openTransitions() {
    if (writesOff) return
    if (transitions !== null) {
      sheetOpen = true
      return
    }
    transitionError = null
    failedId = null
    try {
      const res = await request<{ transitions: TransitionDoc[] }>(`issues/${issueKey}/transitions/`)
      transitions = res.body?.transitions ?? []
      if (writesOff) return
      sheetOpen = true
    } catch (err) {
      transitionError = errorMessage(err)
      if (isCredentialRequired(err)) {
        refused = true
        return
      }
      sheetOpen = true
    }
  }

  async function applyTransition(doc: TransitionDoc) {
    if (applying || writesOff) return
    applying = doc.id
    transitionError = null
    failedId = null
    try {
      await request(`issues/${issueKey}/transition/`, {
        method: 'POST',
        body: { transition_id: doc.id },
      })
      sheetOpen = false
      transitions = null
      void sync()
    } catch (err) {
      transitionError = errorMessage(err)
      failedId = doc.id
      if (isCredentialRequired(err)) {
        refused = true
        sheetOpen = false
      }
    } finally {
      applying = null
    }
  }

  async function send() {
    const text = comment.trim()
    if (writesOff || sending || !sendReady(comment, attachments, uploading)) return
    // The draft goes to storage before the POST, not after: a refused send
    // must leave it there, and the box is emptied two lines below.
    flushDraft('comment', issueKey)
    saveDraft('comment', issueKey, text)
    sending = true
    sendError = null
    // Text-only, on purpose: the overlay is a bubble in the thread, and the
    // picture it would have to paint is the one the server is about to embed
    // for real. The chips stay where they are until the answer comes back.
    const overlay = pendingComment(text, app.me, new Date())
    pending = overlay
    const sent = attachments
    comment = ''
    commentRestored = false
    try {
      await request(`issues/${issueKey}/comment/`, {
        method: 'POST',
        body: commentBody(text, sent),
      })
      clearDraft('comment', issueKey) // only a landed comment forgets its draft
      pending = null
      attachments = []
      releaseThumbs()
      thumbs = {}
      const res = await request<DetailResponse>(`issues/${issueKey}/detail/`)
      detail = res.body
      void sync()
    } catch (err) {
      pending = null
      if (comment.trim() === '') comment = text
      // The chips are NOT dropped: those files are already on the issue, and
      // a retry must embed the same ones rather than ask for the photo again.
      // That includes 502 write_applied_mirror_stale, where the comment
      // itself landed too — this screen offers no retry for that, only the
      // sentence (GDK-1872: attaching the picture twice is the worse answer).
      sendError = errorMessage(err)
      if (isCredentialRequired(err)) {
        refused = true
        transitionError = sendError
      }
    } finally {
      sending = false
    }
  }

  /* ── A2 write controls. Every one of them goes through the same 409 road
   *  the transition sheet built: sticky writesOff, one sentence on the
   *  status row, every control recedes. No control ever throws onward. */

  function refuseWrite(err: unknown, keepSheetOpen = false): boolean {
    if (!isCredentialRequired(err)) return false
    refused = true
    transitionError = errorMessage(err)
    if (keepSheetOpen) return true
    assigneeOpen = false
    priorityOpen = false
    summaryEditing = false
    descOpen = false
    return true
  }

  function openAssignee() {
    if (writesOff) return
    rowError = null
    failedRow = null
    assigneeOpen = true
  }

  function onUserQuery(next: string) {
    userQuery = next
    if (searchTimer) clearTimeout(searchTimer)
    if (next.trim().length < 2) {
      searchSeq++
      searchAbort?.abort()
      searchAbort = null
      users = []
      searching = false
      return
    }
    const seq = ++searchSeq
    searching = true
    searchTimer = setTimeout(() => void runUserSearch(next, seq), 250)
  }

  async function runUserSearch(q: string, seq: number) {
    searchAbort?.abort()
    const ctl = new AbortController()
    searchAbort = ctl
    try {
      const res = await searchUsers(issueKey, q.trim(), { signal: ctl.signal })
      if (seq !== searchSeq) return
      users = res.users
    } catch (err) {
      if (seq !== searchSeq || ctl.signal.aborted) return
      // The fixed rows stay usable; only the search band reports.
      users = []
      rowError = errorMessage(err)
    } finally {
      if (seq === searchSeq) searching = false
    }
  }

  async function pickAssignee(accountId: string | null) {
    if (writesOff || applyingId) return
    applyingId = accountId ?? 'unassigned'
    rowError = null
    failedRow = null
    try {
      const res = await setAssignee(issueKey, accountId)
      written = res.issue
      assigneeOpen = false
      void sync()
    } catch (err) {
      if (refuseWrite(err)) return
      rowError = errorMessage(err)
      failedRow = applyingId
    } finally {
      applyingId = null
    }
  }

  function openPriority() {
    if (writesOff) return
    priorityOpen = true
    if (priorities !== null || prioritiesLoading) return
    prioritiesError = null
    prioritiesLoading = true
    void (async () => {
      try {
        const res = await getPriorities(issueKey)
        priorities = res.priorities
      } catch (err) {
        if (refuseWrite(err)) return
        prioritiesError = errorMessage(err)
      } finally {
        prioritiesLoading = false
      }
    })()
  }

  async function pickPriority(priorityId: string | null) {
    if (writesOff || applyingId) return
    applyingId = priorityId ?? 'none'
    rowError = null
    failedRow = null
    try {
      const res = await setPriority(issueKey, priorityId)
      written = res.issue
      priorityOpen = false
      void sync()
    } catch (err) {
      if (refuseWrite(err)) return
      rowError = errorMessage(err)
      failedRow = applyingId
    } finally {
      applyingId = null
    }
  }

  /* ── Labels and the due date (GDK-1871). Both are the picker dialect the
   *  priority sheet set: a sheet of rows, one write, `written = res.issue`
   *  then `void sync()`.
   *
   *  The one departure is the refusal. refuseWrite drops the open sheet so
   *  its sentence lands on the status row underneath, which is right for a
   *  picker whose rows are the server's — reopening asks the server again.
   *  These two sheets hold something the person composed (a set they
   *  toggled, a date they picked), and eating that on a refusal is the
   *  defect GDK-1863 closed for words. So the latch is taken (writes are
   *  off from here on, every control recedes) and the sheet stays standing
   *  with its set and the same sentence in its own error line. */

  function openLabels() {
    if (writesOff) return
    labelDraft = [...currentLabels]
    labelInput = ''
    labelAdded = []
    labelsError = null
    labelsOpen = true
  }

  function toggleLabel(label: string) {
    labelDraft = labelDraft.includes(label)
      ? labelDraft.filter((l) => l !== label)
      : [...labelDraft, label]
  }

  /** Whitespace separates labels rather than sitting inside one: Jira
   *  refuses a label with a space and the server only trims (lib/labels.ts). */
  function addTypedLabel() {
    const typed = splitLabelInput(labelInput)
    if (typed.length === 0) return
    labelDraft = [...new Set([...labelDraft, ...typed])]
    labelAdded = [...new Set([...labelAdded, ...typed])]
    labelInput = ''
  }

  async function saveLabels() {
    if (writesOff || labelsSaving || !labelsArmed) return
    labelsSaving = true
    labelsError = null
    try {
      const res = await setLabels(issueKey, labelDraft)
      written = res.issue
      labelsOpen = false
      void sync()
    } catch (err) {
      labelsError = errorMessage(err)
      refuseWrite(err, true)
    } finally {
      labelsSaving = false
    }
  }

  function openDue() {
    if (writesOff) return
    dueDraft = currentDue
    dueError = null
    dueOpen = true
  }

  async function writeDue(value: string | null) {
    if (writesOff || dueSaving) return
    dueSaving = true
    dueError = null
    try {
      const res = await setDuedate(issueKey, value)
      written = res.issue
      dueOpen = false
      void sync()
    } catch (err) {
      dueError = errorMessage(err)
      refuseWrite(err, true)
    } finally {
      dueSaving = false
    }
  }

  function editSummary() {
    if (writesOff || !lite) return
    const saved = loadDraft('summary', issueKey)
    summaryDraft = saved ?? lite.summary
    summaryRestored = saved !== null && saved.trim() !== lite.summary.trim()
    summaryError = null
    summaryEditing = true
  }

  /**
   * Leaving the editor keeps the draft — the user may come back — unless
   * the text is already what the server holds, which is nothing to return
   * to. saveDraft treats empty text as a clear, so a wiped box is a clear.
   */
  function closeSummaryEdit(): void {
    cancelDraft('summary')
    if (summaryDraft.trim() === (lite?.summary ?? '').trim()) clearDraft('summary', issueKey)
    else saveDraft('summary', issueKey, summaryDraft)
    summaryEditing = false
    summaryRestored = false
  }

  async function saveSummary() {
    const text = summaryDraft.trim()
    if (writesOff || summarySaving || text === '') return
    flushDraft('summary', issueKey)
    saveDraft('summary', issueKey, summaryDraft)
    summarySaving = true
    summaryError = null
    try {
      const res = await setSummary(issueKey, text)
      clearDraft('summary', issueKey)
      summaryRestored = false
      written = res.issue
      summaryEditing = false
      void sync()
    } catch (err) {
      if (refuseWrite(err)) return
      summaryError = errorMessage(err)
    } finally {
      summarySaving = false
    }
  }

  function editDescription() {
    if (writesOff) return
    // description_md is the write format; old serves predate it and the
    // flattened text is the best draft they can offer.
    const server = detail?.description_md ?? detail?.description_text ?? ''
    const saved = loadDraft('description', issueKey)
    descDraft = saved ?? server
    descRestored = saved !== null && saved.trim() !== server.trim()
    descError = null
    descForceAsk = false
    descOpen = true
  }

  /** Same bargain as the summary editor: closing keeps what differs from
   *  the server, and forgets what does not. */
  function closeDescription(): void {
    cancelDraft('description')
    const server = detail?.description_md ?? detail?.description_text ?? ''
    if (descDraft.trim() === server.trim()) clearDraft('description', issueKey)
    else saveDraft('description', issueKey, descDraft)
    descOpen = false
    descRestored = false
  }

  async function saveDescription(force: boolean) {
    if (writesOff || descSaving) return
    flushDraft('description', issueKey)
    saveDraft('description', issueKey, descDraft)
    descSaving = true
    descError = null
    try {
      await setDescription(issueKey, descDraft, { force })
      clearDraft('description', issueKey)
      descRestored = false
      descOpen = false
      descForceAsk = false
      // Refetch so AdfBody re-renders the stored body, then sync the rows.
      const res = await request<DetailResponse>(`issues/${issueKey}/detail/`)
      detail = res.body
      void sync()
    } catch (err) {
      if (refuseWrite(err)) return
      if (err instanceof ApiError && err.code === 'format_loss') {
        descForceAsk = true
      } else if (err instanceof ApiError && err.code === 'placeholder' && err.serverMessage) {
        descError = t('write.placeholderRefused', { message: err.serverMessage })
      } else {
        descError = errorMessage(err)
      }
    } finally {
      descSaving = false
    }
  }
</script>

<div class="push">
  <Screen>
    {#snippet header()}
      <div class="bar">
        <button class="back" onclick={closeIssue} aria-label={t('app.back')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span>{t('app.back')}</span>
        </button>
        <span class="bar-key">{issueKey}</span>
        <span class="bar-pad">
          {#if lite}
            <button class="share" data-testid="detail-share" onclick={() => void share()} aria-label={t('detail.share')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
                <path d="M16 6l-4-4-4 4" />
                <path d="M12 2v13" />
              </svg>
            </button>
          {/if}
        </span>
      </div>
    {/snippet}

    {#if lite}
      <article class="spined spine-{spineToken(lite)}">
        <div class="chips">
          <span class="chip">
            <span class="dot dot-{spineToken(lite)}" aria-hidden="true"></span>
            <span>{lite.status}</span>
          </span>
        </div>
        {#if summaryEditing}
          <div class="summary-edit">
            <input
              bind:value={summaryDraft}
              placeholder={t('write.issueTitle')}
              aria-label={t('write.editTitle')}
              enterkeyhint="done"
              oninput={(e) => onSummaryInput(e.currentTarget.value)}
              onkeydown={(e) => {
                if (e.key === 'Enter') void saveSummary()
              }}
            />
            <button class="save" class:armed={summaryDraft.trim() !== ''} disabled={summarySaving || summaryDraft.trim() === ''} onclick={() => void saveSummary()}>
              {t('common.save')}
            </button>
            <button class="ghost" onclick={closeSummaryEdit}>{t('common.cancel')}</button>
            {#if summaryRestored}
              <p class="draft-note">{t('write.draftRestored')}</p>
            {/if}
            {#if summaryDraft.trim() === ''}
              <p class="field-err">{t('write.titleRequired')}</p>
            {:else if summaryError}
              <p class="field-err">{summaryError}</p>
            {/if}
          </div>
        {:else}
          <div class="subject">
            <h1 class="type-subject">{lite.summary}</h1>
            <button class="edit" onclick={editSummary} disabled={writesOff} aria-label={t('write.editTitle')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            {#if isEpic && !writesOff}
              <!-- Only on an epic, and only when writes are on: the same
                   plus the Issues tab wears, in the title row's own control
                   dialect. See `isEpic` for why a standard row has none. -->
              <button
                class="edit"
                onclick={() => (childOpen = true)}
                aria-label={t('write.newChild')}
                aria-haspopup="dialog"
                aria-expanded={childOpen}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </svg>
              </button>
            {/if}
          </div>
        {/if}
        <!-- Two rows on purpose (review 2026-09-14): controls on the first
             (type · priority · assignee · due), provenance on the second
             (updated · by). One flex-wrap line broke after "updated 4d ·"
             and left the separator dangling at the line's end; the dots are
             now CSS on the item that follows, so a wrap can never orphan one. -->
        <div class="meta">
          <p class="m-row">
            <span class="m-item">{lite.issue_type}</span>
            <button class="m-btn m-item" onclick={openPriority} disabled={writesOff}>
              {lite.priority ?? t('write.changePriority')}
              <svg class="m-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <button class="m-btn m-item" onclick={openAssignee} disabled={writesOff}>
              {lite.assignee ?? t('common.unassigned')}
              <svg class="m-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {#if lite.duedate || !writesOff}
              <!-- The deadline rides the meta line in the desk's own absolute
                   form — the calendar module's date kind, which keeps the
                   written day whatever zone this phone sits in. Since
                   GDK-1871 it is also the control that changes it, in the
                   same dialect as priority and assignee beside it; with no
                   date set it wears the bare label, which is the only
                   affordance a row without a due date can have. -->
              <button class="m-btn m-item due" onclick={openDue} disabled={writesOff}>
                {lite.duedate
                  ? `${fieldLabel('due')}: ${dueDateLabel(lite.duedate)}`
                  : fieldLabel('due')}
                <svg class="m-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            {/if}
          </p>
          <p class="m-row">
            <span class="m-item">{t('detail.updatedWhen', { when: relTime(lite.updated_at, app.now) })}</span>
            {#if lite.reporter}
              <span class="m-item">{t('detail.byline', { name: lite.reporter })}</span>
            {/if}
          </p>
        </div>
      </article>
    {/if}

    <section class="body">
      {#if detailError}
        <p class="error">{detailError}</p>
      {:else if !detail}
        <div class="skel" aria-hidden="true">
          <span class="g w1"></span><span class="g w2"></span><span class="g w3"></span>
        </div>
      {:else}
        {#if resumeText}
          <div class="resume" data-testid="resume-card">
            <span class="resume-text">{resumeText}</span>
            <button
              type="button"
              class="resume-x"
              aria-label={t('detail.resume.dismiss')}
              onclick={() => (resumeDismissed = true)}>×</button
            >
          </div>
        {/if}
        <h3>{t('detail.comments')} <span class="h-n">{thread.length}</span></h3>
        {#if thread.length === 0}
          <p class="none">{t('detail.noComments')}</p>
        {/if}
        {#each thread as c (c.comment_id)}
          <div class="comment">
            <p class="c-head">
              <span class="c-author">{c.author ?? t('detail.unknownAuthor')}</span>
              <span class="c-when">{relTime(c.created_at, app.now)}</span>
            </p>
            <AdfBody doc={c.raw_body} fallback={c.body} {issueKey} attachments={detail.attachments} />
          </div>
        {/each}

        <div class="h-row">
          <h3>{t('detail.description')}</h3>
          <button class="edit" onclick={editDescription} disabled={writesOff} aria-label={t('write.editDescription')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        </div>
        {#if detail.description_adf || detail.description_text}
          <AdfBody
            doc={detail.description_adf}
            fallback={detail.description_text}
            {issueKey}
            attachments={detail.attachments}
          />
        {:else}
          <p class="none">{t('detail.noDescription')}</p>
        {/if}

        {#if fieldViews.length > 0}
          <h3>{t('detail.fields')}</h3>
          <div data-testid="detail-fields">
            {#each fieldViews as f (f.alias)}
              {#if f.kind === 'key'}
                <!-- A key is a place to go, so the row is the button and the
                     44pt floor app.css puts on every button applies. -->
                <button class="field" onclick={() => openIssue(String(f.value))}>
                  <span class="f-label">{f.label}</span>
                  <span class="f-key">{f.value}</span>
                </button>
              {:else if f.alias === 'labels' && !writesOff}
                <!-- The one editable row (GDK-1871). It is a button, so it
                     takes the 44pt floor like the key rows, but the value
                     keeps the plain text colour a key's does not: this row
                     goes nowhere, it opens the set. The chevron is what says
                     tappable, in the muted register of the label beside it. -->
                <button class="field" data-testid="field-labels" onclick={openLabels}>
                  <span class="f-label">{f.label}</span>
                  <span class="f-value">{Array.isArray(f.value) ? f.value.join(', ') : f.value}</span>
                  <span class="f-chev" aria-hidden="true">›</span>
                </button>
              {:else}
                <div class="field">
                  <span class="f-label">{f.label}</span>
                  <span class="f-value">{Array.isArray(f.value) ? f.value.join(', ') : f.value}</span>
                </div>
              {/if}
            {/each}
          </div>
        {/if}

        {#if detail.linked_issues.length > 0}
          <h3>{t('detail.linked')}</h3>
          {#each detail.linked_issues as l (l.key + l.direction + l.type)}
            <button class="linked" onclick={() => openIssue(l.key)}>
              <span class="l-key">{l.key}</span>
              <span class="l-type">{l.type}</span>
              <span class="l-sum">{l.summary ?? ''}</span>
            </button>
          {/each}
        {/if}
      {/if}
      <div class="tail" aria-hidden="true"></div>
    </section>

    {#snippet footer()}
      <div class="composer-slab" use:keyboardInset>
        {#if lite}
          <button class="status" disabled={writesOff} onclick={openTransitions}>
            <span class="status-line">
              <span class="dot dot-{spineToken(lite)}" aria-hidden="true"></span>
              <span>{lite.status}</span>
              {#if !writesOff}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              {/if}
            </span>
            {#if writesOff && transitionError}
              <span class="status-err">{transitionError}</span>
            {:else if writesOff}
              <!-- The store's probe said credential-less before any write
                   was refused (GDK-952): say why, with the same sentence a
                   refusal gets — the api.ts copy for credential_required. -->
              <span class="status-err">{t('app.errorNoCredential')}</span>
            {/if}
          </button>
        {/if}
        <!-- The picker. A web file input inside WKWebView opens the native
             sheet (Photo Library / Take Photo / Choose File) with no Tauri
             plugin, which is why there is no picker code in this screen at
             all — only a button that clicks this.

             It sits beside .composer rather than inside it, and that is not
             cosmetic: `.composer input` is how three suites already spell
             "the comment field" (e2e/drafts.spec.ts, e2e/pagecomment.spec.ts,
             shots/zz-review.spec.ts), and a second input under that selector
             makes every one of them ambiguous. `hidden`, never a sized
             transparent box: the viewport gate counts every input that
             paints, and this one must not be one of them. -->
        <input
          bind:this={fileInput}
          class="file"
          type="file"
          accept="image/*"
          multiple
          hidden
          tabindex="-1"
          onchange={(e) => void handleFiles(e)}
        />
        <div class="composer safe-bottom" class:off={writesOff}>
          <!-- One chip per uploaded file, on its own full-width row above
               the field. The × takes the file out of the comment, never off
               the issue: the upload already attached it there, which is the
               desk's behaviour too. -->
          {#if attachments.length > 0}
            <div class="att-row" data-testid="composer-attachments">
              {#each attachments as a (a.id)}
                <span class="att">
                  {#if a.is_image && thumbs[a.id]}
                    <img class="att-thumb" src={thumbs[a.id]} alt="" />
                  {/if}
                  <span class="att-name">{attachmentLabel(a) || t('detail.attachments')}</span>
                  <button
                    type="button"
                    class="att-x"
                    aria-label={t('write.removeAttachment')}
                    onclick={() => removeAttachment(a.id)}>×</button
                  >
                </span>
              {/each}
            </div>
          {/if}
          <button
            type="button"
            class="attach"
            aria-label={t('write.attachFile')}
            disabled={writesOff || sending}
            onclick={() => fileInput?.click()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            bind:value={comment}
            disabled={writesOff}
            placeholder={t('write.commentPlaceholder')}
            enterkeyhint="send"
            oninput={(e) => onCommentInput(e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') void send()
            }}
          />
          <button
            class="send"
            class:armed={sendArmed}
            class:busy={sending || uploading > 0}
            disabled={writesOff || !sendReady(comment, attachments, uploading) || sending}
            onclick={() => void send()}
          >
            <!-- State in the pressed control, not a spinner (DESIGN.md §3.5).
                 There is no percentage to show: plugin-http reports nothing
                 until the response head comes back (lib/attach.ts UploadOpts). -->
            {#if sending}{t('write.commentPosting')}{:else if uploading > 0}{t('write.uploading', { n: uploading })}{:else}{t('write.commentButton')}{/if}
          </button>
          {#if sendError && !writesOff}
            <p class="send-error">{sendError}</p>
          {:else if commentRestored && !writesOff}
            <p class="draft-note">{t('write.draftRestored')}</p>
          {/if}
        </div>
      </div>
    {/snippet}
  </Screen>

  <!-- The current value's mark, one owner for both pick sheets. It is a
       shape, not a colour: the row's text stays primary so the mark reads as
       "this is what the issue has", never as "this is the actionable one"
       (the accent is the Cancel/link colour on this screen). -->
  {#snippet currentTick()}
    <svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  {/snippet}

  {#if sheetOpen}
    <Sheet title={t('write.moveStatus')} onclose={() => (sheetOpen = false)}>
      <div class="t-list">
        {#if !transitions && !transitionError}
          <p class="none">{t('write.askingServer')}</p>
        {:else if transitions}
          {#each transitions as tr (tr.id)}
            {@const blocked = (tr.fields?.length ?? 0) > 0}
            <button class="t-row" disabled={blocked || applying !== null} onclick={() => void applyTransition(tr)}>
              <span class="dot dot-{tr.to_category}" aria-hidden="true"></span>
              <span class="t-text">
                <span class="t-name">{applying === tr.id ? t('common.applying') : tr.name}</span>
                <!-- The built-in tracker names a transition after its target,
                     so "Done / → Done" said everything twice; the arrow line
                     stays only when it adds a word. -->
                {#if blocked || tr.to_status !== tr.name}
                  <span class="t-to">→ {tr.to_status}{blocked ? ' · ' + t('write.transitionNeedsFields') : ''}</span>
                {/if}
                {#if failedId === tr.id && transitionError}
                  <span class="t-err">{transitionError}</span>
                {/if}
              </span>
            </button>
          {/each}
          {#if transitions.length === 0}
            <p class="none">{t('write.noTransitionsFrom')}</p>
          {/if}
        {:else if transitionError}
          <p class="error">{transitionError}</p>
        {/if}
      </div>
    </Sheet>
  {/if}

  {#if assigneeOpen}
    <Sheet title={t('write.pickAssignee')} onclose={() => (assigneeOpen = false)}>
      <div class="pick-list">
        <!-- The field sits above what it filters: the rows below it are the
             result of what is typed here, and a filter under its own results
             reads as an afterthought. Row order stays Unassigned → me →
             current → results. -->
        <div class="search">
          <input
            value={userQuery}
            placeholder={t('write.searchNameEmail')}
            inputmode="search"
            oninput={(e) => onUserQuery(e.currentTarget.value)}
          />
          {#if searching}
            <p class="none">{t('common.searching')}</p>
          {:else if userQuery.trim().length >= 2 && users.length === 0}
            <p class="none">{t('write.userNotFound')}</p>
          {/if}
        </div>
        <button
          class="t-row"
          class:current={unassignedNow}
          aria-current={unassignedNow ? 'true' : undefined}
          disabled={applyingId !== null}
          onclick={() => void pickAssignee(null)}
        >
          <span class="t-text">
            <span class="t-name">{t('common.unassigned')}</span>
            {#if failedRow === 'unassigned' && rowError}
              <span class="t-err">{rowError}</span>
            {/if}
          </span>
          {#if unassignedNow}{@render currentTick()}{/if}
        </button>
        {#each assigneeCandidates as c (c.id)}
          {@const current = Boolean(lite?.assignee_id) && lite?.assignee_id === c.accountId}
          <button
            class="t-row"
            class:current
            aria-current={current ? 'true' : undefined}
            disabled={applyingId !== null}
            onclick={() => void pickAssignee(c.accountId)}
          >
            <span class="t-text">
              <span class="t-name">{c.label}</span>
              {#if c.sub}
                <span class="t-to">{c.sub}</span>
              {/if}
              {#if failedRow === c.id && rowError}
                <span class="t-err">{rowError}</span>
              {/if}
            </span>
            {#if current}{@render currentTick()}{/if}
          </button>
        {/each}
      </div>
    </Sheet>
  {/if}

  {#if priorityOpen}
    <Sheet title={t('write.changePriority')} onclose={() => (priorityOpen = false)}>
      <div class="pick-list">
        {#if prioritiesLoading}
          <p class="none">{t('write.askingServer')}</p>
        {:else if prioritiesError}
          <p class="error">{prioritiesError}</p>
        {:else if priorities && lite}
          <button
            class="t-row"
            class:current={priorityNone}
            aria-current={priorityNone ? 'true' : undefined}
            disabled={applyingId !== null}
            onclick={() => void pickPriority(null)}
          >
            <span class="t-text">
              <span class="t-name">{t('common.none')}</span>
              {#if failedRow === 'none' && rowError}
                <span class="t-err">{rowError}</span>
              {/if}
            </span>
            {#if priorityNone}{@render currentTick()}{/if}
          </button>
          {#each priorities as p (p.id)}
            {@const current = Boolean(lite.priority_id) && lite.priority_id === p.id}
            <button
              class="t-row"
              class:current
              aria-current={current ? 'true' : undefined}
              disabled={applyingId !== null}
              onclick={() => void pickPriority(p.id)}
            >
              <span class="t-text">
                <span class="t-name">{p.name}</span>
                {#if failedRow === p.id && rowError}
                  <span class="t-err">{rowError}</span>
                {/if}
              </span>
              {#if current}{@render currentTick()}{/if}
            </button>
          {/each}
          {#if priorities.length === 0}
            <p class="none">{t('write.noPriorities')}</p>
          {/if}
        {/if}
      </div>
    </Sheet>
  {/if}

  {#if labelsOpen}
    <Sheet title={fieldLabel('labels')} onclose={() => (labelsOpen = false)}>
      <div class="pick-list">
        <!-- The rows are the labels this workspace already uses, read off
             the snapshot the phone is holding (lib/labels.ts) — the serve
             has no labels catalog to ask for, and the desk's own dialog
             reads the same source. The free line below adds one that is
             not there yet; it sits under the rows because it is the
             exception, not the way in. -->
        {#each labelChoices as l (l)}
          {@const on = labelDraft.includes(l)}
          <button
            class="t-row"
            class:current={on}
            aria-pressed={on}
            disabled={labelsSaving}
            onclick={() => toggleLabel(l)}
          >
            <span class="t-text"><span class="t-name">{l}</span></span>
            {#if on}{@render currentTick()}{/if}
          </button>
        {/each}
        {#if labelChoices.length === 0}
          <p class="none">{t('common.none')}</p>
        {/if}
        <div class="sheet-foot">
        <div class="label-add">
          <input
            bind:value={labelInput}
            placeholder={t('write.addLabelOptional')}
            aria-label={t('write.addLabelOptional')}
            enterkeyhint="done"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTypedLabel()
              }
            }}
          />
          <button
            class="ghost"
            aria-label={t('write.addLabelOptional')}
            disabled={splitLabelInput(labelInput).length === 0}
            onclick={addTypedLabel}>+</button
          >
        </div>
        <div class="sheet-actions">
          <button
            class="save"
            class:armed={labelsArmed && !writesOff}
            disabled={writesOff || labelsSaving || !labelsArmed}
            onclick={() => void saveLabels()}
          >
            {t('common.save')}
          </button>
        </div>
        {#if labelsError}
          <p class="field-err">{labelsError}</p>
        {/if}
        </div>
      </div>
    </Sheet>
  {/if}

  {#if dueOpen}
    <Sheet title={fieldLabel('due')} onclose={() => (dueOpen = false)}>
      <div class="pick-list">
        <!-- The platform's own date control, not a calendar of our own: it
             speaks YYYY-MM-DD, which is exactly what the server takes, and
             on the phone it is the wheel the person already knows. -->
        <div class="due-edit">
          <input type="date" bind:value={dueDraft} aria-label={fieldLabel('due')} />
        </div>
        <div class="sheet-actions">
          <button
            class="save"
            class:armed={dueArmed && !writesOff}
            disabled={writesOff || dueSaving || !dueArmed}
            onclick={() => void writeDue(dueDraft)}
          >
            {t('common.save')}
          </button>
          {#if currentDue}
            <button class="ghost" disabled={writesOff || dueSaving} onclick={() => void writeDue(null)}>
              {t('common.none')}
            </button>
          {/if}
        </div>
        {#if dueError}
          <p class="field-err">{dueError}</p>
        {/if}
      </div>
    </Sheet>
  {/if}

  {#if descOpen}
    <Sheet title={t('write.editDescription')} tall onclose={closeDescription}>
      <div class="desc-edit">
        <textarea
          bind:value={descDraft}
          placeholder={t('write.descriptionPlain')}
          aria-label={t('write.editDescription')}
          oninput={(e) => onDescInput(e.currentTarget.value)}
        ></textarea>
        {#if descRestored}
          <p class="draft-note">{t('write.draftRestored')}</p>
        {/if}
        {#if descForceAsk}
          <p class="error">{t('write.descriptionForceAsk')}</p>
          <div class="desc-actions">
            <button class="save" class:armed={!writesOff} disabled={descSaving} onclick={() => void saveDescription(true)}>
              {t('write.descriptionReplace')}
            </button>
            <button class="ghost" onclick={() => (descForceAsk = false)}>{t('common.cancel')}</button>
          </div>
        {:else}
          {#if descError}
            <p class="error">{descError}</p>
          {/if}
          <!-- One Cancel per sheet: the Sheet header already carries it, so
               this row holds only the primary action, and it wears the same
               armed fill the composer's Send does (GDK-934 tokens). -->
          <div class="desc-actions">
            <button class="save" class:armed={!writesOff} disabled={descSaving} onclick={() => void saveDescription(false)}>
              {t('common.save')}
            </button>
          </div>
        {/if}
      </div>
    </Sheet>
  {/if}

  {#if childOpen && lite}
    <!-- The Issues tab's create sheet, told what it is filing under
         (GDK-1871). It closes itself, syncs, and opens the new child, so
         this screen owns only the flag — and mounting it inside the `{#if}`
         is what makes each open restore its own drafts (GDK-692). -->
    <CreateSheet
      open={childOpen}
      onclose={() => (childOpen = false)}
      parent={{ key: lite.issue_key, projectKey: lite.project_key ?? '', summary: lite.summary }}
    />
  {/if}
</div>

<style>
  .push {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--color-bg-base);
  }
  .bar {
    display: flex;
    align-items: center;
    min-height: 48px;
    gap: 8px;
  }
  .back {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: var(--spacing-control);
    padding-right: 12px;
    margin-left: -6px;
    color: var(--color-accent-text);
    flex: 1 1 0;
  }
  .back svg {
    width: 22px;
    height: 22px;
  }
  .bar-key {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  /* Mirrors .back's flex share so the key stays centred; the share button
     sits at its far edge, the same accent and 22px glyph as the back arrow. */
  .bar-pad {
    flex: 1 1 0;
    display: flex;
    justify-content: flex-end;
  }
  .share {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: var(--spacing-control);
    min-width: var(--spacing-control);
    margin-right: -6px;
    color: var(--color-accent-text);
  }
  .share svg {
    width: 22px;
    height: 22px;
  }

  .spined {
    border-left: 3px solid transparent;
    padding: 4px 16px 12px 13px;
  }
  .spine-new {
    border-left-color: var(--color-spine-new);
  }
  .spine-inprogress {
    border-left-color: var(--color-status-inprogress);
  }
  .spine-done {
    border-left-color: var(--color-status-done);
  }
  .spine-reopen {
    border-left-color: var(--color-status-reopen);
  }

  .chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .status {
    display: flex;
    width: 100%;
    flex-direction: column;
    align-items: stretch;
    padding: 0 16px;
    border-bottom: 1px solid var(--color-border-subtle);
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--color-text-primary);
    text-align: left;
  }
  .status:disabled {
    opacity: 0.45;
  }
  .status-line {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
  }
  .status-line svg {
    width: 13px;
    height: 13px;
    margin-left: auto;
    color: var(--color-text-muted);
  }
  .status-err {
    padding: 0 0 8px;
    font-size: var(--text-micro);
    font-weight: 400;
    color: var(--color-status-reopen);
  }
  /* Data, not a control (DESIGN.md §4 thumb zone: the transition *action*
     lives in the slab below). The outlined pill read as a second status
     button over the real one — review 2026-09-14 — so the header chip is
     now a dot and a word, the same weight as the slab's line. */
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--color-text-secondary);
  }
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

  h1 {
    margin: 10px 0 6px;
    font-size: var(--text-title);
    line-height: var(--text-title--line-height);
    overflow-wrap: anywhere;
  }
  /* The subject line is a control surface now (GDK-1497 A2): the h1 keeps
     its grammar, an edit glyph rides its end, and the meta fragments below
     open pickers. Every control recedes the way the status row does. */
  .subject {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  .subject h1 {
    flex: 1 1 auto;
  }
  .edit {
    flex: none;
    width: 44px;
    margin-top: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
  }
  .edit svg {
    width: 18px;
    height: 18px;
  }
  .edit:disabled {
    opacity: 0.45;
  }
  .summary-edit {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 10px 0 6px;
  }
  .summary-edit input {
    flex: 1 1 160px;
    min-width: 0;
    min-height: var(--spacing-control);
    padding: 0 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font-size: var(--text-body);
  }
  .field-err {
    flex: 1 0 100%;
    margin: 0;
    font-size: var(--text-micro);
    color: var(--color-status-reopen);
  }
  /* Restored-draft caption (GDK-1863): the muted twin of the error lines
     above and below — same slot, same size, no box of its own. */
  .draft-note {
    flex: 1 0 100%;
    margin: 0;
    padding: 4px 0 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .save {
    flex: none;
    min-height: var(--spacing-control);
    padding: 0 16px;
    border-radius: 6px;
    font-weight: 600;
    background: var(--color-bg-elevated);
    color: var(--color-text-primary);
  }
  /* The armed accent fill lives in app.css now (GDK-1525): one owner for
     .save/.send, and no disabled dim on either — the local `.save.armed`
     pair plus its `.save:disabled` opacity is what this issue removed. */
  .ghost {
    flex: none;
    min-height: var(--spacing-control);
    padding: 0 12px;
    border-radius: 6px;
    color: var(--color-accent-text);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .m-row {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 4px;
    min-width: 0;
  }
  .m-item + .m-item::before {
    content: '·';
    margin-right: 4px;
    color: var(--color-text-muted);
  }
  .m-btn {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px;
    max-width: 100%;
    color: var(--color-text-secondary);
    font-size: var(--text-micro);
  }
  .m-btn:disabled {
    opacity: 0.45;
  }
  .m-chev {
    flex: none;
    width: 12px;
    height: 12px;
    color: var(--color-text-muted);
  }
  .h-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .h-row h3 {
    flex: 1 1 auto;
  }
  .h-row .edit {
    width: 44px;
    margin-top: 16px;
  }

  .body {
    /* 16px under the last paragraph so the description does not butt
       against the status slab (review 2026-09-14, capture 08). */
    padding: 0 16px 16px;
  }
  .none {
    margin: 4px 0 0;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .error {
    margin: 8px 0;
    font-size: var(--text-micro);
    color: var(--color-status-reopen);
  }
  h3 {
    margin: 24px 0 6px;
    font-size: var(--text-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .body > h3:first-of-type {
    margin-top: 8px;
  }
  .h-n {
    font-family: var(--font-mono);
    font-weight: 400;
  }
  /* A card, not a line (vision FIX 2026-09-07). Ported one-for-one from the
     desk it read as the session strip's twin: a bare grey sentence with no
     edge, no tint and no way out but tapping the sentence. The desk's chip
     form is the fix — bg-elevated, a small radius, secondary ink — carried
     onto a phone, where the tap target has to be explicit because the card
     shares the scroll with the thread it sits above.

     Two lines, not one: at 402px "3 status changes, 2 new comments and
     assignee changed" does not fit on a line, and the ellipsis eats the
     specific half. Two, then stop — a taller block would read as chrome. */
  .resume {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    margin: 8px 0 0;
    padding: 8px 4px 8px 10px;
    border-radius: 8px;
    background: var(--color-bg-elevated);
    font-size: var(--text-micro);
    color: var(--color-text-secondary);
  }
  .resume-text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    flex: 1 1 auto;
    min-width: 0;
    /* Centres a one- or two-line sentence against the 44pt dismiss beside
       it, which the negative margins below pull out to the card's edges. */
    padding: 6px 0;
    overflow: hidden;
  }
  .resume-x {
    display: flex;
    flex: none;
    width: var(--spacing-control);
    height: var(--spacing-control);
    margin: -8px 0;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: var(--color-text-muted);
    font-size: var(--text-body);
    line-height: 1;
  }
  .resume-x:active {
    background: var(--color-bg-hover);
  }

  .linked {
    display: flex;
    width: 100%;
    align-items: baseline;
    gap: 8px;
    padding: 6px 0;
    text-align: left;
    border-bottom: 1px solid var(--color-border-subtle);
    min-width: 0;
  }
  .l-key {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--color-accent-text);
  }
  .l-type {
    flex: none;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .l-sum {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-micro);
    color: var(--color-text-secondary);
  }

  /* Fields (GDK-1870). The linked-issue dialect one for one — same rule,
     same gaps, same micro type — turned into a ledger pair: the field's name
     on the left, what the issue carries on the right.

     The value wraps, and that is the point of the round. Three fix versions
     comma-joined do not fit 402px, and an ellipsis there would be the same
     defect this section exists to close: the mirror holding something the
     phone does not show. A second line is cheaper than a hidden value. */
  .field {
    display: flex;
    width: 100%;
    align-items: center;
    /* Every row takes the control floor, not only the key rows that are
       buttons: the 2026-09-14 vision pass saw the three plain rows at half
       the Parent row's pitch and read the section as two blocks. One
       rhythm, and the tap target on the key rows is unchanged. */
    min-height: var(--spacing-control);
    gap: 12px;
    padding: 6px 0;
    text-align: left;
    border-bottom: 1px solid var(--color-border-subtle);
    min-width: 0;
  }
  .f-label {
    flex: none;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .f-value {
    flex: 1 1 auto;
    min-width: 0;
    text-align: right;
    overflow-wrap: anywhere;
    font-size: var(--text-micro);
    color: var(--color-text-secondary);
  }
  .f-key {
    flex: 1 1 auto;
    min-width: 0;
    text-align: right;
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--color-accent-text);
  }

  .comment {
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .c-head {
    margin: 0 0 2px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .c-author {
    font-size: var(--text-micro);
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .c-when {
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
  .tail {
    height: 16px;
  }

  /* Was also called .ghost, which silently overrode the .ghost BUTTON rule
     above (display/padding) for every Cancel on this screen — a loading
     placeholder and a text button are not the same thing. */
  .skel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
  }
  .g {
    height: 12px;
    border-radius: 4px;
    background: var(--color-bg-elevated);
  }
  .w1 {
    width: 90%;
  }
  .w2 {
    width: 76%;
  }
  .w3 {
    width: 40%;
  }

  .composer-slab {
    flex: none;
    background: var(--color-bg-panel);
    border-top: 1px solid var(--color-border-subtle);
  }
  .composer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 16px;
  }
  .composer.off {
    opacity: 0.45;
  }
  .composer input {
    /* Basis 0, not auto: the field yields width to a longer Send label
       ("Uploading… (1)") instead of pushing the button onto a second line —
       the 2026-09-14 vision pass caught the button wrapped under the field
       while an upload was in flight. */
    flex: 1 1 0;
    min-width: 0;
    min-height: var(--spacing-control);
    padding: 0 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
  }
  .composer.off input:disabled {
    opacity: 1;
  }
  .composer input::placeholder {
    color: var(--color-text-muted);
  }
  /* The picker's control: the 44pt icon dialect the title row already uses
     (.edit), sat at the head of the composer. Hidden input beside it paints
     nothing — `hidden` and not a sized transparent box, so the viewport
     gate's input census does not see a field that is not there. */
  .attach {
    flex: none;
    width: var(--spacing-control);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-muted);
  }
  .attach svg {
    width: 20px;
    height: 20px;
  }
  .attach:disabled {
    opacity: 0.45;
  }
  /* One row of chips above the field. Full-width first child of the wrapping
     .composer, so the slab grows by exactly one row and only while something
     is attached. Existing tokens only — this is the .summary-edit field's
     fill and border at the micro size. */
  .att-row {
    flex: 1 0 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  .att {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-width: 0;
    padding-left: 6px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font-size: var(--text-micro);
  }
  .att-thumb {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 4px;
    object-fit: cover;
    /* A hairline so a pale photo still reads as an object on the pale chip. */
    border: 1px solid var(--color-border-subtle);
  }
  /* Waiting is neither idle nor armed: the label changes and the control
     recedes a step (DESIGN §3.5 — state in the pressed control, no spinner). */
  .send.busy {
    opacity: 0.6;
  }
  .att-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The same dismiss the resume card wears, at the same touch size. */
  .att-x {
    display: flex;
    flex: none;
    width: var(--spacing-control);
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: var(--color-text-muted);
    font-size: var(--text-body);
    line-height: 1;
  }
  .att-x:active {
    background: var(--color-bg-hover);
  }
  .send {
    flex: none;
    white-space: nowrap;
    min-height: var(--spacing-control);
    padding: 0 16px;
    border-radius: 6px;
    font-weight: 600;
    background: var(--color-bg-elevated);
    color: var(--color-text-muted);
  }
  /* .send.armed moved to app.css with .save.armed (GDK-1525) — one rule,
     no per-screen pair left to fork the grammar again. */
  .send-error {
    flex: 1 0 100%;
    margin: 0;
    padding: 0;
    font-size: var(--text-micro);
    color: var(--color-status-reopen);
  }

  .t-list {
    overflow-y: auto;
    padding: 4px 8px 8px;
  }
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
  /* The current row is marked by the tick alone. It used to be tinted with
     --color-accent-text, which is also Cancel's and every link's colour on
     this screen, so the row read as "tap me" rather than "this is current". */
  .tick {
    flex: none;
    margin-left: auto;
    width: 16px;
    height: 16px;
    color: var(--color-accent-text);
  }
  .pick-list {
    overflow-y: auto;
    padding: 4px 8px 8px;
    display: flex;
    flex-direction: column;
  }
  .search {
    border-bottom: 1px solid var(--color-border-subtle);
    padding: 4px 8px 8px;
    margin-bottom: 4px;
  }
  .search input {
    width: 100%;
    min-height: var(--spacing-control);
    padding: 0 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
  }
  .search .none {
    padding: 6px 2px 0;
  }
  .desc-edit {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    padding: 4px 16px 16px;
  }
  .desc-edit textarea {
    flex: 1 1 auto;
    min-height: 180px;
    padding: 10px 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font: inherit;
    resize: none;
  }
  /* One action row, two sheets that need it: the description editor's and
     the label/due sheets GDK-1871 added. Same rule, not a second one. */
  .desc-actions,
  .sheet-actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
  }
  /* The tappable mark on the labels row. Muted like the row's own label, so
     the row still reads as text with a way in rather than as a link. */
  .f-chev {
    flex: none;
    color: var(--color-text-muted);
    font-size: var(--text-body);
    line-height: 1;
  }
  /* The free label line under the picker's rows. Same input dialect as the
     assignee sheet's search field, with the add beside it. */
  /* The free line and Save stay in frame while the rows scroll above them:
     the 2026-09-14 vision pass opened the sheet on a workspace with twelve
     labels and found the way to add one, and the Save, below the fold.
     Sticky inside .pick-list's own scroll, on the sheet's panel colour. */
  .sheet-foot {
    position: sticky;
    bottom: 0;
    background: var(--color-bg-panel);
    padding-bottom: 8px;
    border-top: 1px solid var(--color-border-subtle);
  }
  /* In a sheet the actions sit on the 16px gutter the inputs above them
     use (.due-edit / .label-add pad 8 inside .pick-list's 8) — the same
     vision pass measured the Due sheet's Save box starting 8px left of the
     date input's edge. The description editor's .desc-actions is not in a
     .pick-list and keeps its own alignment. */
  .pick-list .sheet-actions {
    padding: 8px 8px 0;
  }
  .label-add {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 0;
  }
  .label-add input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: var(--spacing-control);
    padding: 0 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font-size: var(--text-body);
  }
  .due-edit {
    padding: 8px 8px 0;
  }
  .due-edit input {
    width: 100%;
    min-height: var(--spacing-control);
    padding: 0 12px;
    background: var(--color-bg-base);
    border: 1px solid var(--color-border-subtle);
    border-radius: 6px;
    font-size: var(--text-body);
    color: var(--color-text-primary);
  }
</style>
