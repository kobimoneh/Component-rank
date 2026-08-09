import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, type BootstrapResult } from '../src/main/bootstrap.js'
import { listCategories } from '../src/db/repositories/categories.js'
import {
  categoryColumns, findDuplicate, listCategoryRows, searchComponents,
} from '../src/db/repositories/components.js'
import { componentDetail } from '../src/db/repositories/component-detail.js'
import { compareComponents } from '../src/db/repositories/compare.js'
import { exportCategoryCsv, exportJson } from '../src/db/repositories/export.js'
import {
  addExternal, createComponent, createProfile, setExternalIncluded,
  setOverride, setSpecValue,
} from '../src/db/repositories/mutations.js'
import type { SqlDriver } from '../src/db/driver.js'
import type { SpecDefinition } from '../src/domain/categories/model.js'

/**
 * The twenty V1 acceptance criteria from the brief, walked as one session.
 *
 * This is the "is it done" test. Criteria 16–19 (datasheet AI) are covered by
 * tests/extraction.test.ts at the contract level and are deliberately absent
 * here, because no model is called yet.
 */

let dir: string
let boot: BootstrapResult
let db: SqlDriver

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'complib-accept-'))
  boot = bootstrap(dir)
  db = boot.db
})

afterAll(() => {
  boot?.db.close()
  rmSync(dir, { recursive: true, force: true })
})

function spec(slug: string, key: string): { id: number; def: SpecDefinition } {
  const r = db.prepare(`
    SELECT id, key, name, type, dimension, unit, better, enum_values FROM spec_def
    WHERE key = ? AND category_id = (SELECT id FROM category WHERE slug = ?)
  `).get<{ id: number; key: string; name: string; type: string; dimension: string | null; unit: string | null; better: string; enum_values: string | null }>(key, slug)!
  return {
    id: r.id,
    def: {
      key: r.key, name: r.name, type: r.type as SpecDefinition['type'],
      ...(r.dimension ? { dimension: r.dimension as SpecDefinition['dimension'] } : {}),
      ...(r.unit ? { unit: r.unit } : {}),
      better: r.better as SpecDefinition['better'],
      ...(r.enum_values ? { enumValues: JSON.parse(r.enum_values) as string[] } : {}),
      table: true, filterable: true, sortable: true, unmapped: false,
    },
  }
}

