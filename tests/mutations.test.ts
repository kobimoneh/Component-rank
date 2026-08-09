import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { syncCategories } from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import {
  addExternal, applyExtraction, confirmPackage, createComponent, createProfile,
  deleteComponent, setExternalIncluded, setOverride, setPackage, setSpecValue,
  setTags, updateComponent, type ExtractedField,
} from '../src/db/repositories/mutations.js'
import { listCategoryRows } from '../src/db/repositories/components.js'
import { componentDetail } from '../src/db/repositories/component-detail.js'
import { coerceSpecInput, parseDimensionTriplet } from '../src/domain/specs/coerce.js'
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

const specDef = (categorySlug: string, key: string): { id: number; def: SpecDefinition } => {
  const row = db.prepare(`
    SELECT id, key, name, type, dimension, unit, better, enum_values
    FROM spec_def WHERE key = ? AND category_id = (SELECT id FROM category WHERE slug = ?)
  `).get<{ id: number; key: string; name: string; type: string; dimension: string | null; unit: string | null; better: string; enum_values: string | null }>(key, categorySlug)!
  return {
    id: row.id,
    def: {
      key: row.key, name: row.name, type: row.type as SpecDefinition['type'],
      ...(row.dimension ? { dimension: row.dimension as SpecDefinition['dimension'] } : {}),
      ...(row.unit ? { unit: row.unit } : {}),
      better: row.better as SpecDefinition['better'],
      ...(row.enum_values ? { enumValues: JSON.parse(row.enum_values) as string[] } : {}),
      table: true, filterable: true, sortable: true, unmapped: false,
    },
  }
}

function makeLdo(mpn = 'TPS7A0233PYCHR', x = 0.65, y = 0.65): number {
  const r = createComponent(db, {
    manufacturer: 'Texas Instruments',
    mpn,
    categorySlug: 'tiny-ldo',
    lifecycle: 'active',
    datasheetUrl: 'https://www.ti.com/lit/ds/symlink/tps7a02.pdf',
    package: { name: 'DSBGA-4', pinCount: 4, xNom: 0.64, xMax: x, yNom: 0.64, yMax: y, zMax: 0.36 },
  })
  if (!r.ok) throw new Error('unexpected duplicate')
  return r.id
}

