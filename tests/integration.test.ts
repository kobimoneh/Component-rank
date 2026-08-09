import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, type BootstrapResult } from '../src/main/bootstrap.js'
import { listCategories } from '../src/db/repositories/categories.js'
import {
  categoryColumns,
  dataQuality,
  findDuplicate,
  listCategoryRows,
  normalizeMpn,
  searchComponents,
} from '../src/db/repositories/components.js'
import { componentDetail } from '../src/db/repositories/component-detail.js'

/**
 * End-to-end over the real application bootstrap: migrate a fresh database,
 * import the real component-report taxonomy, seed the real 160 parts, then
 * query it exactly the way the IPC handlers do.
 */

let dir: string
let boot: BootstrapResult

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'complib-'))
  boot = bootstrap(dir)
})

afterAll(() => {
  boot?.db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('first run', () => {
  it('creates the database, migrates, imports categories and seeds parts', () => {
    expect(existsSync(join(dir, 'components.sqlite'))).toBe(true)
    expect(boot.schemaVersion).toBeGreaterThan(0)
    expect(boot.warnings).toEqual([])
    expect(boot.sync!.created).toHaveLength(36)
    expect(boot.seed!.created).toBe(150)
    // 10 more are the same part cross-listed into a second or third category.
    expect(boot.seed!.crossListed).toBe(10)
    expect(boot.seed!.unknownCategories).toEqual([])
  })

  it('recovers explicit dimensions where the source states them, and only there', () => {
    // The other 43 headlines carry no millimetre pair. They stay Unknown rather
    // than having a size inferred from a package code.
    expect(boot.seed!.withDimensions).toBe(107)
    expect(boot.seed!.withoutDimensions).toBe(43)
  })

  it('reports data quality honestly', () => {
    const q = dataQuality(boot.db)
    expect(q.unverifiedDimensions).toBe(107)
    expect(q.missingDimensions).toBe(43)
    expect(q.missingDatasheet).toBe(0)
  })

  it('is idempotent — a second bootstrap does not duplicate anything', () => {
    const second = bootstrap(dir)
    expect(second.sync!.created).toEqual([])
    expect(second.sync!.unchanged).toHaveLength(36)
    expect(second.seed).toBeNull() // seeding only happens on first run
    const count = second.db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n
    expect(count).toBe(150)
    second.db.close()
  })
})

describe('category browsing, the way the UI does it', () => {
  it('lists categories grouped with live component counts', () => {
    const cats = listCategories(boot.db)
    expect(cats).toHaveLength(36)
    const ldo = cats.find((c) => c.slug === 'tiny-ldo')!
    expect(ldo.group).toBe('Power')
    expect(ldo.componentCount).toBe(5)
  })

  it('builds category-specific columns, not one fixed schema', () => {
    const ldoCols = categoryColumns(boot.db, 'tiny-ldo').map((c) => c.key)
    const mcuCols = categoryColumns(boot.db, 'smallest-mcu').map((c) => c.key)

    expect(ldoCols).toContain('iq')
    expect(ldoCols).toContain('dropout')
    expect(ldoCols).not.toContain('flash')

    expect(mcuCols).toContain('flash')
    expect(mcuCols).toContain('gpio_count')
    expect(mcuCols).not.toContain('dropout')

    // Both always carry size, first-class.
    for (const cols of [ldoCols, mcuCols]) {
      expect(cols).toContain('@ic_area')
      expect(cols).toContain('@gross_area')
    }
  })

  it('returns rows with formatted cells and no fabricated numbers', () => {
    const rows = listCategoryRows(boot.db, 'tiny-ldo')
    expect(rows).toHaveLength(5)
    const tps = rows.find((r) => r.mpn === 'TPS7A0233PYCHR')!
    expect(tps.manufacturer).toBe('Texas Instruments')
    expect(tps.cells['@ic_area']!.text).toBe('0.41 mm²')
    expect(tps.cells['@ic_area']!.unverified).toBe(true)
    // Gross size is unknown until a solution profile exists — the IC footprint
    // is never reported as a solution size.
    expect(tps.cells['@gross_area']!.text).toBeNull()
    // No datasheet has been read, so no specification is claimed.
    expect(tps.cells['iq']).toBeUndefined()
  })

  it('does not rank parts whose only dimensions are unverified', () => {
    const rows = listCategoryRows(boot.db, 'tiny-ldo')
    expect(rows.every((r) => r.rank === null)).toBe(true)
    // Either unverified (prose dimensions) or genuinely unknown — never ranked.
    expect(rows.every((r) => /unverified|unknown/i.test(r.unrankedReason ?? ''))).toBe(true)
    expect(rows.some((r) => /unverified/i.test(r.unrankedReason ?? ''))).toBe(true)
  })

  it('ranks the same parts once their dimensions are confirmed', () => {
    const db = boot.db
    db.prepare(`
      UPDATE package SET is_unverified = 0
      WHERE component_id IN (SELECT id FROM component
                             WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo'))
    `).run()

    const rows = listCategoryRows(db, 'tiny-ldo')
    const ranked = rows.filter((r) => r.rank !== null)
    expect(ranked.length).toBeGreaterThan(0)

    // Smallest area takes rank 1, per the imported metric.
    const areas = ranked
      .map((r) => ({ rank: r.rank!, area: r.cells['@ic_area']!.sort! }))
      .sort((a, b) => a.rank - b.rank)
    for (let i = 1; i < areas.length; i++) {
      expect(areas[i]!.area).toBeGreaterThanOrEqual(areas[i - 1]!.area)
    }

    // Put it back so later assertions see the seeded state.
    db.prepare(`
      UPDATE package SET is_unverified = 1
      WHERE component_id IN (SELECT id FROM component
                             WHERE category_id = (SELECT id FROM category WHERE slug='tiny-ldo'))
    `).run()
  })

  it('filters within a category', () => {
    const all = listCategoryRows(boot.db, 'tiny-ldo')
    const filtered = listCategoryRows(boot.db, 'tiny-ldo', 'diodes')
    expect(filtered.length).toBeLessThan(all.length)
    expect(filtered.every((r) => /diodes/i.test(r.manufacturer))).toBe(true)
  })
})

describe('a part can belong to several categories', () => {
  it('lists a cross-listed RF switch in every band category it serves', () => {
    // RF1630 is listed by component-report under 2.4 GHz, cellular and 5-6 GHz.
    // One category per component would silently drop it from two of them.
    const slugs = ['rf-switch-2g4', 'rf-switch-cellular', 'rf-switch-5g6']
    for (const slug of slugs) {
      const rows = listCategoryRows(boot.db, slug)
      expect(rows.map((r) => r.mpn)).toContain('RF1630')
    }
    // …and it is still exactly one component row, not three duplicates.
    const n = boot.db
      .prepare("SELECT COUNT(*) n FROM component WHERE mpn_norm = 'RF1630'")
      .get<{ n: number }>()!.n
    expect(n).toBe(1)
  })

  it('counts memberships, so category counts add up to more than the part count', () => {
    const cats = listCategories(boot.db)
    const total = cats.reduce((sum, c) => sum + c.componentCount, 0)
    expect(total).toBe(160)
    const parts = boot.db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n
    expect(parts).toBe(150)
  })
})

describe('search', () => {
  it('finds a part by a fragment of its MPN', () => {
    const hits = searchComponents(boot.db, 'nRF54')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.mpn.toUpperCase()).toContain('NRF54')
    expect(hits[0]!.categoryName).toBeTruthy()
  })

  it('finds parts by manufacturer', () => {
    const hits = searchComponents(boot.db, 'Nordic')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.manufacturer.includes('Nordic') || /nordic/i.test(h.mpn))).toBe(true)
  })

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchComponents(boot.db, '   ')).toEqual([])
  })
})

