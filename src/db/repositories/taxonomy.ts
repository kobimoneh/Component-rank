import type { SqlDriver } from '../driver.js'

/**
 * Rearranging the library: sections, families, and which family a part is in.
 *
 * Vocabulary, because the schema and the screen use different words for the same
 * things. A **family** is a `category` row — "Tiny LDO", "RF PA 2.4 GHz". A
 * **section** is the rail heading a family sits under — "Power", "RF PA". The
 * database keeps the older names so the importer and every existing query stay
 * put; the UI uses the names you actually say out loud.
 *
 * Three rules run through all of it:
 *
 *  - Nothing is destroyed without being counted first. Deleting a family that
 *    holds the only membership of 40 parts reports those 40 parts and refuses,
 *    rather than quietly leaving them uncategorised.
 *  - A part can be in several families at once — the real component-report data
 *    lists RF1630 as an RF switch for 2.4 GHz, cellular *and* 5–6 GHz — so
 *    "move" and "also add" are different operations and both exist.
 *  - Anything you rearrange survives the next re-import. Placement is pinned,
 *    renames mark the family locally modified, and deletions leave a tombstone.
 */

const now = (): string => new Date().toISOString()

export type Result<T = object> =
  | ({ readonly ok: true; readonly error: null } & T)
  | { readonly ok: false; readonly error: string }

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

// --------------------------------------------------------------------- naming

/** Fold a display name to the key used for uniqueness checks. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * A URL-ish, filename-ish identifier for a family created here. It has to match
 * the shape the imported slugs have (`rf-pa-2400mhz`), because the slug is what
 * every other query and the CSV export key on.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'family'
}

function uniqueSlug(db: SqlDriver, name: string): string {
  const base = slugify(name)
  const taken = (slug: string): boolean =>
    db.prepare('SELECT 1 AS x FROM category WHERE slug = ?').get<{ x: number }>(slug) !== undefined
  if (!taken(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken(candidate)) return candidate
  }
  throw new Error(`Cannot find a free slug for "${name}".`)
}

// ------------------------------------------------------------------- sections

export interface SectionRow {
  readonly id: number
  readonly name: string
  readonly sortOrder: number
  readonly familyCount: number
}

export function listSections(db: SqlDriver): SectionRow[] {
  return db
    .prepare(`
      SELECT s.id, s.name, s.sort_order AS sortOrder,
             (SELECT COUNT(*) FROM category c WHERE c.section_id = s.id) AS familyCount
      FROM section s
      ORDER BY s.sort_order, s.name
    `)
    .all<SectionRow>()
}

export function createSection(db: SqlDriver, name: string): Result<{ id: number }> {
  const clean = name.trim()
  if (!clean) return fail('A section needs a name.')
  const norm = normalizeName(clean)
  const clash = db
    .prepare('SELECT name FROM section WHERE name_norm = ?')
    .get<{ name: string }>(norm)
  if (clash) return fail(`There is already a section called "${clash.name}".`)

  // New sections land at the end, ahead of the "Other" catch-all so a section
  // you just made is not buried under the leftovers.
  const max = db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM section WHERE name <> 'Other'")
    .get<{ n: number }>()!.n
  const id = db
    .prepare('INSERT INTO section (name, name_norm, sort_order, created_at) VALUES (?,?,?,?)')
    .run(clean, norm, max + 10, now()).lastInsertRowid
  return { ok: true, error: null, id }
}

export function renameSection(db: SqlDriver, id: number, name: string): Result {
  const clean = name.trim()
  if (!clean) return fail('A section needs a name.')
  const norm = normalizeName(clean)
  const clash = db
    .prepare('SELECT id, name FROM section WHERE name_norm = ? AND id <> ?')
    .get<{ id: number; name: string }>(norm, id)
  if (clash) return fail(`There is already a section called "${clash.name}".`)
  const res = db
    .prepare('UPDATE section SET name = ?, name_norm = ? WHERE id = ?')
    .run(clean, norm, id)
  if (res.changes === 0) return fail('That section no longer exists.')
  return { ok: true, error: null }
}

/**
 * Delete a section. Its families are never deleted with it — they move to
 * `reassignTo`, or become ungrouped, and are pinned there so a re-sync does not
 * pull them back to a heading you just got rid of.
 */
