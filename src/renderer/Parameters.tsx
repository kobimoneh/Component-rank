import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { DimensionDto, SpecDefDto } from '../shared/ipc.js'

interface Props {
  readonly open: boolean
  readonly slug: string | null
  readonly categoryName: string
  readonly onClose: () => void
  readonly onChanged: () => void
}

const TYPES = [
  { value: 'scalar', label: 'Number with a unit (25 µA)' },
  { value: 'range', label: 'Range with a unit (1.5–5.5 V)' },
  { value: 'number', label: 'Plain number (pin count)' },
  { value: 'bool', label: 'Yes / no' },
  { value: 'enum', label: 'One of a list' },
  { value: 'text', label: 'Free text' },
] as const

/**
 * Add, edit and remove a category's parameters — without a code change, which is
 * the whole point of the dynamic category system.
 *
 * Removing a parameter deletes the values components hold for it, so the count
 * is shown before you confirm, and the removal is recorded so a later re-import
 * does not quietly put it back.
 */
export function Parameters({ open, slug, categoryName, onClose, onChanged }: Props): JSX.Element | null {
  const [defs, setDefs] = useState<SpecDefDto[]>([])
  const [dims, setDims] = useState<DimensionDto[]>([])
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('scalar')
  const [dimension, setDimension] = useState('current')
  const [unit, setUnit] = useState('')
  const [better, setBetter] = useState<'lower' | 'higher' | 'none'>('none')
  const [choices, setChoices] = useState('')

  const load = useCallback((): void => {
    if (!slug) return
    void window.api.listSpecDefs({ slug }).then(setDefs)
  }, [slug])

  useEffect(() => {
    if (!open) return
    load()
    void window.api.dimensions().then(setDims)
  }, [open, load])

  // Keep the unit picker consistent with the chosen dimension. The functional
  // update means this does not need `unit` as a dependency.
  useEffect(() => {
    const d = dims.find((x) => x.id === dimension)
    if (!d || d.units.length === 0) return
    setUnit((current) => (d.units.includes(current) ? current : (d.units[0] ?? '')))
  }, [dimension, dims])

  if (!open || !slug) return null

  const needsDimension = type === 'scalar' || type === 'range'
  const activeDim = dims.find((d) => d.id === dimension)

  const add = (): void => {
    setError(null)
    void window.api
      .addSpecDef({
        slug,
        name,
        type,
        dimension: needsDimension ? dimension : null,
        unit: needsDimension ? unit || null : null,
        better,
        enumValues: type === 'enum'
          ? choices.split(',').map((c) => c.trim()).filter(Boolean)
          : null,
        tableVisible: true,
      })
      .then((r) => {
        if (!r.ok) {
          setError(r.error)
          return
        }
        setName(''); setChoices('')
        load()
        onChanged()
      })
  }

  const remove = (d: SpecDefDto): void => {
    const warning = d.valueCount > 0
      ? `Remove "${d.name}"? This deletes the values ${d.valueCount} component${d.valueCount === 1 ? ' holds' : 's hold'} for it. This cannot be undone.`
      : `Remove "${d.name}"? No component has a value for it yet.`
    if (!window.confirm(warning)) return
    void window.api.removeSpecDef({ slug, key: d.key }).then((r) => {
      if (!r.ok && r.error) setError(r.error)
      load()
      onChanged()
    })
  }

  const patch = (d: SpecDefDto, p: { tableVisible?: boolean; better?: 'lower' | 'higher' | 'none' }): void => {
    void window.api.updateSpecDef({ slug, key: d.key, patch: p }).then(() => {
      load()
      onChanged()
    })
  }

  return (
    <>
      <div className="scrim" data-open="true" onClick={onClose} aria-hidden />
      <div className="modal" role="dialog" aria-label="Category parameters">
        <div className="modal-head">
          <strong>Parameters — {categoryName}</strong>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <table className="param-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} title="Show as a column in the table">Col</th>
                <th>Parameter</th>
                <th>Type</th>
                <th>Unit</th>
                <th title="Which direction counts as better; drives ranking and the leaders strip">Better</th>
                <th className="num" title="Components holding a value">Values</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => (
                <tr key={d.key}>
                  <td>
                    <input
                      type="checkbox"
                      checked={d.tableVisible}
                      onChange={() => patch(d, { tableVisible: !d.tableVisible })}
                      title="Show as a table column"
                    />
                  </td>
                  <td>
                    {d.name}
                    {d.unmapped && (
                      <span className="chip" style={{ marginLeft: 6 }} title={d.sourcePhrase ?? ''}>
                        needs typing
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>{d.type}</td>
                  <td className="mono">{d.unit ?? '—'}</td>
                  <td>
                    <select
                      value={d.better}
                      onChange={(e) => patch(d, { better: e.target.value as 'lower' })}
                      title="Informational parameters are never ranked or coloured"
                      style={{ padding: '2px 5px' }}
                    >
                      <option value="none">informational</option>
                      <option value="lower">lower is better</option>
                      <option value="higher">higher is better</option>
                    </select>
                  </td>
                  <td className="num">{d.valueCount || '—'}</td>
                  <td>
                    <span className={`badge-src${d.source === 'local' ? ' badge-local' : ''}`}>
                      {d.source === 'local' ? 'yours' : d.locallyModified ? 'edited' : 'imported'}
                    </span>
                  </td>
                  <td>
                    <button className="linkbtn" title="Remove parameter" onClick={() => remove(d)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="section-title">Add a parameter</div>
          <div className="field-grid">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Thermal shutdown" />

            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>

            {needsDimension && (
              <>
                <label>Measures</label>
                <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
                  {dims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>

                <label>Display unit</label>
                <select value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {(activeDim?.units ?? []).map((u) => (
                    <option key={u} value={u}>{u || '(none)'}</option>
                  ))}
                </select>
              </>
            )}

            {type === 'enum' && (
              <>
                <label>Choices</label>
                <input
                  value={choices}
                  onChange={(e) => setChoices(e.target.value)}
                  placeholder="SAW, BAW, LTCC"
                />
              </>
            )}

            <label>Better</label>
            <select value={better} onChange={(e) => setBetter(e.target.value as typeof better)}>
              <option value="none">informational — never ranked or coloured</option>
              <option value="lower">lower is better</option>
              <option value="higher">higher is better</option>
            </select>
          </div>

          <div className="hint" style={{ marginTop: 8 }}>
            A numeric parameter needs a dimension so <code>0.5 mA</code> and <code>500 µA</code>{' '}
            stay comparable. Parameters you add are yours — a re-import never touches them.
          </div>

          {error && <div className="chip chip-warn" style={{ marginTop: 12, display: 'block' }}>{error}</div>}
        </div>

        <div className="modal-foot">
          <span className="hint">{defs.length} parameters · {defs.filter((d) => d.tableVisible).length} shown as columns</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Done</button>
          <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>Add parameter</button>
        </div>
      </div>
    </>
  )
}
