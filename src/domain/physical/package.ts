/**
 * Package physical model.
 *
 * A datasheet mechanical drawing normally gives min / nominal / max for each axis.
 * For PCB area comparison this app uses the **maximum** specified dimension when the
 * datasheet states one, because that is the size the board has to accommodate.
 * Quietly substituting the nominal understates every comparison by a percent or two —
 * small enough to look right, which is exactly what makes it dangerous.
 *
 * Which basis was actually used is returned alongside the number and shown in the UI,
 * per axis, so a part specified max-on-X but nominal-only-on-Y reads as `mixed`
 * rather than pretending to a precision it does not have.
 */

export type DimensionBasis = 'max' | 'nominal' | 'min'
export type FootprintBasis = DimensionBasis | 'mixed'

export interface AxisDimensions {
  readonly min: number | null
  readonly nom: number | null
  readonly max: number | null
}

export interface PackageDimensions {
  readonly x: AxisDimensions
  readonly y: AxisDimensions
  readonly z: AxisDimensions
}

export interface AxisPick {
  readonly value: number
  readonly basis: DimensionBasis
}

export interface Footprint {
  readonly x: AxisPick
  readonly y: AxisPick
  readonly areaMm2: number
  readonly basis: FootprintBasis
}

export const EMPTY_AXIS: AxisDimensions = { min: null, nom: null, max: null }

export function axis(min: number | null, nom: number | null, max: number | null): AxisDimensions {
  return { min, nom, max }
}

/** Convenience for the common case where a datasheet gives one number per axis. */
export function nominalPackage(x: number, y: number, z?: number): PackageDimensions {
  return {
    x: axis(null, x, null),
    y: axis(null, y, null),
    z: axis(null, z ?? null, null),
  }
}

/** Pick the dimension used for board area: max, else nominal, else min. */
export function pickAxis(a: AxisDimensions): AxisPick | null {
  if (a.max !== null) return { value: a.max, basis: 'max' }
  if (a.nom !== null) return { value: a.nom, basis: 'nominal' }
  if (a.min !== null) return { value: a.min, basis: 'min' }
  return null
}

/**
 * The X x Y footprint used for every area comparison in the app.
 * Returns null when either axis is unknown — an unknown dimension must stay
 * unknown rather than defaulting to zero and ranking the part as the smallest.
 */
export function footprint(pkg: PackageDimensions): Footprint | null {
  const x = pickAxis(pkg.x)
  const y = pickAxis(pkg.y)
  if (!x || !y) return null
  return {
    x,
    y,
    areaMm2: x.value * y.value,
    basis: x.basis === y.basis ? x.basis : 'mixed',
  }
}

/** IC footprint area in mm², or null when the package is not fully dimensioned. */
export function icArea(pkg: PackageDimensions): number | null {
  return footprint(pkg)?.areaMm2 ?? null
}

/** Height used for stack-up comparison, on the same max-preferred basis. */
export function height(pkg: PackageDimensions): AxisPick | null {
  return pickAxis(pkg.z)
}

export interface FormatDimsOptions {
  readonly decimals?: number
  /** Append the basis, e.g. `2.60 × 2.10 × 0.80 mm (max)`. */
  readonly withBasis?: boolean
}

/** `2.50 × 2.00 × 0.80 mm` — the canonical way this app writes a package size. */
export function formatDimensions(
  pkg: PackageDimensions,
  opts: FormatDimsOptions = {},
): string {
  const d = opts.decimals ?? 2
  const fp = footprint(pkg)
  if (!fp) return 'Unknown'
  const z = height(pkg)
  const core = z
    ? `${fp.x.value.toFixed(d)} × ${fp.y.value.toFixed(d)} × ${z.value.toFixed(d)} mm`
    : `${fp.x.value.toFixed(d)} × ${fp.y.value.toFixed(d)} mm`
  return opts.withBasis ? `${core} (${fp.basis})` : core
}

/** `5.46 mm²` */
export function formatArea(areaMm2: number | null, decimals = 2): string {
  if (areaMm2 === null) return 'Unknown'
  return `${areaMm2.toFixed(decimals)} mm²`
}

/** True when the package has enough information to take part in area ranking. */
export function isDimensioned(pkg: PackageDimensions): boolean {
  return footprint(pkg) !== null
}
