import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { stripComments } from './source-scan'
import {
  createBackStack,
  peekBack,
  systemBack,
  type HistorySeam,
  type PopTarget,
} from './back'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf8')
}

function shippedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(path)
    }
  }
  walk(srcDir)
  return out
}

function fakeNav() {
  let state: unknown = null
  const listeners: Array<() => void> = []
  const history: HistorySeam = {
    get state() {
      return state
    },
    pushState(data: unknown) {
      state = data
    },
  }
  const target: PopTarget = {
    addEventListener(_type, listener) {
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const i = listeners.indexOf(listener)
      if (i >= 0) listeners.splice(i, 1)
    },
  }
  return {
    history,
    target,
    pop() {
      state = null
      for (const l of listeners.slice()) l()
    },
  }
}

describe('peekBack — the stack order DESIGN.md §2 names', () => {
  it('sheet beats detail beats root', () => {
    expect(peekBack({ sheetCount: 1, hasDetail: true })).toBe('sheet')
    expect(peekBack({ sheetCount: 1, hasDetail: false })).toBe('sheet')
    expect(peekBack({ sheetCount: 0, hasDetail: true })).toBe('detail')
    expect(peekBack({ sheetCount: 0, hasDetail: false })).toBe('root')
  })

  it('a replaced linked issue is still one detail frame, not a stack', () => {
    // openIssue replaces the key in place (store.svelte.ts). The back
    // module never sees the key, only whether a detail is showing.
    expect(peekBack({ sheetCount: 0, hasDetail: true })).toBe('detail')
  })
})

describe('createBackStack — same close the visible control performs', () => {
  it('perform on a sheet calls the registered onclose, not closeDetail', () => {
    const stack = createBackStack()
    const onclose = vi.fn()
    const closeDetail = vi.fn()
    stack.registerSheet(onclose)
    expect(stack.perform(true, closeDetail)).toBe('sheet')
    expect(onclose).toHaveBeenCalledOnce()
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('perform on detail calls closeDetail (the ← Back path)', () => {
    const stack = createBackStack()
    const closeDetail = vi.fn()
    expect(stack.perform(true, closeDetail)).toBe('detail')
    expect(closeDetail).toHaveBeenCalledOnce()
  })

  it('root is a no-op: does not close detail and does not throw', () => {
    const stack = createBackStack()
    const closeDetail = vi.fn()
    expect(stack.perform(false, closeDetail)).toBe('root')
    expect(closeDetail).not.toHaveBeenCalled()
  })

  it('unregister (Cancel / scrim / pick) drops the sheet so the next back is honest', () => {
    const stack = createBackStack()
    const stop = stack.registerSheet(() => {})
    expect(stack.peek(true)).toBe('sheet')
    stop()
    expect(stack.peek(true)).toBe('detail')
  })

  it('dismissSheets closes every overlay (tab switch while a picker is open)', () => {
    const stack = createBackStack()
    const a = vi.fn()
    const b = vi.fn()
    stack.registerSheet(a)
    stack.registerSheet(b)
    stack.dismissSheets()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
  })

  it('LIFO: the top sheet closes first', () => {
    const stack = createBackStack()
    const order: string[] = []
    stack.registerSheet(() => order.push('bottom'))
    stack.registerSheet(() => order.push('top'))
    stack.perform(false, () => {})
    expect(order).toEqual(['top'])
  })
})

describe('bind — History is a trap, not a stack', () => {
  it('arms a sentinel so the first hardware back is popstate, not activity-finish', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    stack.bind(nav.history, nav.target, () => false, () => {})
    expect(nav.history.state).toEqual({ gadakBack: true })
  })

  it('popstate with a sheet runs onclose and re-arms the sentinel', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    const onclose = vi.fn()
    stack.registerSheet(onclose)
    stack.bind(nav.history, nav.target, () => true, () => {})
    nav.pop()
    expect(onclose).toHaveBeenCalledOnce()
    expect(nav.history.state).toEqual({ gadakBack: true })
  })

  it('popstate with a detail runs closeDetail (same as the visible ← Back)', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    const closeDetail = vi.fn()
    stack.bind(nav.history, nav.target, () => true, closeDetail)
    nav.pop()
    expect(closeDetail).toHaveBeenCalledOnce()
    expect(nav.history.state).toEqual({ gadakBack: true })
  })

  it('after the visible ← Back, the next pop is root and does not call closeDetail again', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    let detail = true
    const closeDetail = vi.fn(() => {
      detail = false
    })
    stack.bind(nav.history, nav.target, () => detail, closeDetail)
    detail = false // user tapped ← Back; store already cleared
    nav.pop()
    expect(closeDetail).not.toHaveBeenCalled()
    expect(nav.history.state).toEqual({ gadakBack: true })
  })

  it('root pop re-arms and does not leave (the no-op is explicit, not missing wiring)', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    const closeDetail = vi.fn()
    stack.bind(nav.history, nav.target, () => false, closeDetail)
    nav.pop()
    expect(closeDetail).not.toHaveBeenCalled()
    expect(nav.history.state).toEqual({ gadakBack: true })
  })

  it('unbind drops the listener', () => {
    const nav = fakeNav()
    const stack = createBackStack()
    const closeDetail = vi.fn()
    const stop = stack.bind(nav.history, nav.target, () => true, closeDetail)
    stop()
    nav.pop()
    expect(closeDetail).not.toHaveBeenCalled()
  })
})

