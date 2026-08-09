import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type {
  CategoryNavItem, IngestOutcomeDto, PackageVariantDto, ReviewFieldDto,
} from '../shared/ipc.js'

interface Props {
  readonly outcome: IngestOutcomeDto | null
  readonly categories: readonly CategoryNavItem[]
  readonly busy: boolean
  readonly onClose: () => void
  readonly onSaved: (componentId: number) => void
}

/**
 * The import review screen.
 *
 * Every extracted value is shown with the quote that supports it, highlighted in
 * the page it came from. Nothing is saved until you press Save, and anything you
 * edit is stored as a manual value rather than an extracted one.
 *
 * Values whose evidence failed verification are shown too — struck through and
 * off by default — because knowing what the model claimed and could not support
 * is more useful than silently dropping it.
 */
export function Review({ outcome, categories, busy, onClose, onSaved }: Props): JSX.Element | null {
  const [manufacturer, setManufacturer] = useState('')
  const [mpn, setMpn] = useState('')
  const [slug, setSlug] = useState('')
  const [whereUsed, setWhereUsed] = useState('')
  const [variantIndex, setVariantIndex] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [edited, setEdited] = useState<Record<string, boolean>>({})
  const [accepted, setAccepted] = useState<Record<string, boolean>>({})
  const [externalsOn, setExternalsOn] = useState<Record<number, boolean>>({})
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!outcome) return
    setManufacturer(outcome.identity?.manufacturer ?? '')
    setMpn(outcome.identity?.mpn ?? '')
    setSlug(outcome.identity?.categorySlug ?? '')
    setWhereUsed('')
    setVariantIndex(0)
    setError(null)

    const v: Record<string, string> = {}
    const a: Record<string, boolean> = {}
    for (const f of outcome.fields) {
      v[f.specKey] = f.rawValue ?? ''
      // Verified values start accepted; unverified ones start off.
      a[f.specKey] = f.verified
    }
    setValues(v)
    setAccepted(a)
    setEdited({})
    setExternalsOn(Object.fromEntries(outcome.externals.map((_, i) => [i, true])))
  }, [outcome])

  const chosenVariant: PackageVariantDto | null = useMemo(() => {
    if (!outcome) return null
    if (outcome.resolvedPackage) return outcome.resolvedPackage
    return outcome.packageVariants[variantIndex] ?? null
  }, [outcome, variantIndex])

  if (!outcome) return null

  const verifiedCount = outcome.fields.filter((f) => f.verified).length
  const rejectedCount = outcome.fields.filter((f) => !f.verified && f.status !== 'null-value').length
  const unknownCount = outcome.fields.filter((f) => f.status === 'null-value').length

  const save = (): void => {
    setError(null)
    if (!manufacturer.trim() || !mpn.trim()) {
      setError('Manufacturer and part number are required.')
      return
    }
    setSaving(true)

    const fields = outcome.fields
      .filter((f) => accepted[f.specKey] && (values[f.specKey] ?? '').trim() !== '')
      .map((f) => ({
        specKey: f.specKey,
        value: values[f.specKey] ?? '',
        page: f.page,
        evidence: f.evidence,
        confidence: f.confidence,
        edited: edited[f.specKey] === true,
      }))

    const externals = outcome.externals
      .filter((_, i) => externalsOn[i])
      .map((e) => ({
        name: e.name,
        function: e.function,
        qty: e.qty,
        necessity: e.necessity as 'required',
        valueText: e.valueText,
        packageName: e.packageName,
        xMm: e.xMm,
        yMm: e.yMm,
      }))

    void window.api
      .applyReview({
        jobId: outcome.jobId,
        componentId: null,
        identity: {
          manufacturer: manufacturer.trim(),
          mpn: mpn.trim(),
          categorySlug: slug || null,
          datasheetId: outcome.datasheetId,
          whereUsed: whereUsed.trim(),
        },
        package: chosenVariant
          ? {
              name: chosenVariant.name,
              pinCount: chosenVariant.pinCount,
              xMin: chosenVariant.xMin, xNom: chosenVariant.xNom, xMax: chosenVariant.xMax,
              yMin: chosenVariant.yMin, yNom: chosenVariant.yNom, yMax: chosenVariant.yMax,
              zMin: chosenVariant.zMin, zNom: chosenVariant.zNom, zMax: chosenVariant.zMax,
            }
          : null,
        fields,
        externals,
      })
      .then((r) => {
        setSaving(false)
        if (!r.ok) {
          setError(r.error ?? 'Could not save.')
          return
        }
        if (r.componentId !== null) onSaved(r.componentId)
      })
  }

  return (
    <div className="compare-overlay" role="dialog" aria-label="Review extracted data">
      <div className="compare-head">
        <strong>Review before saving</strong>
        <span className="chip">{verifiedCount} verified</span>
        {rejectedCount > 0 && <span className="chip chip-warn">{rejectedCount} unsupported</span>}
        {unknownCount > 0 && <span className="chip">{unknownCount} not found</span>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose} disabled={saving}>Discard</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || busy}>
          {saving ? 'Saving…' : 'Save component'}
        </button>
      </div>

      <div className="compare-body">
        <div className="pipeline">
          {outcome.stages.map((s) => (
            <div key={s.stage} className={`pipeline-step${s.ok ? '' : ' warn'}`}>
              <span className="pipeline-dot" />
              <div>
                <div className="pipeline-name">{s.stage.replace(/-/g, ' ')}</div>
                <div className="hint">{s.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {outcome.error && <div className="callout">{outcome.error}</div>}
        {outcome.needsOcr && (
          <div className="callout">
            Most pages have no text layer — this is a scanned document. Values below (if any)
            came from the pages that did have text. Run it through OCR and post the text via
            the local API for a full read.
          </div>
        )}
        {outcome.identity?.duplicate && (
          <div className="callout">
            {outcome.identity.duplicate.manufacturer} {outcome.identity.duplicate.mpn} is already
            in the library. Saving will be refused — change the part number to the exact ordering
            code of this variant, or close this and open the existing part.
          </div>
        )}

        <div className="section-title">Identity</div>
        <div className="field-grid">
          <label>Manufacturer *</label>
          <input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          <label>Part number *</label>
          <input className="mono" value={mpn} onChange={(e) => setMpn(e.target.value)} />
          <label>Category</label>
          <select value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">— none —</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <label title="Which of your boards or projects this part ships on">Where used?</label>
          <input
            value={whereUsed}
            onChange={(e) => setWhereUsed(e.target.value)}
            placeholder="Sensor node rev C — replaced the AP7350"
          />
        </div>

        {outcome.packageVariants.length > 0 && (
          <>
            <div className="section-title">
              Package
              {outcome.packageChoiceRequired && (
                <span className="chip chip-warn" style={{ marginLeft: 8 }}>
                  {outcome.packageVariants.length} variants — pick the one this part is
                </span>
              )}
            </div>
            <table className="param-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Variant</th>
                  <th>Ordering code</th>
                  <th className="num">Pins</th>
                  <th>Max dimensions</th>
                  <th className="num">Area</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {outcome.packageVariants.map((v, i) => {
                  const x = v.xMax ?? v.xNom
                  const y = v.yMax ?? v.yNom
                  const area = x !== null && y !== null ? x * y : null
                  const isMax = v.xMax !== null && v.yMax !== null
                  return (
                    <tr key={v.name + i}>
                      <td>
                        <input
                          type="radio"
                          name="variant"
                          checked={chosenVariant === v || variantIndex === i}
                          onChange={() => setVariantIndex(i)}
                        />
                      </td>
                      <td>{v.name}</td>
                      <td className="mono">{v.orderingCodeFragment ?? '—'}</td>
                      <td className="num">{v.pinCount ?? '—'}</td>
                      <td>
                        {x !== null && y !== null
                          ? `${x.toFixed(2)} × ${y.toFixed(2)}${v.zMax ? ` × ${v.zMax.toFixed(2)}` : ''} mm`
                          : <span className="missing">—</span>}
                        {!isMax && x !== null && (
                          <span className="chip" style={{ marginLeft: 6 }} title="Datasheet maximum not found; this is the nominal">
                            nominal
                          </span>
                        )}
                      </td>
                      <td className="num">{area === null ? '—' : `${area.toFixed(2)} mm²`}</td>
                      <td className="hint" style={{ maxWidth: 260, whiteSpace: 'normal' }}>
                        {v.evidence ? `p${v.page ?? '?'} · ${v.evidence.slice(0, 70)}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}

        <div className="section-title">Specifications</div>
        {outcome.fields.length === 0 ? (
          <div className="hint">Nothing was extracted. The datasheet and its text are saved.</div>
        ) : (
          <table className="param-table">
            <thead>
              <tr>
                <th style={{ width: 34 }} title="Include when saving">Use</th>
                <th>Parameter</th>
                <th style={{ width: 190 }}>Value</th>
                <th className="num" style={{ width: 60 }}>Conf.</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {outcome.fields.map((f) => (
                <FieldRow
                  key={f.specKey}
                  field={f}
                  value={values[f.specKey] ?? ''}
                  accepted={accepted[f.specKey] === true}
                  expanded={openEvidence === f.specKey}
                  onToggleAccept={() =>
                    setAccepted((p) => ({ ...p, [f.specKey]: !p[f.specKey] }))
                  }
                  onChange={(v) => {
                    setValues((p) => ({ ...p, [f.specKey]: v }))
                    setEdited((p) => ({ ...p, [f.specKey]: true }))
                  }}
                  onToggleEvidence={() =>
                    setOpenEvidence((p) => (p === f.specKey ? null : f.specKey))
                  }
                />
              ))}
            </tbody>
          </table>
        )}

        {outcome.externals.length > 0 && (
          <>
            <div className="section-title">
              Suggested externals — these drive the gross solution size
            </div>
            <table className="param-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }} />
                  <th>Part</th>
                  <th>Function</th>
                  <th className="num">Qty</th>
                  <th>Necessity</th>
                  <th>Size</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {outcome.externals.map((e, i) => (
                  <tr key={`${e.name}-${i}`} className={externalsOn[i] ? '' : 'excluded'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={externalsOn[i] === true}
                        onChange={() => setExternalsOn((p) => ({ ...p, [i]: !p[i] }))}
                      />
                    </td>
                    <td>{e.name}</td>
                    <td style={{ color: 'var(--text-dim)' }}>{e.function}</td>
                    <td className="num">{e.qty}</td>
                    <td><span className="dir-pill">{e.necessity}</span></td>
                    <td>
                      {e.xMm !== null && e.yMm !== null
                        ? `${e.xMm} × ${e.yMm} mm`
                        : <span className="missing">unknown</span>}
                    </td>
                    <td className="hint" style={{ maxWidth: 240, whiteSpace: 'normal' }}>
                      {e.evidence ? `p${e.page ?? '?'} · ${e.evidence.slice(0, 60)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 6 }}>
              An external with no dimensions is saved but not counted towards gross size.
            </div>
          </>
        )}

        {error && <div className="chip chip-warn" style={{ marginTop: 14, display: 'block' }}>{error}</div>}
      </div>
    </div>
  )
}

function FieldRow({
  field, value, accepted, expanded, onToggleAccept, onChange, onToggleEvidence,
}: {
  field: ReviewFieldDto
  value: string
  accepted: boolean
  expanded: boolean
  onToggleAccept: () => void
  onChange: (v: string) => void
  onToggleEvidence: () => void
}): JSX.Element {
  const notFound = field.status === 'null-value'
  return (
    <>
      <tr className={accepted ? '' : 'excluded'}>
        <td>
          <input
            type="checkbox"
            checked={accepted}
            disabled={notFound && value.trim() === ''}
            onChange={onToggleAccept}
            title={
              field.verified ? 'Verified against the datasheet'
              : notFound ? 'The model reported this as not found'
              : 'Evidence could not be verified — check it before including'
            }
          />
        </td>
        <td>
          {field.label}
          {field.unit && <span className="unit"> ({field.unit})</span>}
        </td>
        <td>
          <input
            value={value}
            placeholder={notFound ? 'not found — type it if you know it' : ''}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: '100%' }}
          />
        </td>
        <td className="num">
          <span className={field.verified ? '' : 'missing'}>
            {(field.confidence * 100).toFixed(0)}%
          </span>
        </td>
        <td>
          {field.evidence ? (
            <button
              className="linkbtn"
              onClick={onToggleEvidence}
              title={field.explanation}
              style={{ color: field.verified ? 'var(--good)' : 'var(--bad)' }}
            >
              {field.verified ? '✓' : '✕'} p{field.page ?? '?'} · {field.evidence.slice(0, 46)}
              {field.evidence.length > 46 ? '…' : ''}
            </button>
          ) : (
            <span className="hint">{field.explanation}</span>
          )}
        </td>
      </tr>
      {expanded && field.evidence && (
        <tr>
          <td />
          <td colSpan={4}>
            <div className="evidence-panel">
              <div className="hint" style={{ marginBottom: 6 }}>
                {field.explanation}
              </div>
              <pre className="evidence-text">
                {highlight(field.pageText ?? field.evidence, field.evidence)}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Show the quote in its surrounding page text, highlighted.
 *
 * Matching is normalized the same way the verifier normalizes, so a quote that
 * verified is a quote that highlights — otherwise the screen would claim
 * "verified" while failing to show you where.
 */
function highlight(pageText: string, evidence: string): JSX.Element[] {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase()
  const hay = norm(pageText)
  const needle = norm(evidence)
  const at = hay.indexOf(needle)

  if (at < 0) {
    return [<span key="none">{pageText.slice(0, 1200)}</span>]
  }

  // Map the normalized offset back onto the original text.
  let seen = 0
  let start = 0
  let end = pageText.length
  let prevSpace = false
  for (let i = 0; i < pageText.length; i++) {
    const ch = pageText[i]!
    const isSpace = /\s/.test(ch)
    if (isSpace && prevSpace) continue
    if (seen === at) start = i
    if (seen === at + needle.length) { end = i; break }
    seen++
    prevSpace = isSpace
  }

  const pad = 420
  const from = Math.max(0, start - pad)
  const to = Math.min(pageText.length, end + pad)

  return [
    <span key="before">{from > 0 ? '…' : ''}{pageText.slice(from, start)}</span>,
    <mark key="hit">{pageText.slice(start, end)}</mark>,
    <span key="after">{pageText.slice(end, to)}{to < pageText.length ? '…' : ''}</span>,
  ]
}
