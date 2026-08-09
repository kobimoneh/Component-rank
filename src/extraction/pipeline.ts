import type { SqlDriver } from '../db/driver.js'
import { extractPdfText, rankPagesFor, type ExtractedPage } from './pdf-text.js'
import { verifyAll, type ExtractedClaim, type PageText, type VerifiedClaim } from './evidence.js'
import { getDatasheetPages, setDatasheetPages, storeDatasheet } from '../db/repositories/datasheets.js'
import { enqueueJob } from '../db/repositories/ingest.js'
import { listSpecDefs } from '../db/repositories/spec-defs.js'
import { listCategories } from '../db/repositories/categories.js'
import { findDuplicate } from '../db/repositories/components.js'
import {
  resolvePackageVariant, type ExtractionProvider, type ExtractionRequest,
  type ExtractionResult, type PackageVariant, type SuggestedExternal,
} from '../ai/provider.js'

/**
 * Drop a PDF, get a reviewable proposal.
 *
 * One call does the whole thing: store the bytes, read the text, pick the pages
 * worth sending, ask the model, validate its JSON, verify every quote against
 * the page it cites, and write a proposal for review. Nothing reaches the
 * library until a human accepts it.
 *
 * Each stage reports what it did, so a failure says which step failed rather
 * than "extraction failed".
 */

export type Stage =
  | 'stored'
  | 'text-extracted'
  | 'category-suggested'
  | 'model-called'
  | 'validated'
  | 'verified'
  | 'proposed'

export interface StageReport {
  readonly stage: Stage
  readonly ok: boolean
  readonly detail: string
}

export interface DetectedIdentity {
  readonly manufacturer: string | null
  readonly mpn: string | null
  readonly productName: string | null
  readonly categorySlug: string | null
  readonly categoryConfidence: number
  /** Set when the MPN already exists — the UI offers open/variant instead. */
  readonly duplicate: { id: number; mpn: string; manufacturer: string } | null
}

export interface ReviewField {
  readonly specKey: string
  readonly label: string
  readonly rawValue: string | null
  readonly unit: string | null
  readonly page: number | null
  readonly evidence: string | null
  readonly verified: boolean
  readonly status: VerifiedClaim['status']
  readonly explanation: string
  readonly confidence: number
  /** The full page text, so the review screen can highlight the quote in place. */
  readonly pageText: string | null
}

export interface PageChars {
  readonly page: number
  readonly chars: number
}

export interface IngestOutcome {
  readonly jobId: number
  readonly datasheetId: number
  /** Per-page character counts, so the renderer knows which pages need OCR. */
  readonly pageChars: readonly PageChars[]
  readonly stages: readonly StageReport[]
  readonly identity: DetectedIdentity | null
  readonly packageVariants: readonly PackageVariant[]
  readonly packageChoiceRequired: boolean
  readonly resolvedPackage: PackageVariant | null
  readonly fields: readonly ReviewField[]
  readonly externals: readonly SuggestedExternal[]
  readonly needsOcr: boolean
  readonly pageCount: number
  readonly error: string | null
}

export interface IngestInput {
  readonly bytes: Uint8Array
  readonly fileName: string
  readonly mpnHint?: string | null
  readonly categoryHint?: string | null
  readonly componentId?: number | null
}

/** Characters of datasheet text to send. Kept modest for local models. */
const DEFAULT_BUDGET = 24_000

