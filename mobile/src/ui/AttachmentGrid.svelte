<script module lang="ts">
  /*
   * The Attachments section's body (GDK-1882).
   *
   * Why it exists: until this round the phone drew an attachment only where
   * an ADF body referenced it (AdfBody's prime pass). A photo filed from the
   * create sheet (GDK-1879), or one dropped on the issue from the desk
   * without embedding it, was in the response the phone already had and on
   * no screen — which is DESIGN.md §1's first clause read backwards.
   *
   * Why a component and not more Detail.svelte: Detail is 2300 lines and the
   * bytes half of this is not a template concern — it is a fetch, a cache of
   * object URLs and a revoke, the same three AdfBody owns for the body. What
   * stays in Detail is the heading, because `h3`/`.h-n` are that file's
   * scoped styles and a child's `<h3>` would not wear them.
   *
   * The decisions below are exported and measured by AttachmentGrid.test.ts.
   * They are here rather than in lib/ because they answer only to this
   * component's markup: which rows are cells, which are ledger lines, and
   * what a failed fetch demotes to.
   */
  import type { DetailAttachment } from '../lib/types'

  /**
   * Is this row a picture?
   *
   * The server's own verdict first (`is_image` is `strings.HasPrefix(mime,
   * "image/")` at internal/server/read.go:818), the mime prefix second. The
   * second is not redundant: an older serve, or the upload response shape
   * that AttachmentUploadResponse carries, can hand back a row whose flag was
   * never computed, and a picture in a ledger row is a worse answer than a
   * ledger row that turned out to be a picture.
   */
  export function isImageAttachment(a: Pick<DetailAttachment, 'is_image' | 'mime_type'>): boolean {
    return a.is_image || a.mime_type.trim().toLowerCase().startsWith('image/')
  }

  /** How far one thumbnail has got. `failed` is a demotion, not an error state. */
  export type CellStatus = 'loading' | 'ready' | 'failed'

  /**
   * Where each row is drawn, given what the fetches have answered so far.
   *
   * One function, because the two halves are one decision: a picture whose
   * bytes never arrived must leave the grid *and* join the ledger, and two
   * separate filters would be two places to get that agreement wrong. A cell
   * that has not answered yet stays a cell — it paints a paper square, which
   * is the phone's whole loading vocabulary (DESIGN.md §3.5: no spinners).
   */
  export function partitionAttachments(
    attachments: DetailAttachment[],
    status: (a: DetailAttachment) => CellStatus,
  ): { thumbs: DetailAttachment[]; rows: DetailAttachment[] } {
    const thumbs: DetailAttachment[] = []
    const rows: DetailAttachment[] = []
    for (const a of attachments) {
      if (isImageAttachment(a) && status(a) !== 'failed') thumbs.push(a)
      else rows.push(a)
    }
    return { thumbs, rows }
  }

  /**
   * The muted word at the end of a ledger row: `application/pdf` → `pdf`.
   *
   * Lowercased and trimmed, empty when the row carries no type — the row then
   * prints nothing there rather than an empty register of its own. Not the
   * same function as attachmentLabel's subtype fallback in lib/attach.ts:
   * that one answers "what is this file called when it has no name", this one
   * answers "what kind is it" beside a name that exists.
   */
  export function mimeSubtype(mime: string): string {
    const type = mime.trim().toLowerCase()
    if (type === '') return ''
    const slash = type.indexOf('/')
    return slash === -1 ? type : type.slice(slash + 1).trim()
  }
