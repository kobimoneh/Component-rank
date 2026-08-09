import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  AppStatus,
  CategoryDetail,
  CategoryNavItem,
  CategoryRow,
  ComponentDetail,
} from '../shared/ipc.js'
import { Drawer } from './Drawer.js'

type SortState = { key: string; dir: 'asc' | 'desc' } | null

const GROUP_ORDER = ['Power', 'MCU', 'Wireless', 'RF', 'FPGA', 'Memory', 'Interface', 'Connectors', 'Other']

export function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [categories, setCategories] = useState<CategoryNavItem[]>([])
  const [slug, setSlug] = useState<string | null>(null)
  const [detail, setDetail] = useState<CategoryDetail | null>(null)
  const [rows, setRows] = useState<CategoryRow[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [component, setComponent] = useState<ComponentDetail | null>(null)
  const [cursor, setCursor] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.api.status().then(setStatus)
    void window.api.listCategories().then((list) => {
      setCategories(list)
      // Open the first populated category in nav order rather than whichever
      // happens to sort first by count — ties made that arbitrary.
      const ordered = [...list].sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
      )
      const first = ordered.find((c) => c.componentCount > 0) ?? ordered[0]
      if (first) setSlug(first.slug)
    })
  }, [])

  useEffect(() => {
    if (!slug) return
    setSort(null)
    setCursor(0)
    void window.api.categoryDetail({ slug }).then(setDetail)
    void window.api.categoryRows({ slug }).then(setRows)
  }, [slug])

  useEffect(() => {
    if (openId === null) {
      setComponent(null)
      return
    }
    void window.api.componentDetail({ id: openId }).then(setComponent)
  }, [openId])

  const grouped = useMemo(() => {
    const map = new Map<string, CategoryNavItem[]>()
    for (const c of categories) {
      const list = map.get(c.group) ?? []
      list.push(c)
      map.set(c.group, list)
    }
    return [...map.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    )
  }, [categories])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let out = q
      ? rows.filter(
          (r) => r.mpn.toLowerCase().includes(q) || r.manufacturer.toLowerCase().includes(q),
        )
      : rows

    if (sort) {
      const { key, dir } = sort
      out = [...out].sort((a, b) => {
        const av = a.cells[key]
        const bv = b.cells[key]
        const an = av?.sort ?? null
        const bn = bv?.sort ?? null
        if (an !== null || bn !== null) {
          // Missing always sorts last, in both directions. An unknown value is
          // not a small value.
          if (an === null) return 1
          if (bn === null) return -1
          return dir === 'asc' ? an - bn : bn - an
        }
        const at = av?.text ?? ''
        const bt = bv?.text ?? ''
        if (!at) return 1
        if (!bt) return -1
        return dir === 'asc' ? at.localeCompare(bt) : bt.localeCompare(at)
      })
    } else {
      out = [...out].sort((a, b) => {
        if (a.rank === null && b.rank === null) return a.mpn.localeCompare(b.mpn)
        if (a.rank === null) return 1
        if (b.rank === null) return -1
        return a.rank - b.rank
      })
    }
    return out
  }, [rows, search, sort])

  // Best/worst per numeric column, for the comparison tint.
  const extremes = useMemo(() => {
    const out = new Map<string, { best: number; worst: number }>()
    for (const col of detail?.columns ?? []) {
      if (!col.numeric || col.better === 'none') continue
      const values = visible
        .map((r) => (r.cells[col.key]?.unverified ? null : r.cells[col.key]?.sort ?? null))
        .filter((v): v is number => v !== null)
      if (values.length < 2) continue
      const min = Math.min(...values)
      const max = Math.max(...values)
      if (min === max) continue
      out.set(col.key, col.better === 'lower' ? { best: min, worst: max } : { best: max, worst: min })
    }
    return out
  }, [visible, detail])

  const toggleSort = useCallback((key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }, [])

  // Keyboard: j/k walk rows with the drawer open, Enter opens, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = document.activeElement?.tagName === 'INPUT'
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        if (openId !== null) setOpenId(null)
        else if (typing) (document.activeElement as HTMLElement).blur()
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.min(c + 1, visible.length - 1)
          if (openId !== null) setOpenId(visible[next]?.id ?? null)
          return next
        })
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => {
          const next = Math.max(c - 1, 0)
          if (openId !== null) setOpenId(visible[next]?.id ?? null)
          return next
        })
      } else if (e.key === 'Enter') {
        const row = visible[cursor]
        if (row) setOpenId(row.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, cursor, openId])

  const columns = detail?.columns ?? []

  return (
    <div className="app">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <span>Component Library</span>
      </div>

      <div className="topbar">
        <div className="search-box">
          <span aria-hidden>⌕</span>
          <input
            ref={searchRef}
            value={search}
            placeholder="Filter this category by part number or manufacturer…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="kbd">Ctrl K</span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled title="Datasheet ingestion arrives in phase 5">
          + Add component
        </button>
        <button
          className="btn"
          onClick={() => {
            const root = document.documentElement
            const next = root.dataset['theme'] === 'light' ? 'dark' : 'light'
            root.dataset['theme'] = next
          }}
          title="Toggle theme"
        >
          ◐
        </button>
      </div>

      <nav className="sidebar">
        {grouped.map(([group, items]) => (
          <div key={group}>
            <div className="nav-group">{group}</div>
            {items.map((c) => (
              <button
                key={c.slug}
                className="nav-item"
                aria-current={c.slug === slug}
                onClick={() => setSlug(c.slug)}
                title={c.name}
              >
                <span className="nav-item-label">{c.name}</span>
                <span className="count">{c.componentCount}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main className="main">
        {detail && (
          <header className="cat-header">
            <div style={{ minWidth: 0 }}>
              <div className="cat-title">{detail.name}</div>
              <div className="cat-metric">
                Ranked by: <b>{detail.metricProse || 'not defined'}</b>
              </div>
              {detail.requirements.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {detail.requirements.map((r) => (
                    <span key={r} className="chip chip-warn" title="Parts failing this are shown but not ranked">
                      Hard requirement: {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
              <span className="chip">{visible.length} parts</span>
            </div>
          </header>
        )}

        <div className="table-scroll">
          {visible.length === 0 ? (
            <div className="empty">
              <h3>No components in this category yet</h3>
              <div>Seed data covers the categories present in the June 2026 report.</div>
            </div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 46 }} className="num">#</th>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={col.numeric ? 'num' : ''}
                      onClick={() => toggleSort(col.key)}
                      title={`Sort by ${col.label}`}
                    >
                      {col.label}
                      {col.unit && <span className="unit"> ({col.unit})</span>}
                      {sort?.key === col.key && (
                        <span className="sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => (
                  <tr
                    key={row.id}
                    aria-selected={i === cursor}
                    className={row.failedRequirements.length > 0 ? 'excluded' : ''}
                    onClick={() => {
                      setCursor(i)
                      setOpenId(row.id)
                    }}
                    title={row.unrankedReason ?? undefined}
                  >
                    <td className="num">
                      <span className={`rank${row.rank === 1 ? ' rank-1' : ''}`}>
                        {row.rank === null ? '—' : `#${row.rank}`}
                      </span>
                    </td>
                    {columns.map((col) => {
                      const cell = row.cells[col.key]
                      const ext = extremes.get(col.key)
                      const v = cell?.unverified ? null : cell?.sort ?? null
                      const tint =
                        ext && v !== null ? (v === ext.best ? ' best' : v === ext.worst ? ' worst' : '') : ''
                      const isMpn = col.key === 'mpn'
                      return (
                        <td key={col.key} className={col.numeric ? `num${tint}` : tint.trim()}>
                          {cell?.text ? (
                            <span
                              className={
                                (cell.unverified ? 'unverified ' : '') + (isMpn ? 'mpn' : '')
                              }
                              title={
                                cell.unverified
                                  ? 'Imported from a report summary — not confirmed against a datasheet, and excluded from ranking.'
                                  : undefined
                              }
                            >
                              {isMpn && (
                                <span
                                  className={`lifecycle-dot${row.lifecycle === 'active' ? ' lifecycle-active' : ''}`}
                                />
                              )}
                              {cell.text}
                            </span>
                          ) : (
                            <span className="missing">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="statusbar">
          <span>{status?.componentCount ?? 0} components</span>
          <span>{status?.categoryCount ?? 0} categories</span>
          {status && status.dataQuality.unverifiedDimensions > 0 && (
            <span title="Dimensions parsed from report prose, awaiting confirmation">
              {status.dataQuality.unverifiedDimensions} unverified dimensions
            </span>
          )}
          {status && status.dataQuality.missingDimensions > 0 && (
            <span>{status.dataQuality.missingDimensions} missing dimensions</span>
          )}
          <span style={{ flex: 1 }} />
          {status?.warnings.map((w) => (
            <span key={w} style={{ color: 'var(--warn)' }}>{w}</span>
          ))}
        </div>
      </main>

      <Drawer component={component} open={openId !== null} onClose={() => setOpenId(null)} />
    </div>
  )
}
