import { describe, it, expect } from 'vitest'
import {
  UnitConversionError,
  autoScaleUnit,
  compareQuantities,
  convert,
  covers,
  formatQuantity,
  formatQuantityAuto,
  parseQuantity,
  representative,
  scalar,
  supportsAtLeast,
  toCanonical,
} from '../src/domain/units/index.js'

describe('unit comparability (rule 2: numerics are never presentation strings)', () => {
  it('0.5 mA and 500 µA are the same number', () => {
    const a = parseQuantity('0.5 mA')
    const b = parseQuantity('500 µA')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.typ).toBeCloseTo(5e-4, 15)
    expect(b!.typ).toBeCloseTo(5e-4, 15)
    expect(compareQuantities(a!, b!)).toBe(0)
  })

  it('accepts all three micro signs used in datasheets', () => {
    const micro = parseQuantity('25 µA') // U+00B5
    const mu = parseQuantity('25 μA') // U+03BC
    const ascii = parseQuantity('25 uA')
    for (const q of [micro, mu, ascii]) {
      expect(q).not.toBeNull()
      expect(q!.typ).toBeCloseTo(25e-9 * 1000, 18)
    }
    expect(compareQuantities(micro!, ascii!)).toBe(0)
    expect(compareQuantities(mu!, ascii!)).toBe(0)
  })

  it('sorts a mixed-unit current column correctly', () => {
    const raw = ['1 mA', '25 nA', '500 µA', '2 A', '250 nA']
    const parsed = raw.map((r) => ({ raw: r, q: parseQuantity(r)! }))
    parsed.sort((x, y) => compareQuantities(x.q, y.q))
    expect(parsed.map((p) => p.raw)).toEqual(['25 nA', '250 nA', '500 µA', '1 mA', '2 A'])
  })
})

describe('logarithmic units refuse linear conversion', () => {
  it('dBm does not convert to mW', () => {
    expect(() => convert(10, 'dBm', 'mW')).toThrow(UnitConversionError)
    expect(() => convert(10, 'dBm', 'mW')).toThrow(/never converted automatically/i)
  })

  it('dB and dBm are different dimensions', () => {
    const gain = parseQuantity('12 dB')
    const power = parseQuantity('4 dBm')
    expect(gain!.dimension).toBe('ratio_log')
    expect(power!.dimension).toBe('power_log')
    expect(() => compareQuantities(gain!, power!)).toThrow(UnitConversionError)
  })

  it('refuses Kelvin rather than applying a factor to an offset scale', () => {
    expect(() => toCanonical(300, 'K', 'temperature')).toThrow(UnitConversionError)
  })
})

describe('a unit from the wrong dimension is an error, not a fallthrough', () => {
  // Regression: 'K' once resolved to the kΩ alias, so a 300 K temperature was
  // silently stored as 300000 Ω. A foreign unit must never supply the factor.
  it('throws when the resolved dimension is not the expected one', () => {
    expect(() => toCanonical(5, 'V', 'current')).toThrow(UnitConversionError)
    expect(() => toCanonical(5, 'V', 'current')).toThrow(/Voltage.*Current.*expected/i)
  })

  it('parses to null instead of converting across dimensions', () => {
    expect(parseQuantity('5 V', { preferred: 'current' })).toBeNull()
    expect(parseQuantity('300 K', { preferred: 'temperature' })).toBeNull()
    expect(parseQuantity('1.8–3.6 V', { preferred: 'frequency' })).toBeNull()
  })
})

describe('memory capacity uses binary prefixes (semiconductor convention)', () => {
  it('128 Mbit equals 16 MiB exactly', () => {
    const mbit = parseQuantity('128 Mbit', { preferred: 'data_size' })
    const mib = parseQuantity('16 MiB', { preferred: 'data_size' })
    expect(mbit!.typ).toBe(128 * 1024 * 1024)
    expect(mbit!.typ).toBe(mib!.typ)
  })

  it('line rate stays decimal', () => {
    const q = parseQuantity('100 Mbps', { preferred: 'data_rate' })
    expect(q!.typ).toBe(1e8)
  })
})

