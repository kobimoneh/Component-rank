/**
 * Dimension registry.
 *
 * Every numeric specification in the database is stored as a canonical value plus
 * the unit it was entered in. Filtering, sorting and ranking read the canonical
 * value only, so `0.5 mA` and `500 µA` are the same number to the engine.
 *
 * Two deliberate departures from naive SI:
 *
 *  - Canonical length is **mm** and canonical area is **mm²**, not metres. This app
 *    is about PCB real estate; storing 2.5 rather than 0.0025 keeps the SQLite file
 *    readable when you open it yourself, which is a stated requirement.
 *
 *  - Logarithmic units live in their own dimensions. `dBm` (power_log) and `dB`
 *    (ratio_log) are not the same dimension and neither is `power`, so a dBm value
 *    can never be silently converted into mW during ranking. That conversion is
 *    mathematically defined but semantically wrong to apply automatically, and the
 *    dimension check refuses it for us.
 */

export type DimensionId =
  | 'length'
  | 'area'
  | 'voltage'
  | 'current'
  | 'power'
  | 'resistance'
  | 'capacitance'
  | 'inductance'
  | 'frequency'
  | 'time'
  | 'temperature'
  | 'data_size'
  | 'data_rate'
  | 'ratio_log'
  | 'power_log'
  | 'ratio'
  | 'count'

export interface UnitDef {
  /** Canonical display symbol. */
  readonly symbol: string
  /** Multiply a value in this unit by `factor` to get the dimension's canonical value. */
  readonly factor: number
  /** Alternative spellings accepted by the parser (matched case-insensitively). */
  readonly aliases?: readonly string[]
}

export interface DimensionDef {
  readonly id: DimensionId
  readonly label: string
  readonly canonical: string
  readonly units: readonly UnitDef[]
  /**
   * Logarithmic dimensions carry no SI prefixes and never convert across
   * dimensions. Present so callers can explain the refusal to the user.
   */
  readonly logarithmic?: boolean
  /**
   * Capacity prefixes are powers of 1024, following semiconductor convention:
   * a "128 Mbit" flash is 128 x 2^20 bits = 16 MiB exactly, not 1.28e8 bits.
   */
  readonly binaryPrefixes?: boolean
}

const KI = 1024
const MI = KI * KI
const GI = MI * KI
const TI = GI * KI

