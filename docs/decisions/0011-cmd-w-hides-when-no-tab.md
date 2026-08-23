# 0011 — ⌘W hides the app when there is no browse tab

Status: accepted
Date: 2026-08-22

## Context

⌘W is a single Window-menu accelerator wired to `browse.CloseActive()`
(`desktop/main.go`). `CloseActive` returns early when no in-app browse tab is
active (`desktop/browse.go`), so on the SPA itself — the common case, since a
tab exists only after the person opened an Atlassian link inside the app — the
keystroke is consumed by the menu and nothing happens. No window closes, no
tab closes, no feedback.

That was never a decision. `87093610` chose "not the stock CloseWindow role"
because `ApplicationShouldTerminateAfterLastWindowClosed: true` makes closing
the only window quit the app; the no-tab case was simply left empty.
`fc4d2684` (GDK-351) revisited it for Windows/Linux, where the item was
visible and dead, and removed the item there. It declined the only fallback on
the table — closing the window — because a reflex ⌘W would then discard an
open comment draft.

Two facts have since changed what is on the table:

- The comment body is already persisted per issue while typing
  (`CommentComposer.svelte` → `localStorage`, `commentDraftKey`). A dismissed
  window does not lose it.
- Dismissing is not the same as closing. `app.Hide()` is `[NSApp hide:]`
  (wails v3.0.0-beta.12, `application_darwin.go`), which orders the app out
  without tearing down the `NSWindow` or the pane's `WKWebView`s.

## Decision

On darwin the Window-menu item is `Close` / ⌘W and dismisses the frontmost
thing: the *visible* browse tab if there is one, otherwise the app.
`browseTabs.CloseActive` returns whether it closed a tab so one handler can
make that choice without reading pane state twice.

Visible, not merely open. The SPA calls `Activate("")` while one of its own
overlays is up (palette, media viewer), which clears `active` with tabs still
in the strip — so ⌘W over an overlay hides the app rather than closing a tab
behind it. That is the same rule, not an exception: what is frontmost is the
SPA. `TestCloseActiveIgnoresAnOpenButHiddenTab` is where it is written down.

`app.Hide()` — not `window.Hide()`. `window.Hide()` is `orderOut:`, which
leaves the app active and frontmost with a menu bar and no window; ⌘Tab does
not bring it back, because only a Dock click raises
`ApplicationShouldHandleReopen`. `[NSApp hide:]` deactivates the app, and both
⌘Tab and a Dock click un-hide it.

No `app.Show()` is added anywhere. The three in-app raise paths — reopen
(`ApplicationShouldHandleReopen`), second instance
(`OnSecondInstanceLaunch`), and a deep link applied to a running process
(`applyDeepLink` → `SetURL` + `raiseWindow`) — all end in `raiseWindow`, and
`raiseWindow`'s Focus is wails' `windowFocus`, which calls
`activateIgnoringOtherApps:YES` before `makeKeyAndOrderFront:` when the app is
not active. Activating a hidden app un-hides it, so Restore + Focus is
sufficient. That activate is skipped for a non-activating panel
(`isNonActivatingPanel`, beta.12); the main window is not one, and making it
one would be what breaks this, not a change here. Measured 2026-08-22 by hiding the app and then launching the
executable directly, which reaches `OnSecondInstanceLaunch` with no
LaunchServices activation of its own: the window came back.

Off darwin the item is still not created. Hiding the only window there removes
it from the taskbar with no reopen event to bring it back — GDK-351's F-2
(a ⌘W that visibly does nothing) traded for something worse. The item's
existence derives from darwin, which is what the Dock and `[NSApp hide:]` are
facts about. That left `paneSupported` — GDK-351's "one build-tag fact both
the pane and its menu item derive from" — with no consumer at all, and Go does
not complain about an unread constant, so it is deleted rather than kept with
a corrected comment.

## Rejected

**Closing the window.** Quits the app (`ApplicationShouldTerminateAfterLastWindowClosed`),
which also stops the sync loop. ⌘Q already means quit.

**A label that changes with tab state.** `MenuItem.SetLabel` + `Menu.Update()`
exist, so Safari's contextual "Close Tab" / "Close Window" is reachable. It
needs the browse registry — mutated from the `/desktop/browse` HTTP handlers —
to drive a main-thread menu update, and a missed update is a menu that lies.
`Close` is the platform's own label for ⌘W and is true in both states.

**Persisting mentions and attachments first.** They are dropped on any
re-hydrate today, so they are a separate defect, not a precondition: hide
loses nothing, so it does not wait on them.

## Consequences

- ⌘W is no longer a no-op on macOS. ⌘H keeps its own accelerator and role.
- Nothing is torn down, so the window comes back with the same scroll
  position, the same open dialog, and the same half-typed comment.
- A future second window would make "hide the app" too broad; the handler is
  the place that changes, not this decision's premise.
- Fullscreen was the one case where `[NSApp hide:]` was expected to be ignored.
  It is not, on macOS 26: hiding from a fullscreen space works, the process
  survives, and the window comes back still fullscreen (`AXFullScreen` true
  before and after). If a future OS reverts to ignoring it, the symptom is
  GDK-351's F-2 confined to fullscreen.
