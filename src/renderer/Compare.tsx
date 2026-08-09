import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { CompareResult, CompareSizeDto } from '../shared/ipc.js'

interface Props {
  readonly result: CompareResult | null
  readonly onClose: () => void
}

type SizeMode = 'ic' | 'gross'

/**
 * Comparison: specifications as rows, parts as columns.
 *
 * Best and worst are tinted only where the specification says lower or higher is
 * better. An informational spec is never coloured — tinting "switching frequency"
 * would assert a preference the data does not support.
 */
export function Compare({ result, onClose }: Props): JSX.Element | null {
  const [onlyDifferences, setOnlyDifferences] = useState(false)
  const [sizeMode, setSizeMode] = useState<SizeMode>('ic')

  const rows = useMemo(
    () => (result ? result.rows.filter((r) => !onlyDifferences || r.differs) : []),
    [result, onlyDifferences],
  )

  if (!result) return null

  return (
    <div className="compare-overlay" role="dialog" aria-label="Compare components">
      <div className="compare-head">
        <strong>Comparing {result.components.length} parts</strong>
        {result.mixedCategories && (
          <span className="chip chip-warn">
            Mixed categories — only shared fields are shown
          </span>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={onlyDifferences}
            onChange={(e) => setOnlyDifferences(e.target.checked)}
          />
          Only differences
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Close</button>
      </div>

      <div className="compare-body">
        <SizeVisualization sizes={result.sizes} mode={sizeMode} onMode={setSizeMode} />

        <table className="grid compare-grid">
          <thead>
            <tr>
              <th style={{ minWidth: 190 }}>Specification</th>
              {result.components.map((c) => (
                <th key={c.id} className="num">
                  <div className="mono">{c.mpn}</div>
                  <div style={{ fontWeight: 400, color: 'var(--text-faint)' }}>{c.manufacturer}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  {row.label}
                  {row.unit && <span className="unit"> ({row.unit})</span>}
                  {row.better !== 'none' && (
                    <span className="better-hint" title={`${row.better} is better`}>
                      {row.better === 'lower' ? '↓' : '↑'}
                    </span>
                  )}
                </td>
                {row.values.map((v, i) => (
                  <td
                    key={i}
                    className={[
                      row.numeric ? 'num' : '',
                      v.best ? 'best' : '',
                      v.worst ? 'worst' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {v.text ? (
                      <span className={v.unverified ? 'unverified' : ''}>{v.text}</span>
                    ) : (
                      <span className="missing">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Scaled rectangles at one shared physical scale, so a 0.64 mm LDO next to a
 * 7 mm module is instantly obvious. Switching between package and gross solution
 * can reorder the parts entirely — which is the whole argument for the feature.
 */
function SizeVisualization({
  sizes, mode, onMode,
}: {
  sizes: readonly CompareSizeDto[]
  mode: SizeMode
  onMode: (m: SizeMode) => void
}): JSX.Element {
  const boxes = sizes.map((s) => {
    const w = mode === 'ic' ? s.icWidthMm : s.grossWidthMm
    const h = mode === 'ic' ? s.icHeightMm : s.grossHeightMm
    const area = mode === 'ic' ? s.icAreaMm2 : s.grossAreaMm2
    return { ...s, w, h, area }
  })

  const maxDim = Math.max(
    1,
    ...boxes.flatMap((b) => [b.w ?? 0, b.h ?? 0]),
  )
  // One scale for everything: that is the entire point.
  const PX_PER_MM = Math.min(38, 150 / maxDim)

  const drawable = boxes.filter((b) => b.w !== null && b.h !== null)

  return (
    <div className="sizeviz">
      <div className="sizeviz-head">
        <strong>Physical size</strong>
        <div className="seg">
          <button className={mode === 'ic' ? 'on' : ''} onClick={() => onMode('ic')}>Package</button>
          <button className={mode === 'gross' ? 'on' : ''} onClick={() => onMode('gross')}>
            Gross solution
          </button>
        </div>
        <span className="hint">Same scale · 1 mm = {PX_PER_MM.toFixed(0)} px</span>
      </div>

      {drawable.length === 0 ? (
        <div className="hint" style={{ padding: '12px 0' }}>
          {mode === 'gross'
            ? 'No solution profiles defined yet, so there is no gross size to draw.'
            : 'None of these parts has confirmed dimensions.'}
        </div>
      ) : (
        <div className="sizeviz-row">
          {boxes.map((b) => (
            <div key={b.id} className="sizeviz-item">
              <div className="sizeviz-canvas" style={{ height: maxDim * PX_PER_MM + 8 }}>
                {b.w !== null && b.h !== null ? (
                  <div
                    className={`sizeviz-rect${b.unverified && mode === 'ic' ? ' dashed' : ''}${
                      mode === 'gross' && b.grossOrigin === 'manual' ? ' manual' : ''
                    }`}
                    style={{ width: b.w * PX_PER_MM, height: b.h * PX_PER_MM }}
                    title={`${b.w.toFixed(2)} × ${b.h.toFixed(2)} mm`}
                  />
                ) : (
                  <div className="sizeviz-unknown">?</div>
                )}
              </div>
              <div className="sizeviz-label mono">{b.mpn}</div>
              <div className="sizeviz-area">
                {b.area === null ? '—' : `${b.area.toFixed(2)} mm²`}
                {b.unverified && mode === 'ic' && <span className="hint"> unverified</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
