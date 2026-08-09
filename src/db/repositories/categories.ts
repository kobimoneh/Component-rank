import { createHash } from 'node:crypto'
import type { SqlDriver } from '../driver.js'
import type { Category, SpecDefinition } from '../../domain/categories/model.js'
import { removedSpecKeys } from './spec-defs.js'
import { deletedFamilySlugs, normalizeName } from './taxonomy.js'

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
  /** Upstream still lists these, but you deleted them here. Left deleted. */
  readonly skippedDeleted: readonly string[]
  readonly specsCreated: number
  readonly specsUpdated: number
  /** `slug.key` of spec definitions preserved because they were edited here. */
  readonly specsKeptLocal: readonly string[]
}

/** Stable fingerprint of the upstream definition, used to detect real changes. */
export function categoryHash(c: Category): string {
  const canonical = JSON.stringify({
    name: c.name,
    // The grouping is part of the definition. Leaving it out meant a category
    // that upstream had simply moved to another heading hashed as unchanged, so
    // the move never arrived — found by the section tests.
    group: c.group,
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
  section_pinned: number
}

/**
 * The section a newly imported family should land under, creating it if this is
 * the first family to claim that heading. Upstream `group_name` decides where a
 * family goes only until you move it — see migration 005.
 */
function sectionForGroup(db: SqlDriver, group: string, at: string): number {
  const norm = normalizeName(group)
  const found = db.prepare('SELECT id FROM section WHERE name_norm = ?').get<{ id: number }>(norm)
  if (found) return found.id
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM section').get<{ n: number }>()!.n
  return db
    .prepare('INSERT INTO section (name, name_norm, sort_order, created_at) VALUES (?,?,?,?)')
    .run(group, norm, max + 10, at).lastInsertRowid
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
  const skippedDeleted: string[] = []
  const specReport = { created: 0, updated: 0, keptLocal: [] as string[] }

  db.transaction(() => {
    const existing = db
      .prepare('SELECT id, slug, source, source_hash, locally_modified, section_pinned FROM category')
      .all<CategoryRow>()
    const bySlug = new Map(existing.map((r) => [r.slug, r]))
    // A family you deleted stays deleted. Re-creating it here would be the same
    // silent undo that category_removed_spec prevents for parameters.
    const deleted = deletedFamilySlugs(db)

    categories.forEach((c, index) => {
      if (deleted.has(c.slug)) {
        skippedDeleted.push(c.slug)
        return
      }
      const hash = categoryHash(c)
      const row = bySlug.get(c.slug)

      if (!row) {
        const res = db
          .prepare(`
            INSERT INTO category (slug, name, group_name, description, metric_prose,
                                  ranking_unresolved, sort_order, source, source_hash,
                                  locally_modified, created_at, updated_at, section_id)
            VALUES (?,?,?,?,?,?,?,'imported',?,0,?,?,?)
          `)
          .run(
            c.slug, c.name, c.group, c.description, c.ranking.metricProse,
            c.ranking.unresolved ? 1 : 0, index, hash, now, now,
            sectionForGroup(db, c.group, now),
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

      // Placement follows upstream until you move the family yourself, after
      // which section_pinned keeps it where you put it while everything else
      // about the family still syncs.
      const sectionId = row.section_pinned === 1 ? null : sectionForGroup(db, c.group, now)
      db.prepare(`
        UPDATE category SET name=?, group_name=?, description=?, metric_prose=?,
                            ranking_unresolved=?, sort_order=?, source_hash=?, updated_at=?,
                            section_id = COALESCE(?, section_id)
        WHERE id = ?
      `).run(
        c.name, c.group, c.description, c.ranking.metricProse,
        c.ranking.unresolved ? 1 : 0, index, hash, now, sectionId, row.id,
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
    created, updated, keptLocal, unchanged, orphaned, skippedDeleted,
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
  /** Section heading. Empty string for a family that sits under no section. */
  readonly group: string
  readonly sectionId: number | null
  readonly sectionOrder: number
  readonly local: boolean
  readonly componentCount: number
}

/**
 * The rail, in display order.
 *
 * Order comes from `section.sort_order`, which you can change — it used to be a
 * constant array in the renderer, so a section you created had nowhere to go.
 * A family under no section sorts last and is shown as "Ungrouped".
 */
export function listCategories(db: SqlDriver): CategoryListItem[] {
  return db
    .prepare(`
      SELECT c.id, c.slug, c.name,
             COALESCE(s.name, '') AS "group",
             c.section_id AS sectionId,
             COALESCE(s.sort_order, 100000) AS sectionOrder,
             (c.source = 'local') AS local,
             (SELECT COUNT(*) FROM component_category cc WHERE cc.category_id = c.id) AS componentCount
      FROM category c
      LEFT JOIN section s ON s.id = c.section_id
      ORDER BY sectionOrder, s.name, c.sort_order, c.name
    `)
    .all<Omit<CategoryListItem, 'local'> & { local: number }>()
    .map((r) => ({ ...r, local: r.local === 1 }))
}