describe('V1 acceptance', () => {
  const ids: Record<string, number> = {}

  it('1 — categories are imported from component-report', () => {
    const cats = listCategories(db)
    expect(cats).toHaveLength(36)
    expect(cats.map((c) => c.slug)).toContain('tiny-ldo')
  })

  it('2 — add an MCU manually', () => {
    const r = createComponent(db, {
      manufacturer: 'Nordic Semiconductor',
      mpn: 'NRF54L15-QFAA-R',
      categorySlug: 'ble-mcu-strong',
      lifecycle: 'active',
      package: { name: 'QFN-48', pinCount: 48, xNom: 7.0, xMax: 7.1, yNom: 7.0, yMax: 7.1, zMax: 0.9 },
    })
    expect(r.ok).toBe(true)
    ids['mcu'] = (r as { id: number }).id
  })

  it('3 — add an LDO manually', () => {
    const r = createComponent(db, {
      manufacturer: 'Texas Instruments',
      mpn: 'TPS7A0233PYCHR-MANUAL',
      categorySlug: 'tiny-ldo',
      lifecycle: 'active',
      package: { name: 'DSBGA-4', pinCount: 4, xNom: 0.64, xMax: 0.665, yNom: 0.64, yMax: 0.665, zMax: 0.36 },
    })
    expect(r.ok).toBe(true)
    ids['ldo'] = (r as { id: number }).id
  })

  it('4 — add a memory device manually', () => {
    const r = createComponent(db, {
      manufacturer: 'Winbond',
      mpn: 'W25Q128JVSIQ-MANUAL',
      categorySlug: 'flash-spi-nor-128mb',
      lifecycle: 'active',
      package: { name: 'SOIC-8', pinCount: 8, xMax: 5.35, yMax: 5.35, zMax: 1.75 },
    })
    expect(r.ok).toBe(true)
    ids['flash'] = (r as { id: number }).id

    const cap = spec('flash-spi-nor-128mb', 'memory_interface')
    expect(setSpecValue(db, r.ok ? r.id : 0, cap.id, cap.def, 'Quad SPI').ok).toBe(true)
  })

  it('5 — exact X × Y × Z are stored, and area uses the maximum', () => {
    const d = componentDetail(db, ids['ldo']!)!
    expect(d.package.dimensionsText).toBe('0.67 × 0.67 × 0.36 mm')
    expect(d.package.basis).toBe('max')
    // Max 0.665² = 0.442225. The nominal pair would have given 0.4096.
    expect(d.package.icAreaMm2).toBeCloseTo(0.442225, 6)
  })

  it('6 — define required external components', () => {
    const profile = createProfile(db, ids['ldo']!, 'Recommended', true)
    ids['ldoProfile'] = profile
    addExternal(db, profile, { name: 'CIN 1 µF', function: 'Input decoupling', packageName: '0402', xMm: 1.0, yMm: 0.5 })
    addExternal(db, profile, { name: 'COUT 1 µF', function: 'Output capacitor', packageName: '0402', xMm: 1.0, yMm: 0.5 })

    const d = componentDetail(db, ids['ldo']!)!
    expect(d.solution.externals).toHaveLength(2)
    expect(d.solution.externals.every((e) => e.included)).toBe(true)
  })

  it('7 — IC area is visible', () => {
    expect(componentDetail(db, ids['ldo']!)!.solution.icAreaMm2).toBeCloseTo(0.442225, 6)
  })

  it('8 — gross solution area is visible and distinct from IC area', () => {
    const s = componentDetail(db, ids['ldo']!)!.solution
    expect(s.externalAreaMm2).toBeCloseTo(1.0, 6)
    expect(s.grossComponentAreaMm2).toBeCloseTo(1.442225, 6)
    expect(s.effectiveAreaMm2!).toBeGreaterThan(s.grossComponentAreaMm2!)
    expect(s.origin).toBe('estimated')
  })

  it('9 — changing externals recalculates gross size immediately', () => {
    const before = componentDetail(db, ids['ldo']!)!.solution.effectiveAreaMm2!
    const cout = componentDetail(db, ids['ldo']!)!.solution.externals.find((e) => e.name.startsWith('COUT'))!

    setExternalIncluded(db, cout.id, false)
    const after = componentDetail(db, ids['ldo']!)!.solution
    expect(after.externalAreaMm2).toBeCloseTo(0.5, 6)
    expect(after.effectiveAreaMm2!).toBeLessThan(before)

    setExternalIncluded(db, cout.id, true)
    expect(componentDetail(db, ids['ldo']!)!.solution.effectiveAreaMm2).toBeCloseTo(before, 9)
  })

  it('10 — multiple solution profiles, each with its own BOM', () => {
    const minimum = createProfile(db, ids['mcu']!, 'Minimum BOM', true)
    addExternal(db, minimum, { name: '32 MHz crystal', xMm: 2.0, yMm: 1.6 })
    addExternal(db, minimum, { name: 'Load caps', qty: 2, xMm: 1.0, yMm: 0.5 })

    const lowPower = createProfile(db, ids['mcu']!, 'Low-power (LF crystal)')
    addExternal(db, lowPower, { name: '32 MHz crystal', xMm: 2.0, yMm: 1.6 })
    addExternal(db, lowPower, { name: 'Load caps', qty: 2, xMm: 1.0, yMm: 0.5 })
    addExternal(db, lowPower, { name: '32.768 kHz crystal', xMm: 3.2, yMm: 1.5 })

    const asMinimum = componentDetail(db, ids['mcu']!)!.solution
    expect(asMinimum.profileName).toBe('Minimum BOM')

    db.prepare('UPDATE solution_profile SET is_default = 0 WHERE component_id = ?').run(ids['mcu'])
    db.prepare('UPDATE solution_profile SET is_default = 1 WHERE id = ?').run(lowPower)
    const asLowPower = componentDetail(db, ids['mcu']!)!.solution

    expect(asLowPower.profileName).toBe('Low-power (LF crystal)')
    expect(asLowPower.effectiveAreaMm2!).toBeGreaterThan(asMinimum.effectiveAreaMm2!)

    db.prepare('UPDATE solution_profile SET is_default = 0 WHERE component_id = ?').run(ids['mcu'])
    db.prepare('UPDATE solution_profile SET is_default = 1 WHERE id = ?').run(minimum)
  })

  it('11 — browse components by category', () => {
    const rows = listCategoryRows(db, 'tiny-ldo')
    expect(rows.map((r) => r.mpn)).toContain('TPS7A0233PYCHR-MANUAL')
    expect(listCategoryRows(db, 'flash-spi-nor-128mb').map((r) => r.mpn))
      .toContain('W25Q128JVSIQ-MANUAL')
  })

  it("12 — sort and filter using the category's own characteristics", () => {
    const ldoCols = categoryColumns(db, 'tiny-ldo').map((c) => c.key)
    const flashCols = categoryColumns(db, 'flash-spi-nor-128mb').map((c) => c.key)
    expect(ldoCols).toContain('dropout')
    expect(flashCols).toContain('memory_interface')
    expect(flashCols).not.toContain('dropout')

    const filtered = listCategoryRows(db, 'tiny-ldo', 'texas')
    expect(filtered.every((r) => /texas/i.test(r.manufacturer))).toBe(true)
  })

  it('13 — rank inside a category, with unverified seed data excluded', () => {
    const rows = listCategoryRows(db, 'tiny-ldo')
    const manual = rows.find((r) => r.mpn === 'TPS7A0233PYCHR-MANUAL')!
    // The only part here with confirmed dimensions takes rank 1.
    expect(manual.rank).toBe(1)
    const seeded = rows.filter((r) => r.mpn !== 'TPS7A0233PYCHR-MANUAL')
    expect(seeded.every((r) => r.rank === null)).toBe(true)
  })

  it('14 — compare parts side by side', () => {
    const result = compareComponents(db, [ids['ldo']!, ids['mcu']!, ids['flash']!])
    expect(result.components).toHaveLength(3)
    expect(result.mixedCategories).toBe(true)

    const areaRow = result.rows.find((r) => r.key === '@ic_area')!
    expect(areaRow.values[0]!.best).toBe(true) // the LDO is smallest
    expect(areaRow.values[1]!.worst).toBe(true) // the MCU is largest

    const lifecycle = result.rows.find((r) => r.key === '@lifecycle')!
    expect(lifecycle.values.every((v) => !v.best && !v.worst)).toBe(true)
  })

  it('15 — scaled visual package-size comparison, switchable to gross', () => {
    const sizes = compareComponents(db, [ids['ldo']!, ids['mcu']!]).sizes
    expect(sizes[0]).toMatchObject({ icWidthMm: 0.665, icHeightMm: 0.665 })
    expect(sizes[1]).toMatchObject({ icWidthMm: 7.1, icHeightMm: 7.1 })
    // Both have a gross rectangle to draw, since both have profiles.
    expect(sizes.every((s) => s.grossWidthMm !== null && s.grossHeightMm !== null)).toBe(true)
  })

  it('20 — export and back up', () => {
    const bundle = exportJson(db, '2026-08-09T00:00:00Z')
    expect(bundle.formatVersion).toBe(1)
    expect((bundle.components as unknown[]).length).toBeGreaterThan(150)
    expect((bundle.externalParts as unknown[]).length).toBeGreaterThan(0)

    const csv = exportCategoryCsv(db, 'tiny-ldo')
    expect(csv.split('\n')[0]).toContain('IC size (mm²)')
    expect(csv).toContain('TPS7A0233PYCHR-MANUAL')
    expect(csv).toContain('(unverified)') // seeded rows stay marked
  })

  it('duplicate detection protects the whole flow', () => {
    const again = createComponent(db, {
      manufacturer: 'texas instruments', mpn: ' tps7a0233pychr-manual ', categorySlug: 'tiny-ldo',
    })
    expect(again.ok).toBe(false)
    expect(findDuplicate(db, 'Texas Instruments', 'TPS7A0233PYCHR-MANUAL')).not.toBeNull()
  })

  it('search finds what was just added', () => {
    expect(searchComponents(db, 'NRF54').map((h) => h.mpn)).toContain('NRF54L15-QFAA-R')
    expect(searchComponents(db, 'Winbond').length).toBeGreaterThan(0)
  })

  it('a manual override wins and survives further BOM changes', () => {
    setOverride(db, ids['ldoProfile']!, { widthMm: 2.2, heightMm: 1.4, areaMm2: null, note: 'measured' })
    let s = componentDetail(db, ids['ldo']!)!.solution
    expect(s.origin).toBe('manual')
    expect(s.effectiveAreaMm2).toBeCloseTo(3.08, 6)

    addExternal(db, ids['ldoProfile']!, { name: 'Extra cap', xMm: 1.6, yMm: 0.8 })
    s = componentDetail(db, ids['ldo']!)!.solution
    expect(s.origin).toBe('manual')
    expect(s.effectiveAreaMm2).toBeCloseTo(3.08, 6)
  })
})