describe('systemBack is the singleton the UI wires', () => {
  it('exports the same shape createBackStack returns', () => {
    expect(typeof systemBack.bind).toBe('function')
    expect(typeof systemBack.registerSheet).toBe('function')
    expect(typeof systemBack.dismissSheets).toBe('function')
  })
})

describe('recurrence — the owner stays the owner', () => {
  it('App.svelte binds the singleton with the store\'s ordered closer', () => {
    // GDK-902 2026-09-15: the bind used to name closeIssue directly, when
    // the detail was the only thing back could close. There are three now
    // — detail, the settings layer, the palette — and their order is the
    // entry/exit table's, so the predicate and the closer are one named
    // pair in the store (hasBackTarget / closeTop) rather than a lambda
    // here. The claim is unchanged: App is the only binder.
    const app = read('App.svelte')
    expect(app).toContain('systemBack.bind')
    expect(app).toContain('hasBackTarget')
    expect(app).toContain('closeTop')
  })

  it('the palette is not a sheet — back closes a Detail opened from it first', () => {
    // GDK-902 2026-09-15. peekBack ranks sheets ABOVE the detail, which is
    // right for a transition sheet over a Detail and exactly wrong for the
    // palette: a row tapped out of the palette opens a Detail *over* it, so
    // registering the palette as a sheet would have back close the palette
    // underneath and leave the Detail standing. closeTop is therefore the
    // owner of this order, and no component registers the palette.
    const store = read('lib/store.svelte.ts')
    const closer = store.slice(store.indexOf('export function closeTop'))
    const body = closer.slice(0, closer.indexOf('\n}'))
    expect(body.indexOf('app.detail')).toBeLessThan(body.indexOf('app.layer'))
    expect(body.indexOf('app.layer')).toBeLessThan(body.indexOf('app.palette'))
    expect(read('ui/Palette.svelte')).not.toContain('registerSheet')
    expect(read('screens/Issues.svelte')).not.toContain('registerSheet')
  })

  it('popstate / pushState live only in back.ts', () => {
    const hits: string[] = []
    for (const path of shippedFiles()) {
      const rel = relative(srcDir, path)
      if (rel === 'lib/back.ts') continue
      // lib/source-scan.ts owns the three replaces (GDK-1872 part 2).
      const text = stripComments(readFileSync(path, 'utf8'))
      if (/\baddEventListener\(\s*['"]popstate['"]|\.pushState\s*\(/.test(text)) hits.push(rel)
    }
    expect(hits).toEqual([])
  })

  it('Sheet registers onclose and does not hardcode .safe-bottom', () => {
    const sheet = read('ui/Sheet.svelte')
    expect(sheet).toContain('registerSheet')
    expect(sheet).not.toMatch(/class="sheet safe-bottom"/)
    expect(read('app.css')).toMatch(/\.detail-layer\s+\.sheet/)
  })

  it('the scrim is a named button using the catalog dismiss word', () => {
    const sheet = read('ui/Sheet.svelte')
    expect(sheet).toMatch(/<button[^>]*class="scrim"/)
    expect(sheet).toContain("t('common.cancel')")
    expect(sheet).not.toMatch(/class="scrim"[^>]*aria-hidden/)
  })

  it('the heading is the only owner control, and it opens the palette', () => {
    // GDK-902 2026-09-15: replaces "TabBar dismisses sheets when the visible
    // tab actually changes". There is no tab bar (DESIGN.md §2) — the owner
    // changes at the heading, and it changes through the store's one setter,
    // so a second road to it cannot be written without this failing.
    const issues = read('screens/Issues.svelte')
    expect(issues).toMatch(/class="scope"[^>]*onclick=\{showPalette\}/)
    expect(read('ui/Palette.svelte')).toContain('setOwner')
    expect(existsSync(join(srcDir, 'ui/TabBar.svelte'))).toBe(false)
  })

  it('the offline state is not color-only where it now lives — the gear', () => {
    // GDK-902 2026-09-15: the dot moved from the Pairing tab to the gear
    // that opens the same screen. Same markup, same claim: a slashed square,
    // never a hue on its own.
    const issues = read('screens/Issues.svelte')
    expect(issues).toContain('.dot::after')
    expect(issues).toContain('var(--color-text-primary)')
    expect(issues).toMatch(/class="dot"[^>]*aria-label=\{t\('app\.offline'\)\}/)
  })

  it('main.ts error overlay consumes tokens, not hex', () => {
    const main = read('main.ts')
    expect(main).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(main).toContain('var(--color-status-reopen)')
    expect(main).toContain('var(--color-bg-base)')
  })

  it('app.css does not claim App.svelte collapses the insets', () => {
    expect(read('app.css')).not.toMatch(/App\.svelte collapses/)
  })
})
