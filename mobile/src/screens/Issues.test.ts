import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Issues.svelte'), 'utf8')

describe('GDK-905 Issues plates are catalog-backed and distinct', () => {
  it('does not claim a last-synced snapshot in the offline banner', () => {
    expect(src).not.toContain('last synced snapshot')
    expect(src).toContain("t('app.offlineBanner')")
  })

  it('gates the offline banner on showOfflineBanner, not on offline alone', () => {
    // GDK-902 2026-09-15: `{#if app.offline}` is legal in this file again —
    // the offline dot moved here from the tab bar and is exactly that flag,
    // raw and correct (a dot says "not reachable", a banner says "this is
    // what you are reading instead", which is the judgement
    // showOfflineBanner makes). So the negative is scoped to the banner's
    // own paragraph rather than to the whole file.
    expect(src).toContain('showOfflineBanner')
    expect(src).toMatch(/\{#if offlineBanner\}/)
    const banner = src.slice(src.indexOf("t('app.offlineBanner')"))
    expect(src.slice(0, src.indexOf("t('app.offlineBanner')"))).not.toMatch(
      /\{#if app\.offline\}[\s\S]{0,200}app\.offlineBanner/,
    )
    expect(banner).toBeTruthy()
  })

  it('uses list.emptyTitle for an empty mirror and list.noMatchTitle for an empty scope', () => {
    expect(src).toContain("t('list.emptyTitle')")
    expect(src).toContain("t('list.noMatchTitle')")
    expect(src).not.toContain('Nothing here')
    expect(src).not.toContain('No issues on this mirror match this scope.')
  })

  it('paints a failed bootstrap through issuesBootKind, not an infinite skeleton', () => {
    expect(src).toContain('issuesBootKind')
    expect(src).toMatch(/bootKind === 'failed'|=== "failed"/)
    expect(src).toContain("t('list.renderFailedTitle')")
  })
})
