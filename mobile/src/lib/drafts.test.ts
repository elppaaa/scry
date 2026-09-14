import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDemoSession } from './demo'
import { setActiveHostId } from './hosts'
import { MAX_DRAFTS, clearDraft, listDrafts, loadDraft, saveDraft } from './drafts'

// The mem-storage convention of hosts.test.ts / host-keys.test.ts. Host ids
// are real roster shapes — setActiveHostId ignores anything else.

const mem = new Map<string, string>()
const HOST_A = 'paired:0123abcd'
const HOST_B = 'paired:89abcdef'
const KEY_A = `gadak.drafts.v1@${HOST_A}`

beforeEach(() => {
  mem.clear()
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v)
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage
  setDemoSession(false)
  setActiveHostId(HOST_A)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-14T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  setDemoSession(false)
  mem.clear()
})

describe('drafts — save/load/clear round-trip', () => {
  it('returns what was saved, per kind and issue, and null once cleared', () => {
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    saveDraft('comment', 'NMA-1', 'half a thought')
    saveDraft('summary', 'NMA-1', 'a new title')
    saveDraft('comment', 'NMA-2', 'other issue')
    expect(loadDraft('comment', 'NMA-1')).toBe('half a thought')
    expect(loadDraft('summary', 'NMA-1')).toBe('a new title')
    expect(loadDraft('description', 'NMA-1')).toBeNull()
    expect(loadDraft('comment', 'NMA-2')).toBe('other issue')

    clearDraft('comment', 'NMA-1')
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    expect(loadDraft('summary', 'NMA-1')).toBe('a new title')
  })

  it('a later save for the same composer replaces, not appends', () => {
    saveDraft('comment', 'NMA-1', 'first')
    saveDraft('comment', 'NMA-1', 'second')
    expect(loadDraft('comment', 'NMA-1')).toBe('second')
    expect(listDrafts()).toHaveLength(1)
  })

  it('keeps leading/trailing whitespace inside a non-empty draft', () => {
    saveDraft('comment', 'NMA-1', '  spaced  ')
    expect(loadDraft('comment', 'NMA-1')).toBe('  spaced  ')
  })

  it('lists drafts newest first and forgets the document when the last one goes', () => {
    saveDraft('comment', 'NMA-1', 'a')
    vi.setSystemTime(new Date('2026-09-14T00:00:01Z'))
    saveDraft('description', 'NMA-2', 'b')
    expect(listDrafts().map((d) => `${d.kind}:${d.issueKey}`)).toEqual(['description:NMA-2', 'comment:NMA-1'])
    clearDraft('comment', 'NMA-1')
    clearDraft('description', 'NMA-2')
    expect(listDrafts()).toEqual([])
    expect(mem.has(KEY_A)).toBe(false)
  })
})

describe('drafts — the page comment kind (GDK-1873)', () => {
  it('keys on the page id and never collides with an issue draft of the same string', () => {
    expect(loadDraft('page-comment', '491848')).toBeNull()
    saveDraft('page-comment', '491848', 'one line on the doc')
    expect(loadDraft('page-comment', '491848')).toBe('one line on the doc')
    // The same string as an issue key: different kind, different draft.
    saveDraft('comment', '491848', 'on the issue')
    expect(loadDraft('page-comment', '491848')).toBe('one line on the doc')
    expect(loadDraft('comment', '491848')).toBe('on the issue')
    expect(listDrafts()).toHaveLength(2)

    clearDraft('page-comment', '491848')
    expect(loadDraft('page-comment', '491848')).toBeNull()
    expect(loadDraft('comment', '491848')).toBe('on the issue')
  })

  it('survives the round-trip through storage, so a read of a stored row admits the kind', () => {
    saveDraft('page-comment', '524553', 'kept')
    // isDraftRow filters every read by the kind list: a kind missing from it
    // saves and never comes back, which this reads through the raw document.
    const raw = JSON.parse(mem.get(KEY_A) as string) as { drafts: { kind: string }[] }
    expect(raw.drafts.map((d) => d.kind)).toEqual(['page-comment'])
    expect(loadDraft('page-comment', '524553')).toBe('kept')
  })

  it('empty text clears a page draft, same as every other kind', () => {
    saveDraft('page-comment', '491848', 'something')
    saveDraft('page-comment', '491848', '  \n ')
    expect(loadDraft('page-comment', '491848')).toBeNull()
    expect(mem.has(KEY_A)).toBe(false)
  })
})

