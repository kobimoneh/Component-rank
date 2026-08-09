import type { SqlDriver } from '../driver.js'
import type { SpecDefinition } from '../../domain/categories/model.js'
import { coerceSpecInput } from '../../domain/specs/coerce.js'
import { findDuplicate, normalizeMpn, upsertManufacturer } from './components.js'

/**
 * Writes.
 *
 * The load-bearing rule lives here: a value whose `origin` is `manual` is never
 * changed by an extraction or a re-import. `applyExtraction` skips those fields
 * and reports them, so a later datasheet revision produces a diff to approve
 * rather than a silent mutation.
 */

const now = (): string => new Date().toISOString()

export type Lifecycle = 'active' | 'nrnd' | 'eol' | 'obsolete' | 'unknown'

export interface CreateComponentInput {
  readonly manufacturer: string
  readonly mpn: string
  readonly family?: string | null
  readonly categorySlug?: string | null
  readonly lifecycle?: Lifecycle
  readonly productUrl?: string | null
  readonly datasheetUrl?: string | null
  readonly notes?: string
  readonly price1k?: number | null
  readonly package?: {
    readonly type?: string | null
    readonly name?: string | null
    readonly pinCount?: number | null
    readonly xMin?: number | null; readonly xNom?: number | null; readonly xMax?: number | null
    readonly yMin?: number | null; readonly yNom?: number | null; readonly yMax?: number | null
    readonly zMin?: number | null; readonly zNom?: number | null; readonly zMax?: number | null
  }
}

export type CreateResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly duplicate: { id: number; mpn: string; manufacturer: string } }

/**
 * Create a component. A manufacturer + MPN that already exists is reported as a
 * duplicate and nothing is written — the caller offers open / variant / update.
 */
export function createComponent(db: SqlDriver, input: CreateComponentInput): CreateResult {
  const existing = findDuplicate(db, input.manufacturer, input.mpn)
  if (existing) return { ok: false, duplicate: existing }

  let id = 0
  db.transaction(() => {
    const manufacturerId = upsertManufacturer(db, input.manufacturer)
    const categoryId = input.categorySlug
      ? (db.prepare('SELECT id FROM category WHERE slug = ?').get<{ id: number }>(input.categorySlug)?.id ?? null)
      : null
    const ts = now()

    id = db
      .prepare(`
        INSERT INTO component (manufacturer_id, mpn, mpn_norm, family, category_id, lifecycle,
                               product_url, price_1k_usd, notes, origin, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'manual', ?, ?)
      `)
      .run(
        manufacturerId, input.mpn.trim(), normalizeMpn(input.mpn), input.family ?? null,
        categoryId, input.lifecycle ?? 'unknown', input.productUrl ?? null,
        input.price1k ?? null, input.notes ?? '', ts, ts,
      ).lastInsertRowid

    if (categoryId !== null) {
      db.prepare(
        'INSERT OR IGNORE INTO component_category (component_id, category_id, is_primary) VALUES (?,?,1)',
      ).run(id, categoryId)
    }

    const p = input.package
    if (p) {
      db.prepare(`
        INSERT INTO package (component_id, type, name, pin_count,
                             x_min, x_nom, x_max, y_min, y_nom, y_max, z_min, z_nom, z_max,
                             origin, is_unverified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual', 0)
      `).run(
        id, p.type ?? null, p.name ?? null, p.pinCount ?? null,
        p.xMin ?? null, p.xNom ?? null, p.xMax ?? null,
        p.yMin ?? null, p.yNom ?? null, p.yMax ?? null,
        p.zMin ?? null, p.zNom ?? null, p.zMax ?? null,
      )
    }

    if (input.datasheetUrl) {
      db.prepare('INSERT INTO datasheet (component_id, url, added_at) VALUES (?,?,?)')
        .run(id, input.datasheetUrl, ts)
    }
  })

  return { ok: true, id }
}

