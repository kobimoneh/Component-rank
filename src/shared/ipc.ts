import { z } from 'zod'

/**
 * The IPC contract.
 *
 * One file, shared by the preload bridge, the main-process handlers and the
 * renderer's types. Every payload crossing the boundary is parsed by the schema in
 * the main process before it reaches a repository — a validation failure is an
 * error, never a coerced value.
 */

export const CHANNELS = {
  appStatus: 'app:status',
  categoriesList: 'categories:list',
  categoryDetail: 'category:detail',
  categoryRows: 'category:rows',
  componentDetail: 'component:detail',
  search: 'search:global',
  resync: 'app:resync',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

// ---------------------------------------------------------------- requests

export const CategoryRowsRequest = z.object({
  slug: z.string().min(1),
  search: z.string().optional(),
})
export type CategoryRowsRequest = z.infer<typeof CategoryRowsRequest>

export const SlugRequest = z.object({ slug: z.string().min(1) })
export type SlugRequest = z.infer<typeof SlugRequest>

export const IdRequest = z.object({ id: z.number().int().positive() })
export type IdRequest = z.infer<typeof IdRequest>

export const SearchRequest = z.object({ query: z.string(), limit: z.number().int().min(1).max(200).default(50) })
export type SearchRequest = z.infer<typeof SearchRequest>

// ---------------------------------------------------------------- responses

export interface AppStatus {
  readonly ready: boolean
  readonly databasePath: string
  readonly schemaVersion: number
  readonly componentCount: number
  readonly categoryCount: number
  /** Present when first-run import or sync ran this session. */
  readonly lastSync: {
    readonly created: number
    readonly updated: number
    readonly keptLocal: number
    readonly unchanged: number
    readonly orphaned: readonly string[]
  } | null
  readonly dataQuality: {
    readonly missingDimensions: number
    readonly unverifiedDimensions: number
    readonly missingDatasheet: number
  }
  /** Non-fatal problems worth surfacing rather than swallowing. */
  readonly warnings: readonly string[]
}

export interface CategoryNavItem {
  readonly slug: string
  readonly name: string
  readonly group: string
  readonly componentCount: number
}

export interface ColumnDef {
  readonly key: string
  readonly label: string
  /** Unit shown in the header so cells stay clean. */
  readonly unit: string | null
  readonly numeric: boolean
  readonly better: 'lower' | 'higher' | 'none'
}

export interface CellValue {
  /** Preformatted for display. `null` renders as an em dash, never as 0. */
  readonly text: string | null
  /** Canonical number for client-side sorting. */
  readonly sort: number | null
  readonly unverified: boolean
  readonly origin: 'manual' | 'imported' | 'extracted' | 'derived' | null
}

export interface CategoryRow {
  readonly id: number
  readonly mpn: string
  readonly manufacturer: string
  readonly rank: number | null
  readonly unrankedReason: string | null
  readonly failedRequirements: readonly string[]
  readonly lifecycle: string
  readonly favorite: boolean
  readonly cells: Readonly<Record<string, CellValue>>
}

export interface CategoryDetail {
  readonly slug: string
  readonly name: string
  readonly group: string
  readonly description: string
  readonly metricProse: string
  readonly rankingUnresolved: boolean
  readonly requirements: readonly string[]
  readonly notes: readonly string[]
  readonly columns: readonly ColumnDef[]
  readonly referenceParts: readonly string[]
}

export interface SearchHit {
  readonly id: number
  readonly mpn: string
  readonly manufacturer: string
  readonly categorySlug: string | null
  readonly categoryName: string | null
}

export interface ComponentDetail {
  readonly id: number
  readonly mpn: string
  readonly manufacturer: string
  readonly categorySlug: string | null
  readonly categoryName: string | null
  readonly lifecycle: string
  readonly notes: string
  readonly datasheetUrl: string | null
  readonly price1k: number | null
  readonly favorite: boolean
  readonly package: {
    readonly type: string | null
    readonly name: string | null
    readonly pinCount: number | null
    readonly dimensionsText: string
    readonly basis: string | null
    readonly icAreaMm2: number | null
    readonly unverified: boolean
    readonly unverifiedReason: string | null
  }
  readonly specs: ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly value: string | null
    readonly unverified: boolean
    readonly origin: string | null
  }>
  readonly solution: {
    readonly profileName: string | null
    readonly icAreaMm2: number | null
    readonly externalAreaMm2: number | null
    readonly grossComponentAreaMm2: number | null
    readonly estimateText: string | null
    readonly effectiveAreaMm2: number | null
    readonly origin: 'manual' | 'estimated' | null
    readonly warnings: readonly string[]
    readonly externals: ReadonlyArray<{
      readonly id: number
      readonly name: string
      readonly function: string
      readonly qty: number
      readonly necessity: string
      readonly packageName: string | null
      readonly areaMm2: number | null
      readonly included: boolean
    }>
  }
}

/** The full surface the preload script exposes. Nothing else reaches the renderer. */
export interface RendererApi {
  status(): Promise<AppStatus>
  listCategories(): Promise<CategoryNavItem[]>
  categoryDetail(req: SlugRequest): Promise<CategoryDetail | null>
  categoryRows(req: CategoryRowsRequest): Promise<CategoryRow[]>
  componentDetail(req: IdRequest): Promise<ComponentDetail | null>
  search(req: SearchRequest): Promise<SearchHit[]>
  resync(): Promise<AppStatus>
}