export function deleteSection(db: SqlDriver, id: number, reassignTo: number | null): Result<{ movedFamilies: number }> {
  const row = db.prepare('SELECT id FROM section WHERE id = ?').get<{ id: number }>(id)
  if (!row) return fail('That section no longer exists.')
  if (reassignTo === id) return fail('A section cannot be moved into itself.')
  if (reassignTo !== null) {
    const target = db.prepare('SELECT id FROM section WHERE id = ?').get<{ id: number }>(reassignTo)
    if (!target) return fail('The section to move the families into no longer exists.')
  }

  let moved = 0
  db.transaction(() => {
    moved = db
      .prepare('UPDATE category SET section_id = ?, section_pinned = 1 WHERE section_id = ?')
      .run(reassignTo, id).changes
    db.prepare('DELETE FROM section WHERE id = ?').run(id)
  })
  return { ok: true, error: null, movedFamilies: moved }
}

/** Move a section one place up or down the rail. */
export function moveSection(db: SqlDriver, id: number, direction: 'up' | 'down'): Result {
  const ordered = listSections(db)
  const index = ordered.findIndex((s) => s.id === id)
  if (index === -1) return fail('That section no longer exists.')
  const swapWith = direction === 'up' ? index - 1 : index + 1
  if (swapWith < 0 || swapWith >= ordered.length) return { ok: true, error: null }

  // Rewrite the whole order rather than swapping two values: the seeded orders
  // have gaps and duplicates are possible, so a swap is not always a move.
  const next = [...ordered]
  const a = next[index]!
  next[index] = next[swapWith]!
  next[swapWith] = a
  db.transaction(() => {
    const update = db.prepare('UPDATE section SET sort_order = ? WHERE id = ?')
    next.forEach((s, i) => update.run((i + 1) * 10, s.id))
  })
  return { ok: true, error: null }
}

/** Put a family under a section (or nowhere), and remember that you chose. */
export function moveFamilyToSection(db: SqlDriver, slug: string, sectionId: number | null): Result {
  if (sectionId !== null) {
    const target = db.prepare('SELECT id FROM section WHERE id = ?').get<{ id: number }>(sectionId)
    if (!target) return fail('That section no longer exists.')
  }
  const res = db
    .prepare('UPDATE category SET section_id = ?, section_pinned = 1, updated_at = ? WHERE slug = ?')
    .run(sectionId, now(), slug)
  if (res.changes === 0) return fail('That family no longer exists.')
  return { ok: true, error: null }
}

// ------------------------------------------------------------------- families

export interface CreateFamilyInput {
  readonly name: string
  readonly sectionId?: number | null
  /** Copy the parameter definitions of an existing family, but none of its parts. */
  readonly copyParametersFrom?: string | null
}

export function createFamily(db: SqlDriver, input: CreateFamilyInput): Result<{ slug: string }> {
  const clean = input.name.trim()
  if (!clean) return fail('A family needs a name.')
  const clash = db
    .prepare('SELECT name FROM category WHERE lower(name) = ?')
    .get<{ name: string }>(clean.toLowerCase())
  if (clash) return fail(`There is already a family called "${clash.name}".`)

  const sectionName = input.sectionId
    ? db.prepare('SELECT name FROM section WHERE id = ?').get<{ name: string }>(input.sectionId)?.name
    : null

  const slug = uniqueSlug(db, clean)
  const ts = now()

  db.transaction(() => {
    const id = db
      .prepare(`
        INSERT INTO category (slug, name, group_name, description, metric_prose,
                              ranking_unresolved, sort_order, source, source_hash,
                              locally_modified, created_at, updated_at,
                              section_id, section_pinned)
        VALUES (?,?,?,'','',0,?, 'local', NULL, 0, ?, ?, ?, 1)
      `)
      .run(
        slug, clean, sectionName ?? 'Other',
        db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM category').get<{ n: number }>()!.n,
        ts, ts, input.sectionId ?? null,
      ).lastInsertRowid

    if (input.copyParametersFrom) {
      // Parameters only. Copying the parts as well would create a second family
      // that claims to hold the same components, which is what "also add to
      // family" is for.
      db.prepare(`
        INSERT INTO spec_def (category_id, key, name, type, dimension, unit, unit_label, better,
                              enum_values, table_visible, col_order, filterable, sortable,
                              ai_hint, unmapped, source_phrase, source, locally_modified)
        SELECT ?, key, name, type, dimension, unit, unit_label, better,
               enum_values, table_visible, col_order, filterable, sortable,
               ai_hint, unmapped, source_phrase, 'local', 0
        FROM spec_def WHERE category_id = (SELECT id FROM category WHERE slug = ?)
      `).run(id, input.copyParametersFrom)

      db.prepare(`
        INSERT INTO ranking_rule (category_id, ord, field, direction, missing_policy)
        SELECT ?, ord, field, direction, missing_policy
        FROM ranking_rule WHERE category_id = (SELECT id FROM category WHERE slug = ?)
      `).run(id, input.copyParametersFrom)

      db.prepare(`
        UPDATE category SET metric_prose = (
          SELECT metric_prose FROM category WHERE slug = ?
        ) WHERE id = ?
      `).run(input.copyParametersFrom, id)
    }
  })

  return { ok: true, error: null, slug }
}

