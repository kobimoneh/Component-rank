import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { SpecLexicon, normalizePhrase, fallbackKey } from '../src/import/config-yaml/lexicon.js'
import {
  flattenKeyParameter,
  importCategories,
  parseMetric,
  type ImportReport,
} from '../src/import/config-yaml/import.js'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

let lexicon: SpecLexicon
let configYaml: string
let report: ImportReport

beforeAll(() => {
  lexicon = SpecLexicon.fromYaml(read('../resources/spec-lexicon.yaml'))
  configYaml = read('../resources/component-report/config.yaml')
  report = importCategories(configYaml, lexicon)
})

describe('the YAML colon trap', () => {
  // Three real key_parameters entries contain ": " and are parsed by YAML as
  // dicts, not strings. Two carry hard constraints. Treating the list as
  // string[] either throws or silently drops the constraint.
  it('the fixture really does contain dict-shaped key_parameters', () => {
    const raw = parseYaml(configYaml) as { categories: Array<{ slug: string; key_parameters?: unknown[] }> }
    const dicts = raw.categories.flatMap((c) =>
      (c.key_parameters ?? []).filter((k) => typeof k === 'object' && k !== null).map((k) => ({ slug: c.slug, k })),
    )
    expect(dicts.length).toBe(3)
    expect(dicts.map((d) => d.slug).sort()).toEqual(['fpga-pcie', 'rf-lna-400mhz', 'rf-lna-400mhz'])
  })

  it('flattens a dict back into its original text', () => {
    const flat = flattenKeyParameter({ 'Supply / on current (HARD': 'must be < 6 mA)' })
    expect(flat).toEqual({ text: 'Supply / on current (HARD: must be < 6 mA)', wasFlattened: true })
    expect(flattenKeyParameter('Gain')).toEqual({ text: 'Gain', wasFlattened: false })
  })

  it('rf-lna-400mhz keeps its "< 6 mA" hard constraint as a typed requirement', () => {
    const cat = report.categories.find((c) => c.slug === 'rf-lna-400mhz')!
    const reqs = cat.ranking.requirements
    const current = reqs.find((r) => r.field === 'isupply')
    expect(current).toBeDefined()
    expect(current!.op).toBe('<')
    expect(current!.value).toBe(6)
    expect(current!.unit).toBe('mA')

    const coverage = reqs.find((r) => r.field === 'band_coverage')
    expect(coverage).toBeDefined()
    expect(coverage!.op).toBe('covers')
    expect(coverage!.value).toBe(400)

    // And the constraint text survives verbatim for a human to read.
    expect(cat.importNotes.join(' ')).toMatch(/must be < 6 mA/)
  })

  it('fpga-pcie keeps its hardened-PCIe constraint', () => {
    const cat = report.categories.find((c) => c.slug === 'fpga-pcie')!
    const req = cat.ranking.requirements.find((r) => r.field === 'hardened_pcie')
    expect(req).toBeDefined()
    expect(cat.specs.find((s) => s.key === 'hardened_pcie')!.type).toBe('bool')
    expect(cat.importNotes.join(' ')).toMatch(/hardened/i)
  })
})

describe('taxonomy import', () => {
  it('imports all 36 categories', () => {
    expect(report.categories).toHaveLength(36)
    expect(report.categories.map((c) => c.slug)).toContain('tiny-ldo')
    expect(report.categories.map((c) => c.slug)).toContain('pcie-phy')
  })

  it('groups categories for the nav rail instead of a flat list', () => {
    const groups = new Map<string, number>()
    for (const c of report.categories) groups.set(c.group, (groups.get(c.group) ?? 0) + 1)
    expect(Object.fromEntries(groups)).toEqual({
      Power: 4, // tiny-ldo, buck-5v-3v3, buck-12v-3v3, mini-load-switch
      Wireless: 3, // ble-transceiver, wifi-transceiver, uwb-transceiver
      MCU: 4, // smallest-mcu, smallest-zephyr-mcu, ble-mcu-easy-layout, ble-mcu-strong
      FPGA: 4, // fpga-weak, fpga-medium, fpga-strong, fpga-pcie
      RF: 17, // PA / LNA / Filter / Switch across four bands, plus rf-lna-400mhz
      Memory: 2, // flash-spi-nor-128mb, flash-128mb-any
      Connectors: 1, // tiny-connectors
      Interface: 1, // pcie-phy
    })
    expect([...groups.values()].reduce((a, b) => a + b, 0)).toBe(36)
    expect(groups.get('Other') ?? 0).toBe(0)
  })

  it('keeps best_in_class as reference names only, never as specifications', () => {
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    expect(ldo.referenceParts).toContain('TPS7A0233PYCHR')
    // Reference parts carry no spec values — importing them as facts would be
    // fabricating datasheet data.
    expect(ldo.referenceParts.every((p) => typeof p === 'string')).toBe(true)
  })

  it('preserves category manufacturer overrides', () => {
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    expect(ldo.manufacturers).toContain('Torex')
    expect(ldo.manufacturers).not.toContain('Nordic Semiconductor')
  })
})