</script>

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { requestBlob } from '../lib/api'
  import { attachmentLabel, attachmentPath } from '../lib/attach'
  import { formatAttachmentSize } from '../lib/adf-links'
  import { t } from '../lib/i18n'
  // DetailAttachment is already in scope from the module block above — a
  // second import of the same name is a duplicate identifier, not a re-import.
  import AttachmentViewer from './AttachmentViewer.svelte'

  let { attachments = [] }: { attachments?: DetailAttachment[] } = $props()

  /** id → what the fetch answered. Absent means "not asked yet". */
  let cells = $state<Record<string, { status: CellStatus; url?: string }>>({})
  let blobUrls: string[] = []
  /** The image the full-screen viewer is showing, or null. */
  let viewer = $state<{ name: string; src: string } | null>(null)

  const label = (a: DetailAttachment): string =>
    attachmentLabel(a) || t('detail.attachments')

  function statusOf(a: DetailAttachment): CellStatus {
    return cells[a.id]?.status ?? 'loading'
  }

  const split = $derived(partitionAttachments(attachments, statusOf))

  /*
   * The same road AdfBody's prime pass takes and for the same reason: the
   * renderer's `/api/v1/…` path is a real URL only behind the dev proxy, so
   * the packaged app must dial it itself with the bearer attached. One URL
   * join for the whole app — lib/attach.ts's attachmentPath (GDK-1872 part 2)
   * — and a row it answers null for is a row this app cannot reach, which is
   * a demotion to the ledger, not a broken image.
   */
  async function load(a: DetailAttachment): Promise<void> {
    const path = attachmentPath(a.content_url)
    if (path === null) {
      cells = { ...cells, [a.id]: { status: 'failed' } }
      return
    }
    try {
      const blob = await requestBlob(path)
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      cells = { ...cells, [a.id]: { status: 'ready', url } }
    } catch {
      cells = { ...cells, [a.id]: { status: 'failed' } }
    }
  }

  /**
   * One cell asks for its own bytes when it mounts.
   *
   * An action, not an `$effect`, and the difference is the one GDK-692's
   * gate names (web/src/lib/effect-assigns-state.test.ts): an effect that
   * writes state is a synchronization whose result depends on when it ran,
   * while a photograph arriving is a lifecycle event of the cell that shows
   * it. It also puts the fetch exactly where the grid decided to draw one —
   * a row demoted to the ledger never mounts a cell and never spends a
   * request.
   *
   * `asked` is the idempotence: the `{#each}` is keyed by id, so a cell
   * mounts once, but a re-mount (a detail re-opened on the same key) must
   * not fetch a picture the page already holds.
   */
  const asked = new Set<string>()
  function cellBytes(_node: HTMLElement, a: DetailAttachment): void {
    if (asked.has(a.id)) return
    asked.add(a.id)
    void load(a)
  }

  onDestroy(() => {
    // The viewer is showing one of these URLs; revoking under it would leave
    // a broken frame over a screen that has already gone (AdfBody's order).
    viewer = null
    for (const url of blobUrls) URL.revokeObjectURL(url)
    blobUrls = []
  })

  function open(a: DetailAttachment): void {
    const url = cells[a.id]?.url
    if (!url) return
    viewer = { name: label(a), src: url }
  }
</script>

<div class="grid-wrap" data-testid="detail-attachments">
  {#if split.thumbs.length > 0}
    <div class="grid">
      {#each split.thumbs as a (a.id)}
        <button
          type="button"
          class="thumb"
          data-testid="attachment-thumb"
          aria-label={t('detail.enlarge', { name: label(a) })}
          onclick={() => open(a)}
          use:cellBytes={a}
        >
          {#if cells[a.id]?.url}
            <img src={cells[a.id].url} alt={label(a)} decoding="async" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#each split.rows as a (a.id)}
    <!-- Not a button: the phone has no download path and no opener, so a tap
         here can only be a promise it cannot keep (DESIGN.md §1 third
         clause — an honest absence over an invented verb). -->
    <div class="file" data-testid="attachment-file">
      <span class="f-name">{label(a)}</span>
      {#if formatAttachmentSize(a.size)}
        <span class="f-meta">{formatAttachmentSize(a.size)}</span>
      {/if}
      {#if mimeSubtype(a.mime_type)}
        <span class="f-meta">{mimeSubtype(a.mime_type)}</span>
      {/if}
    </div>
  {/each}
</div>

{#if viewer}
  <AttachmentViewer name={viewer.name} src={viewer.src} onclose={() => (viewer = null)} />
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  /*
   * A square, because a contact sheet of mixed aspect ratios is a ragged
   * edge on a 402px screen and the cover crop is what makes three per row
   * read as one strip. The full frame is one tap away in the viewer, which
   * is where `object-fit: contain` belongs.
   *
   * The cell is well past the 44pt floor app.css puts on every button
   * (~118px at this viewport), so no min-height of its own is needed.
   */
  .thumb {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    border-radius: 6px;
    /* Also the loading state: an unresolved cell is this paper square and
       nothing else — the phone's loading vocabulary is a paper rectangle,
       never a spinner (DESIGN.md §3.5). */
    background: var(--color-bg-panel);
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* The same ledger line the Fields rows are, one register quieter: a
     filename is data, the size and the kind are its metadata. */
  .file {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .f-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body);
    color: var(--color-text-secondary);
  }
  .f-meta {
    flex: none;
    font-size: var(--text-micro);
    color: var(--color-text-muted);
  }
</style>