export const DIMENSIONS: readonly DimensionDef[] = [
  {
    id: 'length',
    label: 'Length',
    canonical: 'mm',
    units: [
      { symbol: 'nm', factor: 1e-6 },
      { symbol: 'µm', factor: 1e-3, aliases: ['um', 'μm', 'micron', 'microns'] },
      { symbol: 'mm', factor: 1 },
      { symbol: 'cm', factor: 10 },
      { symbol: 'm', factor: 1000 },
      { symbol: 'mil', factor: 0.0254, aliases: ['mils', 'thou'] },
      { symbol: 'in', factor: 25.4, aliases: ['inch', 'inches', '"'] },
    ],
  },
  {
    id: 'area',
    label: 'Area',
    canonical: 'mm²',
    units: [
      { symbol: 'µm²', factor: 1e-6, aliases: ['um^2', 'um2', 'µm^2', 'μm²'] },
      { symbol: 'mm²', factor: 1, aliases: ['mm^2', 'mm2', 'sqmm'] },
      { symbol: 'cm²', factor: 100, aliases: ['cm^2', 'cm2'] },
      { symbol: 'm²', factor: 1e6, aliases: ['m^2', 'm2'] },
    ],
  },
  {
    id: 'voltage',
    label: 'Voltage',
    canonical: 'V',
    units: [
      { symbol: 'nV', factor: 1e-9 },
      { symbol: 'µV', factor: 1e-6, aliases: ['uV', 'μV'] },
      { symbol: 'mV', factor: 1e-3 },
      { symbol: 'V', factor: 1, aliases: ['volt', 'volts', 'Vdc', 'VDC'] },
      { symbol: 'kV', factor: 1e3 },
    ],
  },
  {
    id: 'current',
    label: 'Current',
    canonical: 'A',
    units: [
      { symbol: 'pA', factor: 1e-12 },
      { symbol: 'nA', factor: 1e-9 },
      { symbol: 'µA', factor: 1e-6, aliases: ['uA', 'μA'] },
      { symbol: 'mA', factor: 1e-3 },
      { symbol: 'A', factor: 1, aliases: ['amp', 'amps', 'ampere'] },
    ],
  },
  {
    id: 'power',
    label: 'Power',
    canonical: 'W',
    units: [
      { symbol: 'nW', factor: 1e-9 },
      { symbol: 'µW', factor: 1e-6, aliases: ['uW', 'μW'] },
      { symbol: 'mW', factor: 1e-3 },
      { symbol: 'W', factor: 1, aliases: ['watt', 'watts'] },
      { symbol: 'kW', factor: 1e3 },
    ],
  },
  {
    id: 'resistance',
    label: 'Resistance',
    canonical: 'Ω',
    units: [
      { symbol: 'µΩ', factor: 1e-6, aliases: ['uohm', 'uΩ', 'μΩ'] },
      { symbol: 'mΩ', factor: 1e-3, aliases: ['mohm', 'mOhm'] },
      { symbol: 'Ω', factor: 1, aliases: ['ohm', 'ohms'] },
      // No bare 'K' alias: it collides with Kelvin and would turn a temperature
      // into a resistance. Resistor shorthand ("4K7") is a separate notation.
      { symbol: 'kΩ', factor: 1e3, aliases: ['kohm', 'kOhm'] },
      { symbol: 'MΩ', factor: 1e6, aliases: ['Mohm', 'MOhm'] },
      { symbol: 'GΩ', factor: 1e9, aliases: ['Gohm'] },
    ],
  },
  {
    id: 'capacitance',
    label: 'Capacitance',
    canonical: 'F',
    units: [
      { symbol: 'fF', factor: 1e-15 },
      { symbol: 'pF', factor: 1e-12 },
      { symbol: 'nF', factor: 1e-9 },
      { symbol: 'µF', factor: 1e-6, aliases: ['uF', 'μF'] },
      { symbol: 'mF', factor: 1e-3 },
      { symbol: 'F', factor: 1, aliases: ['farad'] },
    ],
  },
  {
    id: 'inductance',
    label: 'Inductance',
    canonical: 'H',
    units: [
      { symbol: 'pH', factor: 1e-12 },
      { symbol: 'nH', factor: 1e-9 },
      { symbol: 'µH', factor: 1e-6, aliases: ['uH', 'μH'] },
      { symbol: 'mH', factor: 1e-3 },
      { symbol: 'H', factor: 1, aliases: ['henry'] },
    ],
  },
  {
    id: 'frequency',
    label: 'Frequency',
    canonical: 'Hz',
    units: [
      { symbol: 'Hz', factor: 1, aliases: ['hertz'] },
      { symbol: 'kHz', factor: 1e3, aliases: ['KHz'] },
      { symbol: 'MHz', factor: 1e6 },
      { symbol: 'GHz', factor: 1e9 },
    ],
  },
  {
    id: 'time',
    label: 'Time',
    canonical: 's',
    units: [
      { symbol: 'fs', factor: 1e-15 },
      { symbol: 'ps', factor: 1e-12 },
      { symbol: 'ns', factor: 1e-9 },
      { symbol: 'µs', factor: 1e-6, aliases: ['us', 'μs'] },
      { symbol: 'ms', factor: 1e-3 },
      { symbol: 's', factor: 1, aliases: ['sec', 'second', 'seconds'] },
    ],
  },
  {
    // Kelvin is deliberately absent: it differs from °C by an offset, not a factor,
    // and this registry is multiplicative. Refusing is better than a 273.15 error.
    id: 'temperature',
    label: 'Temperature',
    canonical: '°C',
    units: [{ symbol: '°C', factor: 1, aliases: ['C', 'degC', 'celsius'] }],
  },
  {
    id: 'data_size',
    label: 'Capacity',
    canonical: 'bit',
    binaryPrefixes: true,
    units: [
      { symbol: 'bit', factor: 1, aliases: ['b', 'bits'] },
      { symbol: 'kbit', factor: KI, aliases: ['Kb', 'kb', 'Kbit', 'Kibit'] },
      { symbol: 'Mbit', factor: MI, aliases: ['Mb', 'mbit', 'Mibit'] },
      { symbol: 'Gbit', factor: GI, aliases: ['Gb', 'gbit', 'Gibit'] },
      { symbol: 'Tbit', factor: TI, aliases: ['Tb', 'tbit'] },
      { symbol: 'byte', factor: 8, aliases: ['B', 'bytes'] },
      { symbol: 'KiB', factor: 8 * KI, aliases: ['KB', 'kB', 'kbyte', 'Kbyte'] },
      { symbol: 'MiB', factor: 8 * MI, aliases: ['MB', 'mbyte', 'Mbyte'] },
      { symbol: 'GiB', factor: 8 * GI, aliases: ['GB', 'gbyte', 'Gbyte'] },
      { symbol: 'TiB', factor: 8 * TI, aliases: ['TB'] },
    ],
  },
  {
    // Line rates are decimal by convention, unlike capacity above.
    id: 'data_rate',
    label: 'Data rate',
    canonical: 'bit/s',
    units: [
      { symbol: 'bit/s', factor: 1, aliases: ['bps', 'bit/sec'] },
      { symbol: 'kbit/s', factor: 1e3, aliases: ['kbps', 'Kbps'] },
      { symbol: 'Mbit/s', factor: 1e6, aliases: ['Mbps'] },
      { symbol: 'Gbit/s', factor: 1e9, aliases: ['Gbps'] },
    ],
  },
  {
    id: 'ratio_log',
    label: 'Ratio (log)',
    canonical: 'dB',
    logarithmic: true,
    units: [{ symbol: 'dB', factor: 1 }],
  },
  {
    id: 'power_log',
    label: 'Power (log)',
    canonical: 'dBm',
    logarithmic: true,
    units: [{ symbol: 'dBm', factor: 1 }],
  },
  {
    id: 'ratio',
    label: 'Ratio',
    canonical: '%',
    units: [
      { symbol: '%', factor: 1, aliases: ['percent', 'pct'] },
      { symbol: 'ppm', factor: 1e-4 },
    ],
  },
  {
    id: 'count',
    label: 'Count',
    canonical: '',
    units: [{ symbol: '', factor: 1, aliases: ['pcs', 'ea', 'x'] }],
  },
] as const

