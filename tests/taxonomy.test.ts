import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { listCategories, syncCategories } from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import { createComponent } from '../src/db/repositories/mutations.js'
import { listCategoryRows } from '../src/db/repositories/components.js'
import { listSpecDefs } from '../src/db/repositories/spec-defs.js'
import type { Category } from '../src/domain/categories/model.js'
import {
  componentFamilies, createFamily, createSection, deleteComponents, deleteFamily,
  deleteSection, familyDeletionImpact, listSections, moveFamilyToSection, moveSection,
  removeComponentsFromFamily, renameFamily, renameSection, setComponentFamily, setLifecycle,
  slugify,
} from '../src/db/repositories/taxonomy.js'

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

/** Re-run the import, optionally with one category's upstream group changed. */
function resync(mutate?: (c: Category) => Category): ReturnType<typeof syncCategories> {
  const list = mutate ? CATEGORIES.map(mutate) : CATEGORIES
  return syncCategories(db, list, '2026-09-01T00:00:00Z')
}

function part(mpn: string, slug: string): number {
  const r = createComponent(db, { manufacturer: 'Acme', mpn, categorySlug: slug })
  if (!r.ok) throw new Error(`unexpected duplicate ${mpn}`)
  return r.id
}

const sectionNamed = (name: string): number =>
  listSections(db).find((s) => s.name === name)!.id

const familySection = (slug: string): string =>
  listCategories(db).find((c) => c.slug === slug)!.group

describe('sections seeded from the imported grouping', () => {
  it('adopts every group name exactly once and orders the rail from the data', () => {
    const sections = listSections(db)
    const names = sections.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('Power')
    expect(names).toContain('RF')
    // The order used to be a constant array in the renderer; it now comes from
    // the table, which is what makes a section you create placeable at all.
    expect(names.indexOf('Power')).toBeLessThan(names.indexOf('MCU'))
    expect(names.indexOf('MCU')).toBeLessThan(names.indexOf('RF'))
    expect(sections.reduce((n, s) => n + s.familyCount, 0)).toBe(CATEGORIES.length)
  })
})

describe('creating and renaming sections', () => {
  it('creates one and refuses a name that already exists, whatever its case', () => {
    const made = createSection(db, 'RF PA')
    expect(made.ok).toBe(true)
    const again = createSection(db, '  rf pa  ')
    expect(again.ok).toBe(false)
    expect(again.error).toContain('already a section')
    expect(listSections(db).filter((s) => s.name.toLowerCase() === 'rf pa')).toHaveLength(1)
  })

  it('rejects an empty name rather than creating a nameless heading', () => {
    expect(createSection(db, '   ').ok).toBe(false)
  })

  it('renames, and still refuses to collide', () => {
    const id = sectionNamed('Power')
    expect(renameSection(db, id, 'Power management').ok).toBe(true)
    expect(listSections(db).some((s) => s.name === 'Power management')).toBe(true)
    expect(renameSection(db, id, 'RF').error).toContain('already a section')
  })

  it('moves a section up the rail, and stops at the top rather than wrapping', () => {
    const before = listSections(db).map((s) => s.name)
    const second = listSections(db)[1]!
    expect(moveSection(db, second.id, 'up').ok).toBe(true)
    const after = listSections(db).map((s) => s.name)
    expect(after[0]).toBe(second.name)
    expect(after[1]).toBe(before[0])

    expect(moveSection(db, after[0] === before[1] ? second.id : second.id, 'up').ok).toBe(true)
    expect(listSections(db)[0]!.name).toBe(second.name)
  })
})

describe('moving families between sections', () => {
  it('moves a family and leaves it there when the import runs again', () => {
    const rfpa = createSection(db, 'RF PA')
    expect(rfpa.ok && rfpa.id).toBeTruthy()
    const id = rfpa.ok ? rfpa.id : 0

    expect(moveFamilyToSection(db, 'tiny-ldo', id).ok).toBe(true)
    expect(familySection('tiny-ldo')).toBe('RF PA')

    // Upstream still says Power, and still says so on the next sync. The pin is
    // the whole point: your placement is not a suggestion.
    resync()
    expect(familySection('tiny-ldo')).toBe('RF PA')
  })

  it('still follows upstream for a family you have never moved', () => {
    expect(familySection('tiny-ldo')).toBe('Power')
    resync((c) => (c.slug === 'tiny-ldo' ? { ...c, group: 'Analogue' } : c))
    expect(familySection('tiny-ldo')).toBe('Analogue')
    expect(listSections(db).some((s) => s.name === 'Analogue')).toBe(true)
  })

  it('can leave a family under no section at all', () => {
    expect(moveFamilyToSection(db, 'tiny-ldo', null).ok).toBe(true)
    expect(familySection('tiny-ldo')).toBe('')
    // Ungrouped sorts last, so it can never hide above the real headings.
    const nav = listCategories(db)
    expect(nav.at(-1)!.slug).toBe('tiny-ldo')
  })
})