export async function ingestDatasheet(
  db: SqlDriver,
  input: IngestInput,
  provider: ExtractionProvider | null,
  opts: { budgetChars?: number } = {},
): Promise<IngestOutcome> {
  const stages: StageReport[] = []
  const budget = opts.budgetChars ?? DEFAULT_BUDGET

  // 1 — store the bytes. Happens first, so a failed extraction still leaves you
  // with the document in the database rather than nothing.
  const stored = storeDatasheet(db, {
    content: input.bytes,
    title: input.fileName,
    source: 'drop',
    componentId: input.componentId ?? null,
  })
  stages.push({
    stage: 'stored',
    ok: true,
    detail: stored.deduplicated
      ? 'Already in the database — reusing the stored copy.'
      : `Stored ${(input.bytes.byteLength / 1024).toFixed(0)} kB.`,
  })

  // 2 — text layer
  let extracted
  try {
    extracted = await extractPdfText(input.bytes)
  } catch (err) {
    stages.push({ stage: 'text-extracted', ok: false, detail: (err as Error).message })
    const jobId = enqueueJob(db, { datasheetId: stored.id, mpnHint: input.mpnHint ?? null })
    return fail(jobId, stored.id, stages, `Could not read the PDF: ${(err as Error).message}`)
  }

  setDatasheetPages(
    db, stored.id,
    extracted.pages.map((p) => ({ page: p.page, text: p.text, method: p.method })),
    'pdfjs',
  )
  stages.push({
    stage: 'text-extracted',
    ok: !extracted.needsOcr,
    detail: extracted.needsOcr
      ? `${extracted.pageCount} pages, but ${extracted.emptyPages.length} have no text layer — this looks like a scan and needs OCR.`
      : `${extracted.pageCount} pages read from the text layer.`,
  })

  const jobId = enqueueJob(db, {
    datasheetId: stored.id,
    componentId: input.componentId ?? null,
    mpnHint: input.mpnHint ?? null,
    categoryHint: input.categoryHint ?? null,
  })

  // 3 — which category, and therefore which parameters matter
  const categorySlug = input.categoryHint ?? guessCategory(db, extracted.pages)
  const specs = categorySlug ? listSpecDefs(db, categorySlug) : []
  stages.push({
    stage: 'category-suggested',
    ok: categorySlug !== null,
    detail: categorySlug
      ? `${categorySlug} — asking for ${specs.length} parameters.`
      : 'Could not guess a category from the text; the model will be asked to choose.',
  })

  if (!provider) {
    stages.push({
      stage: 'model-called',
      ok: false,
      detail: 'No extraction model configured. The datasheet and its text are saved; add a model in Settings to extract automatically.',
    })
    return {
      jobId, datasheetId: stored.id, stages,
      pageChars: extracted.pages.map((p) => ({ page: p.page, chars: p.chars })),
      identity: null, packageVariants: [], packageChoiceRequired: false,
      resolvedPackage: null, fields: [], externals: [],
      needsOcr: extracted.needsOcr, pageCount: extracted.pageCount,
      error: null,
    }
  }

  // 4 — send only the pages that mention what we are looking for
  const terms = [
    ...specs.map((s) => s.name),
    'ordering information', 'mechanical', 'package', 'dimensions',
    'absolute maximum', 'electrical characteristics', 'application circuit',
  ]
  const chosen = selectPages(extracted.pages, terms, budget)

  const request: ExtractionRequest = {
    pages: chosen.map((p) => ({ page: p.page, text: p.text })),
    mpnHint: input.mpnHint ?? null,
    categories: categorySlug
      ? [{
          slug: categorySlug,
          name: categorySlug,
          description: '',
          specs: specs.map((s) => ({ key: s.key, name: s.name, unit: s.unit, ai: null })),
        }]
      : listCategories(db).slice(0, 40).map((c) => ({
          slug: c.slug, name: c.name, description: '', specs: [],
        })),
  }

  let result: ExtractionResult
  try {
    result = await provider.extract(request)
    stages.push({
      stage: 'model-called',
      ok: true,
      detail: `${provider.id} read ${chosen.length} of ${extracted.pageCount} pages.`,
    })
    stages.push({
      stage: 'validated',
      ok: true,
      detail: `${result.claims.length} values, ${result.packageVariants.length} package variants, ${result.suggestedExternals.length} externals.`,
    })
  } catch (err) {
    stages.push({ stage: 'model-called', ok: false, detail: (err as Error).message })
    return fail(jobId, stored.id, stages, (err as Error).message)
  }

  // 5 — verify every quote against the text we actually hold
  const allPages: PageText[] = extracted.pages.map((p) => ({ page: p.page, text: p.text }))
  const claims: ExtractedClaim[] = result.claims.map((c) => ({
    specKey: c.specKey,
    value: c.value,
    unit: c.unit,
    page: c.page,
    evidence: c.evidence,
    confidence: c.confidence,
  }))
  const verification = verifyAll(claims, allPages)
  stages.push({
    stage: 'verified',
    ok: verification.rejected === 0,
    detail: `${verification.verified} verified, ${verification.rejected} rejected as unsupported, ${verification.reportedUnknown} reported as not found.`,
  })

  const byKey = new Map(specs.map((s) => [s.key, s.name]))
  const pageTextByNumber = new Map(extracted.pages.map((p) => [p.page, p.text]))

  const fields: ReviewField[] = verification.claims.map((c) => ({
    specKey: c.specKey,
    label: byKey.get(c.specKey) ?? c.specKey,
    rawValue: c.value === null ? null : String(c.value),
    unit: c.unit,
    page: c.page,
    evidence: c.evidence,
    verified: c.verified,
    status: c.status,
    explanation: c.explanation,
    confidence: c.confidence,
    pageText: c.page === null ? null : (pageTextByNumber.get(c.page) ?? null),
  }))

  const variant = resolvePackageVariant(result.packageVariants, result.mpn ?? input.mpnHint ?? null)

  const duplicate =
    result.manufacturer && result.mpn
      ? findDuplicate(db, result.manufacturer, result.mpn)
      : null

  db.prepare('UPDATE ingest_job SET provider = ?, model = ?, detected_json = ? WHERE id = ?').run(
    provider.id, null,
    JSON.stringify({
      manufacturer: result.manufacturer, mpn: result.mpn,
      productName: result.productName, categorySlug: result.categorySlug ?? categorySlug,
    }),
    jobId,
  )

  stages.push({
    stage: 'proposed',
    ok: true,
    detail: variant.mustAsk
      ? `${result.packageVariants.length} package variants found — choose which one this part is.`
      : 'Ready for review.',
  })

  return {
    jobId,
    datasheetId: stored.id,
    pageChars: extracted.pages.map((p) => ({ page: p.page, chars: p.chars })),
    stages,
    identity: {
      manufacturer: result.manufacturer,
      mpn: result.mpn,
      productName: result.productName,
      categorySlug: result.categorySlug ?? categorySlug,
      categoryConfidence: result.categoryConfidence,
      duplicate,
    },
    packageVariants: result.packageVariants,
    packageChoiceRequired: variant.mustAsk,
    resolvedPackage: variant.resolved,
    fields,
    externals: result.suggestedExternals,
    needsOcr: extracted.needsOcr,
    pageCount: extracted.pageCount,
    error: null,
  }
}

