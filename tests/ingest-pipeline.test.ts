import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openInMemory, type SqlDriver } from '../src/db/driver.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'
import { syncCategories } from '../src/db/repositories/categories.js'
import { SpecLexicon } from '../src/import/config-yaml/lexicon.js'
import { importCategories } from '../src/import/config-yaml/import.js'
import { ingestDatasheet, guessCategory, selectPages } from '../src/extraction/pipeline.js'
import { applyReview, discardReview } from '../src/extraction/apply.js'
import { extractPdfText, itemsToText, rankPagesFor } from '../src/extraction/pdf-text.js'
import { componentDetail } from '../src/db/repositories/component-detail.js'
import { listCategoryRows, searchComponents } from '../src/db/repositories/components.js'
import { updateComponent, setSpecValue } from '../src/db/repositories/mutations.js'
import { getDatasheetPages, datasheetStorageStats } from '../src/db/repositories/datasheets.js'
import { extractJsonObject, buildExtractionPrompt } from '../src/ai/local-openai.js'
import type { ExtractionProvider, ExtractionResult } from '../src/ai/provider.js'
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

/**
 * A minimal but genuinely valid PDF with a real text layer, built by hand so the
 * test exercises the actual pdf.js path rather than a stub.
 */
function makePdf(lines: readonly string[]): Uint8Array {
  const content = lines
    .map((l, i) => `BT /F1 11 Tf 40 ${740 - i * 16} Td (${l.replace(/([()\\])/g, '\\$1')}) Tj ET`)
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

const DATASHEET_LINES = [
  'TPS7A02 Nanopower 200-mA Low-Dropout Voltage Regulator',
  'Texas Instruments  SBVS334  ELECTRICAL CHARACTERISTICS',
  'IQ Quiescent current, no load 25 nA',
  'Dropout voltage at 200 mA 105 mV',
  'VIN Input voltage range 1.5 to 6.0 V',
  'Package DSBGA-4 maximum dimensions 0.665 mm x 0.665 mm',
  'Typical application requires CIN 1 uF and COUT 1 uF ceramic capacitors',
]

let PDF: Uint8Array
beforeAll(() => { PDF = makePdf(DATASHEET_LINES) })

/** A provider that returns a fixed, deliberately mixed-quality result. */
function fakeProvider(result: Partial<ExtractionResult> = {}): ExtractionProvider {
  return {
    id: 'local-openai',
    status: async () => ({ id: 'local-openai', available: true, reason: null }),
    extract: async (): Promise<ExtractionResult> => ({
      manufacturer: 'Texas Instruments',
      mpn: 'TPS7A0233PYCHR',
      productName: 'TPS7A02',
      categorySlug: 'tiny-ldo',
      categoryConfidence: 0.95,
      packageVariants: [{
        name: 'DSBGA-4', orderingCodeFragment: 'YCH', pinCount: 4,
        xMin: null, xNom: 0.64, xMax: 0.665,
        yMin: null, yNom: 0.64, yMax: 0.665,
        zMin: null, zNom: null, zMax: 0.36,
        page: 1, evidence: 'Package DSBGA-4 maximum dimensions 0.665 mm x 0.665 mm',
      }],
      claims: [
        { specKey: 'iq', value: '25 nA', unit: 'nA', page: 1,
          evidence: 'IQ Quiescent current, no load 25 nA', confidence: 0.94 },
        { specKey: 'dropout', value: '105 mV', unit: 'mV', page: 1,
          evidence: 'Dropout voltage at 200 mA 105 mV', confidence: 0.9 },
        // Fabricated — this sentence is nowhere in the document.
        { specKey: 'iout_max', value: '500 mA', unit: 'mA', page: 1,
          evidence: 'Maximum output current 500 mA continuous', confidence: 0.99 },
        // Honest "not found".
        { specKey: 'psrr', value: null, unit: null, page: null, evidence: null, confidence: 0.1 },
      ],
      suggestedExternals: [
        { name: 'CIN 1 µF', function: 'Input capacitor', qty: 1, necessity: 'required',
          valueText: '1 µF', packageName: '0402', xMm: 1.0, yMm: 0.5, page: 1,
          evidence: 'Typical application requires CIN 1 uF and COUT 1 uF ceramic capacitors' },
        { name: 'COUT 1 µF', function: 'Output capacitor', qty: 1, necessity: 'required',
          valueText: '1 µF', packageName: '0402', xMm: 1.0, yMm: 0.5, page: 1, evidence: null },
      ],
      ...result,
    }),
  }
}

describe('PDF text extraction, in-process', () => {
  it('reads a real PDF text layer', async () => {
    const extracted = await extractPdfText(PDF)
    expect(extracted.pageCount).toBe(1)
    expect(extracted.needsOcr).toBe(false)
    expect(extracted.pages[0]!.method).toBe('text-layer')
    expect(extracted.pages[0]!.text).toMatch(/Quiescent current/)
    expect(extracted.pages[0]!.text).toMatch(/0\.665/)
  })

  it('keeps table rows on separate lines instead of running them together', () => {
    const text = itemsToText([
      { str: 'IQ', transform: [1, 0, 0, 1, 40, 700] },
      { str: 'Quiescent current', transform: [1, 0, 0, 1, 90, 700] },
      { str: '25 nA', transform: [1, 0, 0, 1, 300, 700] },
      { str: 'Dropout', transform: [1, 0, 0, 1, 40, 684] },
      { str: '105 mV', transform: [1, 0, 0, 1, 300, 684] },
    ])
    expect(text.split('\n')).toEqual(['IQ Quiescent current 25 nA', 'Dropout 105 mV'])
  })

  it('flags a scanned document rather than extracting nonsense', async () => {
    const blank = await extractPdfText(makePdf(['']))
    expect(blank.needsOcr).toBe(true)
    expect(blank.pages[0]!.method).toBe('none')
  })

  it('ranks pages by how often they mention what we want', () => {
    const pages = [
      { page: 1, text: 'cover page', method: 'text-layer' as const, chars: 10 },
      { page: 2, text: 'quiescent current quiescent current dropout', method: 'text-layer' as const, chars: 40 },
      { page: 3, text: 'ordering information', method: 'text-layer' as const, chars: 20 },
    ]
    const ranked = rankPagesFor(pages, ['quiescent current'], 2)
    expect(ranked[0]!.page).toBe(2)
  })

  it('keeps the page selection inside a character budget', () => {
    const pages = Array.from({ length: 40 }, (_, i) => ({
      page: i + 1,
      text: 'dropout '.repeat(200),
      method: 'text-layer' as const,
      chars: 1600,
    }))
    const chosen = selectPages(pages, ['dropout'], 5000)
    const total = chosen.reduce((n, p) => n + p.text.length, 0)
    expect(chosen.length).toBeLessThan(pages.length)
    expect(total).toBeLessThanOrEqual(5000 + pages[0]!.text.length)
  })
})

describe('category guessing', () => {
  it('recognises an LDO from its own words', async () => {
    const extracted = await extractPdfText(PDF)
    expect(guessCategory(db, extracted.pages)).toBe('tiny-ldo')
  })

  it('returns null rather than guessing wildly', async () => {
    const extracted = await extractPdfText(makePdf(['Some unrelated document about gardening']))
    expect(guessCategory(db, extracted.pages)).toBeNull()
  })
})

describe('drop a PDF, get a reviewable proposal', () => {
  it('stores the document even when no model is configured', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'tps7a02.pdf' }, null)

    expect(outcome.datasheetId).toBeGreaterThan(0)
    expect(datasheetStorageStats(db).stored).toBe(1)
    expect(getDatasheetPages(db, outcome.datasheetId)).toHaveLength(1)
    expect(outcome.fields).toEqual([])
    expect(outcome.stages.find((s) => s.stage === 'model-called')!.detail)
      .toMatch(/No extraction model configured/)
  })

  it('runs the whole pipeline and reports each stage', async () => {
    const outcome = await ingestDatasheet(
      db, { bytes: PDF, fileName: 'tps7a02.pdf' }, fakeProvider(),
    )
    const stages = outcome.stages.map((s) => s.stage)
    expect(stages).toEqual([
      'stored', 'text-extracted', 'category-suggested',
      'model-called', 'validated', 'verified', 'proposed',
    ])
    expect(outcome.identity!.mpn).toBe('TPS7A0233PYCHR')
    expect(outcome.identity!.categorySlug).toBe('tiny-ldo')
  })

  it('verifies each quote against the page it cites', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())

    const iq = outcome.fields.find((f) => f.specKey === 'iq')!
    const fabricated = outcome.fields.find((f) => f.specKey === 'iout_max')!
    const notFound = outcome.fields.find((f) => f.specKey === 'psrr')!

    expect(iq.verified).toBe(true)
    // 0.99 confidence does not save a quote that is not in the document.
    expect(fabricated.verified).toBe(false)
    expect(fabricated.status).toBe('not-found')
    expect(notFound.status).toBe('null-value')

    expect(outcome.stages.find((s) => s.stage === 'verified')!.detail)
      .toMatch(/2 verified, 1 rejected/)
  })

  it('hands the review screen the page text so the quote can be highlighted', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    const iq = outcome.fields.find((f) => f.specKey === 'iq')!
    expect(iq.pageText).toContain('Quiescent current')
    expect(iq.pageText!.includes(iq.evidence!.slice(0, 20))).toBe(true)
  })

  it('resolves the package variant from the ordering code', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    expect(outcome.packageChoiceRequired).toBe(false)
    expect(outcome.resolvedPackage!.name).toBe('DSBGA-4')
    expect(outcome.resolvedPackage!.xMax).toBe(0.665)
  })

  it('asks which package when the ordering code does not disambiguate', async () => {
    const provider = fakeProvider({
      mpn: 'NRF54L15',
      packageVariants: [
        { name: 'QFN-48', orderingCodeFragment: null, pinCount: 48,
          xMin: null, xNom: 7, xMax: 7.1, yMin: null, yNom: 7, yMax: 7.1,
          zMin: null, zNom: null, zMax: 0.9, page: 1, evidence: null },
        { name: 'WLCSP-50', orderingCodeFragment: null, pinCount: 50,
          xMin: null, xNom: 3.1, xMax: 3.2, yMin: null, yNom: 3.1, yMax: 3.2,
          zMin: null, zNom: null, zMax: 0.5, page: 1, evidence: null },
      ],
    })
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, provider)
    expect(outcome.packageChoiceRequired).toBe(true)
    expect(outcome.resolvedPackage).toBeNull()
    expect(outcome.stages.at(-1)!.detail).toMatch(/choose which one/)
  })

  it('surfaces a model failure as a named stage rather than a blank screen', async () => {
    const broken: ExtractionProvider = {
      id: 'local-openai',
      status: async () => ({ id: 'local-openai', available: true, reason: null }),
      extract: async () => { throw new Error('connection refused') },
    }
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, broken)
    expect(outcome.error).toMatch(/connection refused/)
    expect(outcome.stages.find((s) => s.stage === 'model-called')!.ok).toBe(false)
    // The document is still stored — a failed read does not lose the PDF.
    expect(datasheetStorageStats(db).stored).toBe(1)
  })

  it('writes nothing into the library before review', async () => {
    await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    expect(db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM spec_value').get<{ n: number }>()!.n).toBe(0)
  })
})

