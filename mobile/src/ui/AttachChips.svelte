<script lang="ts" module>
  /**
   * One chip on the row. Deliberately not `UploadedAttachment`: the comment
   * composer's chips describe a file that is already on the issue, and the
   * create sheet's describe a file that is still only in RAM because there is
   * no key to attach it to yet. The row paints the same either way, so the
   * row's type is the small thing both can answer — a name and, when the file
   * is a picture, an object URL for the 32px preview.
   */
  export interface AttachChip {
    /** Stable for the life of the chip; the × names it. */
    id: string
    /** Already fallen back to a catalog word by the caller when empty. */
    name: string
    /** An object URL. Absent for a non-image, or before the bytes arrive. */
    thumb?: string
  }
</script>

<script lang="ts">
  /*
   * The picker dialect, in one file (GDK-1879).
   *
   * GDK-1872 put the paperclip, the hidden `<input type="file">` and the chip
   * row in Detail.svelte's composer. GDK-1879 needs the same three on the
   * create sheet, and a second spelling of `accept="image/*" multiple` is
   * exactly how the two screens would come to ask iOS for different things.
   * The CSS moved here verbatim from Detail.svelte — the values did not
   * change, and the composer's boxes are measured before and after.
   *
   * Why a `part` prop instead of one component that renders all three.
   * `.composer input` is how three suites spell "the comment field"
   * (e2e/drafts.spec.ts, e2e/pagecomment.spec.ts, shots/zz-review.spec.ts,
   * and `.create input` likewise in e2e/a2-captures.spec.ts), and Playwright
   * locators are strict — a second input under that selector breaks every one
   * of them. So the picker must stay OUTSIDE the box the chips and the
   * paperclip live in, and a Svelte component renders in one place. Two
   * instances, one file: `part="picker"` is the input, `part="controls"` the
   * row and the button, and the parent hands the first's element to the
   * second. Neither instance carries a wrapper element — the chip row and the
   * paperclip are direct flex children of whatever box the caller puts them
   * in, which is what makes the composer's layout bit-identical.
   */
  import { t } from '../lib/i18n'

  let {
    part,
    chips = [],
    disabled = false,
    testid = 'composer-attachments',
    onpick,
    onremove,
    picker = $bindable(null),
  }: {
    /** 'picker' renders the hidden input; 'controls' the chip row + paperclip. */
    part: 'picker' | 'controls'
    chips?: readonly AttachChip[]
    disabled?: boolean
    /** The chip row's test id, so two screens can be told apart in a spec. */
    testid?: string
    onpick?: (files: File[]) => void
    onremove?: (id: string) => void
    /** Bound on the 'picker' instance, passed plain to the 'controls' one. */
    picker?: HTMLInputElement | null
  } = $props()

  /**
   * A pick. The value is cleared before the callback can await anything:
   * picking the same photo twice is a real pick, and no browser fires a
   * change event when `value` is unchanged.
   */
  function onchange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement
    const files = [...(input.files ?? [])]
    input.value = ''
    if (files.length > 0) onpick?.(files)
  }
</script>

{#if part === 'picker'}
  <!-- A web file input inside WKWebView opens the native sheet (Photo
       Library / Take Photo / Choose File) with no Tauri plugin, which is why
       there is no picker code on either screen — only a button that clicks
       this. `hidden`, never a sized transparent box: the viewport gate counts
       every input that paints, and this one must not be one of them. -->
  <input
    bind:this={picker}
    class="file"
    type="file"
    accept="image/*"
    multiple
    hidden
    tabindex="-1"
    {onchange}
  />
{:else}
  <!-- One chip per file, on its own full-width row above the controls. What
       the × means is the caller's business and differs by screen: on the
       comment composer the file is already on the issue and only leaves the
       comment; on the create sheet nothing has been uploaded yet. -->
  {#if chips.length > 0}
    <div class="att-row" data-testid={testid}>
      {#each chips as c (c.id)}
        <span class="att">
          {#if c.thumb}
            <img class="att-thumb" src={c.thumb} alt="" />
          {/if}
          <span class="att-name">{c.name}</span>
          <button
            type="button"
            class="att-x"
            aria-label={t('write.removeAttachment')}
            onclick={() => onremove?.(c.id)}>×</button
          >
        </span>
      {/each}
    </div>
  {/if}
  <button
    type="button"
    class="attach"
    aria-label={t('write.attachFile')}
    {disabled}
    onclick={() => picker?.click()}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  </button>
{/if}

<style>
  /* Everything below moved verbatim out of Detail.svelte (GDK-1879). The
     selectors, the values and the order are the ones GDK-1872 shipped; the
     only thing that changed is which file owns them. */

  /* The picker's control: the 44pt icon dialect the title row already uses
     (.edit), sat at the head of the composer. It takes its height from the
     flex line it is on, which is 44pt in both callers. */
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
  /* One row of chips above the controls. Full-width first child of a wrapping
     flex box, so the box grows by exactly one row and only while something is
     attached. Existing tokens only — this is the .summary-edit field's fill
     and border at the micro size. */
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
</style>