describe('ranges (spec section 33)', () => {
  it('parses an en-dash range', () => {
    const q = parseQuantity('1.5–5.5 V')
    expect(q!.kind).toBe('range')
    expect(q!.min).toBe(1.5)
    expect(q!.max).toBe(5.5)
  })

  it('parses a signed temperature range', () => {
    const q = parseQuantity('-40 to +85 °C')
    expect(q!.min).toBe(-40)
    expect(q!.max).toBe(85)
  })

  it('answers "supports at least 5 V input"', () => {
    const wide = parseQuantity('1.5–5.5 V')!
    const narrow = parseQuantity('1.8–3.6 V')!
    expect(supportsAtLeast(wide, 5, 'V')).toBe(true)
    expect(supportsAtLeast(narrow, 5, 'V')).toBe(false)
    expect(covers(wide, 3.3, 'V')).toBe(true)
    expect(covers(narrow, 5, 'V')).toBe(false)
  })

  it('parses one-sided bounds and keeps the missing side missing', () => {
    const upper = parseQuantity('< 6 mA')!
    expect(upper.max).toBeCloseTo(6e-3, 15)
    expect(upper.min).toBeNull()
    expect(formatQuantity(upper, { unit: 'mA' })).toBe('≤ 6 mA')

    const lower = parseQuantity('≥ 5 V')!
    expect(lower.min).toBe(5)
    expect(lower.max).toBeNull()
    expect(formatQuantity(lower)).toBe('≥ 5 V')
  })

  it('does not mistake a negative sign for a range separator', () => {
    const q = parseQuantity('-40 °C')!
    expect(q.kind).toBe('scalar')
    expect(q.typ).toBe(-40)
  })
})

describe('refusal rather than guessing', () => {
  it('returns null for text that is not a quantity', () => {
    expect(parseQuantity('Cortex-M33')).toBeNull()
    expect(parseQuantity('QFN-24')).toBeNull()
    expect(parseQuantity('')).toBeNull()
    expect(parseQuantity('yes')).toBeNull()
  })

  it('returns null for a bare number when no dimension is expected', () => {
    expect(parseQuantity('42')).toBeNull()
    expect(parseQuantity('42', { preferred: 'count' })!.typ).toBe(42)
  })
})

describe('formatting', () => {
  it('auto-scales to a readable unit', () => {
    expect(autoScaleUnit(2.5e-8, 'current')).toBe('nA')
    expect(autoScaleUnit(5e-4, 'current')).toBe('µA')
    expect(formatQuantityAuto(scalar(25, 'nA'))).toBe('25 nA')
  })

  it('honours fixed decimals for physical dimensions', () => {
    expect(formatQuantity(scalar(2.5, 'mm'), { decimals: 2 })).toBe('2.50 mm')
  })

  it('renders Unknown rather than zero for an empty quantity', () => {
    expect(formatQuantity({ kind: 'scalar', dimension: 'current', displayUnit: 'A', min: null, typ: null, max: null })).toBe('Unknown')
  })
})

describe('representative values for ranking', () => {
  it('returns null instead of substituting zero when the aspect is absent', () => {
    // "≥ 5 V" has no upper bound. Reporting 5 as the max would invent a ceiling
    // the datasheet never stated, so the honest answer is null.
    const q = parseQuantity('≥ 5 V')!
    expect(representative(q, 'max')).toBeNull()
    expect(representative(q, 'min')).toBe(5)
    const empty = { kind: 'range' as const, dimension: 'voltage' as const, displayUnit: 'V', min: null, typ: null, max: null }
    expect(representative(empty, 'typ')).toBeNull()
  })

  it('places missing values last when sorting', () => {
    const known = scalar(1, 'mA')
    const unknown = { kind: 'scalar' as const, dimension: 'current' as const, displayUnit: 'mA', min: null, typ: null, max: null }
    expect(compareQuantities(known, unknown)).toBeLessThan(0)
    expect(compareQuantities(unknown, known)).toBeGreaterThan(0)
  })
})
