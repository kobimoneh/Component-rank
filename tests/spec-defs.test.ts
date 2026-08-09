import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { syncCategories } from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import {
  addSpecDef, availableDimensions, keyFromName, listSpecDefs, removeSpecDef, updateSpecDef,
} from '../src/db/repositories/spec-defs.js'
import { categoryLeaders } from '../src/db/repositories/leaders.js'
import { categoryColumns, listCategoryRows } from '../src/db/repositories/components.js'
import { createComponent, setSpecValue } from '../src/db/repositories/mutations.js'
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

function def(slug: string, key: string): { id: number; def: SpecDefinition } {
  const r = db.prepare(`
    SELECT id, key, name, type, dimension, unit, better FROM spec_def
    WHERE key = ? AND category_id = (SELECT id FROM category WHERE slug = ?)
  `).get<{ id: number; key: string; name: string; type: string; dimension: string | null; unit: string | null; better: string }>(key, slug)!
  return {
    id: r.id,
    def: {
      key: r.key, name: r.name, type: r.type as SpecDefinition['type'],
      ...(r.dimension ? { dimension: r.dimension as SpecDefinition['dimension'] } : {}),
      ...(r.unit ? { unit: r.unit } : {}),
      better: r.better as SpecDefinition['better'],
      table: true, filterable: true, sortable: true, unmapped: false,
    },
  }
}

function part(mpn: string, x: number, iq?: string): number {
  const r = createComponent(db, {
    manufacturer: 'Vendor', mpn, categorySlug: 'tiny-ldo', lifecycle: 'active',
    package: { xMax: x, yMax: x },
  })
  if (!r.ok) throw new Error('duplicate')
  if (iq) {
    const d = def('tiny-ldo', 'iq')
    setSpecValue(db, r.id, d.id, d.def, iq)
  }
  return r.id
}

describe('adding a parameter', () => {
  it('creates a typed, local parameter and shows it as a column', () => {
    const result = addSpecDef(db, {
      slug: 'tiny-ldo',
      name: 'Thermal shutdown',
      type: 'scalar',
      dimension: 'temperature',
      unit: '°C',
      better: 'higher',
      tableVisible: true,
    })
    expect(result).toMatchObject({ ok: true, key: 'thermal_shutdown' })

    const defs = listSpecDefs(db, 'tiny-ldo')
    const added = defs.find((d) => d.key === 'thermal_shutdown')!
    expect(added.source).toBe('local')
    expect(added.dimension).toBe('temperature')
    expect(added.better).toBe('higher')

    expect(categoryColumns(db, 'tiny-ldo').map((c) => c.key)).toContain('thermal_shutdown')
  })

  it('accepts values for the new parameter and compares them numerically', () => {
    addSpecDef(db, { slug: 'tiny-ldo', name: 'Thermal shutdown', type: 'scalar', dimension: 'temperature', unit: '°C', better: 'higher' })
    const id = part('X-1', 1.0)
    const d = def('tiny-ldo', 'thermal_shutdown')
    expect(setSpecValue(db, id, d.id, d.def, '150 °C').ok).toBe(true)

    const row = listCategoryRows(db, 'tiny-ldo').find((r) => r.mpn === 'X-1')!
    expect(row.cells['thermal_shutdown']!.sort).toBe(150)
  })

  it('refuses a numeric parameter with no dimension, so its units stay comparable', () => {
    const r = addSpecDef(db, { slug: 'tiny-ldo', name: 'Mystery number', type: 'scalar' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/needs a dimension/i)
  })

  it('refuses a choice parameter with no choices, and an empty name', () => {
    expect(addSpecDef(db, { slug: 'tiny-ldo', name: 'Grade', type: 'enum' }).ok).toBe(false)
    expect(addSpecDef(db, { slug: 'tiny-ldo', name: '  ', type: 'text' }).ok).toBe(false)
  })

  it('does not clobber an existing key — it makes a new one', () => {
    const first = addSpecDef(db, { slug: 'tiny-ldo', name: 'Dropout', type: 'text' })
    // 'dropout' already exists from the import.
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.key).toBe('dropout_2')
    expect(listSpecDefs(db, 'tiny-ldo').filter((d) => d.key.startsWith('dropout'))).toHaveLength(2)
  })

  it('derives stable keys from display names', () => {
    expect(keyFromName('Quiescent current (Iq)')).toBe('quiescent_current_iq')
    expect(keyFromName('µA rating')).toBe('ua_rating')
  })

  it('offers the unit registry to the editor', () => {
    const dims = availableDimensions()
    expect(dims.find((d) => d.id === 'current')!.units).toContain('µA')
    expect(dims.map((d) => d.id)).toContain('data_size')
  })
})