/**
 * Rename a family. This marks it locally modified, which is what stops the next
 * re-import from renaming it back — the same flag the category editor uses.
 */
export function renameFamily(db: SqlDriver, slug: string, name: string): Result {
  const clean = name.trim()
  if (!clean) return fail('A family needs a name.')
  const clash = db
    .prepare('SELECT name FROM category WHERE lower(name) = ? AND slug <> ?')
    .get<{ name: string }>(clean.toLowerCase(), slug)
  if (clash) return fail(`There is already a family called "${clash.name}".`)
  const res = db
    .prepare('UPDATE category SET name = ?, locally_modified = 1, updated_at = ? WHERE slug = ?')
    .run(clean, now(), slug)
  if (res.changes === 0) return fail('That family no longer exists.')
  return { ok: true, error: null }
}

export interface FamilyDeletionImpact {
  readonly name: string
  readonly componentCount: number
  /** Parts whose ONLY family is this one — they would be left uncategorised. */
  readonly orphanCount: number
  readonly parameterCount: number
}

/** What deleting this family would cost, so the question can be asked properly. */
export function familyDeletionImpact(db: SqlDriver, slug: string): FamilyDeletionImpact | null {
  const row = db
    .prepare('SELECT id, name FROM category WHERE slug = ?')
    .get<{ id: number; name: string }>(slug)
  if (!row) return null
  const componentCount = db
    .prepare('SELECT COUNT(*) AS n FROM component_category WHERE category_id = ?')
    .get<{ n: number }>(row.id)!.n
  const orphanCount = db
    .prepare(`
      SELECT COUNT(*) AS n FROM component_category cc
      WHERE cc.category_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM component_category o
          WHERE o.component_id = cc.component_id AND o.category_id <> cc.category_id
        )
    `)
    .get<{ n: number }>(row.id)!.n
  const parameterCount = db
    .prepare('SELECT COUNT(*) AS n FROM spec_def WHERE category_id = ?')
    .get<{ n: number }>(row.id)!.n
  return { name: row.name, componentCount, orphanCount, parameterCount }
}

export interface DeleteFamilyOptions {
  /** Move every part into this family first. Required if any part would be orphaned. */
  readonly reassignTo?: string | null
}

/**
 * Delete a family.
 *
 * Refuses while parts would be left with no family at all, because that state is
 * invisible in a rail organised by family — the parts do not vanish, they just
 * stop being anywhere you can find them. Pass `reassignTo` to move them first.
 * Parts that are also in another family are simply unlinked from this one.
 *
 * Its parameters and their values go with it (`ON DELETE CASCADE`); that is the
 * point of deleting a family, and the impact report says how many.
 */