function fail(
  jobId: number, datasheetId: number, stages: StageReport[], error: string,
): IngestOutcome {
  return {
    jobId, datasheetId, pageChars: [], stages,
    identity: null, packageVariants: [], packageChoiceRequired: false,
    resolvedPackage: null, fields: [], externals: [],
    needsOcr: false, pageCount: 0, error,
  }
}

/**
 * Choose which pages to send, within a character budget.
 *
 * The first page nearly always carries the part number and description, so it
 * is always included; the rest are ranked by how often they mention the
 * parameters we want.
 */
export function selectPages(
  pages: readonly ExtractedPage[],
  terms: readonly string[],
  budgetChars: number,
): ExtractedPage[] {
  const usable = pages.filter((p) => p.chars > 0)
  if (usable.length === 0) return []

  const chosen: ExtractedPage[] = []
  let used = 0

  const first = usable[0]
  if (first) {
    chosen.push(first)
    used += first.text.length
  }

  for (const p of rankPagesFor(usable, terms, 12)) {
    if (chosen.some((c) => c.page === p.page)) continue
    if (used + p.text.length > budgetChars) continue
    chosen.push(p)
    used += p.text.length
  }

  return chosen.sort((a, b) => a.page - b.page)
}

/**
 * A cheap first guess at the category from the document's own words, so the
 * model is asked about the right parameters rather than all 36 categories.
 * Only ever a hint — the model may override it, and the reviewer certainly can.
 */