describe('duplicate detection', () => {
  it('matches on manufacturer plus normalized MPN', () => {
    expect(normalizeMpn(' tps7a0233pychr ')).toBe('TPS7A0233PYCHR')
    const dup = findDuplicate(boot.db, 'texas instruments', 'tps7a0233pychr')
    expect(dup).not.toBeNull()
    expect(dup!.mpn).toBe('TPS7A0233PYCHR')
  })

  it('does not match a different manufacturer with the same MPN', () => {
    expect(findDuplicate(boot.db, 'Some Other Vendor', 'TPS7A0233PYCHR')).toBeNull()
  })
})

describe('component detail', () => {
  it('assembles the drawer payload', () => {
    const rows = listCategoryRows(boot.db, 'tiny-ldo')
    const row = rows.find((r) => r.cells['@ic_area']!.sort !== null)!
    const d = componentDetail(boot.db, row.id)!
    expect(d.mpn).toBe(row.mpn)
    expect(d.categoryName).toBe('Very small LDO regulator')
    expect(d.datasheetUrl).toMatch(/^https?:\/\//)
    expect(d.package.unverified).toBe(true)
    expect(d.package.unverifiedReason).toMatch(/not read from the datasheet/i)
    // No solution profile yet, so gross size is absent rather than guessed.
    expect(d.solution.profileName).toBeNull()
    expect(d.solution.effectiveAreaMm2).toBeNull()
  })

  it('keeps the imported prose as a note instead of as data', () => {
    const row = listCategoryRows(boot.db, 'tiny-ldo')[0]!
    const d = componentDetail(boot.db, row.id)!
    expect(d.notes).toMatch(/Imported summary:/)
  })

  it('returns null for an unknown id rather than throwing', () => {
    expect(componentDetail(boot.db, 999999)).toBeNull()
  })
})
