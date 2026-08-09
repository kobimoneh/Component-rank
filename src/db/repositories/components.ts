import type { SqlDriver } from '../driver.js'
import type { CategoryRow, CellValue, ColumnDef, SearchHit } from '../../shared/ipc.js'
import {
  axis,
  footprint,
  formatArea,
  formatDimensions,
  type PackageDimensions,
} from '../../domain/physical/package.js'
import { rankComponents, type RankableRow } from '../../domain/ranking/rank.js'
import { formatQuantity, toCanonical, type Quantity } from '../../domain/units/index.js'
import type { DimensionId } from '../../domain/units/dimensions.js'
import type { RankingRequirement, RankingRule } from '../../domain/categories/model.js'

/** Case- and separator-insensitive form used for duplicate detection. */
export function normalizeMpn(mpn: string): string {
  return mpn.trim().toUpperCase().replace(/[\s_/]+/g, '-').replace(/-+/g, '-')
}

export function normalizeManufacturer(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function upsertManufacturer(db: SqlDriver, name: string): number {
  const norm = normalizeManufacturer(name)
  const found = db.prepare('SELECT id FROM manufacturer WHERE name_norm = ?').get<{ id: number }>(norm)
  if (found) return found.id
  return db.prepare('INSERT INTO manufacturer (name, name_norm) VALUES (?,?)').run(name.trim(), norm)
    .lastInsertRowid
}

export interface DuplicateMatch {
  readonly id: number
  readonly mpn: string
  readonly manufacturer: string
}

/** Duplicate detection on manufacturer + normalized MPN. Never overwrites. */
export function findDuplicate(db: SqlDriver, manufacturer: string, mpn: string): DuplicateMatch | null {
  return (
    db
      .prepare(`
        SELECT c.id, c.mpn, m.name AS manufacturer
        FROM component c JOIN manufacturer m ON m.id = c.manufacturer_id
        WHERE m.name_norm = ? AND c.mpn_norm = ?
      `)
      .get<DuplicateMatch>(normalizeManufacturer(manufacturer), normalizeMpn(mpn)) ?? null
  )
}

interface SpecDefRow {
  id: number
  key: string
  name: string
  type: string
  dimension: string | null
  unit: string | null
  unit_label: string | null
  better: string
  table_visible: number
  col_order: number
}

interface ComponentRowRaw {
  id: number
  mpn: string
  manufacturer: string
  lifecycle: string
  favorite: number
  pkg_type: string | null
  pkg_name: string | null
  x_min: number | null; x_nom: number | null; x_max: number | null
  y_min: number | null; y_nom: number | null; y_max: number | null
  z_min: number | null; z_nom: number | null; z_max: number | null
  pkg_unverified: number | null
}

interface SpecValueRow {
  component_id: number
  spec_def_id: number
  kind: string
  num_min: number | null
  num_typ: number | null
  num_max: number | null
  display_unit: string | null
  bool_val: number | null
  text_val: string | null
  enum_val: string | null
  origin: string
  is_unverified: number
}

function packageOf(r: ComponentRowRaw): PackageDimensions {
  return {
    x: axis(r.x_min, r.x_nom, r.x_max),
    y: axis(r.y_min, r.y_nom, r.y_max),
    z: axis(r.z_min, r.z_nom, r.z_max),
  }
}

function cell(text: string | null, sort: number | null, unverified = false, origin: CellValue['origin'] = null): CellValue {
  return { text, sort, unverified, origin }
}

function formatSpecValue(v: SpecValueRow, def: SpecDefRow): { text: string | null; sort: number | null } {
  switch (def.type) {
    case 'scalar':
    case 'range': {
      if (v.num_min === null && v.num_typ === null && v.num_max === null) return { text: null, sort: null }
      const q: Quantity = {
        kind: def.type === 'range' ? 'range' : 'scalar',
        dimension: (def.dimension ?? 'count') as DimensionId,
        displayUnit: v.display_unit ?? def.unit ?? '',
        min: v.num_min,
        typ: v.num_typ,
        max: v.num_max,
      }
      const unit = def.unit ?? v.display_unit ?? undefined
      return {
        text: formatQuantity(q, unit ? { unit } : {}),
        sort: v.num_typ ?? v.num_max ?? v.num_min,
      }
    }
    case 'number':
      return v.num_typ === null
        ? { text: null, sort: null }
        : { text: String(v.num_typ), sort: v.num_typ }
    case 'bool':
      return v.bool_val === null
        ? { text: null, sort: null }
        : { text: v.bool_val ? 'Yes' : 'No', sort: v.bool_val }
    case 'enum':
      return { text: v.enum_val, sort: null }
    default:
      return { text: v.text_val, sort: null }
  }
}

export function categoryColumns(db: SqlDriver, slug: string): ColumnDef[] {
  const defs = db
    .prepare(`
      SELECT key, name, type, dimension, unit, unit_label, better, table_visible, col_order
      FROM spec_def WHERE category_id = (SELECT id FROM category WHERE slug = ?)
        AND table_visible = 1
      ORDER BY col_order
    `)
    .all<SpecDefRow>(slug)

  return [
    { key: 'mpn', label: 'Part number', unit: null, numeric: false, better: 'none' },
    { key: 'manufacturer', label: 'Manufacturer', unit: null, numeric: false, better: 'none' },
    { key: '@dimensions', label: 'Dimensions', unit: null, numeric: false, better: 'none' },
    { key: '@ic_area', label: 'IC size', unit: 'mm²', numeric: true, better: 'lower' },
    { key: '@gross_area', label: 'Gross size', unit: 'mm²', numeric: true, better: 'lower' },
    ...defs.map((d) => ({
      key: d.key,
      label: d.name,
      unit: d.unit ?? d.unit_label ?? null,
      numeric: d.type === 'scalar' || d.type === 'range' || d.type === 'number',
      better: d.better as ColumnDef['better'],
    })),
    { key: 'package', label: 'Package', unit: null, numeric: false, better: 'none' },
  ]
}

export function listCategoryRows(db: SqlDriver, slug: string, search?: string): CategoryRow[] {
  const cat = db
    .prepare('SELECT id FROM category WHERE slug = ?')
    .get<{ id: number }>(slug)
  if (!cat) return []

  const defs = db
    .prepare(`
      SELECT id, key, name, type, dimension, unit, unit_label, better, table_visible, col_order
      FROM spec_def WHERE category_id = ? ORDER BY col_order
    `)
    .all<SpecDefRow>(cat.id)
  const defById = new Map(defs.map((d) => [d.id, d]))

  const like = search && search.trim() ? `%${search.trim().toLowerCase()}%` : null
  const raw = db
    .prepare(`
      SELECT c.id, c.mpn, m.name AS manufacturer, c.lifecycle, c.favorite,
             p.type AS pkg_type, p.name AS pkg_name,
             p.x_min, p.x_nom, p.x_max, p.y_min, p.y_nom, p.y_max,
             p.z_min, p.z_nom, p.z_max, p.is_unverified AS pkg_unverified
      FROM component_category cc
      JOIN component c ON c.id = cc.component_id
      JOIN manufacturer m ON m.id = c.manufacturer_id
      LEFT JOIN package p ON p.component_id = c.id
      WHERE cc.category_id = ?
        AND (? IS NULL OR LOWER(c.mpn) LIKE ? OR LOWER(m.name) LIKE ?)
      ORDER BY c.mpn
    `)
    .all<ComponentRowRaw>(cat.id, like, like, like)

  if (raw.length === 0) return []

  const ids = raw.map((r) => r.id)
  const values = db
    .prepare(`
      SELECT component_id, spec_def_id, kind, num_min, num_typ, num_max, display_unit,
             bool_val, text_val, enum_val, origin, is_unverified
      FROM spec_value WHERE component_id IN (${ids.map(() => '?').join(',')})
    `)
    .all<SpecValueRow>(...ids)

  const byComponent = new Map<number, SpecValueRow[]>()
  for (const v of values) {
    const list = byComponent.get(v.component_id) ?? []
    list.push(v)
    byComponent.set(v.component_id, list)
  }

  const rules = db
    .prepare('SELECT field, direction, missing_policy FROM ranking_rule WHERE category_id = ? ORDER BY ord')
    .all<{ field: string; direction: string; missing_policy: string }>(cat.id)
    .map((r) => ({ field: r.field, direction: r.direction, missing: r.missing_policy }) as RankingRule)

  const requirements = db
    .prepare('SELECT field, op, value, unit, note FROM ranking_requirement WHERE category_id = ?')
    .all<RankingRequirement>(cat.id)

  // Build cells and the parallel rankable view in one pass.
  const cells = new Map<number, Record<string, CellValue>>()
  const rankable: RankableRow[] = []

  for (const r of raw) {
    const pkg = packageOf(r)
    const fp = footprint(pkg)
    const unverified = r.pkg_unverified === 1
    const numeric: Record<string, number | null> = {}
    const ranges: Record<string, { min: number | null; max: number | null }> = {}
    const bools: Record<string, boolean | null> = {}
    const unverifiedFields: string[] = []

    numeric['@ic_area'] = fp?.areaMm2 ?? null
    if (unverified && fp) unverifiedFields.push('@ic_area')
    numeric['@gross_area'] = null // set once a solution profile exists

    const row: Record<string, CellValue> = {
      mpn: cell(r.mpn, null),
      manufacturer: cell(r.manufacturer, null),
      '@ic_area': cell(
        fp ? formatArea(fp.areaMm2) : null,
        fp?.areaMm2 ?? null,
        unverified,
        unverified ? 'imported' : null,
      ),
      '@gross_area': cell(null, null),
      package: cell(
        r.pkg_name ?? r.pkg_type ?? null,
        null,
        unverified,
      ),
    }

    for (const v of byComponent.get(r.id) ?? []) {
      const def = defById.get(v.spec_def_id)
      if (!def) continue
      const f = formatSpecValue(v, def)
      row[def.key] = cell(f.text, f.sort, v.is_unverified === 1, v.origin as CellValue['origin'])
      if (def.type === 'range') ranges[def.key] = { min: v.num_min, max: v.num_max }
      else if (def.type === 'bool') bools[def.key] = v.bool_val === null ? null : v.bool_val === 1
      else numeric[def.key] = f.sort
      if (v.is_unverified === 1) unverifiedFields.push(def.key)
    }

    // Dimensions belong in the row too, for the size column and the drawer.
    row['@dimensions'] = cell(formatDimensions(pkg), null, unverified)

    cells.set(r.id, row)
    rankable.push({ id: r.id, numeric, ranges, bools, unverifiedFields })
  }

  const ranked = rankComponents(rankable, rules, requirements, (v, u) => toCanonical(v, u))
  const rankById = new Map(ranked.map((x) => [x.id, x]))

  return raw.map((r) => {
    const rk = rankById.get(r.id)
    return {
      id: r.id,
      mpn: r.mpn,
      manufacturer: r.manufacturer,
      rank: rk?.rank ?? null,
      unrankedReason: rk?.unrankedReason ?? null,
      failedRequirements: rk?.failedRequirements ?? [],
      lifecycle: r.lifecycle,
      favorite: r.favorite === 1,
      cells: cells.get(r.id) ?? {},
    }
  })
}

export function searchComponents(db: SqlDriver, query: string, limit = 50): SearchHit[] {
  const q = query.trim()
  if (!q) return []
  const like = `%${q.toLowerCase()}%`
  return db
    .prepare(`
      SELECT c.id, c.mpn, m.name AS manufacturer,
             cat.slug AS categorySlug, cat.name AS categoryName
      FROM component c
      JOIN manufacturer m ON m.id = c.manufacturer_id
      LEFT JOIN category cat ON cat.id = c.category_id
      WHERE LOWER(c.mpn) LIKE ? OR LOWER(m.name) LIKE ? OR LOWER(c.notes) LIKE ?
         OR LOWER(cat.name) LIKE ?
      ORDER BY
        CASE WHEN LOWER(c.mpn) LIKE ? THEN 0 ELSE 1 END,
        c.mpn
      LIMIT ?
    `)
    .all<SearchHit>(like, like, like, like, `${q.toLowerCase()}%`, limit)
}

export interface DataQuality {
  readonly missingDimensions: number
  readonly unverifiedDimensions: number
  readonly missingDatasheet: number
}

export function dataQuality(db: SqlDriver): DataQuality {
  const one = (sql: string): number => db.prepare(sql).get<{ n: number }>()?.n ?? 0
  return {
    missingDimensions: one(`
      SELECT COUNT(*) n FROM component c
      LEFT JOIN package p ON p.component_id = c.id
      WHERE p.id IS NULL
         OR (p.x_max IS NULL AND p.x_nom IS NULL AND p.x_min IS NULL)
         OR (p.y_max IS NULL AND p.y_nom IS NULL AND p.y_min IS NULL)
    `),
    unverifiedDimensions: one(`
      SELECT COUNT(*) n FROM package
      WHERE is_unverified = 1
        AND (x_max IS NOT NULL OR x_nom IS NOT NULL OR x_min IS NOT NULL)
        AND (y_max IS NOT NULL OR y_nom IS NOT NULL OR y_min IS NOT NULL)
    `),
    missingDatasheet: one(`
      SELECT COUNT(*) n FROM component c
      WHERE NOT EXISTS (SELECT 1 FROM datasheet d WHERE d.component_id = c.id AND d.url IS NOT NULL)
    `),
  }
}