export function guessCategory(db: SqlDriver, pages: readonly ExtractedPage[]): string | null {
  const head = pages.slice(0, 3).map((p) => p.text).join('\n').toLowerCase()
  if (!head) return null

  const RULES: ReadonlyArray<{ slug: string; terms: readonly string[] }> = [
    { slug: 'tiny-ldo', terms: ['low-dropout', 'low dropout', 'ldo', 'linear regulator'] },
    { slug: 'buck-5v-3v3', terms: ['step-down', 'buck converter', 'synchronous buck'] },
    { slug: 'mini-load-switch', terms: ['load switch', 'power switch', 'power mux'] },
    { slug: 'ble-mcu-strong', terms: ['bluetooth low energy', 'ble soc', 'bluetooth 5'] },
    { slug: 'ble-transceiver', terms: ['ble transceiver', 'bluetooth radio'] },
    { slug: 'smallest-mcu', terms: ['microcontroller', 'cortex-m', 'mcu'] },
    { slug: 'wifi-transceiver', terms: ['wi-fi', 'wlan', '802.11'] },
    { slug: 'uwb-transceiver', terms: ['ultra-wideband', 'uwb', '802.15.4z'] },
    { slug: 'flash-spi-nor-128mb', terms: ['spi nor', 'serial flash', 'quad spi flash'] },
    { slug: 'rf-pa-2g4', terms: ['power amplifier', 'pa module'] },
    { slug: 'rf-lna-2g4', terms: ['low noise amplifier', 'lna'] },
    { slug: 'rf-switch-2g4', terms: ['rf switch', 'spdt switch'] },
    { slug: 'rf-filter-2g4', terms: ['saw filter', 'baw filter', 'bandpass filter'] },
    { slug: 'tiny-connectors', terms: ['board-to-board', 'connector', 'receptacle'] },
  ]

  let best: { slug: string; score: number } | null = null
  for (const rule of RULES) {
    const score = rule.terms.reduce((n, t) => n + (head.includes(t) ? 1 : 0), 0)
    if (score > 0 && (!best || score > best.score)) best = { slug: rule.slug, score }
  }
  if (!best) return null

  // Only suggest a category that actually exists in this database.
  const exists = db.prepare('SELECT 1 AS x FROM category WHERE slug = ?').get<{ x: number }>(best.slug)
  return exists ? best.slug : null
}


export interface OcrPageInput {
  readonly page: number
  readonly text: string
  readonly confidence: number
}

/**
 * Re-run extraction after the renderer has OCR'd the unreadable pages.
 *
 * The OCR text is merged into what the text layer already gave us — a datasheet
 * is often part text, part scanned drawing — and the whole document is then read
 * again. Evidence is verified against the merged text, so a quote from an OCR'd
 * page verifies exactly like one from a text layer, and the page's `method`
 * records which it was.
 */
