import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { syncCategories } from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import {
  addExternal, createComponent, createProfile, setOverride, setSpecValue,
} from '../src/db/repositories/mutations.js'
import { compareComponents } from '../src/db/repositories/compare.js'
import { checkBackup, exportCategoryCsv, exportJson } from '../src/db/repositories/export.js'
import type { SpecDefinition } from '../src/domain/categories/model.js'

const url = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const MIGRATIONS = loadMigrations(url('../resources/migrations'))
const LEXICON = SpecLexicon.fromYaml(readFileSync(url('../resources/spec-lexicon.yaml'), 'utf8'))
const CATEGORIES = importCategories(
  readFileSync(url('../resources/component-report/config.yaml'), 'utf8'), LEXICON,
).categories

let db: SqlDriver

beforeEach(() => {
  db = openInMemory()
  migrate(db, MIGRATIONS)
  syncCategories(db, CATEGORIES, '2026-08-09T00:00:00Z')
})

function ldo(mpn: string, x: number, y: number, iq: string | null): number {
  const r = createComponent(db, {
    manufacturer: 'Vendor', mpn, categorySlug: 'tiny-ldo', lifecycle: 'active',
    package: { name: 'WLCSP', xMax: x, yMax: y },
  })
  if (!r.ok) throw new Error('duplicate')
  if (iq) {
    const row = db.prepare(`
      SELECT id, key, name, type, dimension, unit, better FROM spec_def
      WHERE key='iq' AND category_id=(SELECT id FROM category WHERE slug='tiny-ldo')
    `).get<{ id: number; key: string; name: string; type: string; dimension: string; unit: string; better: string }>()!
    const def: SpecDefinition = {
      key: row.key, name: row.name, type: row.type as 'scalar',
      dimension: row.dimension as 'current', unit: row.unit,
      better: row.better as 'lower', table: true, filterable: true, sortable: true, unmapped: false,
    }
    setSpecValue(db, r.id, row.id, def, iq)
  }
  return r.id
}

describe('comparison', () => {
  it('lays specifications out as rows and parts as columns', () => {
    const a = ldo('SMALL-1', 0.64, 0.64, '25 nA')
    const b = ldo('BIG-1', 2.0, 2.0, '250 nA')
    const result = compareComponents(db, [a, b])

    expect(result.components.map((c) => c.mpn)).toEqual(['SMALL-1', 'BIG-1'])
    expect(result.mixedCategories).toBe(false)

    const areaRow = result.rows.find((r) => r.key === '@ic_area')!
    expect(areaRow.values[0]!.text).toBe('0.41')
    expect(areaRow.values[1]!.text).toBe('4.00')
  })

  it('tints best and worst only where a direction is defined', () => {
    const a = ldo('SMALL-1', 0.64, 0.64, '25 nA')
    const b = ldo('BIG-1', 2.0, 2.0, '250 nA')
    const result = compareComponents(db, [a, b])

    const areaRow = result.rows.find((r) => r.key === '@ic_area')!
    expect(areaRow.better).toBe('lower')
    expect(areaRow.values[0]!.best).toBe(true)
    expect(areaRow.values[1]!.worst).toBe(true)

    // Lifecycle has no better/worse — it must never be coloured.
    const lifecycle = result.rows.find((r) => r.key === '@lifecycle')!
    expect(lifecycle.better).toBe('none')
    expect(lifecycle.values.every((v) => !v.best && !v.worst)).toBe(true)
  })

  it('never tints an unverified value as best', () => {
    const a = ldo('SEEDED', 0.1, 0.1, null)
    const b = ldo('REAL', 2.0, 2.0, null)
    db.prepare('UPDATE package SET is_unverified = 1 WHERE component_id = ?').run(a)

    const areaRow = compareComponents(db, [a, b]).rows.find((r) => r.key === '@ic_area')!
    expect(areaRow.values[0]!.unverified).toBe(true)
    expect(areaRow.values[0]!.best).toBe(false)
  })

  it('marks which rows actually differ, for the differences filter', () => {
    const a = ldo('A', 1.0, 1.0, '25 nA')
    const b = ldo('B', 1.0, 1.0, '250 nA')
    const rows = compareComponents(db, [a, b]).rows
    expect(rows.find((r) => r.key === '@ic_area')!.differs).toBe(false)
    expect(rows.find((r) => r.key === 'iq')!.differs).toBe(true)
  })

  it('flags a cross-category selection instead of silently comparing apples to oranges', () => {
    const a = ldo('LDO-1', 1.0, 1.0, null)
    const mcu = createComponent(db, {
      manufacturer: 'Vendor', mpn: 'MCU-1', categorySlug: 'smallest-mcu',
      package: { xMax: 2.0, yMax: 2.0 },
    })
    expect(mcu.ok).toBe(true)
    const result = compareComponents(db, [a, (mcu as { id: number }).id])
    expect(result.mixedCategories).toBe(true)
    expect(result.rows.some((r) => r.key === '@ic_area')).toBe(true)
  })
})

