import { describe, expect, it } from 'vitest'
import { attachAll, createReady } from './create-attach'

/*
 * GDK-1879. The branch worth a unit test is the one no e2e on the bundled
 * demo can reach: the create landed and the upload was refused. On a
 * credential-less serve the create is refused first, so the screen never gets
 * to the second write — the only place that path can be measured is here,
 * with a fake uploader that says yes to the create's key and no to the file.
 */

describe('createReady', () => {
  it('needs a title', () => {
    expect(createReady('', 0)).toBe(false)
    expect(createReady('   \n\t ', 0)).toBe(false)
    expect(createReady('Portal login loops', 0)).toBe(true)
  })

  it('will not fire while bytes are still crossing the wire', () => {
    expect(createReady('Portal login loops', 1)).toBe(false)
    expect(createReady('Portal login loops', 3)).toBe(false)
  })
})

describe('attachAll', () => {
  const file = (name: string) => ({ name })

  it('uploads every picked file to the new key, in pick order', async () => {
    const seen: string[] = []
    const out = await attachAll('NMA-77', [file('a.png'), file('b.png'), file('c.png')], async (key, f) => {
      seen.push(`${key}/${f.name}`)
      return { ok: true }
    })
    expect(seen).toEqual(['NMA-77/a.png', 'NMA-77/b.png', 'NMA-77/c.png'])
    expect(out).toEqual({ attached: 3, failed: [] })
  })

  it('runs them one at a time, never overlapping', async () => {
    let live = 0
    let peak = 0
    await attachAll('NMA-77', [file('a.png'), file('b.png'), file('c.png')], async () => {
      live += 1
      peak = Math.max(peak, live)
      await Promise.resolve()
      live -= 1
    })
    expect(peak).toBe(1)
  })

  it('does not throw when an upload is refused — the issue must survive it', async () => {
    const out = await attachAll('NMA-77', [file('a.png')], async () => {
      throw new Error('credential_required')
    })
    expect(out).toEqual({ attached: 0, failed: [{ name: 'a.png' }] })
  })

  it('keeps going after a refusal and names the first failure first', async () => {
    const seen: string[] = []
    const out = await attachAll(
      'NMA-77',
      [file('a.png'), file('b.png'), file('c.png')],
      async (_key, f) => {
        seen.push(f.name)
        if (f.name !== 'b.png') throw new Error('nope')
        return { ok: true }
      },
    )
    // Every file was attempted: one refusal is not a reason to drop the rest.
    expect(seen).toEqual(['a.png', 'b.png', 'c.png'])
    expect(out.attached).toBe(1)
    expect(out.failed.map((f) => f.name)).toEqual(['a.png', 'c.png'])
  })

  it('answers an empty outcome for an empty pick, without calling the uploader', async () => {
    let calls = 0
    const out = await attachAll('NMA-77', [], async () => {
      calls += 1
    })
    expect(calls).toBe(0)
    expect(out).toEqual({ attached: 0, failed: [] })
  })
})
