import type { SqlDriver } from '../driver.js'
import type { ComponentDetail } from '../../shared/ipc.js'
import {
  axis,
  footprint,
  formatArea,
  formatDimensions,
  type PackageDimensions,
} from '../../domain/physical/package.js'
import { computeSolutionSize } from '../../domain/gross-size/estimate.js'
import type { ExternalPart, SolutionProfile } from '../../domain/gross-size/model.js'
import { formatQuantity, type Quantity } from '../../domain/units/index.js'
import type { DimensionId } from '../../domain/units/dimensions.js'

interface DetailRow {
  id: number
  mpn: string
  manufacturer: string
  categorySlug: string | null
  categoryName: string | null
  lifecycle: string
  notes: string
  where_used: string
  price_1k_usd: number | null
  favorite: number
  pkg_type: string | null
  pkg_name: string | null
  pin_count: number | null
  x_min: number | null; x_nom: number | null; x_max: number | null
  y_min: number | null; y_nom: number | null; y_max: number | null
  z_min: number | null; z_nom: number | null; z_max: number | null
  pkg_unverified: number | null
  pkg_unverified_reason: string | null
}

interface SpecJoinRow {
  key: string
  name: string
  type: string
  dimension: string | null
  unit: string | null
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

interface ProfileRow {
  id: number
  name: string
  is_default: number
  notes: string | null
  override_w: number | null
  override_h: number | null
  override_area: number | null
  override_note: string | null
}

interface ExternalRow {
  id: number
  name: string
  function: string
  qty: number
  necessity: string
  value_text: string | null
  package_name: string | null
  x_mm: number | null
  y_mm: number | null
  z_mm: number | null
  included: number
  notes: string | null
  source_ref: string | null
}

function toExternal(r: ExternalRow): ExternalPart {
  return {
    id: String(r.id),
    name: r.name,
    function: r.function,
    qty: r.qty,
    necessity: r.necessity as ExternalPart['necessity'],
    valueText: r.value_text,
    packageName: r.package_name,
    xMm: r.x_mm,
    yMm: r.y_mm,
    zMm: r.z_mm,
    included: r.included === 1,
    notes: r.notes,
    sourceRef: r.source_ref,
  }
}

export function componentDetail(db: SqlDriver, id: number): ComponentDetail | null {
  const row = db
    .prepare(`
      SELECT c.id, c.mpn, m.name AS manufacturer,
             cat.slug AS categorySlug, cat.name AS categoryName,
             c.lifecycle, c.notes, c.where_used, c.price_1k_usd, c.favorite,
             p.type AS pkg_type, p.name AS pkg_name, p.pin_count,
             p.x_min, p.x_nom, p.x_max, p.y_min, p.y_nom, p.y_max,
             p.z_min, p.z_nom, p.z_max,
             p.is_unverified AS pkg_unverified, p.unverified_reason AS pkg_unverified_reason
      FROM component c
      JOIN manufacturer m ON m.id = c.manufacturer_id
      LEFT JOIN category cat ON cat.id = c.category_id
      LEFT JOIN package p ON p.component_id = c.id
      WHERE c.id = ?
    `)
    .get<DetailRow>(id)
  if (!row) return null

  const pkg: PackageDimensions = {
    x: axis(row.x_min, row.x_nom, row.x_max),
    y: axis(row.y_min, row.y_nom, row.y_max),
    z: axis(row.z_min, row.z_nom, row.z_max),
  }
  const fp = footprint(pkg)

  const specs = db
    .prepare(`
      SELECT d.key, d.name, d.type, d.dimension, d.unit,
             v.num_min, v.num_typ, v.num_max, v.display_unit,
             v.bool_val, v.text_val, v.enum_val, v.origin, v.is_unverified
      FROM spec_value v
      JOIN spec_def d ON d.id = v.spec_def_id
      WHERE v.component_id = ?
      ORDER BY d.col_order
    `)
    .all<SpecJoinRow>(id)
    .map((s) => {
      let value: string | null = null
      if (s.type === 'scalar' || s.type === 'range') {
        if (s.num_min !== null || s.num_typ !== null || s.num_max !== null) {
          const q: Quantity = {
            kind: s.type === 'range' ? 'range' : 'scalar',
            dimension: (s.dimension ?? 'count') as DimensionId,
            displayUnit: s.display_unit ?? s.unit ?? '',
            min: s.num_min, typ: s.num_typ, max: s.num_max,
          }
          value = formatQuantity(q, s.unit ? { unit: s.unit } : {})
        }
      } else if (s.type === 'number') {
        value = s.num_typ === null ? null : String(s.num_typ)
      } else if (s.type === 'bool') {
        value = s.bool_val === null ? null : s.bool_val ? 'Yes' : 'No'
      } else if (s.type === 'enum') {
        value = s.enum_val
      } else {
        value = s.text_val
      }
      return {
        key: s.key,
        label: s.name,
        value,
        unverified: s.is_unverified === 1,
        origin: s.origin,
      }
    })

  const profileRow = db
    .prepare(`
      SELECT id, name, is_default, notes, override_w, override_h, override_area, override_note
      FROM solution_profile WHERE component_id = ?
      ORDER BY is_default DESC, ord, id LIMIT 1
    `)
    .get<ProfileRow>(id)

  const externalRows = profileRow
    ? db
        .prepare(`
          SELECT id, name, function, qty, necessity, value_text, package_name,
                 x_mm, y_mm, z_mm, included, notes, source_ref
          FROM external_part WHERE profile_id = ? ORDER BY ord, id
        `)
        .all<ExternalRow>(profileRow.id)
    : []

  const profile: SolutionProfile | null = profileRow
    ? {
        id: String(profileRow.id),
        name: profileRow.name,
        isDefault: profileRow.is_default === 1,
        notes: profileRow.notes,
        externals: externalRows.map(toExternal),
        override:
          profileRow.override_w !== null ||
          profileRow.override_h !== null ||
          profileRow.override_area !== null
            ? {
                widthMm: profileRow.override_w,
                heightMm: profileRow.override_h,
                areaMm2: profileRow.override_area,
                note: profileRow.override_note,
              }
            : null,
      }
    : null

  // No profile means the solution has not been defined yet. Gross size stays
  // unknown rather than quietly reporting the IC footprint as a solution size.
  const solution = profile
    ? computeSolutionSize({ icPackage: fp ? pkg : null, profile })
    : null

  const datasheet = db
    .prepare('SELECT url FROM datasheet WHERE component_id = ? AND url IS NOT NULL LIMIT 1')
    .get<{ url: string }>(id)

  return {
    id: row.id,
    mpn: row.mpn,
    manufacturer: row.manufacturer,
    categorySlug: row.categorySlug,
    categoryName: row.categoryName,
    lifecycle: row.lifecycle,
    notes: row.notes,
    whereUsed: row.where_used ?? '',
    datasheetUrl: datasheet?.url ?? null,
    price1k: row.price_1k_usd,
    favorite: row.favorite === 1,
    package: {
      type: row.pkg_type,
      name: row.pkg_name,
      pinCount: row.pin_count,
      dimensionsText: formatDimensions(pkg),
      basis: fp?.basis ?? null,
      icAreaMm2: fp?.areaMm2 ?? null,
      unverified: row.pkg_unverified === 1,
      unverifiedReason: row.pkg_unverified_reason,
    },
    specs,
    solution: {
      profileName: profile?.name ?? null,
      icAreaMm2: solution?.icAreaMm2 ?? fp?.areaMm2 ?? null,
      externalAreaMm2: solution?.externalAreaMm2 ?? null,
      grossComponentAreaMm2: solution?.grossComponentAreaMm2 ?? null,
      estimateText: solution?.estimate
        ? `${solution.estimate.widthMm.toFixed(2)} × ${solution.estimate.heightMm.toFixed(2)} mm — ${formatArea(solution.estimate.areaMm2)}`
        : null,
      effectiveAreaMm2: solution?.effective?.areaMm2 ?? null,
      origin: solution?.effective?.origin ?? null,
      warnings: solution?.warnings ?? [],
      externals: externalRows.map((e) => ({
        id: e.id,
        name: e.name,
        function: e.function,
        qty: e.qty,
        necessity: e.necessity,
        packageName: e.package_name,
        areaMm2: e.x_mm !== null && e.y_mm !== null ? e.x_mm * e.y_mm * e.qty : null,
        included: e.included === 1,
      })),
    },
  }
}
