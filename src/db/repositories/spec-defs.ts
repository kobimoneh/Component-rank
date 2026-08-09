import type { SqlDriver } from '../driver.js'
import type { Better, SpecType } from '../../domain/categories/model.js'
import type { DimensionId } from '../../domain/units/dimensions.js'
import { DIMENSIONS } from '../../domain/units/dimensions.js'

/**
 * Adding, editing and removing a category's parameters.
 *
 * Two rules make this safe against re-import:
 *
 *  - A parameter you add is `source = 'local'`, which sync already leaves alone.
 *  - A parameter you remove is recorded in `category_removed_spec`, so the next
 *    import does not quietly put it back. Undoing a deliberate decision without
 *    saying so is the same class of error as overwriting a manual value.
 */

export interface SpecDefRow {
  readonly id: number
  readonly key: string
  readonly name: string
  readonly type: SpecType
  readonly dimension: DimensionId | null
  readonly unit: string | null
  readonly better: Better
  readonly enumValues: readonly string[] | null
  readonly tableVisible: boolean
  readonly colOrder: number
  readonly unmapped: boolean
  readonly source: 'imported' | 'local'
  readonly locallyModified: boolean
  readonly sourcePhrase: string | null
  /** How many components currently carry a value for this parameter. */
  readonly valueCount: number
}

interface RawRow {
  id: number; key: string; name: string; type: string
  dimension: string | null; unit: string | null; better: string
  enum_values: string | null; table_visible: number; col_order: number
  unmapped: number; source: string; locally_modified: number
  source_phrase: string | null; value_count: number
}

function toRow(r: RawRow): SpecDefRow {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    type: r.type as SpecType,
    dimension: (r.dimension as DimensionId | null) ?? null,
    unit: r.unit,
    better: r.better as Better,
    enumValues: r.enum_values ? (JSON.parse(r.enum_values) as string[]) : null,
    tableVisible: r.table_visible === 1,
    colOrder: r.col_order,
    unmapped: r.unmapped === 1,
    source: r.source as 'imported' | 'local',
    locallyModified: r.locally_modified === 1,
    sourcePhrase: r.source_phrase,
    valueCount: r.value_count,
  }
}

export function listSpecDefs(db: SqlDriver, slug: string): SpecDefRow[] {
  return db
    .prepare(`
      SELECT d.id, d.key, d.name, d.type, d.dimension, d.unit, d.better, d.enum_values,
             d.table_visible, d.col_order, d.unmapped, d.source, d.locally_modified,
             d.source_phrase,
             (SELECT COUNT(*) FROM spec_value v WHERE v.spec_def_id = d.id) AS value_count
      FROM spec_def d
      WHERE d.category_id = (SELECT id FROM category WHERE slug = ?)
      ORDER BY d.col_order, d.id
    `)
    .all<RawRow>(slug)
    .map(toRow)
}

/** Dimensions offered in the parameter editor, for the unit picker. */
export function availableDimensions(): Array<{ id: DimensionId; label: string; units: string[] }> {
  return DIMENSIONS.map((d) => ({
    id: d.id,
    label: d.label,
    units: d.units.map((u) => u.symbol),
  }))
}

export interface AddSpecInput {
  readonly slug: string
  readonly name: string
  readonly type: SpecType
  readonly dimension?: DimensionId | null
  readonly unit?: string | null
  readonly better?: Better
  readonly enumValues?: readonly string[] | null
  readonly tableVisible?: boolean
}

export type AddSpecResult =
  | { readonly ok: true; readonly id: number; readonly key: string }
  | { readonly ok: false; readonly error: string }