describe('creating a component manually', () => {
  it('stores identity, package and category membership', () => {
    const id = makeLdo()
    const d = componentDetail(db, id)!
    expect(d.mpn).toBe('TPS7A0233PYCHR')
    expect(d.manufacturer).toBe('Texas Instruments')
    expect(d.categoryName).toBe('Very small LDO regulator')
    expect(d.lifecycle).toBe('active')
    expect(d.package.unverified).toBe(false)
    // Max dimensions win: 0.65 x 0.65, not the 0.64 nominal.
    expect(d.package.basis).toBe('max')
    expect(d.package.icAreaMm2).toBeCloseTo(0.4225, 6)
    expect(listCategoryRows(db, 'tiny-ldo').map((r) => r.mpn)).toEqual(['TPS7A0233PYCHR'])
  })

  it('refuses a duplicate instead of overwriting, and offers the existing one', () => {
    const id = makeLdo()
    const again = createComponent(db, {
      manufacturer: 'texas instruments', // different case
      mpn: 'tps7a0233pychr ',            // different case and spacing
      categorySlug: 'tiny-ldo',
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.duplicate.id).toBe(id)
    expect(db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n).toBe(1)
  })

  it('lets the same MPN exist under a different manufacturer', () => {
    makeLdo()
    const other = createComponent(db, {
      manufacturer: 'Some Other Vendor', mpn: 'TPS7A0233PYCHR', categorySlug: 'tiny-ldo',
    })
    expect(other.ok).toBe(true)
  })

  it('deletes a component and everything hanging off it', () => {
    const id = makeLdo()
    const profileId = createProfile(db, id, 'Recommended', true)
    addExternal(db, profileId, { name: 'CIN', xMm: 1, yMm: 0.5 })
    deleteComponent(db, id)
    expect(db.prepare('SELECT COUNT(*) n FROM package').get<{ n: number }>()!.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM solution_profile').get<{ n: number }>()!.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM external_part').get<{ n: number }>()!.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM component_category').get<{ n: number }>()!.n).toBe(0)
  })
})

describe('editing specification values', () => {
  it('parses typed input and stores canonical numbers', () => {
    const id = makeLdo()
    const iq = specDef('tiny-ldo', 'iq')
    expect(setSpecValue(db, id, iq.id, iq.def, '25 nA')).toEqual({ ok: true })

    const row = db.prepare('SELECT num_typ, canonical_unit, origin FROM spec_value WHERE component_id = ?')
      .get<{ num_typ: number; canonical_unit: string; origin: string }>(id)!
    expect(row.num_typ).toBeCloseTo(25e-9, 15)
    expect(row.canonical_unit).toBe('current')
    expect(row.origin).toBe('manual')
  })

  it('stores a range as bounds, not a string', () => {
    const id = makeLdo()
    const vin = specDef('tiny-ldo', 'vin_range')
    expect(setSpecValue(db, id, vin.id, vin.def, '1.5–6.0 V')).toEqual({ ok: true })
    const row = db.prepare("SELECT num_min, num_max FROM spec_value WHERE spec_def_id = ?")
      .get<{ num_min: number; num_max: number }>(vin.id)!
    expect(row.num_min).toBe(1.5)
    expect(row.num_max).toBe(6)
  })

  it('rejects nonsense rather than coercing it to a number', () => {
    const id = makeLdo()
    const iq = specDef('tiny-ldo', 'iq')
    const result = setSpecValue(db, id, iq.id, iq.def, 'quite low')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a value for/i)
    expect(db.prepare('SELECT COUNT(*) n FROM spec_value').get<{ n: number }>()!.n).toBe(0)
  })

  it('refuses a value from the wrong dimension', () => {
    const id = makeLdo()
    const iq = specDef('tiny-ldo', 'iq')
    expect(setSpecValue(db, id, iq.id, iq.def, '3.3 V').ok).toBe(false)
  })

  it('clearing a field removes the value rather than storing zero', () => {
    const id = makeLdo()
    const iq = specDef('tiny-ldo', 'iq')
    setSpecValue(db, id, iq.id, iq.def, '25 nA')
    setSpecValue(db, id, iq.id, iq.def, '   ')
    expect(db.prepare('SELECT COUNT(*) n FROM spec_value').get<{ n: number }>()!.n).toBe(0)
  })

  it('shows the edited value in the category table', () => {
    const id = makeLdo()
    const iq = specDef('tiny-ldo', 'iq')
    setSpecValue(db, id, iq.id, iq.def, '25 nA')
    const row = listCategoryRows(db, 'tiny-ldo')[0]!
    expect(row.cells['iq']!.text).toBe('0.025 µA')
    expect(row.cells['iq']!.sort).toBeCloseTo(25e-9, 15)
  })
})

describe('coercion rules', () => {
  const def = (over: Partial<SpecDefinition>): SpecDefinition => ({
    key: 'k', name: 'Test', type: 'scalar', better: 'none',
    table: true, filterable: true, sortable: true, unmapped: false, ...over,
  })

  it('accepts yes/no for booleans and refuses anything else', () => {
    const b = def({ type: 'bool' })
    expect(coerceSpecInput(b, 'Yes')).toMatchObject({ ok: true })
    expect(coerceSpecInput(b, 'false')).toMatchObject({ ok: true })
    expect(coerceSpecInput(b, 'maybe')).toMatchObject({ ok: false })
  })

  it('validates enums against their allowed values', () => {
    const e = def({ type: 'enum', enumValues: ['SAW', 'BAW'] })
    expect(coerceSpecInput(e, 'baw')).toMatchObject({ ok: true })
    const bad = coerceSpecInput(e, 'FBAR')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/SAW, BAW/)
  })

  it('parses dimension triplets', () => {
    expect(parseDimensionTriplet('2.5 x 2.0 x 0.8 mm')).toEqual({ x: 2.5, y: 2.0, z: 0.8 })
    expect(parseDimensionTriplet('2.5×2.0')).toEqual({ x: 2.5, y: 2.0, z: null })
    expect(parseDimensionTriplet('big')).toBeNull()
    expect(parseDimensionTriplet('0 x 2')).toBeNull()
  })
})

