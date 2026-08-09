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

  // Mutations
  createComponent(req: CreateComponentRequest): Promise<CreateOutcome>
  updateComponent(req: UpdateComponentRequest): Promise<void>
  deleteComponent(req: IdRequest): Promise<void>
  setPackage(req: SetPackageRequest): Promise<void>
  confirmPackage(req: IdRequest): Promise<void>
  setSpec(req: SetSpecRequest): Promise<SetSpecOutcome>
  categorySpecs(req: SlugRequest): Promise<SpecFieldDef[]>

  // Solution size
  createProfile(req: ProfileCreateRequest): Promise<number>
  setDefaultProfile(req: ProfileDefaultRequest): Promise<void>
  setOverride(req: OverrideRequest): Promise<void>
  addExternal(req: ExternalAddRequest): Promise<number>
  updateExternal(req: ExternalUpdateRequest): Promise<void>
  deleteExternal(req: IdRequest): Promise<void>

  // Comparison and export
  compare(req: CompareRequest): Promise<CompareResult>
  exportJson(): Promise<ExportOutcome>
  exportCsv(req: SlugRequest): Promise<ExportOutcome>
  providerStatus(): Promise<ProviderStatusInfo[]>

  // Category parameters
  listSpecDefs(req: SlugRequest): Promise<SpecDefDto[]>
  addSpecDef(req: AddSpecDefRequest): Promise<AddSpecOutcome>
  removeSpecDef(req: SpecKeyRequest): Promise<RemoveSpecOutcome>
  updateSpecDef(req: UpdateSpecDefRequest): Promise<{ ok: boolean; error: string | null }>
  dimensions(): Promise<DimensionDto[]>
  leaders(req: SlugRequest): Promise<LeaderBoardDto>
}

export interface ProviderStatusInfo {
  readonly id: string
  readonly available: boolean
  readonly reason: string | null
}

export interface CompareCellDto {
  readonly text: string | null
  readonly sort: number | null
  readonly unverified: boolean
  readonly best: boolean
  readonly worst: boolean
}

export interface CompareRowDto {
  readonly key: string
  readonly label: string
  readonly unit: string | null
  readonly numeric: boolean
  readonly better: 'lower' | 'higher' | 'none'
  readonly values: readonly CompareCellDto[]
  readonly differs: boolean
}

export interface CompareSizeDto {
  readonly id: number
  readonly mpn: string
  readonly icWidthMm: number | null
  readonly icHeightMm: number | null
  readonly icAreaMm2: number | null
  readonly grossWidthMm: number | null
  readonly grossHeightMm: number | null
  readonly grossAreaMm2: number | null
  readonly grossOrigin: 'manual' | 'estimated' | null
  readonly unverified: boolean
}

export interface CompareResult {
  readonly components: ReadonlyArray<{
    readonly id: number
    readonly mpn: string
    readonly manufacturer: string
    readonly categoryName: string | null
  }>
  readonly rows: readonly CompareRowDto[]
  readonly sizes: readonly CompareSizeDto[]
  readonly mixedCategories: boolean
}

// =============================================================================
// Mutations, comparison and export
// =============================================================================

export const MUTATION_CHANNELS = {
  componentCreate: 'component:create',
  componentUpdate: 'component:update',
  componentDelete: 'component:delete',
  packageSet: 'component:setPackage',
  packageConfirm: 'component:confirmPackage',
  specSet: 'component:setSpec',
  categorySpecs: 'category:specs',
  profileCreate: 'profile:create',
  profileSetDefault: 'profile:setDefault',
  profileSetOverride: 'profile:setOverride',
  externalAdd: 'external:add',
  externalUpdate: 'external:update',
  externalDelete: 'external:delete',
  compare: 'compare:rows',
  exportJson: 'export:json',
  exportCsv: 'export:csv',
  providerStatus: 'ai:status',
  specDefsList: 'specdef:list',
  specDefAdd: 'specdef:add',
  specDefRemove: 'specdef:remove',
  specDefUpdate: 'specdef:update',
  dimensions: 'specdef:dimensions',
  leaders: 'category:leaders',
} as const

