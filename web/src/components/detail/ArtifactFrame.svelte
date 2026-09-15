<script lang="ts">
  /*
   * ArtifactFrame (GDK-1897) — the host half of an HTML attachment.
   *
   * The dashboard wall's contract, on the issue detail: the authored HTML
   * runs in a sandboxed iframe (allow-scripts + popup grants, never
   * allow-same-origin), the parent owns every byte the frame learns, and
   * the frame's only way back is the two-verb whitelist in
   * lib/dashboard-protocol (`refresh`, `open`). The one datasource pushed
   * here is the host itself — `context`, assembled by lib/artifact-context,
   * the single owner of what an artifact may learn about its issue/page.
   */
  import { onMount } from 'svelte'
  import {
    createVerbThrottle,
    parseFrameMessage,
    type DataMessage,
  } from '../../lib/dashboard-protocol'
  import { navigate, parseHash, router } from '../../lib/router.svelte'
  import { resolveOpen } from '../../lib/place-dimension'
  import type { ArtifactContext } from '../../lib/artifact-context'
  import type { DetailAttachment } from '../../lib/types'

  let {
    attachment,
    context,
    height = 'h-80',
  }: {
    attachment: DetailAttachment
    context: ArtifactContext | null
    /** The frame's sizing classes; the card pins h-80, the overlay fills. */
    height?: string
  } = $props()

  let frame = $state<HTMLIFrameElement | null>(null)

  // Same flood floors as the dashboard wall's verbs (DashboardView), same
  // shared helper — a hostile artifact cannot turn its host into a refresh
  // pump or a navigation churn, and this file owns no throttle logic.
  const refreshThrottle = createVerbThrottle(2000, window)
  const openThrottle = createVerbThrottle(1000, window)

  /** The one push: the host itself, as the frame's `context` datasource. */
  function pushContext(): void {
    // targetOrigin '*' because the sandboxed frame is opaque-origin — it
    // cannot be named — and the payload is the context, which carries no
    // secrets by construction. The context row is keyed, not positional
    // like a dashboard's rows: one row, one object, read as rows[0].key.
    // The cast records that divergence from DataMessage's positional rows
    // rather than widening the shared type here.
    const msg: DataMessage = {
      type: 'data',
      name: 'context',
      columns: Object.keys(context ?? {}),
      // The context is not always plain here: the overlay's copy is read
      // straight out of the media-viewer store, so it arrives as a $state
      // proxy, and postMessage structured-clones — which refuses proxies.
      // Without the snapshot the overlay's push dies with DataCloneError
      // while the card's plain prop clones fine (measured, GDK-1897 R2).
      // Same idiom as the stores' IndexedDB puts: flatten at the clone
      // boundary, whichever caller handed the proxy in.
      rows: [context ? $state.snapshot(context) : null] as unknown as unknown[][],
      truncated: false,
    }
    frame?.contentWindow?.postMessage(msg, '*')
  }

  function onMessage(ev: MessageEvent): void {
    // Only this frame's messages — another window's (or another artifact
    // frame's) message is not ours to act on.
    if (!frame || ev.source !== frame.contentWindow) return
    const msg = parseFrameMessage(ev.data)
    if (!msg) return
    if (msg.type === 'refresh') {
      refreshThrottle.run(pushContext)
      return
    }
    // `open`: the same verb, the same routing as the dashboard wall —
    // parseHash re-serializes through the app's grammar and resolveOpen
    // decides which dimension moves, so an artifact's links land exactly
    // where a dashboard's do. (No debug attr here: the publish set in
    // lib/debug-attrs is closed, and this is not a new axis — the app's
    // navigation is observable as-is.)
    openThrottle.run(() => {
      const route = parseHash(msg.hash)
      const { params } = resolveOpen(router.params, route.params)
      navigate(route.path, params)
    })
  }

  onMount(() => {
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      refreshThrottle.flush()
      openThrottle.flush()
    }
  })
</script>

<!--
  sandbox exactly the dashboard wall's grants (DashboardView) and nothing
  else: no allow-same-origin (the frame must not read this origin, where
  localStorage holds tokens), no allow-forms/top-navigation. bg-bg-base, not
  transparent, so the span between attach and the document's first paint
  matches the card behind it (GDK-1598); color-scheme: normal keeps the
  authored document out of the host's dark mode.
-->
<iframe
  bind:this={frame}
  src={attachment.artifact_url}
  title={attachment.filename}
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  class="w-full {height} border-0 bg-bg-base"
  style="color-scheme: normal"
  data-testid="artifact-frame"
  data-attachment-id={attachment.id}
  onload={pushContext}
></iframe>
