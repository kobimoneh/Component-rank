import type { IpcMain } from 'electron'
import type { BootstrapResult } from './bootstrap.js'
import {
  CHANNELS,
  CategoryRowsRequest,
  IdRequest,
  SearchRequest,
  SlugRequest,
  type AppStatus,
  type CategoryDetail,
  type CategoryNavItem,
} from '../shared/ipc.js'
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