export interface UpdateComponentPatch {
  readonly family?: string | null
  readonly lifecycle?: Lifecycle
  readonly productUrl?: string | null
  readonly notes?: string
  readonly whereUsed?: string
  readonly price1k?: number | null
  readonly favorite?: boolean
  readonly flag?: 'reference' | 'best_in_class' | 'avoid' | null
}

export function updateComponent(db: SqlDriver, id: number, patch: UpdateComponentPatch): void {
  const sets: string[] = []
  const params: unknown[] = []
  const put = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`)
    params.push(value)
  }
  if (patch.family !== undefined) put('family', patch.family)
  if (patch.lifecycle !== undefined) put('lifecycle', patch.lifecycle)
  if (patch.productUrl !== undefined) put('product_url', patch.productUrl)
  if (patch.notes !== undefined) put('notes', patch.notes)
  if (patch.whereUsed !== undefined) put('where_used', patch.whereUsed)
  if (patch.price1k !== undefined) put('price_1k_usd', patch.price1k)
  if (patch.favorite !== undefined) put('favorite', patch.favorite ? 1 : 0)
  if (patch.flag !== undefined) put('flag', patch.flag)
  if (sets.length === 0) return
  put('updated_at', now())
  params.push(id)
  db.prepare(`UPDATE component SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteComponent(db: SqlDriver, id: number): void {
  db.prepare('DELETE FROM component WHERE id = ?').run(id)
}

export interface PackagePatch {
  readonly type?: string | null
  readonly name?: string | null
  readonly pinCount?: number | null
  readonly xMin?: number | null; readonly xNom?: number | null; readonly xMax?: number | null
  readonly yMin?: number | null; readonly yNom?: number | null; readonly yMax?: number | null
  readonly zMin?: number | null; readonly zNom?: number | null; readonly zMax?: number | null
}

/**
 * Edit package dimensions. A user edit is always `manual` and always clears the
 * unverified flag — you looked at the datasheet, so the number is now confirmed.
 */
export function setPackage(db: SqlDriver, componentId: number, patch: PackagePatch): void {
  const exists = db
    .prepare('SELECT id FROM package WHERE component_id = ?')
    .get<{ id: number }>(componentId)
  if (!exists) {
    db.prepare(`
      INSERT INTO package (component_id, type, name, pin_count,
                           x_min, x_nom, x_max, y_min, y_nom, y_max, z_min, z_nom, z_max,
                           origin, is_unverified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'manual', 0)
    `).run(
      componentId, patch.type ?? null, patch.name ?? null, patch.pinCount ?? null,
      patch.xMin ?? null, patch.xNom ?? null, patch.xMax ?? null,
      patch.yMin ?? null, patch.yNom ?? null, patch.yMax ?? null,
      patch.zMin ?? null, patch.zNom ?? null, patch.zMax ?? null,
    )
    return
  }
  const cols: Record<string, unknown> = {
    type: patch.type, name: patch.name, pin_count: patch.pinCount,
    x_min: patch.xMin, x_nom: patch.xNom, x_max: patch.xMax,
    y_min: patch.yMin, y_nom: patch.yNom, y_max: patch.yMax,
    z_min: patch.zMin, z_nom: patch.zNom, z_max: patch.zMax,
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [col, value] of Object.entries(cols)) {
    if (value === undefined) continue
    sets.push(`${col} = ?`)
    params.push(value)
  }
  sets.push("origin = 'manual'", 'is_unverified = 0', 'unverified_reason = NULL')
  params.push(componentId)
  db.prepare(`UPDATE package SET ${sets.join(', ')} WHERE component_id = ?`).run(...params)
}

/** Confirm imported dimensions as-is, without changing the numbers. */
export function confirmPackage(db: SqlDriver, componentId: number): void {
  db.prepare(`
    UPDATE package SET is_unverified = 0, unverified_reason = NULL, origin = 'manual'
    WHERE component_id = ?
  `).run(componentId)
}

export type SetSpecResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Write a spec value from user input. Always stored with `origin = 'manual'`. */
export function setSpecValue(
  db: SqlDriver,
  componentId: number,
  specDefId: number,
  def: SpecDefinition,
  raw: string,
): SetSpecResult {
  const coerced = coerceSpecInput(def, raw)
  if (!coerced.ok) return { ok: false, error: coerced.error }

  if (coerced.cleared) {
    db.prepare('DELETE FROM spec_value WHERE component_id = ? AND spec_def_id = ?')
      .run(componentId, specDefId)
    return { ok: true }
  }

  const c = coerced.columns
  db.prepare(`
    INSERT INTO spec_value (component_id, spec_def_id, kind, num_min, num_typ, num_max,
                            canonical_unit, display_unit, bool_val, text_val, enum_val,
                            origin, is_unverified, confidence, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'manual', 0, NULL, ?)
    ON CONFLICT (component_id, spec_def_id) DO UPDATE SET
      kind = excluded.kind, num_min = excluded.num_min, num_typ = excluded.num_typ,
      num_max = excluded.num_max, canonical_unit = excluded.canonical_unit,
      display_unit = excluded.display_unit, bool_val = excluded.bool_val,
      text_val = excluded.text_val, enum_val = excluded.enum_val,
      origin = 'manual', is_unverified = 0, confidence = NULL, updated_at = excluded.updated_at
  `).run(
    componentId, specDefId, c.kind, c.numMin, c.numTyp, c.numMax,
    c.canonicalUnit, c.displayUnit, c.boolVal, c.textVal, c.enumVal, now(),
  )
  return { ok: true }
}

// ------------------------------------------------------------- solution size

export function createProfile(
  db: SqlDriver,
  componentId: number,
  name: string,
  makeDefault = false,
): number {
  let id = 0
  db.transaction(() => {
    if (makeDefault) {
      db.prepare('UPDATE solution_profile SET is_default = 0 WHERE component_id = ?').run(componentId)
    }
    const ord = db
      .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM solution_profile WHERE component_id = ?')
      .get<{ n: number }>(componentId)!.n
    const hasAny = db
      .prepare('SELECT COUNT(*) n FROM solution_profile WHERE component_id = ?')
      .get<{ n: number }>(componentId)!.n
    id = db
      .prepare('INSERT INTO solution_profile (component_id, name, is_default, ord) VALUES (?,?,?,?)')
      .run(componentId, name, makeDefault || hasAny === 0 ? 1 : 0, ord).lastInsertRowid
  })
  return id
}

export function setDefaultProfile(db: SqlDriver, componentId: number, profileId: number): void {
  db.transaction(() => {
    db.prepare('UPDATE solution_profile SET is_default = 0 WHERE component_id = ?').run(componentId)
    db.prepare('UPDATE solution_profile SET is_default = 1 WHERE id = ? AND component_id = ?')
      .run(profileId, componentId)
  })
}

export function deleteProfile(db: SqlDriver, profileId: number): void {
  db.prepare('DELETE FROM solution_profile WHERE id = ?').run(profileId)
}

export interface OverridePatch {
  readonly widthMm: number | null
  readonly heightMm: number | null
  readonly areaMm2: number | null
  readonly note: string | null
}

/** Set or clear the manual gross-size override. */
export function setOverride(db: SqlDriver, profileId: number, patch: OverridePatch | null): void {
  if (patch === null) {
    db.prepare(`
      UPDATE solution_profile
      SET override_w = NULL, override_h = NULL, override_area = NULL, override_note = NULL
      WHERE id = ?
    `).run(profileId)
    return
  }
  db.prepare(`
    UPDATE solution_profile
    SET override_w = ?, override_h = ?, override_area = ?, override_note = ?
    WHERE id = ?
  `).run(patch.widthMm, patch.heightMm, patch.areaMm2, patch.note, profileId)
}

export interface ExternalInput {
  readonly name: string
  readonly function?: string
  readonly qty?: number
  readonly necessity?: 'required' | 'recommended' | 'optional' | 'configuration'
  readonly valueText?: string | null
  readonly packageName?: string | null
  readonly xMm?: number | null
  readonly yMm?: number | null
  readonly zMm?: number | null
  readonly included?: boolean
  readonly notes?: string | null
  readonly sourceRef?: string | null
}

export function addExternal(db: SqlDriver, profileId: number, input: ExternalInput): number {
  const ord = db
    .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM external_part WHERE profile_id = ?')
    .get<{ n: number }>(profileId)!.n
  return db
    .prepare(`
      INSERT INTO external_part (profile_id, name, function, qty, necessity, value_text,
                                 package_name, x_mm, y_mm, z_mm, included, notes, source_ref, ord)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    .run(
      profileId, input.name, input.function ?? '', input.qty ?? 1,
      input.necessity ?? 'required', input.valueText ?? null, input.packageName ?? null,
      input.xMm ?? null, input.yMm ?? null, input.zMm ?? null,
      input.included === false ? 0 : 1, input.notes ?? null, input.sourceRef ?? null, ord,
    ).lastInsertRowid
}

export function updateExternal(db: SqlDriver, id: number, input: Partial<ExternalInput>): void {
  const cols: Record<string, unknown> = {
    name: input.name, function: input.function, qty: input.qty, necessity: input.necessity,
    value_text: input.valueText, package_name: input.packageName,
    x_mm: input.xMm, y_mm: input.yMm, z_mm: input.zMm,
    included: input.included === undefined ? undefined : input.included ? 1 : 0,
    notes: input.notes, source_ref: input.sourceRef,
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [col, value] of Object.entries(cols)) {
    if (value === undefined) continue
    sets.push(`${col} = ?`)
    params.push(value)
  }
  if (sets.length === 0) return
  params.push(id)
  db.prepare(`UPDATE external_part SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteExternal(db: SqlDriver, id: number): void {
  db.prepare('DELETE FROM external_part WHERE id = ?').run(id)
}

export function setExternalIncluded(db: SqlDriver, id: number, included: boolean): void {
  db.prepare('UPDATE external_part SET included = ? WHERE id = ?').run(included ? 1 : 0, id)
}

// ------------------------------------------------------- extraction merging

export interface ExtractedField {
  readonly specKey: string
  readonly raw: string
  readonly confidence: number
  readonly page: number | null
  readonly evidence: string | null
  readonly evidenceVerified: boolean
}

export interface FieldOutcome {
  readonly specKey: string
  readonly status: 'written' | 'kept-manual' | 'rejected' | 'unchanged'
  readonly oldValue: string | null
  readonly newValue: string | null
  readonly reason: string | null
}

/**
 * Merge approved extraction results into a component.
 *
 * A field whose current value is `manual` is **never** overwritten. It comes back
 * as `kept-manual` with both values so the UI can offer the change explicitly.
 * A field whose evidence failed verification is rejected outright.
 */
export function applyExtraction(
  db: SqlDriver,
  componentId: number,
  categoryId: number,
  fields: readonly ExtractedField[],
  opts: { readonly acceptManualOverwrites?: readonly string[] } = {},
): FieldOutcome[] {
  const allow = new Set(opts.acceptManualOverwrites ?? [])
  const outcomes: FieldOutcome[] = []

  const defRow = db.prepare(`
    SELECT id, key, name, type, dimension, unit, unit_label, better, enum_values
    FROM spec_def WHERE category_id = ? AND key = ?
  `)

  db.transaction(() => {
    for (const f of fields) {
      const row = defRow.get<{
        id: number; key: string; name: string; type: string
        dimension: string | null; unit: string | null; unit_label: string | null
        better: string; enum_values: string | null
      }>(categoryId, f.specKey)
      if (!row) {
        outcomes.push({
          specKey: f.specKey, status: 'rejected', oldValue: null, newValue: f.raw,
          reason: 'No such specification in this category.',
        })
        continue
      }

      if (!f.evidenceVerified) {
        outcomes.push({
          specKey: f.specKey, status: 'rejected', oldValue: null, newValue: f.raw,
          reason: 'Evidence could not be found on the cited page.',
        })
        continue
      }

      const current = db
        .prepare('SELECT origin, num_typ, text_val, enum_val, bool_val FROM spec_value WHERE component_id = ? AND spec_def_id = ?')
        .get<{ origin: string; num_typ: number | null; text_val: string | null; enum_val: string | null; bool_val: number | null }>(
          componentId, row.id,
        )
      const oldValue = current
        ? String(current.num_typ ?? current.text_val ?? current.enum_val ?? current.bool_val ?? '')
        : null

      if (current?.origin === 'manual' && !allow.has(f.specKey)) {
        outcomes.push({
          specKey: f.specKey, status: 'kept-manual', oldValue, newValue: f.raw,
          reason: 'You edited this value; extraction will not overwrite it.',
        })
        continue
      }

      const def: SpecDefinition = {
        key: row.key, name: row.name, type: row.type as SpecDefinition['type'],
        ...(row.dimension ? { dimension: row.dimension as SpecDefinition['dimension'] } : {}),
        ...(row.unit ? { unit: row.unit } : {}),
        ...(row.unit_label ? { unitLabel: row.unit_label } : {}),
        better: row.better as SpecDefinition['better'],
        ...(row.enum_values ? { enumValues: JSON.parse(row.enum_values) as string[] } : {}),
        table: false, filterable: true, sortable: true, unmapped: false,
      }
      const coerced = coerceSpecInput(def, f.raw)
      if (!coerced.ok) {
        outcomes.push({
          specKey: f.specKey, status: 'rejected', oldValue, newValue: f.raw,
          reason: coerced.error,
        })
        continue
      }

      const c = coerced.columns
      db.prepare(`
        INSERT INTO spec_value (component_id, spec_def_id, kind, num_min, num_typ, num_max,
                                canonical_unit, display_unit, bool_val, text_val, enum_val,
                                origin, is_unverified, confidence, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'extracted', 0, ?, ?)
        ON CONFLICT (component_id, spec_def_id) DO UPDATE SET
          kind = excluded.kind, num_min = excluded.num_min, num_typ = excluded.num_typ,
          num_max = excluded.num_max, canonical_unit = excluded.canonical_unit,
          display_unit = excluded.display_unit, bool_val = excluded.bool_val,
          text_val = excluded.text_val, enum_val = excluded.enum_val,
          origin = 'extracted', confidence = excluded.confidence, updated_at = excluded.updated_at
      `).run(
        componentId, row.id, c.kind, c.numMin, c.numTyp, c.numMax,
        c.canonicalUnit, c.displayUnit, c.boolVal, c.textVal, c.enumVal,
        f.confidence, now(),
      )

      const valueId = db
        .prepare('SELECT id FROM spec_value WHERE component_id = ? AND spec_def_id = ?')
        .get<{ id: number }>(componentId, row.id)!.id

      db.prepare(`
        INSERT INTO provenance (subject_type, subject_id, page, evidence, evidence_verified,
                                confidence, model, extracted_at)
        VALUES ('spec_value', ?, ?, ?, 1, ?, NULL, ?)
      `).run(valueId, f.page, f.evidence, f.confidence, now())

      outcomes.push({
        specKey: f.specKey,
        status: oldValue === null ? 'written' : oldValue === f.raw ? 'unchanged' : 'written',
        oldValue, newValue: f.raw, reason: null,
      })
    }
  })

  return outcomes
}

// ------------------------------------------------------------------- tagging

export function setTags(db: SqlDriver, componentId: number, tags: readonly string[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM component_tag WHERE component_id = ?').run(componentId)
    const insert = db.prepare('INSERT OR IGNORE INTO component_tag (component_id, tag) VALUES (?,?)')
    for (const tag of tags) {
      const clean = tag.trim().replace(/^#/, '').toLowerCase()
      if (clean) insert.run(componentId, clean)
    }
  })
}

export function touchRecentlyViewed(db: SqlDriver, componentId: number): void {
  db.prepare(`
    INSERT INTO recently_viewed (component_id, viewed_at) VALUES (?,?)
    ON CONFLICT (component_id) DO UPDATE SET viewed_at = excluded.viewed_at
  `).run(componentId, now())
}