/** Derive a stable snake_case key from a display name. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[µμ]/g, 'u')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

export function addSpecDef(db: SqlDriver, input: AddSpecInput): AddSpecResult {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'A parameter needs a name.' }

  const cat = db.prepare('SELECT id FROM category WHERE slug = ?').get<{ id: number }>(input.slug)
  if (!cat) return { ok: false, error: `No category "${input.slug}".` }

  const base = keyFromName(name)
  if (!base) return { ok: false, error: 'That name does not produce a usable key.' }

  if ((input.type === 'scalar' || input.type === 'range') && !input.dimension) {
    return { ok: false, error: 'A numeric parameter needs a dimension so its units can be compared.' }
  }
  if (input.type === 'enum' && (!input.enumValues || input.enumValues.length === 0)) {
    return { ok: false, error: 'A choice parameter needs at least one allowed value.' }
  }

  // Unique key within the category, without silently clobbering an existing one.
  let key = base
  let n = 2
  const exists = db.prepare('SELECT 1 AS x FROM spec_def WHERE category_id = ? AND key = ?')
  while (exists.get<{ x: number }>(cat.id, key)) {
    key = `${base}_${n++}`
    if (n > 50) return { ok: false, error: 'Could not find a free key for that name.' }
  }

  let id = 0
  db.transaction(() => {
    const ord = db
      .prepare('SELECT COALESCE(MAX(col_order), -1) + 1 AS n FROM spec_def WHERE category_id = ?')
      .get<{ n: number }>(cat.id)!.n

    id = db.prepare(`
      INSERT INTO spec_def (category_id, key, name, type, dimension, unit, better,
                            enum_values, table_visible, col_order, filterable, sortable,
                            unmapped, source, locally_modified)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,1,0,'local',1)
    `).run(
      cat.id, key, name, input.type, input.dimension ?? null, input.unit ?? null,
      input.better ?? 'none',
      input.enumValues ? JSON.stringify(input.enumValues) : null,
      input.tableVisible === false ? 0 : 1, ord,
    ).lastInsertRowid

    // Re-adding something previously removed clears the tombstone.
    db.prepare('DELETE FROM category_removed_spec WHERE category_id = ? AND key = ?')
      .run(cat.id, key)
  })

  return { ok: true, id, key }
}

export interface RemoveSpecResult {
  readonly ok: boolean
  /** Values deleted along with the definition. */
  readonly valuesDeleted: number
  readonly error: string | null
}

/**
 * Remove a parameter from a category.
 *
 * This deletes the values components held for it — which is why the count is
 * returned, so the UI can say exactly what will be lost before you confirm.
 */
export function removeSpecDef(
  db: SqlDriver,
  slug: string,
  key: string,
  now = new Date().toISOString(),
): RemoveSpecResult {
  const row = db
    .prepare(`
      SELECT d.id, d.category_id,
             (SELECT COUNT(*) FROM spec_value v WHERE v.spec_def_id = d.id) AS value_count
      FROM spec_def d
      WHERE d.key = ? AND d.category_id = (SELECT id FROM category WHERE slug = ?)
    `)
    .get<{ id: number; category_id: number; value_count: number }>(key, slug)
  if (!row) return { ok: false, valuesDeleted: 0, error: `No parameter "${key}" in this category.` }

  db.transaction(() => {
    db.prepare('DELETE FROM spec_def WHERE id = ?').run(row.id)
    db.prepare(`
      INSERT OR REPLACE INTO category_removed_spec (category_id, key, removed_at) VALUES (?,?,?)
    `).run(row.category_id, key, now)
    // Any ranking rule that pointed at it would otherwise rank on a dead field.
    db.prepare('DELETE FROM ranking_rule WHERE category_id = ? AND field = ?').run(row.category_id, key)
    db.prepare('DELETE FROM ranking_requirement WHERE category_id = ? AND field = ?').run(row.category_id, key)
  })

  return { ok: true, valuesDeleted: row.value_count, error: null }
}

export interface UpdateSpecPatch {
  readonly name?: string
  readonly unit?: string | null
  readonly better?: Better
  readonly tableVisible?: boolean
  readonly colOrder?: number
}

/**
 * Edit a parameter. Any edit marks it locally modified, so a later sync keeps
 * your version and reports it rather than overwriting.
 */
export function updateSpecDef(
  db: SqlDriver,
  slug: string,
  key: string,
  patch: UpdateSpecPatch,
): { ok: boolean; error: string | null } {
  const row = db
    .prepare(`
      SELECT id FROM spec_def
      WHERE key = ? AND category_id = (SELECT id FROM category WHERE slug = ?)
    `)
    .get<{ id: number }>(key, slug)
  if (!row) return { ok: false, error: `No parameter "${key}" in this category.` }

  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: 'A parameter needs a name.' }
    sets.push('name = ?'); params.push(patch.name.trim())
  }
  if (patch.unit !== undefined) { sets.push('unit = ?'); params.push(patch.unit) }
  if (patch.better !== undefined) { sets.push('better = ?'); params.push(patch.better) }
  if (patch.tableVisible !== undefined) {
    sets.push('table_visible = ?'); params.push(patch.tableVisible ? 1 : 0)
  }
  if (patch.colOrder !== undefined) { sets.push('col_order = ?'); params.push(patch.colOrder) }
  if (sets.length === 0) return { ok: true, error: null }

  sets.push('locally_modified = 1')
  params.push(row.id)
  db.prepare(`UPDATE spec_def SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return { ok: true, error: null }
}

/** Keys deliberately removed from a category, so sync does not re-add them. */
export function removedSpecKeys(db: SqlDriver, categoryId: number): Set<string> {
  return new Set(
    db
      .prepare('SELECT key FROM category_removed_spec WHERE category_id = ?')
      .all<{ key: string }>(categoryId)
      .map((r) => r.key),
  )
}