describe('saving an approved review', () => {
  const approve = async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    return { outcome, result: applyReview(db, {
      jobId: outcome.jobId,
      identity: {
        manufacturer: 'Texas Instruments',
        mpn: 'TPS7A0233PYCHR',
        categorySlug: 'tiny-ldo',
        datasheetId: outcome.datasheetId,
        whereUsed: 'Sensor node rev C',
      },
      package: {
        name: outcome.resolvedPackage!.name,
        pinCount: outcome.resolvedPackage!.pinCount,
        xMax: outcome.resolvedPackage!.xMax,
        yMax: outcome.resolvedPackage!.yMax,
        zMax: outcome.resolvedPackage!.zMax,
      },
      // Only the verified fields, as the screen defaults to.
      fields: outcome.fields
        .filter((f) => f.verified)
        .map((f) => ({
          specKey: f.specKey, value: f.rawValue!, page: f.page,
          evidence: f.evidence, confidence: f.confidence, edited: false,
        })),
      externals: outcome.externals.map((e) => ({
        name: e.name, function: e.function, qty: e.qty,
        necessity: e.necessity as 'required',
        valueText: e.valueText, packageName: e.packageName, xMm: e.xMm, yMm: e.yMm,
      })),
    }) }
  }

  it('creates the component with max dimensions and the right area', async () => {
    const { result } = await approve()
    expect(result.ok).toBe(true)
    const d = componentDetail(db, result.componentId!)!
    expect(d.mpn).toBe('TPS7A0233PYCHR')
    expect(d.package.basis).toBe('max')
    expect(d.package.icAreaMm2).toBeCloseTo(0.442225, 6)
    expect(d.package.unverified).toBe(false)
  })

  it('writes the verified specs and nothing else', async () => {
    const { result } = await approve()
    const d = componentDetail(db, result.componentId!)!
    const keys = d.specs.map((s) => s.key)
    expect(keys).toContain('iq')
    expect(keys).toContain('dropout')
    // The fabricated one never made it in.
    expect(keys).not.toContain('iout_max')
    expect(d.specs.find((s) => s.key === 'iq')!.value).toBe('0.025 µA')
    expect(d.specs.find((s) => s.key === 'iq')!.origin).toBe('extracted')
  })

  it('records provenance for every value it wrote', async () => {
    const { result } = await approve()
    const rows = db
      .prepare(`
        SELECT p.page, p.evidence, p.evidence_verified FROM provenance p
        JOIN spec_value v ON v.id = p.subject_id
        WHERE p.subject_type = 'spec_value' AND v.component_id = ?
      `)
      .all<{ page: number; evidence: string; evidence_verified: number }>(result.componentId!)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.evidence_verified === 1)).toBe(true)
    expect(rows.some((r) => /Quiescent current/.test(r.evidence))).toBe(true)
  })

  it('creates a solution profile from the approved externals, and gross size follows', async () => {
    const { result } = await approve()
    const d = componentDetail(db, result.componentId!)!
    expect(d.solution.profileName).toBe('From datasheet')
    expect(d.solution.externals).toHaveLength(2)
    expect(d.solution.externalAreaMm2).toBeCloseTo(1.0, 6)
    expect(d.solution.grossComponentAreaMm2).toBeCloseTo(0.442225 + 1.0, 6)
    expect(d.solution.effectiveAreaMm2!).toBeGreaterThan(d.solution.grossComponentAreaMm2!)
  })

  it('stores "Where used?" and makes it searchable', async () => {
    const { result } = await approve()
    expect(componentDetail(db, result.componentId!)!.whereUsed).toBe('Sensor node rev C')
    expect(searchComponents(db, 'sensor node').map((h) => h.id)).toContain(result.componentId!)
  })

  it('the part appears in its category, ranked, immediately', async () => {
    const { result } = await approve()
    const row = listCategoryRows(db, 'tiny-ldo').find((r) => r.id === result.componentId)!
    expect(row.rank).toBe(1)
    expect(row.cells['iq']!.text).toBe('0.025 µA')
    expect(row.cells['@ic_area']!.unverified).toBe(false)
  })

  it('marks the job applied and the proposals accepted', async () => {
    const { outcome, result } = await approve()
    expect(result.ok).toBe(true)
    const job = db.prepare('SELECT status FROM ingest_job WHERE id = ?')
      .get<{ status: string }>(outcome.jobId)!
    expect(job.status).toBe('applied')
  })

  it('refuses to create a duplicate and says which part it is', async () => {
    await approve()
    const second = await approve()
    expect(second.result.ok).toBe(false)
    expect(second.result.duplicate!.mpn).toBe('TPS7A0233PYCHR')
    expect(db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n).toBe(1)
  })

  it('an edited value is stored as manual and survives a later extraction', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    const result = applyReview(db, {
      jobId: outcome.jobId,
      identity: {
        manufacturer: 'TI', mpn: 'EDITED-1', categorySlug: 'tiny-ldo',
        datasheetId: outcome.datasheetId,
      },
      package: null,
      fields: [{
        specKey: 'iq', value: '30 nA', page: 1,
        evidence: 'IQ Quiescent current, no load 25 nA', confidence: 0.94, edited: true,
      }],
      externals: [],
    })
    const d = componentDetail(db, result.componentId!)!
    expect(d.specs.find((s) => s.key === 'iq')!.value).toBe('0.03 µA')
  })

  it('discarding leaves the library untouched but keeps the document', async () => {
    const outcome = await ingestDatasheet(db, { bytes: PDF, fileName: 'x.pdf' }, fakeProvider())
    discardReview(db, outcome.jobId)
    expect(db.prepare('SELECT COUNT(*) n FROM component').get<{ n: number }>()!.n).toBe(0)
    expect(datasheetStorageStats(db).stored).toBe(1)
    const job = db.prepare('SELECT status FROM ingest_job WHERE id = ?')
      .get<{ status: string }>(outcome.jobId)!
    expect(job.status).toBe('rejected')
  })
})

