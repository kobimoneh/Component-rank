import type { IpcMain } from 'electron'
import type { BootstrapResult } from './bootstrap.js'
import {
  CHANNELS,
  MUTATION_CHANNELS,
  CategoryRowsRequest,
  CompareRequest,
  CreateComponentRequest,
  ExternalAddRequest,
  ExternalUpdateRequest,
  IdRequest,
  OverrideRequest,
  ProfileCreateRequest,
  ProfileDefaultRequest,
  SearchRequest,
  SetPackageRequest,
  SetSpecRequest,
  SlugRequest,
  UpdateComponentRequest,
  type AppStatus,
  type CategoryDetail,
  type CategoryNavItem,
  type SpecFieldDef,
} from '../shared/ipc.js'
import {
  addExternal, confirmPackage, createComponent, createProfile, deleteComponent,
  deleteExternal, setDefaultProfile, setOverride, setPackage, setSpecValue,
  updateComponent, updateExternal,
} from '../db/repositories/mutations.js'
import { compareComponents } from '../db/repositories/compare.js'
import { exportCategoryCsv, exportJson } from '../db/repositories/export.js'
import { ClaudeCliProvider } from '../ai/claude-cli.js'
import { listCategories } from '../db/repositories/categories.js'
import {
  categoryColumns,
  dataQuality,
  listCategoryRows,
  searchComponents,
} from '../db/repositories/components.js'
import { componentDetail } from '../db/repositories/component-detail.js'

/**
 * IPC handlers.
 *
 * Every request payload is parsed by its Zod schema before it reaches a
 * repository. A malformed payload throws, and the renderer sees the rejection —
 * it is never coerced into a query.
 */
export function registerIpc(ipc: IpcMain, boot: BootstrapResult): void {
  const { db } = boot

  const status = (): AppStatus => {
    const counts = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM component) AS components, (SELECT COUNT(*) FROM category) AS categories',
      )
      .get<{ components: number; categories: number }>()
    return {
      ready: true,
      databasePath: boot.databasePath,
      schemaVersion: boot.schemaVersion,
      componentCount: counts?.components ?? 0,
      categoryCount: counts?.categories ?? 0,
      lastSync: boot.sync
        ? {
            created: boot.sync.created.length,
            updated: boot.sync.updated.length,
            keptLocal: boot.sync.keptLocal.length,
            unchanged: boot.sync.unchanged.length,
            orphaned: boot.sync.orphaned,
          }
        : null,
      dataQuality: dataQuality(db),
      warnings: boot.warnings,
    }
  }

  ipc.handle(CHANNELS.appStatus, () => status())
  ipc.handle(CHANNELS.resync, () => status())

  ipc.handle(CHANNELS.categoriesList, (): CategoryNavItem[] =>
    listCategories(db).map((c) => ({
      slug: c.slug,
      name: c.name,
      group: c.group,
      componentCount: c.componentCount,
    })),
  )

  ipc.handle(CHANNELS.categoryDetail, (_e, payload: unknown): CategoryDetail | null => {
    const { slug } = SlugRequest.parse(payload)
    const row = db
      .prepare(`
        SELECT slug, name, group_name AS "group", description, metric_prose AS metricProse,
               ranking_unresolved AS rankingUnresolved, id
        FROM category WHERE slug = ?
      `)
      .get<{
        slug: string; name: string; group: string; description: string
        metricProse: string; rankingUnresolved: number; id: number
      }>(slug)
    if (!row) return null

    const requirements = db
      .prepare('SELECT note FROM ranking_requirement WHERE category_id = ?')
      .all<{ note: string }>(row.id)
      .map((r) => r.note)
    const notes = db
      .prepare('SELECT note FROM category_note WHERE category_id = ?')
      .all<{ note: string }>(row.id)
      .map((r) => r.note)
    const referenceParts = db
      .prepare('SELECT mpn FROM category_reference_part WHERE category_id = ? ORDER BY ord')
      .all<{ mpn: string }>(row.id)
      .map((r) => r.mpn)

    return {
      slug: row.slug,
      name: row.name,
      group: row.group,
      description: row.description,
      metricProse: row.metricProse,
      rankingUnresolved: row.rankingUnresolved === 1,
      requirements,
      notes,
      columns: categoryColumns(db, slug),
      referenceParts,
    }
  })

  ipc.handle(CHANNELS.categoryRows, (_e, payload: unknown) => {
    const req = CategoryRowsRequest.parse(payload)
    return listCategoryRows(db, req.slug, req.search)
  })

  ipc.handle(CHANNELS.componentDetail, (_e, payload: unknown) => {
    const { id } = IdRequest.parse(payload)
    return componentDetail(db, id)
  })

  ipc.handle(CHANNELS.search, (_e, payload: unknown) => {
    const req = SearchRequest.parse(payload)
    return searchComponents(db, req.query, req.limit)
  })
}

/**
 * Mutation, comparison and export handlers.
 *
 * Registered separately so the read surface above stays legible. Same rule: the
 * Zod schema runs before any repository call, and a validation failure rejects
 * the invoke rather than being coerced into a query.
 */
