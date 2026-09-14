/*
 * GDK-1860: the mount a copied http link has to carry.
 *
 * The three shapes the same bundle is served in, measured through the one
 * owner (config.appMountPath) rather than through each copy-link builder:
 * `gadak serve` at the root, a workspace mount, and a hosted mount, where
 * `/demo/` and `/backlog/` share a bundle and declare theirs with a
 * `<base href>`. The third one is the one that was wrong — a link copied on
 * the public demo pointed at the site root, which is the landing page, not
 * the app.
 *
 * The unit project runs in node, so the two globals basePath() and
 * workspaceName() read are stood up by hand rather than by a DOM: the pair
 * of reads is the whole surface (config.ts:480-508, :547).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

const realDocument = (globalThis as { document?: unknown }).document
const realWindow = (globalThis as { window?: unknown }).window

async function mountPath(pathname: string, baseHref?: string): Promise<string> {
  vi.resetModules()
  const base = baseHref === undefined ? null : { getAttribute: () => baseHref }
  Object.assign(globalThis, {
    document: {
      querySelector: (sel: string) => (sel === 'base[href]' ? base : null),
      documentElement: { dataset: {} as Record<string, string> },
    },
    window: { location: { pathname } },
  })
  const { appMountPath } = await import('./config')
  return appMountPath()
}

describe('appMountPath', () => {
  afterEach(() => {
    Object.assign(globalThis, { document: realDocument, window: realWindow })
  })

  it('is the root on a plain serve', async () => {
    expect(await mountPath('/')).toBe('/')
  })

  it('is the workspace mount when the page is on one', async () => {
    expect(await mountPath('/w/work/')).toBe('/w/work/')
  })

  it('is the declared base on a hosted mount', async () => {
    expect(await mountPath('/demo/', '/demo/')).toBe('/demo/')
    expect(await mountPath('/backlog/', '/backlog/')).toBe('/backlog/')
  })

  it('prefers the workspace mount over a base tag', async () => {
    expect(await mountPath('/w/gdk/', '/')).toBe('/w/gdk/')
  })
})
