import { createHash } from 'node:crypto'
import type { SqlDriver } from '../driver.js'
import type { Category, SpecDefinition } from '../../domain/categories/model.js'
import { removedSpecKeys } from './spec-defs.js'

/**
 * Category persistence and non-destructive sync with component-report.
 *
 * The contract (spec section 20): re-importing must never discard local work.
 * A row you edited is kept and reported as "kept local". A category that has
 * disappeared upstream is kept and reported as orphaned, never deleted. Only
 * rows still identical to what was last imported are refreshed.
 */

export interface SyncReport {
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly keptLocal: readonly string[]
  readonly unchanged: readonly string[]
  /** Present locally but absent from the incoming config. Never deleted. */
  readonly orphaned: readonly string[]
  readonly specsCreated: number
  readonly specsUpdated: number
  /** `slug.key` of spec definitions preserved because they were edited here. */
  readonly specsKeptLocal: readonly string[]
}

/** Stable fingerprint of the upstream definition, used to detect real changes. */
export function categoryHash(c: Category): string {
  const canonical = JSON.stringify({
    name: c.name,
    description: c.description,
    metric: c.ranking.metricProse,
    specs: [...c.specs].map((s) => [s.key, s.name, s.type, s.dimension ?? '', s.unit ?? '', s.better]).sort(),
    manufacturers: [...c.manufacturers].sort(),
    references: [...c.referenceParts].sort(),
    rules: c.ranking.rules.map((r) => [r.field, r.direction, r.missing]),
    requirements: c.ranking.requirements.map((r) => [r.field, r.op, r.value, r.unit]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function specHash(s: SpecDefinition): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        s.key, s.name, s.type, s.dimension ?? '', s.unit ?? '', s.unitLabel ?? '',
        s.better, s.enumValues ?? [], s.table, s.filterable, s.sortable, s.ai ?? '', s.unmapped,
      ]),
    )
    .digest('hex')
}

interface CategoryRow {
  id: number
  slug: string
  source: string
  source_hash: string | null
  locally_modified: number
}

interface SpecRow {
  id: number
  key: string
  source: string
  locally_modified: number
}

function writeSpecs(
  db: SqlDriver,
  categoryId: number,
  specs: readonly SpecDefinition[],
  report: { created: number; updated: number; keptLocal: string[] },
  slug: string,
): void {
  const existing = db
    .prepare('SELECT id, key, source, locally_modified FROM spec_def WHERE category_id = ?')
    .all<SpecRow>(categoryId)
  const byKey = new Map(existing.map((r) => [r.key, r]))
  // A parameter you deliberately removed stays removed. Re-adding it on the next
  // import would quietly undo the decision.
  const removed = removedSpecKeys(db, categoryId)

  const insert = db.prepare(`
    INSERT INTO spec_def (category_id, key, name, type, dimension, unit, unit_label, better,
                          enum_values, table_visible, col_order, filterable, sortable, ai_hint,
                          unmapped, source_phrase, source, locally_modified)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'imported',0)
  `)
  const update = db.prepare(`
    UPDATE spec_def SET name=?, type=?, dimension=?, unit=?, unit_label=?, better=?,
                        enum_values=?, table_visible=?, col_order=?, filterable=?, sortable=?,
                        ai_hint=?, unmapped=?, source_phrase=?
    WHERE id = ?
  `)

  specs.forEach((s, i) => {
    if (removed.has(s.key)) {
      report.keptLocal.push(`${slug}.${s.key} (removed here)`)
      return
    }
    const row = byKey.get(s.key)
    const enumJson = s.enumValues ? JSON.stringify(s.enumValues) : null
    if (!row) {
      insert.run(
        categoryId, s.key, s.name, s.type, s.dimension ?? null, s.unit ?? null,
        s.unitLabel ?? null, s.better, enumJson, s.table ? 1 : 0, i,
        s.filterable ? 1 : 0, s.sortable ? 1 : 0, s.ai ?? null,
        s.unmapped ? 1 : 0, s.sourcePhrase ?? null,
      )
      report.created++
      return
    }
    // A spec the user edited, or created locally, is never overwritten by a sync.
    if (row.locally_modified === 1 || row.source === 'local') {
      report.keptLocal.push(`${slug}.${s.key}`)
      return
    }
    update.run(
      s.name, s.type, s.dimension ?? null, s.unit ?? null, s.unitLabel ?? null, s.better,
      enumJson, s.table ? 1 : 0, i, s.filterable ? 1 : 0, s.sortable ? 1 : 0,
      s.ai ?? null, s.unmapped ? 1 : 0, s.sourcePhrase ?? null, row.id,
    )
    report.updated++
  })
}

