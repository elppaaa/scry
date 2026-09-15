<script lang="ts">
  import type { Snippet } from 'svelte'

  // The one screen frame: owns the safe-top inset and the scroll region.
  // Screens author content into an already-inset frame, so a touch target
  // under the status bar cannot be written (DESIGN.md §4.1).
  //
  // `scroller` is the scroll region, lent out (GDK-902): the list has to
  // save and restore its position across a palette open-and-cancel, and the
  // element that scrolls is this component's, not the caller's. Bindable
  // and defaulted, so every screen that does not care is unchanged.
  let {
    header,
    children,
    footer,
    scroller = $bindable(null),
  }: {
    header?: Snippet
    children: Snippet
    footer?: Snippet
    scroller?: HTMLElement | null
  } = $props()
</script>

<div class="screen">
  {#if header}
    <header class="safe-top">
      {@render header()}
    </header>
  {/if}
  <main bind:this={scroller}>
    {@render children()}
  </main>
  {#if footer}
    {@render footer()}
  {/if}
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    background: var(--color-bg-base);
  }
  header {
    flex: none;
    padding-left: 16px;
    padding-right: 16px;
  }
  main {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
  }
</style>
