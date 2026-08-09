import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

/**
 * The right-click menu.
 *
 * Electron gives you nothing here: `window.prompt` and `window.confirm` do not
 * exist, and the native menu would need a main-process round trip for every
 * item. So this is a plain DOM menu, which also means the items can carry the
 * same typography and disabled-with-a-reason treatment as the rest of the app.
 *
 * The rules it follows:
 *
 *  - An action that cannot run is shown disabled **with the reason**, not
 *    hidden. A menu that changes shape depending on invisible state is a menu
 *    you have to learn twice.
 *  - Destructive items are last, separated, and tinted.
 *  - It is fully keyboard-driven, because the table already is.
 */

export interface MenuItem {
  readonly id: string
  readonly label: string
  /** Right-aligned detail: a shortcut, a count, the current value. */
  readonly hint?: string
  readonly danger?: boolean
  readonly disabled?: boolean
  /** Shown as a title when disabled. Say why, never just grey it out. */
  readonly reason?: string
  readonly checked?: boolean
  readonly submenu?: readonly MenuEntry[]
  readonly onSelect?: () => void
}

export interface MenuSeparator {
  readonly id: string
  readonly separator: true
  /** Optional heading for the group that follows. */
  readonly label?: string
}

export type MenuEntry = MenuItem | MenuSeparator

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e

export interface MenuState {
  readonly x: number
  readonly y: number
  /** What was clicked, shown greyed at the top so a menu is never ambiguous. */
  readonly title?: string
  readonly items: readonly MenuEntry[]
}

const MENU_MIN_WIDTH = 210

function Panel({
  items,
  onClose,
  autoFocus,
  title,
}: {
  readonly items: readonly MenuEntry[]
  readonly onClose: () => void
  readonly autoFocus: boolean
  readonly title?: string
}): JSX.Element {
  const [active, setActive] = useState(-1)
  const [openSub, setOpenSub] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const selectable = items.filter((e): e is MenuItem => !isSeparator(e) && !e.disabled)

  const run = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return
      if (item.submenu) {
        setOpenSub((s) => (s === item.id ? null : item.id))
        return
      }
      onClose()
      item.onSelect?.()
    },
    [onClose],
  )

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (selectable.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setActive((a) => (a + 1) % selectable.length)
      setOpenSub(null)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setActive((a) => (a <= 0 ? selectable.length - 1 : a - 1))
      setOpenSub(null)
    } else if (e.key === 'ArrowRight') {
      const item = selectable[active]
      if (item?.submenu) {
        e.preventDefault()
        setOpenSub(item.id)
      }
    } else if (e.key === 'ArrowLeft') {
      setOpenSub(null)
    } else if (e.key === 'Enter' || e.key === ' ') {
      const item = selectable[active]
      if (item) {
        e.preventDefault()
        run(item)
      }
    }
  }

  return (
    <div
      className="menu"
      role="menu"
      tabIndex={-1}
      ref={ref}
      onKeyDown={onKeyDown}
      style={{ minWidth: MENU_MIN_WIDTH }}
    >
      {title && <div className="menu-title">{title}</div>}
      {items.map((entry) =>
        isSeparator(entry) ? (
          entry.label ? (
            <div key={entry.id} className="menu-heading">{entry.label}</div>
          ) : (
            <div key={entry.id} className="menu-sep" role="separator" />
          )
        ) : (
          <div key={entry.id} className="menu-row">
            <button
              type="button"
              role="menuitem"
              className={`menu-item${entry.danger ? ' danger' : ''}${
                selectable[active]?.id === entry.id ? ' active' : ''
              }`}
              disabled={entry.disabled === true}
              title={entry.disabled ? entry.reason : undefined}
              aria-haspopup={entry.submenu ? 'menu' : undefined}
              aria-expanded={entry.submenu ? openSub === entry.id : undefined}
              onMouseEnter={() => {
                setActive(selectable.findIndex((s) => s.id === entry.id))
                setOpenSub(entry.submenu ? entry.id : null)
              }}
              onClick={() => run(entry)}
            >
              <span className="menu-check" aria-hidden>{entry.checked ? '✓' : ''}</span>
              <span className="menu-label">{entry.label}</span>
              {entry.hint && <span className="menu-hint">{entry.hint}</span>}
              {entry.submenu && <span className="menu-arrow" aria-hidden>›</span>}
            </button>
            {entry.submenu && openSub === entry.id && (
              <div className="submenu">
                <Panel items={entry.submenu} onClose={onClose} autoFocus={false} />
              </div>
            )}
          </div>
        ),
      )}
      {selectable.length === 0 && <div className="menu-empty">Nothing to do here</div>}
    </div>
  )
}

export function ContextMenu({
  state,
  onClose,
}: {
  readonly state: MenuState | null
  readonly onClose: () => void
}): JSX.Element | null {
  const holder = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Measure, then flip. Placing it optimistically and correcting afterwards is
  // visible as a jump; this renders it hidden for one frame instead.
  useLayoutEffect(() => {
    if (!state) {
      setPos(null)
      return
    }
    const el = holder.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    const left = state.x + width + pad > window.innerWidth
      ? Math.max(pad, state.x - width)
      : state.x
    const top = state.y + height + pad > window.innerHeight
      ? Math.max(pad, window.innerHeight - height - pad)
      : state.y
    setPos({ left, top })
  }, [state])

  useEffect(() => {
    if (!state) return
    const close = (e: Event): void => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      onClose()
    }
    // `capture` so the menu closes before the click reaches a row underneath.
    window.addEventListener('mousedown', close, true)
    window.addEventListener('keydown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('keydown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [state, onClose])

  if (!state) return null

  return (
    <div
      className="menu-holder"
      ref={holder}
      style={{
        left: pos?.left ?? state.x,
        top: pos?.top ?? state.y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Panel items={state.items} onClose={onClose} autoFocus {...(state.title ? { title: state.title } : {})} />
    </div>
  )
}

/** Convenience for building submenu entries from a list. */
export function radioItems<T>(
  options: readonly T[],
  current: T,
  label: (t: T) => string,
  onPick: (t: T) => void,
): MenuEntry[] {
  return options.map((o) => ({
    id: `radio-${String(o)}`,
    label: label(o),
    checked: o === current,
    onSelect: () => onPick(o),
  }))
}
