import type { DimensionId } from '../units/dimensions.js'

/**
 * Category and specification definitions.
 *
 * Everything here is data, loaded from the database at runtime. Adding a category
 * or changing which parameters matter must never require a code change, so no
 * category slug or spec key appears in a switch statement anywhere in the app.
 */

export type SpecType = 'scalar' | 'range' | 'number' | 'bool' | 'enum' | 'text'

/** Whether a smaller or larger value is better, for comparison highlighting. */
export type Better = 'lower' | 'higher' | 'none'

/**
 * Fields the app computes rather than stores, referenced by ranking rules and
 * table columns with an `@` prefix so they cannot collide with a spec key.
 */
export const VIRTUAL_FIELDS = [
  '@ic_area',
  '@gross_area',
  '@ic_width',
  '@ic_height',
  '@z_height',
  '@external_count',
  '@price_1k',
] as const
export type VirtualField = (typeof VIRTUAL_FIELDS)[number]

export function isVirtualField(ref: string): ref is VirtualField {
  return (VIRTUAL_FIELDS as readonly string[]).includes(ref)
}

export interface SpecDefinition {
  readonly key: string
  readonly name: string
  readonly type: SpecType
  /** Required for `scalar` and `range`; absent for the other types. */
  readonly dimension?: DimensionId
  /** Preferred display unit; the stored value is always canonical. */
  readonly unit?: string
  /** Free label for `number` specs that carry a unit the registry does not model. */
  readonly unitLabel?: string
  readonly better: Better
  readonly enumValues?: readonly string[]
  /** Visible as a table column by default. */
  readonly table: boolean
  readonly filterable: boolean
  readonly sortable: boolean
  /** Guidance handed to the extraction model. */
  readonly ai?: string
  /**
   * True when the importer could not type this parameter and fell back to text.
   * Surfaces in the category editor as "needs typing" rather than being hidden.
   */
  readonly unmapped: boolean
  /** Verbatim source phrase from component-report, kept for sync and traceability. */
  readonly sourcePhrase?: string
}

export type RankDirection = 'asc' | 'desc'

/** What to do with components missing the ranking field. */
export type MissingPolicy = 'last' | 'first' | 'exclude'

export interface RankingRule {
  /** A spec key, or a virtual field such as `@ic_area`. */
  readonly field: string
  readonly direction: RankDirection
  readonly missing: MissingPolicy
}

export type RequirementOp = '<' | '<=' | '>' | '>=' | '=' | 'covers'

/**
 * A hard constraint from the source config, e.g. "on current must be < 6 mA".
 * Components failing a requirement are excluded from the ranking but remain
 * visible and clearly marked, rather than silently vanishing from the table.
 */
export interface RankingRequirement {
  readonly field: string
  readonly op: RequirementOp
  readonly value: number
  readonly unit: string
  readonly note: string
}

export interface CategoryRanking {
  /** The original `metric:` prose, always shown so the intent is not lost. */
  readonly metricProse: string
  readonly rules: readonly RankingRule[]
  readonly requirements: readonly RankingRequirement[]
  /** True when no rule could be derived and the prose is all we have. */
  readonly unresolved: boolean
}

export interface Category {
  readonly slug: string
  readonly name: string
  /** Logical nav group: Power, Wireless, MCU, FPGA, Memory, RF, Interface, Connectors. */
  readonly group: string
  readonly description: string
  readonly ranking: CategoryRanking
  readonly specs: readonly SpecDefinition[]
  readonly manufacturers: readonly string[]
  /** MPNs listed as best-in-class upstream. Reference names only, never specs. */
  readonly referenceParts: readonly string[]
  /** Notes the importer could not turn into structured data. */
  readonly importNotes: readonly string[]
}

export function findSpec(category: Category, key: string): SpecDefinition | undefined {
  return category.specs.find((s) => s.key === key)
}

/** Columns a category table shows by default, in order. */
export function defaultColumns(category: Category): string[] {
  return [
    'mpn',
    'manufacturer',
    '@ic_area',
    '@gross_area',
    ...category.specs.filter((s) => s.table).map((s) => s.key),
    'package',
  ]
}
