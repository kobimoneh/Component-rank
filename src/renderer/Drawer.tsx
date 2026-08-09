import { Fragment, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { ComponentDetail } from '../shared/ipc.js'

interface Props {
  readonly component: ComponentDetail | null
  readonly open: boolean
  readonly onClose: () => void
}

function area(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(2)} mm²`
}

function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  badge?: string
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section">
      <button className="section-head" onClick={() => setOpen((o) => !o)}>
        <span>
          {open ? '▾' : '▸'} {title}
        </span>
        {badge && <span className="chip">{badge}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

/**
 * The only detail surface. It slides over the table rather than navigating away,
 * so the sort, filters and selection you built survive — and j/k keep walking
 * rows with it open.
 */
export function Drawer({ component, open, onClose }: Props): JSX.Element {
  const c = component
  const s = c?.solution

  return (
    <>
      <div
        className="scrim"
        data-open={open}
        style={{ pointerEvents: open ? 'auto' : 'none' }}
        onClick={onClose}
        aria-hidden
      />
      <aside className="drawer" data-open={open} aria-hidden={!open}>
        {c && (
          <>
            <div className="drawer-head">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="drawer-mfr">{c.manufacturer}</div>
                  <div className="drawer-mpn">{c.mpn}</div>
                </div>
                <button className="btn" onClick={onClose} title="Close (Esc)">
                  ✕
                </button>
              </div>
              <div className="drawer-sub">
                {c.categoryName ?? 'Uncategorised'}
                {c.package.name ? ` · ${c.package.name}` : ''}
                {c.package.dimensionsText !== 'Unknown' ? ` · ${c.package.dimensionsText}` : ''}
                {c.package.basis ? ` (${c.package.basis})` : ''}
              </div>
            </div>

            <div className="drawer-body">
              <div className="headline-grid">
                <div className="headline-cell">
                  <div className="headline-label">IC area</div>
                  <div className={`headline-value${c.package.unverified ? ' unverified' : ''}`}>
                    {area(c.package.icAreaMm2)}
                  </div>
                  <div className="headline-note">
                    {c.package.unverified
                      ? 'Unverified — from a report summary'
                      : c.package.basis
                        ? `${c.package.basis} dimensions`
                        : 'No dimensions'}
                  </div>
                </div>
                <div className="headline-cell">
                  <div className="headline-label">Gross solution</div>
                  <div className="headline-value">{area(s?.effectiveAreaMm2 ?? null)}</div>
                  <div className="headline-note">
                    {s?.origin ? (
                      <span className={`origin-tag origin-${s.origin}`}>{s.origin}</span>
                    ) : (
                      'No solution profile yet'
                    )}
                  </div>
                </div>
              </div>

              {c.package.unverified && c.package.unverifiedReason && (
                <div className="chip chip-warn" style={{ marginBottom: 12 }}>
                  {c.package.unverifiedReason}
                </div>
              )}

              <Section title="Physical">
                <dl className="specs">
                  <dt>Dimensions</dt>
                  <dd className={c.package.unverified ? 'unverified' : ''}>
                    {c.package.dimensionsText}
                  </dd>
                  <dt>Basis</dt>
                  <dd>{c.package.basis ?? '—'}</dd>
                  <dt>IC area</dt>
                  <dd>{area(c.package.icAreaMm2)}</dd>
                  <dt>Package</dt>
                  <dd>{c.package.name ?? c.package.type ?? '—'}</dd>
                  <dt>Pins / balls</dt>
                  <dd>{c.package.pinCount ?? '—'}</dd>
                </dl>
              </Section>

              <Section title="Solution size" badge={s?.profileName ?? 'not defined'}>
                {s && s.profileName ? (
                  <dl className="specs">
                    <dt>A · IC area</dt>
                    <dd>{area(s.icAreaMm2)}</dd>
                    <dt>B · Externals</dt>
                    <dd>{area(s.externalAreaMm2)}</dd>
                    <dt>C · Gross component</dt>
                    <dd>{area(s.grossComponentAreaMm2)}</dd>
                    <dt>D · Estimated PCB</dt>
                    <dd>{s.estimateText ?? '—'}</dd>
                  </dl>
                ) : (
                  <div style={{ color: 'var(--text-faint)' }}>
                    No solution profile defined. Gross size stays unknown rather than
                    reporting the IC footprint as a solution size.
                  </div>
                )}
                {s?.warnings.map((w) => (
                  <div key={w} className="chip chip-warn" style={{ marginTop: 8 }}>
                    {w}
                  </div>
                ))}
              </Section>

              <Section title="Externals" badge={String(s?.externals.length ?? 0)}>
                {s && s.externals.length > 0 ? (
                  <table className="ext-table">
                    <thead>
                      <tr>
                        <th />
                        <th>Part</th>
                        <th>Function</th>
                        <th className="num">Qty</th>
                        <th>Package</th>
                        <th className="num">Area</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.externals.map((e) => (
                        <tr key={e.id}>
                          <td>
                            <input type="checkbox" checked={e.included} readOnly />
                          </td>
                          <td>{e.name}</td>
                          <td style={{ color: 'var(--text-dim)' }}>{e.function}</td>
                          <td className="num">{e.qty}</td>
                          <td className="mono">{e.packageName ?? '—'}</td>
                          <td className="num">{e.areaMm2 === null ? '—' : e.areaMm2.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ color: 'var(--text-faint)' }}>
                    No required externals recorded yet.
                  </div>
                )}
              </Section>

              <Section title="Category specifications" badge={String(c.specs.length)}>
                {c.specs.length > 0 ? (
                  <dl className="specs">
                    {c.specs.map((sp) => (
                      <Fragment key={sp.key}>
                        <dt>{sp.label}</dt>
                        <dd className={sp.unverified ? 'unverified' : ''}>
                          {sp.value ?? <span className="missing">Unknown</span>}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <div style={{ color: 'var(--text-faint)' }}>
                    No specifications recorded. Seed data imports identity and datasheet
                    links only — specifications come from a datasheet extraction.
                  </div>
                )}
              </Section>

              <Section title="Datasheet" defaultOpen={false}>
                {c.datasheetUrl ? (
                  <a href={c.datasheetUrl} style={{ color: 'var(--accent)' }}>
                    {c.datasheetUrl}
                  </a>
                ) : (
                  <span className="missing">No datasheet linked</span>
                )}
                {c.price1k !== null && (
                  <div style={{ marginTop: 8, color: 'var(--text-dim)' }}>
                    Price @1k: ${c.price1k.toFixed(2)}
                  </div>
                )}
              </Section>

              <Section title="Notes" defaultOpen={false}>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                    font: 'inherit',
                    color: 'var(--text-dim)',
                  }}
                >
                  {c.notes || 'No notes.'}
                </pre>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
