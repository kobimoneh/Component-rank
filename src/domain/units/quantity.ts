import {
  getDimension,
  lookupUnitLoose,
  type DimensionId,
  type DimensionDef,
} from './dimensions.js'

export type QuantityKind = 'scalar' | 'range'

/**
 * A numeric specification value.
 *
 * `min` / `typ` / `max` are always canonical for the dimension (see dimensions.ts).
 * `displayUnit` records how the user entered or prefers to see it and never
 * participates in comparison. A scalar populates `typ`; a range populates at least
 * one of `min` / `max` and may also carry a `typ`.
 */
export interface Quantity {
  readonly kind: QuantityKind
  readonly dimension: DimensionId
  readonly displayUnit: string
  readonly min: number | null
  readonly typ: number | null
  readonly max: number | null
}

export class UnitConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnitConversionError'
  }
}

function resolve(unit: string, preferred?: DimensionId): { dim: DimensionDef; factor: number } {
  const hit = lookupUnitLoose(unit, preferred)
  if (!hit) throw new UnitConversionError(`Unrecognised unit: "${unit}"`)
  // A caller that names the dimension it expects must get that dimension or an
  // error. Falling through to a symbol from some other dimension would apply a
  // foreign factor to the value and store it as if it were canonical — the exact
  // way "300 K" quietly becomes 300000 Ω.
  if (preferred && hit.dimension.id !== preferred) {
    throw new UnitConversionError(
      `Unit "${unit}" is ${hit.dimension.label}, but ${getDimension(preferred).label} was expected.`,
    )
  }
  return { dim: hit.dimension, factor: hit.unit.factor }
}

/** Convert a value expressed in `unit` into the dimension's canonical value. */
export function toCanonical(value: number, unit: string, preferred?: DimensionId): number {
  return value * resolve(unit, preferred).factor
}

/** Convert a canonical value into `unit`. */
export function fromCanonical(canonical: number, unit: string, preferred?: DimensionId): number {
  return canonical / resolve(unit, preferred).factor
}

/**
 * Convert between two units.
 *
 * Refuses across dimensions. In particular `dBm -> mW` throws: the maths exists but
 * applying it silently during ranking would compare a logarithmic reading against a
 * linear one, which is the class of plausible-wrong-number this app must not produce.
 * Callers that genuinely want it must convert explicitly and record that they did.
 */
export function convert(
  value: number,
  fromUnit: string,
  toUnit: string,
  preferred?: DimensionId,
): number {
  const from = resolve(fromUnit, preferred)
  const to = resolve(toUnit, preferred)
  if (from.dim.id !== to.dim.id) {
    const extra =
      from.dim.logarithmic || to.dim.logarithmic
        ? ' Logarithmic and linear units are never converted automatically.'
        : ''
    throw new UnitConversionError(
      `Cannot convert ${fromUnit} (${from.dim.label}) to ${toUnit} (${to.dim.label}).${extra}`,
    )
  }
  return (value * from.factor) / to.factor
}

export function scalar(value: number, unit: string, preferred?: DimensionId): Quantity {
  const { dim } = resolve(unit, preferred)
  return {
    kind: 'scalar',
    dimension: dim.id,
    displayUnit: unit,
    min: null,
    typ: toCanonical(value, unit, preferred),
    max: null,
  }
}

export function range(
  minValue: number | null,
  maxValue: number | null,
  unit: string,
  opts: { typ?: number | null; preferred?: DimensionId } = {},
): Quantity {
  const { dim } = resolve(unit, opts.preferred)
  return {
    kind: 'range',
    dimension: dim.id,
    displayUnit: unit,
    min: minValue === null ? null : toCanonical(minValue, unit, opts.preferred),
    typ: opts.typ === undefined || opts.typ === null ? null : toCanonical(opts.typ, unit, opts.preferred),
    max: maxValue === null ? null : toCanonical(maxValue, unit, opts.preferred),
  }
}

export type Representative = 'min' | 'typ' | 'max' | 'mid'

/**
 * Reduce a quantity to a single canonical number for sorting or ranking.
 *
 * Returns null when the requested aspect is absent — callers must decide how to
 * place missing data rather than receiving a substituted zero.
 */
export function representative(q: Quantity, pick: Representative = 'typ'): number | null {
  switch (pick) {
    case 'min':
      return q.min ?? q.typ ?? null
    case 'max':
      return q.max ?? q.typ ?? null
    case 'mid': {
      if (q.min !== null && q.max !== null) return (q.min + q.max) / 2
      return q.typ ?? q.min ?? q.max ?? null
    }
    case 'typ':
    default:
      return q.typ ?? (q.min !== null && q.max !== null ? (q.min + q.max) / 2 : (q.min ?? q.max))
  }
}

/**
 * "Show me parts that support at least X" — true when the quantity's upper bound
 * reaches `value`. A scalar is treated as its own bound.
 */
export function supportsAtLeast(q: Quantity, value: number, unit: string): boolean {
  const target = toCanonical(value, unit, q.dimension)
  const upper = q.max ?? q.typ
  return upper !== null && upper >= target
}

/** True when the quantity's lower bound reaches down to `value` or below. */
export function supportsAtMost(q: Quantity, value: number, unit: string): boolean {
  const target = toCanonical(value, unit, q.dimension)
  const lower = q.min ?? q.typ
  return lower !== null && lower <= target
}

/** True when `value` falls inside the quantity's span. */
export function covers(q: Quantity, value: number, unit: string): boolean {
  const target = toCanonical(value, unit, q.dimension)
  const lower = q.min ?? q.typ
  const upper = q.max ?? q.typ
  if (lower === null || upper === null) return false
  return target >= lower && target <= upper
}

/**
 * Compare two quantities of the same dimension. Throws across dimensions so a
 * mismatched sort surfaces as an error instead of an arbitrary ordering.
 */
export function compareQuantities(
  a: Quantity,
  b: Quantity,
  pick: Representative = 'typ',
): number {
  if (a.dimension !== b.dimension) {
    throw new UnitConversionError(
      `Cannot compare ${getDimension(a.dimension).label} with ${getDimension(b.dimension).label}.`,
    )
  }
  const av = representative(a, pick)
  const bv = representative(b, pick)
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return av - bv
}