describe('drafts — host namespacing', () => {
  it('two hosts never see each other’s drafts; the bare key serves a null host', () => {
    saveDraft('comment', 'NMA-1', 'from A')
    setActiveHostId(HOST_B)
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    saveDraft('comment', 'NMA-1', 'from B')
    expect(loadDraft('comment', 'NMA-1')).toBe('from B')
    setActiveHostId(HOST_A)
    expect(loadDraft('comment', 'NMA-1')).toBe('from A')
    expect(mem.has(KEY_A)).toBe(true)
    expect(mem.has(`gadak.drafts.v1@${HOST_B}`)).toBe(true)

    setActiveHostId(null)
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    saveDraft('comment', 'NMA-1', 'legacy')
    expect(mem.has('gadak.drafts.v1')).toBe(true)
  })
})

describe('drafts — cap and eviction', () => {
  it(`keeps at most ${MAX_DRAFTS}, evicting the oldest by updatedAt`, () => {
    for (let i = 0; i < MAX_DRAFTS; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 0, i)))
      saveDraft('comment', `NMB-${i}`, `text ${i}`)
    }
    expect(listDrafts()).toHaveLength(MAX_DRAFTS)
    // Touch NMA-0 so it is no longer the oldest — NMA-1 must go instead.
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 1, 0)))
    saveDraft('comment', 'NMA-0', 'text 0 again')
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 1, 1)))
    saveDraft('comment', 'NMB-new', 'the 51st')
    expect(listDrafts()).toHaveLength(MAX_DRAFTS)
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    expect(loadDraft('comment', 'NMA-0')).toBe('text 0 again')
    expect(loadDraft('comment', 'NMB-new')).toBe('the 51st')
  })

  it('the cap is one budget across kinds — a page draft evicts the oldest issue draft', () => {
    for (let i = 0; i < MAX_DRAFTS; i++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 0, i)))
      saveDraft('comment', `NMB-${i}`, `text ${i}`)
    }
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 14, 0, 2, 0)))
    saveDraft('page-comment', '491848', 'the page line')
    expect(listDrafts()).toHaveLength(MAX_DRAFTS)
    expect(loadDraft('comment', 'NMB-0')).toBeNull() // the oldest went
    expect(loadDraft('page-comment', '491848')).toBe('the page line')
    expect(listDrafts()[0]).toMatchObject({ kind: 'page-comment', issueKey: '491848' })
  })
})

describe('drafts — empty text is a clear', () => {
  it('saving whitespace removes an existing draft and never creates one', () => {
    saveDraft('comment', 'NMA-1', 'something')
    saveDraft('comment', 'NMA-1', '   \n')
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    saveDraft('summary', 'NMA-9', '')
    expect(listDrafts()).toEqual([])
    expect(mem.has(KEY_A)).toBe(false)
  })
})

describe('drafts — the demo session never touches storage', () => {
  it('writes nothing, reads nothing, clears nothing while the demo is active', () => {
    saveDraft('comment', 'NMA-1', 'real host draft')
    setDemoSession(true)
    saveDraft('comment', 'DEMO-1', 'typed in the demo')
    // Only the real host's document — mem also holds the active-host pointer.
    expect([...mem.keys()].filter((k) => k.startsWith('gadak.drafts.'))).toEqual([KEY_A])
    expect(loadDraft('comment', 'NMA-1')).toBeNull() // a real draft never shows in the demo
    expect(listDrafts()).toEqual([])
    clearDraft('comment', 'NMA-1')
    setDemoSession(false)
    expect(loadDraft('comment', 'NMA-1')).toBe('real host draft')
  })
})

describe('drafts — corrupt or foreign storage', () => {
  it('unparseable bytes read as no drafts and a read leaves them byte-identical', () => {
    mem.set(KEY_A, '{not json')
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    expect(listDrafts()).toEqual([])
    expect(mem.get(KEY_A)).toBe('{not json')
  })

  it('a save replaces unparseable bytes, so one bad write does not brick drafts', () => {
    mem.set(KEY_A, '{not json')
    saveDraft('comment', 'NMA-1', 'fresh')
    expect(loadDraft('comment', 'NMA-1')).toBe('fresh')
  })

  it('a doc of a schema this build does not speak reads as no drafts and is never overwritten', () => {
    const future = JSON.stringify({ schema: 99, drafts: [{ future: true }] })
    mem.set(KEY_A, future)
    expect(loadDraft('comment', 'NMA-1')).toBeNull()
    saveDraft('comment', 'NMA-1', 'from an old build')
    clearDraft('comment', 'NMA-1')
    expect(mem.get(KEY_A)).toBe(future)
  })

  it('drops malformed rows inside a well-formed doc instead of failing the read', () => {
    mem.set(
      KEY_A,
      JSON.stringify({
        schema: 1,
        drafts: [{ kind: 'comment', issueKey: 'NMA-1', text: 'ok', updatedAt: 'x' }, { kind: 'bogus' }, 7],
      }),
    )
    expect(loadDraft('comment', 'NMA-1')).toBe('ok')
    expect(listDrafts()).toHaveLength(1)
  })
})
