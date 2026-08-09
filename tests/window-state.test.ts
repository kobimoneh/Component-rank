import { describe, it, expect } from 'vitest'
import {
  DEFAULT_STATE, MIN_HEIGHT, MIN_WIDTH,
  isOnSomeDisplay, loadWindowState, maximizeAction, sameRect, saveWindowState,
} from '../src/main/window-state.js'
import { openInMemory } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = loadMigrations(fileURLToPath(new URL('../resources/migrations', import.meta.url)))

/**
 * The real two-display layout measured on this machine. Display 33 is primary
 * and sits to the right; display 1 is where the app actually opens.
 */
const DISPLAYS = [
  { id: 33, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
  { id: 1, bounds: { x: 0, y: 357, width: 1920, height: 1080 } },
]

describe('maximize across displays', () => {
  // Measured: a window on display 1 told to maximize lands on display 33 at
  // x=2566. The user sees it bounce to the other monitor and never enlarge on
  // the screen they were looking at.
  it('corrects a maximize that jumped to another display', () => {
    expect(maximizeAction({ beforeDisplayId: 1, afterDisplayId: 33, manuallyMaximized: false }))
      .toBe('correct')
  })

  it('leaves a well-behaved maximize alone', () => {
    expect(maximizeAction({ beforeDisplayId: 1, afterDisplayId: 1, manuallyMaximized: false }))
      .toBe('none')
  })

  it('treats a second click as restore once we are manually maximized', () => {
    expect(maximizeAction({ beforeDisplayId: 1, afterDisplayId: 33, manuallyMaximized: true }))
      .toBe('restore')
    expect(maximizeAction({ beforeDisplayId: 1, afterDisplayId: 1, manuallyMaximized: true }))
      .toBe('restore')
  })

  it('does nothing before it has seen the window anywhere', () => {
    expect(maximizeAction({ beforeDisplayId: null, afterDisplayId: 33, manuallyMaximized: false }))
      .toBe('none')
  })
})

describe('off-screen protection', () => {
  it('accepts a position on the secondary display', () => {
    expect(isOnSomeDisplay({ x: 23, y: 399, width: 1200, height: 800 }, DISPLAYS)).toBe(true)
  })

  it('accepts a position on the primary display', () => {
    expect(isOnSomeDisplay({ x: 2566, y: 27, width: 1200, height: 800 }, DISPLAYS)).toBe(true)
  })

  it('rejects a position from a monitor that is no longer connected', () => {
    // Saved while a third screen was attached far to the right.
    expect(isOnSomeDisplay({ x: 9000, y: 200, width: 1200, height: 800 }, DISPLAYS)).toBe(false)
  })

  it('rejects a window whose title bar is barely reachable', () => {
    // Only a sliver overlaps: dragging it back would be impossible.
    expect(isOnSomeDisplay({ x: -1150, y: 400, width: 1200, height: 800 }, DISPLAYS)).toBe(false)
  })

  it('rejects a window entirely above the desktop', () => {
    expect(isOnSomeDisplay({ x: 100, y: -900, width: 1200, height: 800 }, DISPLAYS)).toBe(false)
  })
})

describe('rectangle comparison', () => {
  it('tolerates a pixel of window-manager slop', () => {
    expect(sameRect({ x: 0, y: 357, width: 1920, height: 1080 }, { x: 1, y: 358, width: 1919, height: 1079 }))
      .toBe(true)
    expect(sameRect({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1200, height: 800 }))
      .toBe(false)
  })
})

describe('geometry persistence', () => {
  const fresh = () => {
    const db = openInMemory()
    migrate(db, MIGRATIONS)
    return db
  }

  it('returns the default when nothing has been saved', () => {
    expect(loadWindowState(fresh())).toEqual(DEFAULT_STATE)
  })

  it('round-trips a saved window', () => {
    const db = fresh()
    saveWindowState(db, { x: 968, y: 135, width: 1440, height: 900, maximized: false })
    expect(loadWindowState(db)).toEqual({ x: 968, y: 135, width: 1440, height: 900, maximized: false })
  })

  it('remembers the maximized flag', () => {
    const db = fresh()
    saveWindowState(db, { x: 0, y: 0, width: 1920, height: 1080, maximized: true })
    expect(loadWindowState(db).maximized).toBe(true)
  })

  it('clamps a saved size below the minimum instead of opening a sliver', () => {
    const db = fresh()
    saveWindowState(db, { x: 10, y: 10, width: 200, height: 100, maximized: false })
    const state = loadWindowState(db)
    expect(state.width).toBe(MIN_WIDTH)
    expect(state.height).toBe(MIN_HEIGHT)
  })

  it('falls back to the default rather than throwing on corrupt state', () => {
    const db = fresh()
    db.prepare("INSERT INTO setting (key, value) VALUES ('window.state', '{not json')").run()
    expect(loadWindowState(db)).toEqual(DEFAULT_STATE)
  })

  it('the minimum is small enough for a laptop screen', () => {
    // 960x600 refused perfectly reasonable window sizes on a 1366x768 display.
    expect(MIN_WIDTH).toBeLessThanOrEqual(830)
    expect(MIN_HEIGHT).toBeLessThanOrEqual(600)
  })
})
