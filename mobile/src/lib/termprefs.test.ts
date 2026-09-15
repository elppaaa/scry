import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyTerminalFontSize,
  readTerminalFontSize,
  TERMINAL_FONT_SIZES,
  writeTerminalFontSize,
} from './termprefs'

/*
 * The preference's own gates (GDK-901). The unit project runs in node
 * (vite.config.ts `test.environment`), so localStorage is the same guarded
 * stub hosts.test.ts uses, and the document root is a fake with the two
 * style methods applyTerminalFontSize touches — the contract under test is
 * which key is written and which property is set, not what a browser does
 * with either.
 */

const mem = new Map<string, string>()

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
})

afterEach(() => {
  mem.clear()
})

/** A root whose style records the two calls applyTerminalFontSize makes. */
function fakeRoot(): { root: HTMLElement; recorded: Map<string, string> } {
  const recorded = new Map<string, string>()
  const root = {
    style: {
      setProperty: (name: string, value: string) => void recorded.set(name, value),
      removeProperty: (name: string) => void recorded.delete(name),
    },
  } as unknown as HTMLElement
  return { root, recorded }
}

describe('readTerminalFontSize', () => {
  it('reads 13 when nothing is stored', () => {
    expect(readTerminalFontSize()).toBe(13)
  })

  it('round-trips every size in the set', () => {
    for (const px of TERMINAL_FONT_SIZES) {
      writeTerminalFontSize(px)
      expect(readTerminalFontSize(), `after writing ${px}`).toBe(px)
    }
  })

  it('reads 13 for a malformed value', () => {
    mem.set('gadak.terminal.fontSize', 'abc')
    expect(readTerminalFontSize()).toBe(13)
  })

  it('reads 13 for a size outside the set', () => {
    mem.set('gadak.terminal.fontSize', '12')
    expect(readTerminalFontSize()).toBe(13)
  })

  it('reads 13 when localStorage throws', () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error('unavailable')
      },
    } as unknown as Storage
    expect(readTerminalFontSize()).toBe(13)
  })
})

describe('writeTerminalFontSize', () => {
  it('refuses a value outside the set without touching storage', () => {
    writeTerminalFontSize(12)
    expect(mem.has('gadak.terminal.fontSize')).toBe(false)
    writeTerminalFontSize(NaN)
    expect(mem.has('gadak.terminal.fontSize')).toBe(false)
  })

  it('writes the number as a plain string', () => {
    writeTerminalFontSize(17)
    expect(mem.get('gadak.terminal.fontSize')).toBe('17')
  })

  it('removes the key when asked for the default', () => {
    writeTerminalFontSize(17)
    writeTerminalFontSize(13)
    expect(mem.has('gadak.terminal.fontSize')).toBe(false)
  })
})

describe('applyTerminalFontSize', () => {
  it('sets the inline variable for a non-default size', () => {
    const { root, recorded } = fakeRoot()
    applyTerminalFontSize(17, root)
    expect(recorded.get('--text-terminal')).toBe('17px')
  })

  it('removes the inline variable for the default, leaving the token owner', () => {
    const { root, recorded } = fakeRoot()
    applyTerminalFontSize(17, root)
    applyTerminalFontSize(13, root)
    expect(recorded.has('--text-terminal')).toBe(false)
  })

  it('removing a variable that was never set is a no-op, not a throw', () => {
    const { root, recorded } = fakeRoot()
    applyTerminalFontSize(13, root)
    expect(recorded.has('--text-terminal')).toBe(false)
  })
})