export async function reExtractWithOcr(
  db: SqlDriver,
  jobId: number,
  datasheetId: number,
  ocrPages: readonly OcrPageInput[],
  provider: ExtractionProvider | null,
  opts: { budgetChars?: number } = {},
): Promise<IngestOutcome> {
  const stages: StageReport[] = []
  const existing = getDatasheetPages(db, datasheetId)
  const byPage = new Map(existing.map((p) => [p.page, p]))

  for (const o of ocrPages) {
    const current = byPage.get(o.page)
    // Only replace a page the text layer could not read; never overwrite good text.
    if (current && current.text.replace(/\s/g, '').length >= 40) continue
    byPage.set(o.page, {
      page: o.page, text: o.text, method: 'ocr', confidence: o.confidence,
    })
  }

  const merged = [...byPage.values()].sort((a, b) => a.page - b.page)
  setDatasheetPages(
    db, datasheetId,
    merged.map((p) => ({
      page: p.page,
      text: p.text,
      method: (p.method === 'ocr' ? 'ocr' : p.method === 'none' ? 'none' : 'text-layer'),
      confidence: p.confidence,
    })),
    'tesseract.js',
  )

  const avg = ocrPages.length
    ? ocrPages.reduce((n, p) => n + p.confidence, 0) / ocrPages.length
    : 0
  stages.push({
    stage: 'text-extracted',
    ok: true,
    detail: `${ocrPages.length} page${ocrPages.length === 1 ? '' : 's'} read by OCR (mean confidence ${(avg * 100).toFixed(0)}%), merged with the text layer.`,
  })

  const pages: ExtractedPage[] = merged.map((p) => ({
    page: p.page,
    text: p.text,
    method: p.method === 'ocr' ? 'none' : 'text-layer',
    chars: p.text.replace(/\s/g, '').length,
  }))

  const job = db
    .prepare('SELECT category_hint AS hint, mpn_hint AS mpn FROM ingest_job WHERE id = ?')
    .get<{ hint: string | null; mpn: string | null }>(jobId)

  const categorySlug = job?.hint ?? guessCategory(db, pages)
  const specs = categorySlug ? listSpecDefs(db, categorySlug) : []
  stages.push({
    stage: 'category-suggested',
    ok: categorySlug !== null,
    detail: categorySlug
      ? `${categorySlug} — asking for ${specs.length} parameters.`
      : 'Could not guess a category; the model will be asked to choose.',
  })

  if (!provider) {
    stages.push({
      stage: 'model-called', ok: false,
      detail: 'No extraction model configured. The OCR text is saved and searchable.',
    })
    return {
      jobId, datasheetId, stages,
      pageChars: pages.map((p) => ({ page: p.page, chars: p.chars })),
      identity: null, packageVariants: [], packageChoiceRequired: false,
      resolvedPackage: null, fields: [], externals: [],
      needsOcr: false, pageCount: pages.length, error: null,
    }
  }

  const terms = [
    ...specs.map((s) => s.name),
    'ordering information', 'mechanical', 'package', 'dimensions',
    'absolute maximum', 'electrical characteristics', 'application circuit',
  ]
  const chosen = selectPages(pages, terms, opts.budgetChars ?? DEFAULT_BUDGET)

  let result: ExtractionResult
  try {
    result = await provider.extract({
      pages: chosen.map((p) => ({ page: p.page, text: p.text })),
      mpnHint: job?.mpn ?? null,
      categories: categorySlug
        ? [{
            slug: categorySlug, name: categorySlug, description: '',
            specs: specs.map((s) => ({ key: s.key, name: s.name, unit: s.unit, ai: null })),
          }]
        : [],
    })
    stages.push({
      stage: 'model-called', ok: true,
      detail: `${provider.id} read ${chosen.length} of ${pages.length} pages.`,
    })
    stages.push({
      stage: 'validated', ok: true,
      detail: `${result.claims.length} values, ${result.packageVariants.length} package variants, ${result.suggestedExternals.length} externals.`,
    })
  } catch (err) {
    stages.push({ stage: 'model-called', ok: false, detail: (err as Error).message })
    return fail(jobId, datasheetId, stages, (err as Error).message)
  }

  const allPages: PageText[] = pages.map((p) => ({ page: p.page, text: p.text }))
  const verification = verifyAll(
    result.claims.map((c) => ({
      specKey: c.specKey, value: c.value, unit: c.unit,
      page: c.page, evidence: c.evidence, confidence: c.confidence,
    })),
    allPages,
  )
  stages.push({
    stage: 'verified',
    ok: verification.rejected === 0,
    detail: `${verification.verified} verified, ${verification.rejected} rejected as unsupported, ${verification.reportedUnknown} reported as not found.`,
  })

  const byKey = new Map(specs.map((s) => [s.key, s.name]))
  const pageTextByNumber = new Map(pages.map((p) => [p.page, p.text]))
  const fields: ReviewField[] = verification.claims.map((c) => ({
    specKey: c.specKey,
    label: byKey.get(c.specKey) ?? c.specKey,
    rawValue: c.value === null ? null : String(c.value),
    unit: c.unit, page: c.page, evidence: c.evidence,
    verified: c.verified, status: c.status, explanation: c.explanation,
    confidence: c.confidence,
    pageText: c.page === null ? null : (pageTextByNumber.get(c.page) ?? null),
  }))

  const variant = resolvePackageVariant(result.packageVariants, result.mpn ?? job?.mpn ?? null)
  const duplicate = result.manufacturer && result.mpn
    ? findDuplicate(db, result.manufacturer, result.mpn)
    : null

  stages.push({ stage: 'proposed', ok: true, detail: 'Ready for review.' })

  return {
    jobId, datasheetId, stages,
    pageChars: pages.map((p) => ({ page: p.page, chars: p.chars })),
    identity: {
      manufacturer: result.manufacturer, mpn: result.mpn,
      productName: result.productName,
      categorySlug: result.categorySlug ?? categorySlug,
      categoryConfidence: result.categoryConfidence, duplicate,
    },
    packageVariants: result.packageVariants,
    packageChoiceRequired: variant.mustAsk,
    resolvedPackage: variant.resolved,
    fields, externals: result.suggestedExternals,
    needsOcr: false, pageCount: pages.length, error: null,
  }
}