export function deleteFamily(
  db: SqlDriver,
  slug: string,
  options: DeleteFamilyOptions = {},
): Result<{ movedComponents: number; orphanCount: number }> {
  const impact = familyDeletionImpact(db, slug)
  if (!impact) return fail('That family no longer exists.')

  const reassignTo = options.reassignTo ?? null
  if (reassignTo === slug) return fail('A family cannot be merged into itself.')

  let target: { id: number; name: string } | undefined
  if (reassignTo) {
    target = db
      .prepare('SELECT id, name FROM category WHERE slug = ?')
      .get<{ id: number; name: string }>(reassignTo)
    if (!target) return fail('The family to move the parts into no longer exists.')
  }

  if (!target && impact.orphanCount > 0) {
    return fail(
      `${impact.orphanCount} part${impact.orphanCount === 1 ? ' is' : 's are'} in no other family. ` +
        'Choose a family to move them into first.',
    )
  }

  const row = db.prepare('SELECT id, name FROM category WHERE slug = ?').get<{ id: number; name: string }>(slug)!
  let moved = 0

  db.transaction(() => {
    if (target) {
      // INSERT OR IGNORE: a part already in the target keeps its single row.
      moved = db
        .prepare(`
          INSERT OR IGNORE INTO component_category (component_id, category_id, is_primary)
          SELECT component_id, ?, 0 FROM component_category WHERE category_id = ?
        `)
        .run(target.id, row.id).changes
      // Parts whose primary family was this one now point at the target, rather
      // than at nothing.
      db.prepare('UPDATE component SET category_id = ? WHERE category_id = ?').run(target.id, row.id)
      db.prepare(`
        UPDATE component_category SET is_primary = 1
        WHERE category_id = ? AND component_id IN (SELECT component_id FROM component_category WHERE category_id = ?)
      `).run(target.id, row.id)
    }
    db.prepare('INSERT OR REPLACE INTO deleted_category (slug, name, deleted_at) VALUES (?,?,?)')
      .run(slug, row.name, now())
    db.prepare('DELETE FROM category WHERE id = ?').run(row.id)
  })

  return { ok: true, error: null, movedComponents: moved, orphanCount: impact.orphanCount }
}

/** Slugs deleted here, which `syncCategories` must not resurrect. */
export function deletedFamilySlugs(db: SqlDriver): Set<string> {
  return new Set(
    db.prepare('SELECT slug FROM deleted_category').all<{ slug: string }>().map((r) => r.slug),
  )
}

/** Forget a deletion, so the next re-import may bring the family back. */
export function undeleteFamily(db: SqlDriver, slug: string): void {
  db.prepare('DELETE FROM deleted_category WHERE slug = ?').run(slug)
}

// ------------------------------------------------------------- membership

export type MembershipMode = 'move' | 'add'

export interface MembershipChange {
  readonly moved: number
  readonly alreadyThere: number
}

/**
 * Put parts in a family.
 *
 * `move` removes them from `fromSlug` on the way; `add` leaves every existing
 * membership alone. A part is allowed to be in several families, so the two are
 * genuinely different intentions and the caller has to say which one it means.
 */
export function setComponentFamily(
  db: SqlDriver,
  componentIds: readonly number[],
  toSlug: string,
  mode: MembershipMode,
  fromSlug: string | null = null,
): Result<MembershipChange> {
  if (componentIds.length === 0) return fail('No parts selected.')
  const to = db.prepare('SELECT id, name FROM category WHERE slug = ?').get<{ id: number; name: string }>(toSlug)
  if (!to) return fail('That family no longer exists.')
  if (mode === 'move' && fromSlug === toSlug) {
    return { ok: true, error: null, moved: 0, alreadyThere: componentIds.length }
  }
  const from = fromSlug
    ? db.prepare('SELECT id FROM category WHERE slug = ?').get<{ id: number }>(fromSlug)
    : undefined
  if (mode === 'move' && fromSlug && !from) return fail('The family to move out of no longer exists.')

  let moved = 0
  let alreadyThere = 0

  db.transaction(() => {
    const exists = db.prepare(
      'SELECT 1 AS x FROM component_category WHERE component_id = ? AND category_id = ?',
    )
    const insert = db.prepare(
      'INSERT INTO component_category (component_id, category_id, is_primary) VALUES (?,?,?)',
    )
    for (const id of componentIds) {
      if (exists.get<{ x: number }>(id, to.id)) alreadyThere++
      else {
        insert.run(id, to.id, mode === 'move' ? 1 : 0)
        moved++
      }
      if (mode === 'move') {
        if (from) {
          db.prepare('DELETE FROM component_category WHERE component_id = ? AND category_id = ?')
            .run(id, from.id)
        }
        db.prepare('UPDATE component_category SET is_primary = 0 WHERE component_id = ? AND category_id <> ?')
          .run(id, to.id)
        db.prepare('UPDATE component_category SET is_primary = 1 WHERE component_id = ? AND category_id = ?')
          .run(id, to.id)
        db.prepare('UPDATE component SET category_id = ?, updated_at = ? WHERE id = ?')
          .run(to.id, now(), id)
      }
    }
  })

  return { ok: true, error: null, moved, alreadyThere }
}