describe('package editing', () => {
  it('a manual edit confirms the dimensions and clears unverified', () => {
    const id = makeLdo()
    db.prepare("UPDATE package SET is_unverified = 1, origin = 'imported' WHERE component_id = ?").run(id)
    setPackage(db, id, { xMax: 0.66, yMax: 0.66 })
    const d = componentDetail(db, id)!
    expect(d.package.unverified).toBe(false)
    expect(d.package.icAreaMm2).toBeCloseTo(0.4356, 6)
  })

  it('confirming imported dimensions keeps the numbers but makes them rankable', () => {
    const id = makeLdo()
    db.prepare("UPDATE package SET is_unverified = 1, origin = 'imported' WHERE component_id = ?").run(id)
    expect(listCategoryRows(db, 'tiny-ldo')[0]!.rank).toBeNull()

    confirmPackage(db, id)
    const row = listCategoryRows(db, 'tiny-ldo')[0]!
    expect(row.rank).toBe(1)
    expect(row.cells['@ic_area']!.sort).toBeCloseTo(0.4225, 6)
  })
})

describe('solution profiles and gross size', () => {
  it('recalculates gross size as externals are included and excluded', () => {
    const id = makeLdo()
    const profileId = createProfile(db, id, 'Recommended', true)
    const cin = addExternal(db, profileId, { name: 'CIN 1 µF', packageName: '0402', xMm: 1.0, yMm: 0.5 })
    addExternal(db, profileId, { name: 'COUT 1 µF', packageName: '0402', xMm: 1.0, yMm: 0.5 })

    const both = componentDetail(db, id)!.solution
    expect(both.icAreaMm2).toBeCloseTo(0.4225, 6)
    expect(both.externalAreaMm2).toBeCloseTo(1.0, 6)
    expect(both.grossComponentAreaMm2).toBeCloseTo(1.4225, 6)
    expect(both.origin).toBe('estimated')
    // D must exceed C — a board is bigger than the sum of its parts.
    expect(both.effectiveAreaMm2!).toBeGreaterThan(both.grossComponentAreaMm2!)

    setExternalIncluded(db, cin, false)
    const one = componentDetail(db, id)!.solution
    expect(one.externalAreaMm2).toBeCloseTo(0.5, 6)
    expect(one.effectiveAreaMm2!).toBeLessThan(both.effectiveAreaMm2!)

    setExternalIncluded(db, cin, true)
    expect(componentDetail(db, id)!.solution.effectiveAreaMm2).toBeCloseTo(both.effectiveAreaMm2!, 9)
  })

  it('a manual override wins and is marked as such', () => {
    const id = makeLdo()
    const profileId = createProfile(db, id, 'Recommended', true)
    addExternal(db, profileId, { name: 'CIN', xMm: 1.0, yMm: 0.5 })
    const estimated = componentDetail(db, id)!.solution.effectiveAreaMm2!

    setOverride(db, profileId, { widthMm: 2.4, heightMm: 1.6, areaMm2: null, note: 'measured on rev B' })
    const overridden = componentDetail(db, id)!.solution
    expect(overridden.origin).toBe('manual')
    expect(overridden.effectiveAreaMm2).toBeCloseTo(3.84, 6)
    expect(overridden.effectiveAreaMm2).not.toBeCloseTo(estimated, 3)

    // Changing the BOM must not silently replace what the user typed.
    addExternal(db, profileId, { name: 'COUT', xMm: 1.6, yMm: 0.8 })
    const after = componentDetail(db, id)!.solution
    expect(after.origin).toBe('manual')
    expect(after.effectiveAreaMm2).toBeCloseTo(3.84, 6)

    setOverride(db, profileId, null)
    expect(componentDetail(db, id)!.solution.origin).toBe('estimated')
  })

  it('supports several profiles with different BOMs', () => {
    const id = makeLdo()
    const minimum = createProfile(db, id, 'Minimum BOM', true)
    addExternal(db, minimum, { name: 'CIN', xMm: 1.0, yMm: 0.5 })

    const lowPower = createProfile(db, id, 'Low-power (LF crystal)')
    addExternal(db, lowPower, { name: 'CIN', xMm: 1.0, yMm: 0.5 })
    addExternal(db, lowPower, { name: '32.768 kHz crystal', xMm: 2.0, yMm: 1.2 })

    expect(componentDetail(db, id)!.solution.profileName).toBe('Minimum BOM')
    const minArea = componentDetail(db, id)!.solution.effectiveAreaMm2!

    db.prepare('UPDATE solution_profile SET is_default = 0 WHERE component_id = ?').run(id)
    db.prepare('UPDATE solution_profile SET is_default = 1 WHERE id = ?').run(lowPower)
    const lowArea = componentDetail(db, id)!.solution.effectiveAreaMm2!
    expect(lowArea).toBeGreaterThan(minArea)
  })
})

