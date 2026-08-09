import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate, currentVersion, assertNotNewerThan } from '../src/db/migrate.js'
import {
  syncCategories,
  listCategories,
  markCategoryModified,
  markSpecModified,
  categoryHash,
} from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import type { Category } from '../src/domain/categories/model.js'

const url = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string): string => readFileSync(url(rel), 'utf8')

const MIGRATIONS = loadMigrations(url('../src/db/migrations'))
const LEXICON = SpecLexicon.fromYaml(read('../resources/spec-lexicon.yaml'))
const CATEGORIES = importCategories(read('./fixtures/component-report.config.yaml'), LEXICON).categories

let db: SqlDriver

beforeEach(() => {
  db = openInMemory()
  migrate(db, MIGRATIONS)
})

describe('migrations', () => {
  it('brings an empty database up to the latest version', () => {
    const fresh = openInMemory()
    expect(currentVersion(fresh)).toBe(0)
    const result = migrate(fresh, MIGRATIONS)
    expect(result.from).toBe(0)
    expect(result.to).toBe(MIGRATIONS.length)
    expect(result.applied).toHaveLength(MIGRATIONS.length)
  })

  it('is idempotent', () => {
    const again = migrate(db, MIGRATIONS)
    expect(again.applied).toEqual([])
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('rolls back completely when a migration fails', () => {
    const bad = [{ version: 99, name: 'bad', sql: 'CREATE TABLE ok_table(a); CREATE TABLE ok_table(a);' }]
    expect(() => migrate(db, bad)).toThrow()
    // The first statement must not survive the failed migration.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'")
      .all()
    expect(tables).toEqual([])
    expect(currentVersion(db)).toBe(MIGRATIONS.length)
  })

  it('refuses to open a database from a newer build', () => {
    db.setPragma('user_version', 999)
    expect(() => assertNotNewerThan(db, MIGRATIONS.length)).toThrow(/newer|only knows up to/i)
  })

  it('enforces foreign keys so cascades actually cascade', () => {
    expect(Number(db.pragma('foreign_keys'))).toBe(1)
  })
})

describe('category import into the database', () => {
  it('stores all 36 categories with their specs and ranking rules', () => {
    const report = syncCategories(db, CATEGORIES, '2026-08-09T00:00:00Z')
    expect(report.created).toHaveLength(36)
    expect(report.specsCreated).toBeGreaterThan(60)

    const list = listCategories(db)
    expect(list).toHaveLength(36)
    expect(list.every((c) => c.componentCount === 0)).toBe(true)

    const rules = db
      .prepare(`SELECT field, direction FROM ranking_rule
                WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo') ORDER BY ord`)
      .all<{ field: string; direction: string }>()
    expect(rules).toEqual([
      { field: '@ic_area', direction: 'asc' },
      { field: 'iq', direction: 'asc' },
    ])
  })

  it('persists the hard constraints', () => {
    syncCategories(db, CATEGORIES, '2026-08-09T00:00:00Z')
    const req = db
      .prepare(`SELECT field, op, value, unit FROM ranking_requirement
                WHERE category_id = (SELECT id FROM category WHERE slug='rf-lna-400mhz')
                ORDER BY field`)
      .all<{ field: string; op: string; value: number; unit: string }>()
    expect(req).toEqual([
      { field: 'band_coverage', op: 'covers', value: 400, unit: 'MHz' },
      { field: 'isupply', op: '<', value: 6, unit: 'mA' },
    ])
  })

  it('stores best_in_class as reference names carrying no specifications', () => {
    syncCategories(db, CATEGORIES, '2026-08-09T00:00:00Z')
    const refs = db
      .prepare(`SELECT mpn FROM category_reference_part
                WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo') ORDER BY ord`)
      .all<{ mpn: string }>()
    expect(refs.map((r) => r.mpn)).toContain('TPS7A0233PYCHR')
    // No component rows were fabricated from them.
    expect(db.prepare('SELECT COUNT(*) c FROM component').get<{ c: number }>()!.c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM spec_value').get<{ c: number }>()!.c).toBe(0)
  })
})

describe('re-import is non-destructive (spec section 20)', () => {
  const NOW = '2026-08-09T00:00:00Z'

  beforeEach(() => {
    syncCategories(db, CATEGORIES, NOW)
  })

  it('reports everything unchanged when the config has not moved', () => {
    const second = syncCategories(db, CATEGORIES, NOW)
    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged).toHaveLength(36)
    expect(second.keptLocal).toEqual([])
  })

  it('keeps a category you edited and says so, instead of overwriting it', () => {
    db.prepare("UPDATE category SET name = 'My tiny LDOs' WHERE slug = 'tiny-ldo'").run()
    markCategoryModified(db, 'tiny-ldo')

    // Upstream renames the same category.
    const changed: Category[] = CATEGORIES.map((c) =>
      c.slug === 'tiny-ldo' ? { ...c, name: 'Upstream renamed LDO' } : c,
    )
    const report = syncCategories(db, changed, NOW)

    expect(report.keptLocal).toContain('tiny-ldo')
    expect(report.updated).not.toContain('tiny-ldo')
    const row = db.prepare("SELECT name FROM category WHERE slug='tiny-ldo'").get<{ name: string }>()
    expect(row!.name).toBe('My tiny LDOs')
  })

  it('keeps a spec definition you retyped', () => {
    db.prepare(`
      UPDATE spec_def SET unit = 'nA', name = 'Iq (my units)'
      WHERE key = 'iq' AND category_id = (SELECT id FROM category WHERE slug='tiny-ldo')
    `).run()
    markSpecModified(db, 'tiny-ldo', 'iq')

    const changed: Category[] = CATEGORIES.map((c) =>
      c.slug === 'tiny-ldo'
        ? { ...c, description: c.description + ' (upstream edit)', specs: c.specs }
        : c,
    )
    const report = syncCategories(db, changed, NOW)

    expect(report.specsKeptLocal).toContain('tiny-ldo.iq')
    const spec = db
      .prepare(`SELECT unit, name FROM spec_def WHERE key='iq'
                AND category_id=(SELECT id FROM category WHERE slug='tiny-ldo')`)
      .get<{ unit: string; name: string }>()
    expect(spec).toEqual({ unit: 'nA', name: 'Iq (my units)' })
  })

  it('applies a genuine upstream change to an untouched category', () => {
    const changed: Category[] = CATEGORIES.map((c) =>
      c.slug === 'tiny-ldo' ? { ...c, description: 'Upstream rewrote this.' } : c,
    )
    const report = syncCategories(db, changed, NOW)
    expect(report.updated).toEqual(['tiny-ldo'])
    const row = db
      .prepare("SELECT description FROM category WHERE slug='tiny-ldo'")
      .get<{ description: string }>()
    expect(row!.description).toBe('Upstream rewrote this.')
  })

  it('never deletes a category that disappeared upstream', () => {
    const fewer = CATEGORIES.filter((c) => c.slug !== 'pcie-phy')
    const report = syncCategories(db, fewer, NOW)
    expect(report.orphaned).toEqual(['pcie-phy'])
    expect(listCategories(db)).toHaveLength(36)
  })

  it('adds a new upstream category without disturbing the others', () => {
    const extra: Category = {
      slug: 'wifi-halow',
      name: 'Wi-Fi HaLow / 802.11ah',
      group: 'Wireless',
      description: 'Sub-GHz long-range Wi-Fi modules.',
      ranking: { metricProse: 'Smallest module footprint', rules: [{ field: '@ic_area', direction: 'asc', missing: 'last' }], requirements: [], unresolved: false },
      specs: [],
      manufacturers: ['Morse Micro', 'Newracom'],
      referenceParts: [],
      importNotes: [],
    }
    const report = syncCategories(db, [...CATEGORIES, extra], NOW)
    expect(report.created).toEqual(['wifi-halow'])
    expect(report.unchanged).toHaveLength(36)
    expect(listCategories(db)).toHaveLength(37)
  })

  it('hashes only meaningful content, so cosmetic reordering is not a change', () => {
    const a = CATEGORIES.find((c) => c.slug === 'tiny-ldo')!
    const reordered: Category = { ...a, manufacturers: [...a.manufacturers].reverse() }
    expect(categoryHash(reordered)).toBe(categoryHash(a))
  })
})