const BY_ID = new Map<DimensionId, DimensionDef>(DIMENSIONS.map((d) => [d.id, d]))

export function getDimension(id: DimensionId): DimensionDef {
  const d = BY_ID.get(id)
  if (!d) throw new Error(`Unknown dimension: ${id}`)
  return d
}

/**
 * Normalize a unit token for lookup.
 *
 * Handles the two micro signs that occur in the wild — U+00B5 MICRO SIGN and
 * U+03BC GREEK SMALL LETTER MU look identical but are different code points, and
 * datasheet copy-paste produces both — plus the ASCII `u` substitute.
 */
export function normalizeUnitToken(raw: string): string {
  return raw
    .trim()
    .replace(/μ/g, 'µ')
    .replace(/Ω/g, 'Ω')
    .replace(/\s+/g, '')
}

export interface UnitLookup {
  readonly dimension: DimensionDef
  readonly unit: UnitDef
}

/**
 * Resolve a unit symbol to its dimension.
 *
 * Ambiguity is resolved by passing `preferred`. Without it, `m` (metre) and `b`
 * (bit) style collisions resolve to the first registered match, so callers that
 * know the expected dimension should always say so.
 */
export function lookupUnit(raw: string, preferred?: DimensionId): UnitLookup | null {
  const token = normalizeUnitToken(raw)
  const search = (dim: DimensionDef): UnitLookup | null => {
    for (const unit of dim.units) {
      if (normalizeUnitToken(unit.symbol) === token) return { dimension: dim, unit }
    }
    for (const unit of dim.units) {
      for (const alias of unit.aliases ?? []) {
        if (normalizeUnitToken(alias) === token) return { dimension: dim, unit }
      }
    }
    return null
  }

  if (preferred) {
    const hit = search(getDimension(preferred))
    if (hit) return hit
  }
  for (const dim of DIMENSIONS) {
    const hit = search(dim)
    if (hit) return hit
  }
  return null
}

/** Case-insensitive fallback, used only after the exact pass fails. */
export function lookupUnitLoose(raw: string, preferred?: DimensionId): UnitLookup | null {
  const exact = lookupUnit(raw, preferred)
  if (exact) return exact
  const token = normalizeUnitToken(raw).toLowerCase()
  const search = (dim: DimensionDef): UnitLookup | null => {
    for (const unit of dim.units) {
      const candidates = [unit.symbol, ...(unit.aliases ?? [])]
      for (const c of candidates) {
        if (normalizeUnitToken(c).toLowerCase() === token) return { dimension: dim, unit }
      }
    }
    return null
  }
  if (preferred) {
    const hit = search(getDimension(preferred))
    if (hit) return hit
  }
  for (const dim of DIMENSIONS) {
    const hit = search(dim)
    if (hit) return hit
  }
  return null
}