export function registerMutationIpc(
  ipc: IpcMain,
  boot: BootstrapResult,
  helpers: {
    saveFile(defaultName: string, contents: string): Promise<{ path: string | null; cancelled: boolean }>
  },
): void {
  const { db } = boot

  ipc.handle(MUTATION_CHANNELS.componentCreate, (_e, payload: unknown) => {
    const req = CreateComponentRequest.parse(payload)
    const result = createComponent(db, req)
    return result.ok
      ? { ok: true, id: result.id, duplicate: null }
      : { ok: false, id: null, duplicate: result.duplicate }
  })

  ipc.handle(MUTATION_CHANNELS.componentUpdate, (_e, payload: unknown) => {
    const req = UpdateComponentRequest.parse(payload)
    updateComponent(db, req.id, req.patch)
  })

  ipc.handle(MUTATION_CHANNELS.componentDelete, (_e, payload: unknown) => {
    deleteComponent(db, IdRequest.parse(payload).id)
  })

  ipc.handle(MUTATION_CHANNELS.packageSet, (_e, payload: unknown) => {
    const req = SetPackageRequest.parse(payload)
    setPackage(db, req.id, req.patch)
  })

  ipc.handle(MUTATION_CHANNELS.packageConfirm, (_e, payload: unknown) => {
    confirmPackage(db, IdRequest.parse(payload).id)
  })

  ipc.handle(MUTATION_CHANNELS.categorySpecs, (_e, payload: unknown): SpecFieldDef[] => {
    const { slug } = SlugRequest.parse(payload)
    return db
      .prepare(`
        SELECT key, name, type, unit, unit_label, enum_values, ai_hint, unmapped
        FROM spec_def WHERE category_id = (SELECT id FROM category WHERE slug = ?)
        ORDER BY col_order
      `)
      .all<{
        key: string; name: string; type: string; unit: string | null
        unit_label: string | null; enum_values: string | null; ai_hint: string | null; unmapped: number
      }>(slug)
      .map((r) => ({
        key: r.key,
        label: r.name,
        type: r.type,
        unit: r.unit ?? r.unit_label,
        enumValues: r.enum_values ? (JSON.parse(r.enum_values) as string[]) : null,
        hint: r.ai_hint,
        unmapped: r.unmapped === 1,
      }))
  })

  ipc.handle(MUTATION_CHANNELS.specSet, (_e, payload: unknown) => {
    const req = SetSpecRequest.parse(payload)
    const row = db
      .prepare(`
        SELECT d.id, d.key, d.name, d.type, d.dimension, d.unit, d.unit_label, d.better, d.enum_values
        FROM spec_def d
        JOIN component c ON c.category_id = d.category_id
        WHERE c.id = ? AND d.key = ?
      `)
      .get<{
        id: number; key: string; name: string; type: string; dimension: string | null
        unit: string | null; unit_label: string | null; better: string; enum_values: string | null
      }>(req.componentId, req.specKey)
    if (!row) return { ok: false, error: `No specification "${req.specKey}" in this category.` }

    const def = {
      key: row.key, name: row.name, type: row.type as 'scalar',
      ...(row.dimension ? { dimension: row.dimension as 'current' } : {}),
      ...(row.unit ? { unit: row.unit } : {}),
      ...(row.unit_label ? { unitLabel: row.unit_label } : {}),
      better: row.better as 'none',
      ...(row.enum_values ? { enumValues: JSON.parse(row.enum_values) as string[] } : {}),
      table: true, filterable: true, sortable: true, unmapped: false,
    }
    const result = setSpecValue(db, req.componentId, row.id, def, req.value)
    return result.ok ? { ok: true, error: null } : { ok: false, error: result.error }
  })

  ipc.handle(MUTATION_CHANNELS.profileCreate, (_e, payload: unknown) => {
    const req = ProfileCreateRequest.parse(payload)
    return createProfile(db, req.componentId, req.name, req.makeDefault ?? false)
  })

  ipc.handle(MUTATION_CHANNELS.profileSetDefault, (_e, payload: unknown) => {
    const req = ProfileDefaultRequest.parse(payload)
    setDefaultProfile(db, req.componentId, req.profileId)
  })

  ipc.handle(MUTATION_CHANNELS.profileSetOverride, (_e, payload: unknown) => {
    const req = OverrideRequest.parse(payload)
    setOverride(db, req.profileId, req.override)
  })

  ipc.handle(MUTATION_CHANNELS.externalAdd, (_e, payload: unknown) => {
    const req = ExternalAddRequest.parse(payload)
    const { profileId, ...rest } = req
    return addExternal(db, profileId, rest)
  })

  ipc.handle(MUTATION_CHANNELS.externalUpdate, (_e, payload: unknown) => {
    const req = ExternalUpdateRequest.parse(payload)
    updateExternal(db, req.id, req.patch)
  })

  ipc.handle(MUTATION_CHANNELS.externalDelete, (_e, payload: unknown) => {
    deleteExternal(db, IdRequest.parse(payload).id)
  })

  ipc.handle(MUTATION_CHANNELS.compare, (_e, payload: unknown) => {
    const req = CompareRequest.parse(payload)
    return compareComponents(db, req.ids)
  })

  ipc.handle(MUTATION_CHANNELS.exportJson, async () => {
    const bundle = exportJson(db)
    const contents = JSON.stringify(bundle, null, 2)
    const saved = await helpers.saveFile('component-library-export.json', contents)
    return {
      ok: saved.path !== null,
      path: saved.path,
      bytes: saved.path ? Buffer.byteLength(contents, 'utf8') : 0,
      cancelled: saved.cancelled,
    }
  })

  ipc.handle(MUTATION_CHANNELS.exportCsv, async (_e, payload: unknown) => {
    const { slug } = SlugRequest.parse(payload)
    const contents = exportCategoryCsv(db, slug)
    const saved = await helpers.saveFile(`${slug}.csv`, contents)
    return {
      ok: saved.path !== null,
      path: saved.path,
      bytes: saved.path ? Buffer.byteLength(contents, 'utf8') : 0,
      cancelled: saved.cancelled,
    }
  })

  ipc.handle(MUTATION_CHANNELS.providerStatus, async () => {
    const provider = new ClaudeCliProvider({
      binaryPath: process.env['CLAUDE_BIN'] ?? '',
    })
    const status = await provider.status()
    return [{ id: status.id, available: status.available, reason: status.reason }]
  })
}
