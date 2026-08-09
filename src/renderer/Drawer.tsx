import { Fragment, useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import type { ComponentDetail } from '../shared/ipc.js'

interface Props {
  readonly component: ComponentDetail | null
  readonly open: boolean
  readonly onClose: () => void
  /** Refetch after a mutation. */
  readonly onChanged: () => void
}

function area(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(2)} mm²`
}

function Section({
  title, children, defaultOpen = true, badge,
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
        <span>{open ? '▾' : '▸'} {title}</span>
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
export function Drawer({ component: c, open, onClose, onChanged }: Props): JSX.Element {
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
                <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  <button
                    className="btn"
                    title={c.favorite ? 'Remove from favourites' : 'Add to favourites'}
                    onClick={() => {
                      void window.api
                        .updateComponent({ id: c.id, patch: { favorite: !c.favorite } })
                        .then(onChanged)
                    }}
                  >
                    {c.favorite ? '★' : '☆'}
                  </button>
                  <button className="btn" onClick={onClose} title="Close (Esc)">✕</button>
                </div>
              </div>
              <div className="drawer-sub">
                {c.categoryName ?? 'No family'}
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
                    {s?.origin
                      ? <span className={`origin-tag origin-${s.origin}`}>{s.origin}</span>
                      : 'No solution profile yet'}
                  </div>
                </div>
              </div>

              {c.package.unverified && (
                <div className="callout">
                  <div>{c.package.unverifiedReason}</div>
                  <button
                    className="btn"
                    style={{ marginTop: 8 }}
                    onClick={() => { void window.api.confirmPackage({ id: c.id }).then(onChanged) }}
                  >
                    I checked the datasheet — confirm these dimensions
                  </button>
                  <div className="hint" style={{ marginTop: 6 }}>
                    Confirming makes this part eligible for ranking.
                  </div>
                </div>
              )}

              <Section title="Physical">
                <dl className="specs">
                  <dt>Dimensions</dt>
                  <dd className={c.package.unverified ? 'unverified' : ''}>{c.package.dimensionsText}</dd>
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

              <SolutionSection component={c} onChanged={onChanged} />

              <Section title="Family specifications" badge={String(c.specs.length)}>
                {c.specs.length > 0 ? (
                  <dl className="specs">
                    {c.specs.map((sp) => (
                      <Fragment key={sp.key}>
                        <dt>{sp.label}</dt>
                        <dd className={sp.unverified ? 'unverified' : ''}>
                          {sp.value ?? <span className="missing">Unknown</span>}
                          {sp.origin === 'extracted' && (
                            <sup className="prov" title="Extracted from a datasheet">•</sup>
                          )}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <div className="hint">
                    No specifications recorded. Seed data imports identity and datasheet links
                    only — specifications come from a datasheet, read by you or extracted.
                  </div>
                )}
              </Section>

              <Section title="Datasheet" defaultOpen={false}>
                {c.datasheetUrl
                  ? <a href={c.datasheetUrl} style={{ color: 'var(--accent)' }}>{c.datasheetUrl}</a>
                  : <span className="missing">No datasheet linked</span>}
                {c.price1k !== null && (
                  <div style={{ marginTop: 8, color: 'var(--text-dim)' }}>
                    Price @1k: ${c.price1k.toFixed(2)}
                  </div>
                )}
              </Section>

              <WhereUsed component={c} onChanged={onChanged} />

              <Section title="Notes" defaultOpen={false}>
                <pre className="notes">{c.notes || 'No notes.'}</pre>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  )
}

/**
 * "Where used?" — free text you fill in by hand.
 *
 * Deliberately not a relation to a projects table: the value is in writing
 * "Sensor node rev C, replaced the AP7350" in five seconds, and a schema would
 * get in the way of that. It is searchable, so "what did I use on the sensor
 * node?" is answerable.
 */
function WhereUsed({
  component: c, onChanged,
}: {
  component: ComponentDetail
  onChanged: () => void
}): JSX.Element {
  const [text, setText] = useState(c.whereUsed)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setText(c.whereUsed)
    setDirty(false)
  }, [c.id, c.whereUsed])

  const save = (): void => {
    if (!dirty) return
    void window.api
      .updateComponent({ id: c.id, patch: { whereUsed: text } })
      .then(() => {
        setDirty(false)
        onChanged()
      })
  }

  return (
    <Section title="Where used?" badge={c.whereUsed ? undefined : 'empty'}>
      <textarea
        rows={3}
        value={text}
        placeholder="Sensor node rev C · replaced the AP7350 · 4-layer only"
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
        onBlur={save}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span className="hint">Your boards, projects and revisions. Searchable.</span>
        <span style={{ flex: 1 }} />
        {dirty && <button className="btn" onClick={save}>Save</button>}
      </div>
    </Section>
  )
}

/** Solution size: the four measurements, the profile, and an editable BOM. */
function SolutionSection({
  component: c, onChanged,
}: {
  component: ComponentDetail
  onChanged: () => void
}): JSX.Element {
  const s = c.solution
  const [name, setName] = useState('')
  const [pkg, setPkg] = useState('')
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [qty, setQty] = useState('1')
  const [ow, setOw] = useState('')
  const [oh, setOh] = useState('')
  const [profileId, setProfileId] = useState<number | null>(null)

  const num = (v: string): number | null => {
    const n = Number(v.trim())
    return v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
  }

  const ensureProfile = async (): Promise<number> => {
    if (profileId !== null) return profileId
    const id = await window.api.createProfile({
      componentId: c.id, name: 'Recommended', makeDefault: true,
    })
    setProfileId(id)
    return id
  }

  if (!s.profileName) {
    return (
      <Section title="Solution size" badge="not defined">
        <div className="hint" style={{ marginBottom: 10 }}>
          Gross size stays unknown until you define what this part needs around it.
          The IC footprint is never reported as a solution size.
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            void window.api
              .createProfile({ componentId: c.id, name: 'Recommended', makeDefault: true })
              .then(onChanged)
          }}
        >
          Define a solution profile
        </button>
      </Section>
    )
  }

  return (
    <>
      <Section title="Solution size" badge={s.profileName}>
        <dl className="specs">
          <dt>A · IC area</dt><dd>{area(s.icAreaMm2)}</dd>
          <dt>B · Externals</dt><dd>{area(s.externalAreaMm2)}</dd>
          <dt>C · Gross component</dt><dd>{area(s.grossComponentAreaMm2)}</dd>
          <dt>D · Estimated PCB</dt><dd>{s.estimateText ?? '—'}</dd>
        </dl>

        <div className="override-row">
          <span className="hint">Override (if you have measured it):</span>
          <input placeholder="width" value={ow} onChange={(e) => setOw(e.target.value)} style={{ width: 66 }} />
          <span>×</span>
          <input placeholder="height" value={oh} onChange={(e) => setOh(e.target.value)} style={{ width: 66 }} />
          <span className="hint">mm</span>
          <button
            className="btn"
            onClick={() => {
              void (async () => {
                const id = await ensureProfile()
                const w = num(ow); const h = num(oh)
                if (w === null || h === null) return
                await window.api.setOverride({
                  profileId: id,
                  override: { widthMm: w, heightMm: h, areaMm2: null, note: null },
                })
                onChanged()
              })()
            }}
          >
            Set
          </button>
          {s.origin === 'manual' && (
            <button
              className="btn"
              onClick={() => {
                void (async () => {
                  const id = await ensureProfile()
                  await window.api.setOverride({ profileId: id, override: null })
                  setOw(''); setOh('')
                  onChanged()
                })()
              }}
            >
              Clear
            </button>
          )}
        </div>

        {s.warnings.map((w) => (
          <div key={w} className="chip chip-warn" style={{ marginTop: 8, display: 'block' }}>{w}</div>
        ))}
      </Section>

      <Section title="Externals" badge={String(s.externals.length)}>
        {s.externals.length > 0 && (
          <table className="ext-table">
            <thead>
              <tr>
                <th title="Include in the gross-size calculation" />
                <th>Part</th>
                <th className="num">Qty</th>
                <th>Package</th>
                <th className="num">Area</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.externals.map((e) => (
                <tr key={e.id} className={e.included ? '' : 'excluded'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={e.included}
                      title={e.included ? 'Counted in gross size' : 'Not counted'}
                      onChange={() => {
                        void window.api
                          .updateExternal({ id: e.id, patch: { included: !e.included } })
                          .then(onChanged)
                      }}
                    />
                  </td>
                  <td>{e.name}</td>
                  <td className="num">{e.qty}</td>
                  <td className="mono">{e.packageName ?? '—'}</td>
                  <td className="num">{e.areaMm2 === null ? '—' : e.areaMm2.toFixed(2)}</td>
                  <td>
                    <button
                      className="linkbtn"
                      title="Remove"
                      onClick={() => { void window.api.deleteExternal({ id: e.id }).then(onChanged) }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="ext-add">
          <input placeholder="10 µF cap" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="0402" value={pkg} onChange={(e) => setPkg(e.target.value)} style={{ width: 70 }} />
          <input placeholder="X" value={x} onChange={(e) => setX(e.target.value)} style={{ width: 54 }} />
          <input placeholder="Y" value={y} onChange={(e) => setY(e.target.value)} style={{ width: 54 }} />
          <input placeholder="qty" value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 46 }} />
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() => {
              void (async () => {
                const id = await ensureProfile()
                await window.api.addExternal({
                  profileId: id,
                  name: name.trim(),
                  packageName: pkg.trim() || null,
                  xMm: num(x),
                  yMm: num(y),
                  qty: Math.max(1, Number(qty) || 1),
                })
                setName(''); setPkg(''); setX(''); setY(''); setQty('1')
                onChanged()
              })()
            }}
          >
            Add
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          An external with no dimensions is listed but not counted, and says so.
        </div>
      </Section>
    </>
  )
}