describe('deleting a section', () => {
  it('never deletes the families inside it', () => {
    const power = sectionNamed('Power')
    const before = listCategories(db).filter((c) => c.group === 'Power').length
    expect(before).toBeGreaterThan(0)

    const r = deleteSection(db, power, null)
    expect(r.ok && r.movedFamilies).toBe(before)
    expect(listCategories(db)).toHaveLength(CATEGORIES.length)
    expect(listCategories(db).filter((c) => c.group === '').length).toBe(before)
  })

  it('moves them into the section you name, and pins them there', () => {
    const power = sectionNamed('Power')
    const rf = sectionNamed('RF')

    const r = deleteSection(db, power, rf)
    expect(r.ok).toBe(true)
    expect(familySection('tiny-ldo')).toBe('RF')

    // Pinned, so the re-import does not drag them back to a heading you deleted
    // — nor recreate the heading itself.
    resync()
    expect(familySection('tiny-ldo')).toBe('RF')
    expect(listSections(db).some((s) => s.name === 'Power')).toBe(false)
  })
})

describe('creating families', () => {
  it('slugs the name and puts it in the section you chose', () => {
    const rf = sectionNamed('RF')
    const r = createFamily(db, { name: 'GNSS receiver', sectionId: rf })
    expect(r.ok && r.slug).toBe('gnss-receiver')
    expect(familySection('gnss-receiver')).toBe('RF')
  })

  it('does not reuse a slug that is taken', () => {
    createFamily(db, { name: 'GNSS receiver' })
    const second = createFamily(db, { name: 'GNSS Receiver!' })
    expect(second.ok && second.slug).toBe('gnss-receiver-2')
  })

  it('refuses a duplicate display name', () => {
    const r = createFamily(db, { name: 'Very small LDO regulator' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('already a family')
  })

  it('copies parameters from another family without copying its parts', () => {
    part('TPS7A02', 'tiny-ldo')
    const source = listSpecDefs(db, 'tiny-ldo')
    expect(source.length).toBeGreaterThan(0)

    const r = createFamily(db, { name: 'Tiny LDO (automotive)', copyParametersFrom: 'tiny-ldo' })
    expect(r.ok).toBe(true)
    const copied = listSpecDefs(db, 'tiny-ldo-automotive')
    expect(copied.map((s) => s.key).sort()).toEqual(source.map((s) => s.key).sort())
    // Every copy is local, so a sync of the original never reaches through.
    expect(copied.every((s) => s.source === 'local')).toBe(true)
    expect(listCategoryRows(db, 'tiny-ldo-automotive')).toHaveLength(0)
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(1)
  })

  it('a family created here survives a re-import untouched', () => {
    createFamily(db, { name: 'Wi-Fi HaLow' })
    resync()
    expect(listCategories(db).some((c) => c.slug === 'wi-fi-halow')).toBe(true)
  })

  it('slugify never produces an empty identifier', () => {
    expect(slugify('!!!')).toBe('family')
    expect(slugify('RF PA 2.4 GHz')).toBe('rf-pa-2-4-ghz')
  })
})

describe('renaming a family', () => {
  it('keeps the new name when the import runs again', () => {
    expect(renameFamily(db, 'tiny-ldo', 'Nanopower LDO').ok).toBe(true)
    const report = resync()
    expect(report.keptLocal).toContain('tiny-ldo')
    expect(listCategories(db).find((c) => c.slug === 'tiny-ldo')!.name).toBe('Nanopower LDO')
  })

  it('refuses a name another family already has', () => {
    createFamily(db, { name: 'GNSS receiver' })
    const r = renameFamily(db, 'tiny-ldo', 'gnss receiver')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('already a family')
  })
})

describe('deleting a family', () => {
  it('reports what would be lost before anything happens', () => {
    part('A1', 'tiny-ldo')
    part('A2', 'tiny-ldo')
    const impact = familyDeletionImpact(db, 'tiny-ldo')!
    expect(impact.componentCount).toBe(2)
    expect(impact.orphanCount).toBe(2)
    expect(impact.parameterCount).toBeGreaterThan(0)
    // Asking is not doing.
    expect(listCategories(db).some((c) => c.slug === 'tiny-ldo')).toBe(true)
  })

  it('refuses while parts would be left in no family at all', () => {
    part('A1', 'tiny-ldo')
    const r = deleteFamily(db, 'tiny-ldo')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no other family')
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(1)
  })

  it('moves the parts into the family you name, then deletes', () => {
    const id = part('A1', 'tiny-ldo')
    const r = deleteFamily(db, 'tiny-ldo', { reassignTo: 'buck-5v-3v3' })
    expect(r.ok && r.movedComponents).toBe(1)
    expect(listCategories(db).some((c) => c.slug === 'tiny-ldo')).toBe(false)
    expect(listCategoryRows(db, 'buck-5v-3v3').map((x) => x.mpn)).toEqual(['A1'])
    // The part keeps a primary family rather than pointing at a deleted row.
    expect(componentFamilies(db, id)).toEqual([
      { slug: 'buck-5v-3v3', name: expect.any(String) as unknown as string, primary: true },
    ])
  })

  it('deletes an empty family with no ceremony', () => {
    expect(deleteFamily(db, 'tiny-ldo').ok).toBe(true)
    expect(listCategories(db).some((c) => c.slug === 'tiny-ldo')).toBe(false)
  })

  it('stays deleted when the import runs again', () => {
    deleteFamily(db, 'tiny-ldo')
    const report = resync()
    expect(report.skippedDeleted).toContain('tiny-ldo')
    expect(listCategories(db).some((c) => c.slug === 'tiny-ldo')).toBe(false)
  })

  it('refuses to merge a family into itself', () => {
    expect(deleteFamily(db, 'tiny-ldo', { reassignTo: 'tiny-ldo' }).ok).toBe(false)
  })
})

describe('moving parts between families', () => {
  it('move takes the part out of the family it came from', () => {
    const id = part('A1', 'tiny-ldo')
    const r = setComponentFamily(db, [id], 'buck-5v-3v3', 'move', 'tiny-ldo')
    expect(r.ok && r.moved).toBe(1)
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(0)
    expect(listCategoryRows(db, 'buck-5v-3v3')).toHaveLength(1)
    expect(componentFamilies(db, id).map((f) => f.slug)).toEqual(['buck-5v-3v3'])
  })

  it('add leaves the original membership alone, because a part can be in several', () => {
    const id = part('RF1630', 'tiny-ldo')
    const r = setComponentFamily(db, [id], 'buck-5v-3v3', 'add')
    expect(r.ok && r.moved).toBe(1)
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(1)
    expect(listCategoryRows(db, 'buck-5v-3v3')).toHaveLength(1)
    const families = componentFamilies(db, id)
    expect(families).toHaveLength(2)
    // The family it started in stays the primary one.
    expect(families.find((f) => f.primary)!.slug).toBe('tiny-ldo')
  })

  it('counts a part that is already there instead of duplicating it', () => {
    const id = part('A1', 'tiny-ldo')
    const r = setComponentFamily(db, [id], 'tiny-ldo', 'add')
    expect(r.ok && r.alreadyThere).toBe(1)
    expect(componentFamilies(db, id)).toHaveLength(1)
  })

  it('moves a whole selection at once', () => {
    const ids = [part('A1', 'tiny-ldo'), part('A2', 'tiny-ldo'), part('A3', 'tiny-ldo')]
    const r = setComponentFamily(db, ids, 'buck-5v-3v3', 'move', 'tiny-ldo')
    expect(r.ok && r.moved).toBe(3)
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(0)
    expect(listCategoryRows(db, 'buck-5v-3v3')).toHaveLength(3)
  })

  it('refuses to strand a part when taking it out of its only family', () => {
    const id = part('A1', 'tiny-ldo')
    const r = removeComponentsFromFamily(db, [id], 'tiny-ldo')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no other family')
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(1)
  })

  it('removes it happily once it is in a second family', () => {
    const id = part('RF1630', 'tiny-ldo')
    setComponentFamily(db, [id], 'buck-5v-3v3', 'add')
    const r = removeComponentsFromFamily(db, [id], 'tiny-ldo')
    expect(r.ok && r.removed).toBe(1)
    // The survivor becomes primary, so the part still opens somewhere.
    expect(componentFamilies(db, id)).toEqual([
      { slug: 'buck-5v-3v3', name: expect.any(String) as unknown as string, primary: true },
    ])
  })
})

describe('bulk edits from the right-click menu', () => {
  it('sets lifecycle across a selection', () => {
    const ids = [part('A1', 'tiny-ldo'), part('A2', 'tiny-ldo')]
    expect(setLifecycle(db, ids, 'nrnd')).toBe(2)
    const rows = db
      .prepare('SELECT lifecycle FROM component WHERE id IN (?,?)')
      .all<{ lifecycle: string }>(ids[0], ids[1])
    expect(rows.every((r) => r.lifecycle === 'nrnd')).toBe(true)
  })

  it('deletes a selection', () => {
    const ids = [part('A1', 'tiny-ldo'), part('A2', 'tiny-ldo')]
    expect(deleteComponents(db, ids)).toBe(2)
    expect(listCategoryRows(db, 'tiny-ldo')).toHaveLength(0)
  })

  it('does nothing at all when nothing is selected', () => {
    expect(setLifecycle(db, [], 'eol')).toBe(0)
    expect(deleteComponents(db, [])).toBe(0)
    expect(setComponentFamily(db, [], 'tiny-ldo', 'move').ok).toBe(false)
  })
})
