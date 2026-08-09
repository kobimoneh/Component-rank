import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { SqlDriver } from '../db/driver.js'

/**
 * Window geometry persistence.
 *
 * Three things this fixes, all observed rather than assumed:
 *
 *  - The window did not remember its size or position at all, so every launch
 *    reset it.
 *  - `setBounds` while still maximized only partially applies — the window
 *    manager keeps its own placement. Restoring has to `unmaximize()` first.
 *  - Maximizing could move the window onto another display and leave it there.
 *    A saved position is only reused if it still intersects a connected screen.
 */

const KEY = 'window.state'

export interface WindowState {
  readonly x: number | null
  readonly y: number | null
  readonly width: number
  readonly height: number
  readonly maximized: boolean
}

export const DEFAULT_STATE: WindowState = {
  x: null, y: null, width: 1440, height: 900, maximized: false,
}

/** Smallest usable window. Deliberately modest — a laptop screen is not large. */
export const MIN_WIDTH = 820
export const MIN_HEIGHT = 560

export function loadWindowState(db: SqlDriver): WindowState {
  const row = db.prepare('SELECT value FROM setting WHERE key = ?').get<{ value: string }>(KEY)
  if (!row) return DEFAULT_STATE
  try {
    const parsed = JSON.parse(row.value) as Partial<WindowState>
    return {
      x: typeof parsed.x === 'number' ? parsed.x : null,
      y: typeof parsed.y === 'number' ? parsed.y : null,
      width: Math.max(MIN_WIDTH, Number(parsed.width) || DEFAULT_STATE.width),
      height: Math.max(MIN_HEIGHT, Number(parsed.height) || DEFAULT_STATE.height),
      maximized: parsed.maximized === true,
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function saveWindowState(db: SqlDriver, state: WindowState): void {
  db.prepare(`
    INSERT INTO setting (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(KEY, JSON.stringify(state))
}

/**
 * True when the saved rectangle still overlaps a connected display.
 * Without this, unplugging a monitor strands the window off-screen and the
 * app looks like it failed to start.
 */
export function isOnSomeDisplay(
  bounds: Rectangle,
  displays: ReadonlyArray<{ bounds: Rectangle }>,
): boolean {
  return displays.some((d) => {
    const b = d.bounds
    const overlapX = Math.min(bounds.x + bounds.width, b.x + b.width) - Math.max(bounds.x, b.x)
    const overlapY = Math.min(bounds.y + bounds.height, b.y + b.height) - Math.max(bounds.y, b.y)
    // Require a real slab of the title bar to be reachable, not one pixel.
    return overlapX > 120 && overlapY > 40
  })
}

/** Options for `new BrowserWindow`, derived from the saved state. */
export function initialBounds(state: WindowState): {
  width: number; height: number; x?: number; y?: number
} {
  const base = { width: state.width, height: state.height }
  if (state.x === null || state.y === null) return base

  const candidate = { x: state.x, y: state.y, width: state.width, height: state.height }
  const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds }))
  if (!isOnSomeDisplay(candidate, displays)) return base
  return { ...base, x: state.x, y: state.y }
}

/**
 * Track a window and persist its geometry.
 *
 * Only unmaximized geometry is recorded, so restoring from a maximized session
 * gives back the size the window had before it was maximized rather than the
 * screen dimensions.
 */
export function trackWindow(win: BrowserWindow, db: SqlDriver): void {
  let timer: NodeJS.Timeout | null = null

  const persist = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    saveWindowState(db, {
      x: bounds.x, y: bounds.y,
      width: Math.max(MIN_WIDTH, bounds.width),
      height: Math.max(MIN_HEIGHT, bounds.height),
      maximized,
    })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, 400)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    persist()
  })
}
