import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'

/**
 * The three questions the context menus need to ask.
 *
 * Electron removes `window.prompt` and `window.confirm` outright, so every
 * "rename this" and "are you sure" needs a real component. Which is just as
 * well: the picker has to search, because choosing among 36 families from a
 * nested submenu is not a thing anyone should have to do.
 *
 * All three return through a single `onSubmit`, and all three close on Escape
 * without acting.
 */

function Shell({
  title,
  subtitle,
  onClose,
  children,
}: {
  readonly title: string
  readonly subtitle?: string | null
  readonly onClose: () => void
  readonly children: React.ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="dialog-scrim" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="dialog-title">{title}</div>
          {subtitle && <div className="dialog-sub">{subtitle}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}

export interface PromptSpec {
  readonly kind: 'prompt'
  readonly title: string
  readonly subtitle?: string | null
  readonly label: string
  readonly initial?: string
  readonly placeholder?: string
  readonly confirmLabel?: string
  readonly onSubmit: (value: string) => void
}

export interface PickOption {
  readonly value: string
  readonly label: string
  readonly hint?: string
  readonly group?: string
}

export interface PickerSpec {
  readonly kind: 'picker'
  readonly title: string
  readonly subtitle?: string | null
  readonly options: readonly PickOption[]
  readonly confirmLabel?: string
  /** Offered as an explicit choice rather than an empty selection. */
  readonly noneLabel?: string | null
  readonly onSubmit: (value: string | null) => void
}

export interface ConfirmSpec {
  readonly kind: 'confirm'
  readonly title: string
  readonly subtitle?: string | null
  readonly body: React.ReactNode
  readonly confirmLabel: string
  readonly danger?: boolean
  readonly onSubmit: () => void
}

export type DialogSpec = PromptSpec | PickerSpec | ConfirmSpec

export function Dialog({
  spec,
  error,
  onClose,
}: {
  readonly spec: DialogSpec | null
  /** A refusal from the main process, shown in place rather than as a toast. */
  readonly error: string | null
  readonly onClose: () => void
}): JSX.Element | null {
  if (!spec) return null
  if (spec.kind === 'prompt') return <PromptBody spec={spec} error={error} onClose={onClose} />
  if (spec.kind === 'picker') return <PickerBody spec={spec} error={error} onClose={onClose} />
  return (
    <Shell title={spec.title} subtitle={spec.subtitle ?? null} onClose={onClose}>
      <div className="dialog-body">{spec.body}</div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className={`btn ${spec.danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => spec.onSubmit()}
        >
          {spec.confirmLabel}
        </button>
      </div>
    </Shell>
  )
}

function PromptBody({
  spec, error, onClose,
}: {
  readonly spec: PromptSpec
  readonly error: string | null
  readonly onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState(spec.initial ?? '')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(spec.initial ?? '')
    // Select the existing text: a rename almost always replaces it wholesale.
    const t = window.setTimeout(() => {
      input.current?.focus()
      input.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [spec])

  const submit = (): void => {
    if (value.trim()) spec.onSubmit(value.trim())
  }

  return (
    <Shell title={spec.title} subtitle={spec.subtitle ?? null} onClose={onClose}>
      <div className="dialog-body">
        <label className="field">
          <span>{spec.label}</span>
          <input
            ref={input}
            value={value}
            placeholder={spec.placeholder ?? ''}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </label>
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!value.trim()} onClick={submit}>
          {spec.confirmLabel ?? 'Save'}
        </button>
      </div>
    </Shell>
  )
}

function PickerBody({
  spec, error, onClose,
}: {
  readonly spec: PickerSpec
  readonly error: string | null
  readonly onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setQuery('')
    setPicked(null)
    const t = window.setTimeout(() => input.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [spec])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return spec.options
    return spec.options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.group ?? '').toLowerCase().includes(q),
    )
  }, [spec.options, query])

  const submit = (value: string | null): void => spec.onSubmit(value)

  return (
    <Shell title={spec.title} subtitle={spec.subtitle ?? null} onClose={onClose}>
      <div className="dialog-body">
        <input
          ref={input}
          className="dialog-search"
          value={query}
          placeholder="Search…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const first = picked ?? shown[0]?.value ?? null
              if (first) submit(first)
            }
          }}
        />
        <div className="dialog-list" role="listbox">
          {spec.noneLabel && (
            <button
              className={`dialog-option${picked === '' ? ' picked' : ''}`}
              role="option"
              aria-selected={picked === ''}
              onClick={() => setPicked('')}
              onDoubleClick={() => submit(null)}
            >
              <span className="dialog-option-label">{spec.noneLabel}</span>
            </button>
          )}
          {shown.map((o) => (
            <button
              key={o.value}
              className={`dialog-option${picked === o.value ? ' picked' : ''}`}
              role="option"
              aria-selected={picked === o.value}
              onClick={() => setPicked(o.value)}
              onDoubleClick={() => submit(o.value)}
            >
              <span className="dialog-option-label">{o.label}</span>
              {o.group && <span className="dialog-option-group">{o.group}</span>}
              {o.hint && <span className="dialog-option-hint">{o.hint}</span>}
            </button>
          ))}
          {shown.length === 0 && <div className="dialog-empty">Nothing matches “{query}”.</div>}
        </div>
      </div>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={picked === null}
          onClick={() => submit(picked === '' ? null : picked)}
        >
          {spec.confirmLabel ?? 'Choose'}
        </button>
      </div>
    </Shell>
  )
}