describe('removing a parameter', () => {
  it('removes the column and reports how many values were lost', () => {
    const id = part('X-1', 1.0, '25 nA')
    expect(listCategoryRows(db, 'tiny-ldo').find((r) => r.mpn === 'X-1')!.cells['iq']).toBeDefined()

    const result = removeSpecDef(db, 'tiny-ldo', 'iq')
    expect(result.ok).toBe(true)
    expect(result.valuesDeleted).toBe(1)

    expect(categoryColumns(db, 'tiny-ldo').map((c) => c.key)).not.toContain('iq')
    expect(listCategoryRows(db, 'tiny-ldo').find((r) => r.id === id)!.cells['iq']).toBeUndefined()
  })

  it('drops ranking rules that pointed at it, so nothing ranks on a dead field', () => {
    const before = db.prepare(`
      SELECT field FROM ranking_rule
      WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo') ORDER BY ord
    `).all<{ field: string }>().map((r) => r.field)
    expect(before).toContain('iq')

    removeSpecDef(db, 'tiny-ldo', 'iq')

    const after = db.prepare(`
      SELECT field FROM ranking_rule
      WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo') ORDER BY ord
    `).all<{ field: string }>().map((r) => r.field)
    expect(after).not.toContain('iq')
    expect(after).toContain('@ic_area') // the primary rule survives
  })

  it('stays removed when the upstream category has not changed', () => {
    removeSpecDef(db, 'tiny-ldo', 'psrr')
    syncCategories(db, CATEGORIES, '2026-08-10T00:00:00Z')
    expect(listSpecDefs(db, 'tiny-ldo').map((d) => d.key)).not.toContain('psrr')
  })

  it('stays removed when upstream DOES change, and the sync says so', () => {
    // The case the guard exists for: an unchanged category is skipped entirely,
    // so the parameter only risks coming back when upstream edits the category.
    removeSpecDef(db, 'tiny-ldo', 'psrr')
    const changed = CATEGORIES.map((c) =>
      c.slug === 'tiny-ldo' ? { ...c, description: 'Upstream rewrote this.' } : c,
    )
    const report = syncCategories(db, changed, '2026-08-10T00:00:00Z')

    expect(report.updated).toContain('tiny-ldo')
    expect(listSpecDefs(db, 'tiny-ldo').map((d) => d.key)).not.toContain('psrr')
    expect(report.specsKeptLocal.some((k) => k.includes('tiny-ldo.psrr'))).toBe(true)
  })

  it('re-adding a removed parameter clears the tombstone', () => {
    removeSpecDef(db, 'tiny-ldo', 'psrr')
    const added = addSpecDef(db, {
      slug: 'tiny-ldo', name: 'PSRR', type: 'scalar', dimension: 'ratio_log', unit: 'dB', better: 'higher',
    })
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.key).toBe('psrr')
    expect(listSpecDefs(db, 'tiny-ldo').map((d) => d.key)).toContain('psrr')
  })

  it('reports a clear error for a parameter that is not there', () => {
    expect(removeSpecDef(db, 'tiny-ldo', 'nope').error).toMatch(/No parameter/)
  })
})

