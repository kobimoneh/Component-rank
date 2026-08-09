import type { PackageDimensions } from '../physical/package.js'

/** How firmly the reference design calls for this part. */
export type Necessity = 'required' | 'recommended' | 'optional' | 'configuration'

export interface ExternalPart {
  readonly id: string
  readonly name: string
  /** What it does in the circuit — "VDD decoupling", "DCDC inductor". */
  readonly function: string
  readonly qty: number
  readonly necessity: Necessity
  /** "10 µF", "32 MHz" — kept as text; the value is not what consumes board area. */
  readonly valueText: string | null
  /** "0402", "2.0 × 1.6 mm", "DFN-6". */
  readonly packageName: string | null
  readonly xMm: number | null
  readonly yMm: number | null
  readonly zMm: number | null
  /** Excluded parts stay in the BOM but contribute nothing to gross size. */
  readonly included: boolean
  readonly notes: string | null
  /** Where the requirement came from — datasheet page, app note, user experience. */
  readonly sourceRef: string | null
}

/** A manual gross-size figure supplied by the user, which always wins. */
export interface SizeOverride {
  readonly widthMm: number | null
  readonly heightMm: number | null
  readonly areaMm2: number | null
  readonly note: string | null
}

export interface SolutionProfile {
  readonly id: string
  /** "Minimum BOM", "Low-power (LF crystal)", "DCDC enabled". */
  readonly name: string
  readonly isDefault: boolean
  readonly notes: string | null
  readonly externals: readonly ExternalPart[]
  readonly override: SizeOverride | null
}

export interface EstimatorSettings {
  /** Courtyard/keepout added around every part, per side, in mm. */
  readonly courtyardMarginMm: number
  /** Multiplier for routing, fanout and placement reality. */
  readonly routingAllowance: number
  /** Preferred width:height of the estimated rectangle. */
  readonly targetAspect: number
}

export const DEFAULT_ESTIMATOR_SETTINGS: EstimatorSettings = {
  courtyardMarginMm: 0.25,
  routingAllowance: 1.15,
  targetAspect: 1.3,
}

export type SizeOrigin = 'manual' | 'estimated'

export interface EstimatedRectangle {
  readonly widthMm: number
  readonly heightMm: number
  readonly areaMm2: number
  /** Rectangles packed, counting quantities. */
  readonly partCount: number
  /** Parts left out because they carry no dimensions. */
  readonly undimensionedParts: readonly string[]
  readonly settings: EstimatorSettings
}

/**
 * The four separate measurements from spec section 6. They are deliberately
 * distinct fields: IC area is not solution area, and nothing in this codebase
 * may present one as the other.
 */
export interface SolutionSize {
  /** A — the IC package footprint alone. */
  readonly icAreaMm2: number | null
  /** B — summed package areas of the included externals. */
  readonly externalAreaMm2: number | null
  /** C — A + B. Still not a PCB area; it is the silicon-and-passives total. */
  readonly grossComponentAreaMm2: number | null
  /** D — an estimated bounding rectangle for the whole solution. */
  readonly estimate: EstimatedRectangle | null
  /** What the UI should show as "the" gross size, and where it came from. */
  readonly effective: {
    readonly widthMm: number | null
    readonly heightMm: number | null
    readonly areaMm2: number | null
    readonly origin: SizeOrigin
  } | null
  /** Included externals that could not be counted, by name. */
  readonly warnings: readonly string[]
}

export interface SolutionInput {
  readonly icPackage: PackageDimensions | null
  readonly profile: SolutionProfile
  readonly settings?: EstimatorSettings
}