describe('size visualization data', () => {
  it('provides package rectangles at real millimetre dimensions', () => {
    const a = ldo('SMALL-1', 0.64, 0.64, null)
    const b = ldo('BIG-1', 3.0, 2.0, null)
    const sizes = compareComponents(db, [a, b]).sizes

    expect(sizes[0]).toMatchObject({ mpn: 'SMALL-1', icWidthMm: 0.64, icHeightMm: 0.64 })
    expect(sizes[1]).toMatchObject({ mpn: 'BIG-1', icWidthMm: 3.0, icHeightMm: 2.0 })
  })

  it('reports gross rectangles and their origin, so manual reads differently', () => {
    const a = ldo('A', 1.0, 1.0, null)
    const profile = createProfile(db, a, 'Recommended', true)
    addExternal(db, profile, { name: 'CIN', xMm: 1.0, yMm: 0.5 })

    let sizes = compareComponents(db, [a, ldo('B', 1.0, 1.0, null)]).sizes
    expect(sizes[0]!.grossOrigin).toBe('estimated')
    expect(sizes[0]!.grossWidthMm).toBeGreaterThan(0)

    setOverride(db, profile, { widthMm: 4, heightMm: 3, areaMm2: null, note: null })
    sizes = compareComponents(db, [a]).sizes
    expect(sizes[0]!.grossOrigin).toBe('manual')
    expect(sizes[0]!.grossAreaMm2).toBeCloseTo(12, 6)
  })

  it('a part can be smaller by package but larger by solution', () => {
    // The entire argument for the gross-size feature, as a test.
    const tiny = ldo('TINY-IC', 1.0, 1.0, null)
    const bigger = ldo('BIGGER-IC', 1.6, 1.0, null)

    const tinyProfile = createProfile(db, tiny, 'Recommended', true)
    addExternal(db, tinyProfile, { name: 'crystal', xMm: 2.0, yMm: 1.6 })
    addExternal(db, tinyProfile, { name: 'C1', xMm: 1.0, yMm: 0.5 })
    addExternal(db, tinyProfile, { name: 'C2', xMm: 1.0, yMm: 0.5 })

    const biggerProfile = createProfile(db, bigger, 'Recommended', true)
    addExternal(db, biggerProfile, { name: 'C1', xMm: 1.0, yMm: 0.5 })

    const sizes = compareComponents(db, [tiny, bigger]).sizes
    expect(sizes[0]!.icAreaMm2!).toBeLessThan(sizes[1]!.icAreaMm2!)
    expect(sizes[0]!.grossAreaMm2!).toBeGreaterThan(sizes[1]!.grossAreaMm2!)
  })
})

describe('export and backup', () => {
  it('exports a full-fidelity JSON bundle', () => {
    ldo('A', 1.0, 1.0, '25 nA')
    const bundle = exportJson(db, '2026-08-09T00:00:00Z')
    expect(bundle.formatVersion).toBe(1)
    expect(bundle.schemaVersion).toBe(MIGRATIONS.length)
    expect(bundle.categories).toHaveLength(36)
    expect(bundle.components).toHaveLength(1)
    expect(bundle.specValues).toHaveLength(1)
    // Round-trips through JSON without loss of shape.
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow()
  })

  it('exports CSV with units in the header and unverified values marked', () => {
    const a = ldo('A', 0.64, 0.64, '25 nA')
    db.prepare('UPDATE package SET is_unverified = 1 WHERE component_id = ?').run(a)

    const csv = exportCategoryCsv(db, 'tiny-ldo')
    const [header, row] = csv.split('\n')
    expect(header).toContain('IC size (mm²)')
    expect(header).toContain('Quiescent current (µA)')
    // A spreadsheet must not launder an unverified number into a fact.
    expect(row).toContain('(unverified)')
  })

  it('quotes CSV fields containing commas', () => {
    createComponent(db, {
      manufacturer: 'Vendor, Inc.', mpn: 'X-1', categorySlug: 'tiny-ldo',
      package: { xMax: 1, yMax: 1 },
    })
    const csv = exportCategoryCsv(db, 'tiny-ldo')
    expect(csv).toContain('"Vendor, Inc."')
  })

  it('refuses to restore a backup from a newer schema', () => {
    expect(checkBackup({ formatVersion: 1, schemaVersion: 99 }, 1).ok).toBe(false)
    expect(checkBackup({ formatVersion: 1, schemaVersion: 99 }, 1).reason).toMatch(/only knows up to 1/)
    expect(checkBackup({ formatVersion: 1, schemaVersion: 1 }, 1).ok).toBe(true)
    expect(checkBackup({ formatVersion: 2 as 1, schemaVersion: 1 }, 1).ok).toBe(false)
  })
})
