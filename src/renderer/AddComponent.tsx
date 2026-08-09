import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CategoryNavItem, SpecFieldDef } from '../shared/ipc.js'

interface Props {
  readonly open: boolean
  readonly categories: readonly CategoryNavItem[]
  readonly initialCategory: string | null
  readonly onClose: () => void
  readonly onCreated: (id: number) => void
  /** Ask the drop zone to open a file picker. */
  readonly onPickPdf: () => void
}

const LIFECYCLES = ['unknown', 'active', 'nrnd', 'eol', 'obsolete'] as const

/**
 * Adding a component.
 *
 * The datasheet is the fast path and it leads: drop a PDF and the app reads it,
 * OCR-ing scanned pages, and fills everything in for you to approve. Typing it
 * all by hand is the fallback for a part with no datasheet to hand, so it starts
 * collapsed rather than being the first thing you see.
 */
export function AddComponent({
  open, categories, initialCategory, onClose, onCreated, onPickPdf,
}: Props): JSX.Element | null {
  const [manual, setManual] = useState(false)
  const [manufacturer, setManufacturer] = useState('')
  const [mpn, setMpn] = useState('')
  const [slug, setSlug] = useState(initialCategory ?? '')
  const [lifecycle, setLifecycle] = useState<(typeof LIFECYCLES)[number]>('unknown')
  const [datasheetUrl, setDatasheetUrl] = useState('')
  const [whereUsed, setWhereUsed] = useState('')
  const [packageName, setPackageName] = useState('')
  const [pins, setPins] = useState('')
  const [xMax, setXMax] = useState('')
  const [yMax, setYMax] = useState('')
  const [zMax, setZMax] = useState('')
  const [notes, setNotes] = useState('')
  const [specs, setSpecs] = useState<SpecFieldDef[]>([])
  const [specValues, setSpecValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState<{ id: number; mpn: string; manufacturer: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setSlug(initialCategory ?? '')
      setManual(false)
    }
  }, [open, initialCategory])

  useEffect(() => {
    if (!slug) {
      setSpecs([])
      return
    }
    void window.api.categorySpecs({ slug }).then(setSpecs)
  }, [slug])

  if (!open) return null

  const reset = (): void => {
    setManufacturer(''); setMpn(''); setLifecycle('unknown'); setDatasheetUrl('')
    setPackageName(''); setPins(''); setXMax(''); setYMax(''); setZMax('')
    setNotes(''); setWhereUsed(''); setSpecValues({}); setError(null); setDuplicate(null)
  }

  const num = (v: string): number | null => {
    const n = Number(v.trim())
    return v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null
  }

  const submit = async (): Promise<void> => {
    setError(null)
    setDuplicate(null)
    if (!manufacturer.trim() || !mpn.trim()) {
      setError('Manufacturer and part number are required.')
      return
    }
    setBusy(true)
    try {
      const result = await window.api.createComponent({
        manufacturer: manufacturer.trim(),
        mpn: mpn.trim(),
        categorySlug: slug || null,
        lifecycle,
        datasheetUrl: datasheetUrl.trim() || null,
        notes: notes.trim(),
        package: {
          name: packageName.trim() || null,
          pinCount: pins.trim() ? Number(pins) : null,
          xMax: num(xMax), yMax: num(yMax), zMax: num(zMax),
        },
      })

      if (!result.ok) {
        setDuplicate(result.duplicate)
        return
      }

      if (whereUsed.trim()) {
        await window.api.updateComponent({ id: result.id!, patch: { whereUsed: whereUsed.trim() } })
      }

      // Written after creation so one bad field cannot lose the whole entry.
      const problems: string[] = []
      for (const [key, raw] of Object.entries(specValues)) {
        if (!raw.trim()) continue
        const r = await window.api.setSpec({ componentId: result.id!, specKey: key, value: raw })
        if (!r.ok && r.error) problems.push(r.error)
      }
      if (problems.length > 0) setError(`Saved, but: ${problems.join(' ')}`)

      onCreated(result.id!)
      reset()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="scrim" data-open="true" onClick={onClose} aria-hidden />
      <div className="modal" role="dialog" aria-label="Add component">
        <div className="modal-head">
          <strong>Add component</strong>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <button
            className="drop-cta"
            onClick={() => { onClose(); onPickPdf() }}
          >
            <div className="drop-cta-icon" aria-hidden>⇩</div>
            <div>
              <div className="drop-cta-title">Drop or choose a datasheet PDF</div>
              <div className="hint">
                The app reads it — OCR-ing scanned pages — detects the part number, package,
                category, maximum dimensions, specifications and the externals it needs.
                You review and approve; nothing is saved until you do.
              </div>
            </div>
          </button>
          <div className="hint" style={{ textAlign: 'center', margin: '10px 0 2px' }}>
            You can also drop a PDF anywhere on the window at any time.
          </div>

          <button
            className="section-head"
            style={{ borderTop: '1px solid var(--border)', marginTop: 14 }}
            onClick={() => setManual((m) => !m)}
          >
            <span>{manual ? '▾' : '▸'} Enter it by hand instead</span>
            <span className="hint">for a part with no datasheet</span>
          </button>

          {manual && (
            <>
              <div className="field-grid" style={{ marginTop: 10 }}>
                <label>Manufacturer *</label>
                <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} placeholder="Texas Instruments" />

                <label>Part number *</label>
                <input className="mono" value={mpn} onChange={(e) => setMpn(e.target.value)} placeholder="TPS7A0233PYCHR" />

                <label>Category</label>
                <select value={slug} onChange={(e) => setSlug(e.target.value)}>
                  <option value="">— none —</option>
                  {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>

                <label>Lifecycle</label>
                <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as typeof lifecycle)}>
                  {LIFECYCLES.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>

                <label>Datasheet URL</label>
                <input value={datasheetUrl} onChange={(e) => setDatasheetUrl(e.target.value)} placeholder="https://…" />

                <label>Where used?</label>
                <input value={whereUsed} onChange={(e) => setWhereUsed(e.target.value)} placeholder="Sensor node rev C" />
              </div>

              <div className="section-title">
                Package — enter <b>maximum</b> dimensions where the datasheet gives them
              </div>
              <div className="field-grid">
                <label>Package name</label>
                <input value={packageName} onChange={(e) => setPackageName(e.target.value)} placeholder="DSBGA-4" />
                <label>Pins / balls</label>
                <input value={pins} onChange={(e) => setPins(e.target.value)} inputMode="numeric" placeholder="4" />
                <label>X max (mm)</label>
                <input value={xMax} onChange={(e) => setXMax(e.target.value)} inputMode="decimal" placeholder="0.665" />
                <label>Y max (mm)</label>
                <input value={yMax} onChange={(e) => setYMax(e.target.value)} inputMode="decimal" placeholder="0.665" />
                <label>Z max (mm)</label>
                <input value={zMax} onChange={(e) => setZMax(e.target.value)} inputMode="decimal" placeholder="0.36" />
              </div>

              {specs.length > 0 && (
                <>
                  <div className="section-title">
                    {categories.find((c) => c.slug === slug)?.name} specifications
                  </div>
                  <div className="field-grid">
                    {specs.map((s) => (
                      <FieldRow
                        key={s.key}
                        spec={s}
                        value={specValues[s.key] ?? ''}
                        onChange={(v) => setSpecValues((prev) => ({ ...prev, [s.key]: v }))}
                      />
                    ))}
                  </div>
                </>
              )}

              <div className="section-title">Notes</div>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Difficult layout, known errata, used successfully in Project X…" />
            </>
          )}

          {duplicate && (
            <div className="chip chip-warn" style={{ marginTop: 12, display: 'block' }}>
              {duplicate.manufacturer} {duplicate.mpn} already exists. Nothing was changed —
              open the existing part, or enter a different ordering code for the variant.
            </div>
          )}
          {error && <div className="chip chip-warn" style={{ marginTop: 12, display: 'block' }}>{error}</div>}
        </div>

        <div className="modal-foot">
          <span className="hint">
            {manual ? 'Only manufacturer and part number are required.' : 'A datasheet fills in everything for you.'}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          {manual && (
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
              Save component
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function FieldRow({
  spec, value, onChange,
}: {
  spec: SpecFieldDef
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  const label = spec.unit ? `${spec.label} (${spec.unit})` : spec.label
  if (spec.type === 'enum' && spec.enumValues) {
    return (
      <>
        <label title={spec.hint ?? undefined}>{label}</label>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— unknown —</option>
          {spec.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </>
    )
  }
  if (spec.type === 'bool') {
    return (
      <>
        <label title={spec.hint ?? undefined}>{label}</label>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— unknown —</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </>
    )
  }
  const placeholder =
    spec.type === 'range' ? `e.g. 1.5–5.5 ${spec.unit ?? ''}`.trim()
    : spec.unit ? `e.g. 25 ${spec.unit}`
    : ''
  return (
    <>
      <label title={spec.hint ?? undefined}>
        {label}
        {spec.unmapped && <span className="chip" style={{ marginLeft: 6 }}>needs typing</span>}
      </label>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </>
  )
}