export const AddSpecDefRequest = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['scalar', 'range', 'number', 'bool', 'enum', 'text']),
  dimension: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  better: z.enum(['lower', 'higher', 'none']).optional(),
  enumValues: z.array(z.string().min(1)).nullable().optional(),
  tableVisible: z.boolean().optional(),
})
export type AddSpecDefRequest = z.infer<typeof AddSpecDefRequest>

export const SpecKeyRequest = z.object({
  slug: z.string().min(1),
  key: z.string().min(1),
})
export type SpecKeyRequest = z.infer<typeof SpecKeyRequest>

export const UpdateSpecDefRequest = z.object({
  slug: z.string().min(1),
  key: z.string().min(1),
  patch: z.object({
    name: z.string().min(1).optional(),
    unit: z.string().nullable().optional(),
    better: z.enum(['lower', 'higher', 'none']).optional(),
    tableVisible: z.boolean().optional(),
  }),
})
export type UpdateSpecDefRequest = z.infer<typeof UpdateSpecDefRequest>

export interface SpecDefDto {
  readonly id: number
  readonly key: string
  readonly name: string
  readonly type: string
  readonly dimension: string | null
  readonly unit: string | null
  readonly better: 'lower' | 'higher' | 'none'
  readonly enumValues: readonly string[] | null
  readonly tableVisible: boolean
  readonly unmapped: boolean
  readonly source: 'imported' | 'local'
  readonly locallyModified: boolean
  readonly sourcePhrase: string | null
  readonly valueCount: number
}

export interface DimensionDto {
  readonly id: string
  readonly label: string
  readonly units: readonly string[]
}

export interface LeaderDto {
  readonly key: string
  readonly label: string
  readonly unit: string | null
  readonly better: 'lower' | 'higher'
  readonly componentId: number
  readonly mpn: string
  readonly manufacturer: string
  readonly valueText: string
  readonly tied: boolean
  readonly tiedWith: number
  readonly contenders: number
  readonly skippedUnverified: number
}

export interface LeaderBoardDto {
  readonly slug: string
  readonly leaders: readonly LeaderDto[]
  readonly noData: ReadonlyArray<{ key: string; label: string }>
}

export interface AddSpecOutcome {
  readonly ok: boolean
  readonly key: string | null
  readonly error: string | null
}

export interface RemoveSpecOutcome {
  readonly ok: boolean
  readonly valuesDeleted: number
  readonly error: string | null
}

export const CreateComponentRequest = z.object({
  manufacturer: z.string().min(1, 'Manufacturer is required'),
  mpn: z.string().min(1, 'Part number is required'),
  family: z.string().nullable().optional(),
  categorySlug: z.string().nullable().optional(),
  lifecycle: z.enum(['active', 'nrnd', 'eol', 'obsolete', 'unknown']).optional(),
  productUrl: z.string().nullable().optional(),
  datasheetUrl: z.string().nullable().optional(),
  notes: z.string().optional(),
  price1k: z.number().nullable().optional(),
  package: z
    .object({
      type: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      pinCount: z.number().int().positive().nullable().optional(),
      xMin: z.number().positive().nullable().optional(),
      xNom: z.number().positive().nullable().optional(),
      xMax: z.number().positive().nullable().optional(),
      yMin: z.number().positive().nullable().optional(),
      yNom: z.number().positive().nullable().optional(),
      yMax: z.number().positive().nullable().optional(),
      zMin: z.number().positive().nullable().optional(),
      zNom: z.number().positive().nullable().optional(),
      zMax: z.number().positive().nullable().optional(),
    })
    .optional(),
})
export type CreateComponentRequest = z.infer<typeof CreateComponentRequest>

export const UpdateComponentRequest = z.object({
  id: z.number().int().positive(),
  patch: z.object({
    family: z.string().nullable().optional(),
    lifecycle: z.enum(['active', 'nrnd', 'eol', 'obsolete', 'unknown']).optional(),
    productUrl: z.string().nullable().optional(),
    notes: z.string().optional(),
    price1k: z.number().nullable().optional(),
    favorite: z.boolean().optional(),
    flag: z.enum(['reference', 'best_in_class', 'avoid']).nullable().optional(),
  }),
})
export type UpdateComponentRequest = z.infer<typeof UpdateComponentRequest>