/**
 * Take parts out of a family without deleting them. Refuses for any part whose
 * only family is this one — the part would become unreachable in the rail.
 */
export function removeComponentsFromFamily(
  db: SqlDriver,
  componentIds: readonly number[],
  slug: string,
): Result<{ removed: number }> {
  if (componentIds.length === 0) return fail('No parts selected.')
  const cat = db.prepare('SELECT id, name FROM category WHERE slug = ?').get<{ id: number; name: string }>(slug)
  if (!cat) return fail('That family no longer exists.')

  const otherCount = db.prepare(
    'SELECT COUNT(*) AS n FROM component_category WHERE component_id = ? AND category_id <> ?',
  )
  const stranded = componentIds.filter((id) => otherCount.get<{ n: number }>(id, cat.id)!.n === 0)
  if (stranded.length > 0) {
    return fail(
      `${stranded.length} of these parts ${stranded.length === 1 ? 'is' : 'are'} in no other family. ` +
        'Move them somewhere before taking them out of this one.',
    )
  }

  let removed = 0
  db.transaction(() => {
    for (const id of componentIds) {
      removed += db
        .prepare('DELETE FROM component_category WHERE component_id = ? AND category_id = ?')
        .run(id, cat.id).changes
      // Whatever family is left becomes the primary one.
      const next = db
        .prepare('SELECT category_id FROM component_category WHERE component_id = ? ORDER BY is_primary DESC, category_id LIMIT 1')
        .get<{ category_id: number }>(id)
      if (next) {
        db.prepare('UPDATE component_category SET is_primary = 1 WHERE component_id = ? AND category_id = ?')
          .run(id, next.category_id)
        db.prepare('UPDATE component SET category_id = ?, updated_at = ? WHERE id = ?')
          .run(next.category_id, now(), id)
      }
    }
  })
  return { ok: true, error: null, removed }
}

/** Families a part belongs to, primary first. */
export function componentFamilies(db: SqlDriver, componentId: number): Array<{ slug: string; name: string; primary: boolean }> {
  return db
    .prepare(`
      SELECT c.slug, c.name, cc.is_primary AS isPrimary
      FROM component_category cc JOIN category c ON c.id = cc.category_id
      WHERE cc.component_id = ?
      ORDER BY cc.is_primary DESC, c.name
    `)
    .all<{ slug: string; name: string; isPrimary: number }>(componentId)
    .map((r) => ({ slug: r.slug, name: r.name, primary: r.isPrimary === 1 }))
}

export type Lifecycle = 'active' | 'nrnd' | 'eol' | 'obsolete' | 'unknown'

/** Set lifecycle on a selection, from the right-click menu. */
export function setLifecycle(db: SqlDriver, componentIds: readonly number[], lifecycle: Lifecycle): number {
  if (componentIds.length === 0) return 0
  let n = 0
  db.transaction(() => {
    const update = db.prepare('UPDATE component SET lifecycle = ?, updated_at = ? WHERE id = ?')
    const ts = now()
    for (const id of componentIds) n += update.run(lifecycle, ts, id).changes
  })
  return n
}

export function deleteComponents(db: SqlDriver, componentIds: readonly number[]): number {
  if (componentIds.length === 0) return 0
  let n = 0
  db.transaction(() => {
    const del = db.prepare('DELETE FROM component WHERE id = ?')
    for (const id of componentIds) n += del.run(id).changes
  })
  return n
}