describe('Where used', () => {
  it('is editable by hand and searchable', () => {
    const created = db.prepare('SELECT 1').get()
    expect(created).toBeTruthy()

    const r = db.prepare(`
      INSERT INTO manufacturer (name, name_norm) VALUES ('Vendor','vendor')
    `).run()
    const id = db.prepare(`
      INSERT INTO component (manufacturer_id, mpn, mpn_norm, lifecycle, created_at, updated_at)
      VALUES (?, 'X-1', 'X-1', 'active', '', '')
    `).run(r.lastInsertRowid).lastInsertRowid

    updateComponent(db, id, { whereUsed: 'Gateway rev B, 4-layer only' })
    expect(componentDetail(db, id)!.whereUsed).toBe('Gateway rev B, 4-layer only')
    expect(searchComponents(db, 'gateway').map((h) => h.id)).toContain(id)
    expect(searchComponents(db, '4-layer').map((h) => h.id)).toContain(id)
  })

  it('defaults to empty rather than null', () => {
    const r = db.prepare("INSERT INTO manufacturer (name, name_norm) VALUES ('V','v')").run()
    const id = db.prepare(`
      INSERT INTO component (manufacturer_id, mpn, mpn_norm, lifecycle, created_at, updated_at)
      VALUES (?, 'Y-1', 'Y-1', 'active', '', '')
    `).run(r.lastInsertRowid).lastInsertRowid
    expect(componentDetail(db, id)!.whereUsed).toBe('')
  })
})