export const SetPackageRequest = z.object({
  id: z.number().int().positive(),
  patch: z.object({
    type: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    pinCount: z.number().int().positive().nullable().optional(),
    xMin: z.number().positive().nullable().optional(),
    xNom: z.number().positive().nullable().optional(),
    xMax: z.number().positive().nullable().optional(),
    yMin: z.number().positive().nullable().optional(),
    yNom: z.number().positive().nullable().optional(),
    yMax: z.number().positive().nullable().optional(),
    zMin: z.number().positive().nullable().optional(),
    zNom: z.number().positive().nullable().optional(),
    zMax: z.number().positive().nullable().optional(),
  }),
})
export type SetPackageRequest = z.infer<typeof SetPackageRequest>

export const SetSpecRequest = z.object({
  componentId: z.number().int().positive(),
  specKey: z.string().min(1),
  value: z.string(),
})
export type SetSpecRequest = z.infer<typeof SetSpecRequest>

export const ProfileCreateRequest = z.object({
  componentId: z.number().int().positive(),
  name: z.string().min(1),
  makeDefault: z.boolean().optional(),
})
export type ProfileCreateRequest = z.infer<typeof ProfileCreateRequest>

export const ProfileDefaultRequest = z.object({
  componentId: z.number().int().positive(),
  profileId: z.number().int().positive(),
})
export type ProfileDefaultRequest = z.infer<typeof ProfileDefaultRequest>

export const OverrideRequest = z.object({
  profileId: z.number().int().positive(),
  override: z
    .object({
      widthMm: z.number().positive().nullable(),
      heightMm: z.number().positive().nullable(),
      areaMm2: z.number().positive().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
})
export type OverrideRequest = z.infer<typeof OverrideRequest>

export const ExternalAddRequest = z.object({
  profileId: z.number().int().positive(),
  name: z.string().min(1),
  function: z.string().optional(),
  qty: z.number().int().positive().optional(),
  necessity: z.enum(['required', 'recommended', 'optional', 'configuration']).optional(),
  valueText: z.string().nullable().optional(),
  packageName: z.string().nullable().optional(),
  xMm: z.number().positive().nullable().optional(),
  yMm: z.number().positive().nullable().optional(),
  zMm: z.number().positive().nullable().optional(),
})
export type ExternalAddRequest = z.infer<typeof ExternalAddRequest>

export const ExternalUpdateRequest = z.object({
  id: z.number().int().positive(),
  patch: z.object({
    name: z.string().min(1).optional(),
    function: z.string().optional(),
    qty: z.number().int().positive().optional(),
    necessity: z.enum(['required', 'recommended', 'optional', 'configuration']).optional(),
    valueText: z.string().nullable().optional(),
    packageName: z.string().nullable().optional(),
    xMm: z.number().positive().nullable().optional(),
    yMm: z.number().positive().nullable().optional(),
    included: z.boolean().optional(),
  }),
})
export type ExternalUpdateRequest = z.infer<typeof ExternalUpdateRequest>

export const CompareRequest = z.object({
  ids: z.array(z.number().int().positive()).min(2).max(10),
})
export type CompareRequest = z.infer<typeof CompareRequest>

export interface SpecFieldDef {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly unit: string | null
  readonly enumValues: readonly string[] | null
  readonly hint: string | null
  readonly unmapped: boolean
}

export interface CreateOutcome {
  readonly ok: boolean
  readonly id: number | null
  readonly duplicate: { readonly id: number; readonly mpn: string; readonly manufacturer: string } | null
}

export interface SetSpecOutcome {
  readonly ok: boolean
  readonly error: string | null
}

export interface ExportOutcome {
  readonly ok: boolean
  readonly path: string | null
  readonly bytes: number
  readonly cancelled: boolean
}