describe('editing a parameter', () => {
  it('changes the display unit and marks it locally modified', () => {
    expect(updateSpecDef(db, 'tiny-ldo', 'iq', { unit: 'nA', better: 'lower' }).ok).toBe(true)
    const d = listSpecDefs(db, 'tiny-ldo').find((x) => x.key === 'iq')!
    expect(d.unit).toBe('nA')
    expect(d.locallyModified).toBe(true)
  })

  it('a locally edited parameter survives re-import', () => {
    updateSpecDef(db, 'tiny-ldo', 'iq', { name: 'Iq (mine)', unit: 'nA' })
    syncCategories(db, CATEGORIES, '2026-08-10T00:00:00Z')
    const d = listSpecDefs(db, 'tiny-ldo').find((x) => x.key === 'iq')!
    expect(d.name).toBe('Iq (mine)')
    expect(d.unit).toBe('nA')
  })

  it('hiding a parameter removes the column without losing the values', () => {
    const id = part('X-1', 1.0, '25 nA')
    updateSpecDef(db, 'tiny-ldo', 'iq', { tableVisible: false })
    expect(categoryColumns(db, 'tiny-ldo').map((c) => c.key)).not.toContain('iq')

    updateSpecDef(db, 'tiny-ldo', 'iq', { tableVisible: true })
    expect(listCategoryRows(db, 'tiny-ldo').find((r) => r.id === id)!.cells['iq']!.sort)
      .toBeCloseTo(25e-9, 15)
  })
})

describe('who is best at what', () => {
  it('names the leader for each directional parameter', () => {
    part('SMALL', 0.6, '250 nA')
    part('LOWIQ', 2.0, '25 nA')

    const board = categoryLeaders(db, 'tiny-ldo')
    const area = board.leaders.find((l) => l.key === '@ic_area')!
    const iq = board.leaders.find((l) => l.key === 'iq')!

    expect(area.mpn).toBe('SMALL')
    expect(area.better).toBe('lower')
    expect(iq.mpn).toBe('LOWIQ')
    expect(iq.valueText).toBe('0.025 µA')
  })

  it('produces no leader for a parameter with no direction', () => {
    part('A', 1.0)
    const board = categoryLeaders(db, 'tiny-ldo')
    // Vin is informational — a wider range is not automatically "better".
    expect(board.leaders.map((l) => l.key)).not.toContain('vin_range')
    expect(board.leaders.every((l) => l.better === 'lower' || l.better === 'higher')).toBe(true)
  })

  it('never crowns an unverified value, and says how many it skipped', () => {
    const seeded = part('SEEDED', 0.1)
    db.prepare('UPDATE package SET is_unverified = 1 WHERE component_id = ?').run(seeded)
    part('REAL', 2.0)

    const area = categoryLeaders(db, 'tiny-ldo').leaders.find((l) => l.key === '@ic_area')!
    expect(area.mpn).toBe('REAL')
    expect(area.skippedUnverified).toBeGreaterThan(0)
  })

  it('reports a tie rather than picking a winner silently', () => {
    part('AAA', 1.0)
    part('BBB', 1.0)
    const area = categoryLeaders(db, 'tiny-ldo').leaders.find((l) => l.key === '@ic_area')!
    expect(area.tied).toBe(true)
    expect(area.tiedWith).toBe(1)
    expect(area.mpn).toBe('AAA') // deterministic pick, so the strip does not flicker
  })

  it('lists parameters nobody has data for instead of pretending', () => {
    part('A', 1.0)
    const board = categoryLeaders(db, 'tiny-ldo')
    expect(board.noData.map((n) => n.key)).toContain('dropout')
    expect(board.leaders.map((l) => l.key)).not.toContain('dropout')
  })

  it('is empty when the category has no parts at all', () => {
    const board = categoryLeaders(db, 'tiny-ldo')
    expect(board.leaders).toEqual([])
    expect(board.noData.length).toBeGreaterThan(0)
  })

  it('follows a newly added parameter', () => {
    addSpecDef(db, {
      slug: 'tiny-ldo', name: 'Thermal shutdown', type: 'scalar',
      dimension: 'temperature', unit: '°C', better: 'higher',
    })
    const hot = part('HOT', 1.0)
    const cool = part('COOL', 1.0)
    const d = def('tiny-ldo', 'thermal_shutdown')
    setSpecValue(db, hot, d.id, d.def, '175 °C')
    setSpecValue(db, cool, d.id, d.def, '150 °C')

    const leader = categoryLeaders(db, 'tiny-ldo').leaders.find((l) => l.key === 'thermal_shutdown')!
    expect(leader.mpn).toBe('HOT')
    expect(leader.contenders).toBe(2)
  })
})
