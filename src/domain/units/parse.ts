import { lookupUnitLoose, type DimensionId } from './dimensions.js'
import { range, scalar, type Quantity } from './quantity.js'

/**
 * Resolve a unit, but only accept it when it belongs to the expected dimension.
 * Text naming a unit from the wrong dimension is not a value for this field, so
 * the parser reports "not a quantity" rather than converting across dimensions.
 */
function accepts(unit: string, preferred?: DimensionId): boolean {
  const hit = lookupUnitLoose(unit, preferred)
  if (!hit) return false
  return preferred === undefined || hit.dimension.id === preferred
}

/**
 * Parse datasheet-style quantity text into a typed Quantity.
 *
 * Returns null rather than guessing when the text does not clearly denote a
 * quantity. A null here means "not a number I understand" and the caller stores
 * the original text; it must never become a fabricated numeric.
 */

const NUMBER = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g

/** Range separators, longest first so `...` wins over `..`. */
const RANGE_SEPARATORS = ['...', '..', '–', '—', '~', ' to ', ' To ', ' TO ', '..', '-']

export interface ParseOptions {
  /** Expected dimension, used to disambiguate colliding unit symbols. */
  readonly preferred?: DimensionId
}

function normalize(input: string): string {
  return input
    .replace(/\u00A0/g, ' ')
    .replace(/μ/g, 'µ')
    .replace(/−/g, '-')
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .trim()
}

/** Split off a trailing unit token from a fragment like `5.5 V` or `500µA`. */
function splitUnit(fragment: string): { unit: string } {
  NUMBER.lastIndex = 0
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = NUMBER.exec(fragment)) !== null) last = m
  if (!last) return { unit: '' }
  return { unit: fragment.slice(last.index + last[0].length).trim() }
}

function numbersIn(text: string): number[] {
  NUMBER.lastIndex = 0
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = NUMBER.exec(text)) !== null) out.push(Number(m[0]))
  return out
}

export function parseQuantity(input: string, opts: ParseOptions = {}): Quantity | null {
  if (!input) return null
  const text = normalize(input)
  if (!text) return null

  // ±5 V  ->  -5 .. +5
  const plusMinus = /^[±+]\/?-?\s*(.+)$/.exec(text)
  if (text.startsWith('±') && plusMinus) {
    const body = plusMinus[1]
    if (body) {
      const nums = numbersIn(body)
      const { unit } = splitUnit(body)
      const n = nums[0]
      if (n !== undefined && unit && accepts(unit, opts.preferred)) {
        return range(-Math.abs(n), Math.abs(n), unit, { preferred: opts.preferred })
      }
    }
  }

  // Single-sided bounds: "< 6 mA", "≥ 5 V", "up to 200 mA", "min 1.8 V"
  const bound = /^(<=|>=|≤|≥|<|>|max\.?|min\.?|up\s+to|at\s+least)\s*(.+)$/i.exec(text)
  if (bound) {
    const op = (bound[1] ?? '').toLowerCase()
    const body = bound[2] ?? ''
    const nums = numbersIn(body)
    const { unit } = splitUnit(body)
    const n = nums[0]
    if (n !== undefined && unit && accepts(unit, opts.preferred)) {
      const isUpper = ['<', '<=', '≤', 'max', 'max.', 'up to'].includes(op)
      return isUpper
        ? range(null, n, unit, { preferred: opts.preferred })
        : range(n, null, unit, { preferred: opts.preferred })
    }
    return null
  }

  // Ranges: "1.5–5.5 V", "-40 to +85 °C", "1.8 V to 3.6 V"
  for (const sep of RANGE_SEPARATORS) {
    // A leading minus is a sign, not a separator, so only split on '-' when it sits
    // between a digit and a digit/sign with the left side already a complete number.
    const idx = sep === '-' ? findBareHyphen(text) : text.indexOf(sep)
    if (idx <= 0) continue
    const left = text.slice(0, idx).trim()
    const right = text.slice(idx + sep.length).trim()
    if (!left || !right) continue
    const leftNums = numbersIn(left)
    const rightNums = numbersIn(right)
    if (leftNums.length !== 1 || rightNums.length !== 1) continue
    const rightUnit = splitUnit(right).unit
    const leftUnit = splitUnit(left).unit
    const unit = rightUnit || leftUnit
    if (!unit) continue
    const hit = lookupUnitLoose(unit, opts.preferred)
    if (!hit || !accepts(unit, opts.preferred)) continue
    // If both sides name a unit they must agree on dimension.
    if (leftUnit && rightUnit) {
      const lh = lookupUnitLoose(leftUnit, opts.preferred)
      if (!lh || lh.dimension.id !== hit.dimension.id) continue
    }
    const lo = leftNums[0]
    const hi = rightNums[0]
    if (lo === undefined || hi === undefined) continue
    return range(Math.min(lo, hi), Math.max(lo, hi), unit, { preferred: opts.preferred })
  }

  // Plain scalar: "500 µA", "2.5mm", "-40 °C"
  const nums = numbersIn(text)
  if (nums.length !== 1) return null
  const { unit } = splitUnit(text)
  const value = nums[0]
  if (value === undefined) return null
  if (!unit) {
    // Bare number is only meaningful for dimensionless counts, and only when the
    // caller told us that is what it expects.
    if (opts.preferred === 'count') return scalar(value, '', 'count')
    return null
  }
  if (!accepts(unit, opts.preferred)) return null
  return scalar(value, unit, opts.preferred)
}

/** Index of a hyphen acting as a range separator rather than a sign. */
function findBareHyphen(text: string): number {
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== '-') continue
    const before = text.slice(0, i).trimEnd()
    const after = text.slice(i + 1).trimStart()
    if (!before || !after) continue
    if (!/[\d.]$/.test(before)) continue // left side must end a number…
    if (!/^[\d.+]/.test(after)) continue // …and right side must start one
    return i
  }
  return -1
}
