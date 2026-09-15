// Keyboard-aware bottom bar (DESIGN.md §4.2). In WKWebView the software
// keyboard overlays the layout viewport — the page does not resize — so a
// bottom-fixed composer disappears behind it. The VisualViewport API is the
// one honest measurement of the obscured band; this action translates the
// node up by exactly that band while the keyboard is up.
//
// Svelte action: <div use:keyboardInset>.

export function keyboardInset(node: HTMLElement) {
  const vv = window.visualViewport
  if (!vv) return
  const update = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    node.style.transform = inset > 0 ? `translateY(-${inset}px)` : ''
    // GDK-902 2026-09-15 — the same measurement, published as a selector.
    //
    // A node that rides this action is bottom-most only while the band is
    // closed: with the keyboard up it has been translated above it, and the
    // clearance a bottom-most surface owes the home indicator becomes a dead
    // strip between the node and the keys (the defect
    // `.composer.safe-bottom:focus-within` exists to remove). CSS cannot ask
    // the VisualViewport, and `:focus-within` is the wrong question — the key
    // bar's focus lives in a sibling field, and a hardware keyboard would
    // answer "up" for a node still sitting on the home indicator. This action
    // already holds the honest answer, so it stamps it and app.css reads it.
    // Nothing else consumes the attribute; the sheets and composers that also
    // use this action are unaffected.
    if (inset > 0) node.dataset.keyboardInset = ''
    else delete node.dataset.keyboardInset
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
  return {
    destroy() {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      node.style.transform = ''
      delete node.dataset.keyboardInset
    },
  }
}
