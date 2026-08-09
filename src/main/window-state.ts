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

/**
 * Maximize correction for multi-display setups.
 *
 * Measured on a two-display WSLg session: display 33 is primary
 * (2560x1440 at x=1920), display 1 is secondary (1920x1080 at x=0). A window
 * sitting on display 1 and told to maximize lands on display **33** at x=2566.
 * From the user's seat the window vanishes to the other monitor and the app on
 * the screen they were looking at never enlarges.
 *
 * The fix is to maximize manually into the work area of the display the window
 * was already on. That was verified to work: 1919x1079, still on display 1.
 *
 * The correction only fires when the display actually changed, so on a platform
 * where maximize behaves correctly this code never interferes.
 */

export type MaximizeAction = 'none' | 'correct' | 'restore'

/**
 * What to do when a `maximize` event arrives.
 *
 *  - `restore`  — we are already manually maximized, so this click means restore.
 *  - `correct`  — the window jumped to another display; put it back and fill that one.
 *  - `none`     — maximize behaved; leave it alone.
 */
export function maximizeAction(opts: {
  readonly beforeDisplayId: number | null
  readonly afterDisplayId: number
  readonly manuallyMaximized: boolean
}): MaximizeAction {
  if (opts.manuallyMaximized) return 'restore'
  if (opts.beforeDisplayId === null) return 'none'
  return opts.beforeDisplayId === opts.afterDisplayId ? 'none' : 'correct'
}

/** True when two rectangles are the same within a pixel of slop. */
export function sameRect(a: Rectangle, b: Rectangle, slop = 2): boolean {
  return (
    Math.abs(a.x - b.x) <= slop && Math.abs(a.y - b.y) <= slop &&
    Math.abs(a.width - b.width) <= slop && Math.abs(a.height - b.height) <= slop
  )
}

/**
 * Apply bounds, then apply them again once the window manager has settled.
 *
 * Measured: a single `setBounds` right after `unmaximize` applies the size but
 * keeps the old x/y, leaving a full-width window starting at the old offset —
 * straddling both monitors. The second application sticks.
 */
function applyBounds(win: BrowserWindow, bounds: Rectangle): void {
  win.setBounds(bounds)
  setTimeout(() => {
    if (win.isDestroyed()) return
    const current = win.getBounds()
    if (!sameRect(current, bounds)) win.setBounds(bounds)
  }, 90)
}

export function correctMaximizeAcrossDisplays(win: BrowserWindow): void {
  let homeDisplayId: number | null = null
  let restoreBounds: Rectangle | null = null
  let manuallyMaximized = false
  let correcting = false

  const remember = (): void => {
    if (win.isDestroyed() || win.isMaximized() || correcting) return
    const bounds = win.getBounds()
    if (manuallyMaximized) {
      // Still sitting in our manual maximize? Keep the remembered home.
      const home = screen.getAllDisplays().find((d) => d.id === homeDisplayId)
      if (home && sameRect(bounds, home.workArea)) return
      // Dragged or resized out of it — it is a normal window again.
      manuallyMaximized = false
    }
    homeDisplayId = screen.getDisplayMatching(bounds).id
    restoreBounds = bounds
  }

  win.on('move', remember)
  win.on('resize', remember)
  remember()

  /**
   * Evaluated on a short delay, not synchronously.
   *
   * The `maximize` event fires before the window manager has finished placing
   * the window: reading bounds immediately reports the *old* display, the check
   * concludes nothing moved, and the window then lands on the wrong monitor
   * anyway. Measured directly — the first version of this fix did exactly that.
   */
  const evaluate = (): void => {
    if (win.isDestroyed()) return
    const after = screen.getDisplayMatching(win.getBounds())
    const action = maximizeAction({
      beforeDisplayId: homeDisplayId,
      afterDisplayId: after.id,
      manuallyMaximized,
    })

    if (action === 'restore') {
      correcting = true
      win.unmaximize()
      if (restoreBounds) applyBounds(win, restoreBounds)
      manuallyMaximized = false
      setTimeout(() => { correcting = false }, 400)
      return
    }

    if (action === 'correct') {
      const home = screen.getAllDisplays().find((d) => d.id === homeDisplayId)
      if (!home) return
      correcting = true
      // unmaximize first: setBounds while maximized is only partially applied.
      win.unmaximize()
      applyBounds(win, home.workArea)
      manuallyMaximized = true
      setTimeout(() => { correcting = false }, 400)
    }
  }

  win.on('maximize', () => {
    setTimeout(evaluate, 220)
  })

  win.on('unmaximize', () => {
    // Ignore the unmaximize we caused ourselves.
    if (!correcting) manuallyMaximized = false
  })
}
