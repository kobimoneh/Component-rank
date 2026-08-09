import { getDimension, lookupUnitLoose, type DimensionId } from './dimensions.js'
import { fromCanonical, type Quantity } from './quantity.js'

export interface FormatOptions {
  /** Force a display unit. Defaults to the quantity's own, then auto-scaling. */
  readonly unit?: string
  /** Fixed decimal places. Omit for significant-figure formatting. */
  readonly decimals?: number
  /** Significant figures when `decimals` is not given. */
  readonly significant?: number
  /** Render without the unit suffix (for table cells with a unit in the header). */
  readonly omitUnit?: boolean
}

/** Choose the unit that puts |value| in [1, 1000), preferring larger units on ties. */
export function autoScaleUnit(canonical: number, dimension: DimensionId): string {
  const dim = getDimension(dimension)
  if (dim.logarithmic || dim.units.length === 1) return dim.canonical
  const v = Math.abs(canonical)
  if (v === 0) return dim.canonical

  let best = dim.canonical
  let bestScore = Number.POSITIVE_INFINITY
  for (const unit of dim.units) {
    const scaled = v / unit.factor
    if (scaled <= 0) continue
    // Prefer 1 <= scaled < 1000; score by distance from that window.
    const score =
      scaled >= 1 && scaled < 1000
        ? Math.abs(Math.log10(scaled) - 1)
        : 100 + Math.abs(Math.log10(scaled) - 1)
    if (score < bestScore) {
      bestScore = score
      best = unit.symbol
    }
  }
  return best
}

function renderNumber(value: number, opts: FormatOptions): string {
  if (opts.decimals !== undefined) return value.toFixed(opts.decimals)
  const sig = opts.significant ?? 4
  if (value === 0) return '0'
  const rounded = Number(value.toPrecision(sig))
  // Avoid exponent notation for the magnitudes this app deals with.
  if (Math.abs(rounded) >= 1e-4 && Math.abs(rounded) < 1e7) {
    return String(rounded)
  }
  return rounded.toExponential(Math.max(0, sig - 1))
}

/**
 * Render a quantity for display.
 *
 * A range renders with an en dash (`1.5–5.5 V`); a one-sided range renders with the
 * bound operator (`≤ 6 mA`) so the missing side is visibly missing rather than
 * silently filled in.
 */
export function formatQuantity(q: Quantity, opts: FormatOptions = {}): string {
  const unit = opts.unit ?? q.displayUnit ?? autoScaleUnit(q.typ ?? q.max ?? q.min ?? 0, q.dimension)
  // A display unit from a foreign dimension is ignored rather than applied; the
  // canonical unit is always a truthful rendering of the stored number.
  const hit = lookupUnitLoose(unit, q.dimension)
  const resolved = hit && hit.dimension.id === q.dimension ? unit : getDimension(q.dimension).canonical
  const suffix = opts.omitUnit || resolved === '' ? '' : ` ${resolved}`
  const conv = (v: number): string => renderNumber(fromCanonical(v, resolved, q.dimension), opts)

  if (q.kind === 'scalar') {
    if (q.typ === null) return 'Unknown'
    return `${conv(q.typ)}${suffix}`
  }

  if (q.min !== null && q.max !== null) return `${conv(q.min)}–${conv(q.max)}${suffix}`
  if (q.max !== null) return `≤ ${conv(q.max)}${suffix}`
  if (q.min !== null) return `≥ ${conv(q.min)}${suffix}`
  if (q.typ !== null) return `${conv(q.typ)}${suffix}`
  return 'Unknown'
}

/** Auto-scaled rendering, ignoring the stored display unit. */
export function formatQuantityAuto(q: Quantity, opts: FormatOptions = {}): string {
  const anchor = q.typ ?? q.max ?? q.min ?? 0
  return formatQuantity(q, { ...opts, unit: autoScaleUnit(anchor, q.dimension) })
}