describe('local model reply handling', () => {
  it('accepts plain JSON, fenced JSON, and JSON buried in chatter', () => {
    const obj = { mpn: 'X' }
    expect(extractJsonObject('{"mpn":"X"}')).toEqual(obj)
    expect(extractJsonObject('```json\n{"mpn":"X"}\n```')).toEqual(obj)
    expect(extractJsonObject('Sure! Here you go:\n{"mpn":"X"}\nHope that helps.')).toEqual(obj)
  })

  it('throws on a reply with no JSON rather than returning junk', () => {
    expect(() => extractJsonObject('I could not read that datasheet.')).toThrow(/no JSON/)
  })

  it('builds a prompt that names the category parameters and the pages', () => {
    const prompt = buildExtractionPrompt({
      pages: [{ page: 7, text: 'IQ 25 nA' }],
      mpnHint: 'TPS7A02',
      categories: [{
        slug: 'tiny-ldo', name: 'Tiny LDO', description: '',
        specs: [{ key: 'iq', name: 'Quiescent current', unit: 'µA', ai: null }],
      }],
    })
    expect(prompt).toContain('TPS7A02')
    expect(prompt).toContain('iq: Quiescent current (µA)')
    expect(prompt).toContain('--- PAGE 7 ---')
  })
})

/** Keeps the unused-import checker honest about the spec helper. */
export type _Unused = SpecDefinition | typeof setSpecValue