function writeChildren(db: SqlDriver, categoryId: number, c: Category): void {
  // These are pure projections of the upstream list, safe to replace wholesale.
  db.prepare('DELETE FROM category_manufacturer WHERE category_id = ?').run(categoryId)
  const mfr = db.prepare('INSERT INTO category_manufacturer (category_id, name, ord) VALUES (?,?,?)')
  c.manufacturers.forEach((name, i) => mfr.run(categoryId, name, i))

  db.prepare('DELETE FROM category_reference_part WHERE category_id = ?').run(categoryId)
  const ref = db.prepare('INSERT INTO category_reference_part (category_id, mpn, ord) VALUES (?,?,?)')
  c.referenceParts.forEach((mpn, i) => ref.run(categoryId, mpn, i))

  db.prepare('DELETE FROM category_note WHERE category_id = ?').run(categoryId)
  const note = db.prepare('INSERT INTO category_note (category_id, note) VALUES (?,?)')
  c.importNotes.forEach((n) => note.run(categoryId, n))

  db.prepare('DELETE FROM ranking_rule WHERE category_id = ?').run(categoryId)
  const rule = db.prepare(
    'INSERT INTO ranking_rule (category_id, ord, field, direction, missing_policy) VALUES (?,?,?,?,?)',
  )
  c.ranking.rules.forEach((r, i) => rule.run(categoryId, i, r.field, r.direction, r.missing))

  db.prepare('DELETE FROM ranking_requirement WHERE category_id = ?').run(categoryId)
  const req = db.prepare(
    'INSERT INTO ranking_requirement (category_id, field, op, value, unit, note) VALUES (?,?,?,?,?,?)',
  )
  c.ranking.requirements.forEach((r) => req.run(categoryId, r.field, r.op, r.value, r.unit, r.note))
}

export function syncCategories(
  db: SqlDriver,
  categories: readonly Category[],
  now = new Date().toISOString(),
): SyncReport {
  const created: string[] = []
  const updated: string[] = []
  const keptLocal: string[] = []
  const unchanged: string[] = []
  const specReport = { created: 0, updated: 0, keptLocal: [] as string[] }

  db.transaction(() => {
    const existing = db
      .prepare('SELECT id, slug, source, source_hash, locally_modified FROM category')
      .all<CategoryRow>()
    const bySlug = new Map(existing.map((r) => [r.slug, r]))

    categories.forEach((c, index) => {
      const hash = categoryHash(c)
      const row = bySlug.get(c.slug)

      if (!row) {
        const res = db
          .prepare(`
            INSERT INTO category (slug, name, group_name, description, metric_prose,
                                  ranking_unresolved, sort_order, source, source_hash,
                                  locally_modified, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,'imported',?,0,?,?)
          `)
          .run(
            c.slug, c.name, c.group, c.description, c.ranking.metricProse,
            c.ranking.unresolved ? 1 : 0, index, hash, now, now,
          )
        writeChildren(db, res.lastInsertRowid, c)
        writeSpecs(db, res.lastInsertRowid, c.specs, specReport, c.slug)
        created.push(c.slug)
        return
      }

      // Your edits win. A locally modified category is left exactly as it is.
      if (row.locally_modified === 1 || row.source === 'local') {
        keptLocal.push(c.slug)
        return
      }

      if (row.source_hash === hash) {
        unchanged.push(c.slug)
        return
      }

      db.prepare(`
        UPDATE category SET name=?, group_name=?, description=?, metric_prose=?,
                            ranking_unresolved=?, sort_order=?, source_hash=?, updated_at=?
        WHERE id = ?
      `).run(
        c.name, c.group, c.description, c.ranking.metricProse,
        c.ranking.unresolved ? 1 : 0, index, hash, now, row.id,
      )
      writeChildren(db, row.id, c)
      writeSpecs(db, row.id, c.specs, specReport, c.slug)
      updated.push(c.slug)
    })
  })

  const incoming = new Set(categories.map((c) => c.slug))
  const orphaned = db
    .prepare('SELECT slug FROM category')
    .all<{ slug: string }>()
    .map((r) => r.slug)
    .filter((slug) => !incoming.has(slug))

  return {
    created, updated, keptLocal, unchanged, orphaned,
    specsCreated: specReport.created,
    specsUpdated: specReport.updated,
    specsKeptLocal: specReport.keptLocal,
  }
}

/** Mark a category as locally modified so future syncs leave it alone. */
export function markCategoryModified(db: SqlDriver, slug: string): void {
  db.prepare('UPDATE category SET locally_modified = 1 WHERE slug = ?').run(slug)
}

export function markSpecModified(db: SqlDriver, slug: string, key: string): void {
  db.prepare(`
    UPDATE spec_def SET locally_modified = 1
    WHERE key = ? AND category_id = (SELECT id FROM category WHERE slug = ?)
  `).run(key, slug)
}

export interface CategoryListItem {
  readonly id: number
  readonly slug: string
  readonly name: string
  readonly group: string
  readonly componentCount: number
}

export function listCategories(db: SqlDriver): CategoryListItem[] {
  return db
    .prepare(`
      SELECT c.id, c.slug, c.name, c.group_name AS "group",
             (SELECT COUNT(*) FROM component_category cc WHERE cc.category_id = c.id) AS componentCount
      FROM category c
      ORDER BY c.group_name, c.sort_order, c.name
    `)
    .all<CategoryListItem>()
}