describe('manual values survive extraction (rule 9)', () => {
  const verified = (specKey: string, raw: string): ExtractedField => ({
    specKey, raw, confidence: 0.9, page: 12, evidence: 'x', evidenceVerified: true,
  })

  it('never overwrites a value you typed, and reports the conflict', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    const iq = specDef('tiny-ldo', 'iq')
    setSpecValue(db, id, iq.id, iq.def, '25 nA')

    const outcomes = applyExtraction(db, id, categoryId, [verified('iq', '300 nA')])
    expect(outcomes[0]!.status).toBe('kept-manual')
    expect(outcomes[0]!.reason).toMatch(/will not overwrite/i)

    const stored = db.prepare('SELECT num_typ, origin FROM spec_value WHERE spec_def_id = ?')
      .get<{ num_typ: number; origin: string }>(iq.id)!
    expect(stored.num_typ).toBeCloseTo(25e-9, 15)
    expect(stored.origin).toBe('manual')
  })

  it('applies the change when you explicitly approve it', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    const iq = specDef('tiny-ldo', 'iq')
    setSpecValue(db, id, iq.id, iq.def, '25 nA')

    const outcomes = applyExtraction(db, id, categoryId, [verified('iq', '300 nA')], {
      acceptManualOverwrites: ['iq'],
    })
    expect(outcomes[0]!.status).toBe('written')
    const stored = db.prepare('SELECT num_typ, origin FROM spec_value WHERE spec_def_id = ?')
      .get<{ num_typ: number; origin: string }>(iq.id)!
    expect(stored.num_typ).toBeCloseTo(300e-9, 15)
    expect(stored.origin).toBe('extracted')
  })

  it('writes into an empty field without asking', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    const outcomes = applyExtraction(db, id, categoryId, [verified('iq', '25 nA')])
    expect(outcomes[0]!.status).toBe('written')
    expect(componentDetail(db, id)!.specs.find((s) => s.key === 'iq')!.value).toBe('0.025 µA')
  })

  it('refuses a field whose evidence did not verify', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    const outcomes = applyExtraction(db, id, categoryId, [
      { specKey: 'iq', raw: '25 nA', confidence: 0.99, page: 3, evidence: 'made up', evidenceVerified: false },
    ])
    expect(outcomes[0]!.status).toBe('rejected')
    expect(outcomes[0]!.reason).toMatch(/evidence/i)
    expect(db.prepare('SELECT COUNT(*) n FROM spec_value').get<{ n: number }>()!.n).toBe(0)
  })

  it('records provenance for what it does write', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    applyExtraction(db, id, categoryId, [
      { specKey: 'iq', raw: '25 nA', confidence: 0.82, page: 43, evidence: 'IQ Quiescent current 25 nA', evidenceVerified: true },
    ])
    const p = db.prepare('SELECT page, evidence, evidence_verified, confidence FROM provenance')
      .get<{ page: number; evidence: string; evidence_verified: number; confidence: number }>()!
    expect(p.page).toBe(43)
    expect(p.evidence).toMatch(/Quiescent current/)
    expect(p.evidence_verified).toBe(1)
    expect(p.confidence).toBeCloseTo(0.82, 6)
  })

  it('rejects a spec that does not belong to the category', () => {
    const id = makeLdo()
    const categoryId = db.prepare("SELECT id FROM category WHERE slug='tiny-ldo'").get<{ id: number }>()!.id
    const outcomes = applyExtraction(db, id, categoryId, [verified('flash', '128 MiB')])
    expect(outcomes[0]!.status).toBe('rejected')
  })
})

describe('annotations', () => {
  it('stores favourites, flags and tags', () => {
    const id = makeLdo()
    updateComponent(db, id, { favorite: true, flag: 'reference', notes: 'Used on Project X' })
    setTags(db, id, ['#small', 'Tested', ' preferred '])

    const row = db.prepare('SELECT favorite, flag, notes FROM component WHERE id = ?')
      .get<{ favorite: number; flag: string; notes: string }>(id)!
    expect(row.favorite).toBe(1)
    expect(row.flag).toBe('reference')
    expect(row.notes).toBe('Used on Project X')

    const tags = db.prepare('SELECT tag FROM component_tag WHERE component_id = ? ORDER BY tag')
      .all<{ tag: string }>(id).map((t) => t.tag)
    expect(tags).toEqual(['preferred', 'small', 'tested'])
  })
})