describe('lexicon coverage', () => {
  it('types every distinct key_parameter in the real config', () => {
    // A miss is not fatal — it degrades to an editable text spec — but it should
    // be a deliberate, visible decision, so the list is asserted empty here.
    expect(report.unmappedPhrases).toEqual([])
    expect(report.matchedPhraseCount).toBe(report.phraseCount)
    expect(report.phraseCount).toBe(205)
  })

  it('produces typed, dimensioned specs rather than strings', () => {
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    const iq = ldo.specs.find((s) => s.key === 'iq')!
    expect(iq.type).toBe('scalar')
    expect(iq.dimension).toBe('current')
    expect(iq.better).toBe('lower')

    const vin = ldo.specs.find((s) => s.key === 'vin_range')!
    expect(vin.type).toBe('range')
    expect(vin.dimension).toBe('voltage')
  })

  it('splits a multi-spec phrase into several definitions', () => {
    // "Vin / Vout range, PSRR" is three specs in one source string.
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    for (const key of ['vin_range', 'vout_range', 'psrr']) {
      expect(ldo.specs.map((s) => s.key)).toContain(key)
    }
  })

  it('maps footprint phrases to a derived field, not a stored spec', () => {
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    expect(ldo.specs.map((s) => s.key)).not.toContain('package_footprint')
    expect(ldo.ranking.rules[0]!.field).toBe('@ic_area')
  })

  it('degrades an unknown phrase to an editable text spec flagged unmapped', () => {
    const resolved = lexicon.resolve('Some parameter nobody has mapped yet')
    expect(resolved.matched).toBe(false)
    expect(resolved.specs).toHaveLength(1)
    expect(resolved.specs[0]!.unmapped).toBe(true)
    expect(resolved.specs[0]!.type).toBe('text')
    expect(resolved.specs[0]!.name).toBe('Some parameter nobody has mapped yet')
  })

  it('normalizes punctuation so mm² and mm2 are the same phrase', () => {
    expect(normalizePhrase('Package footprint (mm²)')).toBe(normalizePhrase('package footprint (mm2)'))
    expect(lexicon.resolve('package footprint (mm2)').matched).toBe(true)
  })

  it('generates stable keys for unmapped phrases', () => {
    expect(fallbackKey('Peak current draw!')).toBe(fallbackKey('peak  current   draw'))
  })
})

describe('metric prose becomes ordered ranking rules', () => {
  it('tiny-ldo ranks by smallest area then lowest Iq', () => {
    const ldo = report.categories.find((c) => c.slug === 'tiny-ldo')!
    expect(ldo.ranking.metricProse).toMatch(/Smallest package footprint/)
    expect(ldo.ranking.rules).toHaveLength(2)
    expect(ldo.ranking.rules[0]).toEqual({ field: '@ic_area', direction: 'asc', missing: 'last' })
    expect(ldo.ranking.rules[1]).toEqual({ field: 'iq', direction: 'asc', missing: 'last' })
    expect(ldo.ranking.unresolved).toBe(false)
  })

  it('a total-solution metric ranks by gross area, not IC area', () => {
    const buck = report.categories.find((c) => c.slug === 'buck-5v-3v3')!
    expect(buck.ranking.rules[0]!.field).toBe('@gross_area')
  })

  it('always keeps the original prose even when a clause cannot be resolved', () => {
    for (const c of report.categories) {
      expect(c.ranking.metricProse.length).toBeGreaterThan(0)
    }
  })

  it('marks a category unresolved rather than inventing a ranking', () => {
    const r = parseMetric('Whatever feels best on the day', [], [])
    expect(r.rules).toEqual([])
    expect(r.unresolved).toBe(true)
    expect(r.metricProse).toBe('Whatever feels best on the day')
  })

  it('every category ends up with at least one usable ranking rule', () => {
    expect(report.categoriesWithUnresolvedRanking).toEqual([])
  })
})

describe('malformed input is rejected loudly', () => {
  it('throws when a category is missing name or slug', () => {
    expect(() => importCategories('categories:\n  - name: X\n', lexicon)).toThrow(/needs 'name' and 'slug'/)
  })

  it('throws when there are no categories at all', () => {
    expect(() => importCategories('settings: {}\n', lexicon)).toThrow(/no categories/)
  })
})
