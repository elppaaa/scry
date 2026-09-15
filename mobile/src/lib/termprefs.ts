/*
 * The phone's terminal font-size preference (GDK-901) — the single owner.
 *
 * One module decides what a valid size is, where it is persisted, and how it
 * reaches the renderer: as the inline `--text-terminal` override on the
 * document root, which is the variable mobile/src/app.css declares (13px) and
 * lib/terminal/renderer.ts `terminalFontSize()` already reads at creation.
 * Nothing else in the app writes that variable, so the token stays the owner
 * of the default and this module is the only writer of an exception to it.
 *
 * The persistence stance is the hosts roster's (lib/hosts.ts): plain
 * localStorage, guarded reads, never a requirement. 13 — the token's own
 * value — is *not* an exception: choosing it removes the stored key and the
 * inline property, so a future token change moves everyone who never opted
 * out, and a phone that opted in and back out carries no dead weight.
 */

/** The only valid sizes. 13 is the token's own value and the default. */
export const TERMINAL_FONT_SIZES = [11, 13, 15, 17] as const

export type TerminalFontSize = (typeof TERMINAL_FONT_SIZES)[number]

const FONT_SIZE_KEY = 'gadak.terminal.fontSize'

/** The token's own value — what a missing, malformed or foreign read means. */
export const TERMINAL_FONT_SIZE_DEFAULT = 13

function isFontSize(px: number): px is TerminalFontSize {
  return (TERMINAL_FONT_SIZES as readonly number[]).includes(px)
}

/**
 * The stored preference, or 13. A missing key, a malformed value, a size
 * this build does not know (written by a future build, since the set is not
 * a wire contract), and an unavailable localStorage all read the same: the
 * token's value. Never throws — a preference must not be able to kill boot.
 */
export function readTerminalFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY)
    if (raw === null) return TERMINAL_FONT_SIZE_DEFAULT
    const px = Number.parseFloat(raw)
    return Number.isFinite(px) && isFontSize(px) ? px : TERMINAL_FONT_SIZE_DEFAULT
  } catch {
    return TERMINAL_FONT_SIZE_DEFAULT
  }
}

/**
 * Persists a size. A value outside the set is a no-op — the control offers
 * four buttons, so an invalid one is a bug or a future build's, and a
 * future build reading this storage trusts the set check above either way.
 */
export function writeTerminalFontSize(px: number): void {
  try {
    if (!isFontSize(px)) return
    if (px === TERMINAL_FONT_SIZE_DEFAULT) {
      localStorage.removeItem(FONT_SIZE_KEY)
      return
    }
    localStorage.setItem(FONT_SIZE_KEY, String(px))
  } catch {
    // Over-quota or unavailable: the session still runs on the value below.
  }
}

/**
 * Sets `--text-terminal` on `root` so the renderer (and any future reader
 * of the token) sees the preference. 13 removes the inline property — the
 * stylesheet token owns the value again, which is what makes "default" and
 * "never set" indistinguishable by design.
 */
export function applyTerminalFontSize(px: number, root?: HTMLElement): void {
  // Lazy, not a default parameter: the default is evaluated at call time,
  // and the store calls this from boot() in the unit project's node
  // environment, where `document` does not exist. No root → nothing to
  // apply; the persisted value still carries the preference.
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (!target) return
  if (px === TERMINAL_FONT_SIZE_DEFAULT) {
    target.style.removeProperty('--text-terminal')
    return
  }
  target.style.setProperty('--text-terminal', `${px}px`)
}
