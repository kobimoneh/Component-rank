import { createRequire } from 'node:module'

/**
 * PDF text extraction, in-process.
 *
 * The whole point of this workflow is that dropping a PDF Just Works, so text
 * extraction happens inside the app rather than in a separate worker script the
 * user has to run.
 *
 * pdf.js is loaded through createRequire for the same reason as node:sqlite: the
 * legacy CommonJS build is what works under both Vitest and the Electron main
 * bundle, and letting the bundler chew on it produces worker-loader grief.
 */

const nodeRequire = createRequire(import.meta.url)

export interface ExtractedPage {
  readonly page: number
  readonly text: string
  readonly method: 'text-layer' | 'none'
  /** Characters recovered. Used to decide whether OCR is needed. */
  readonly chars: number
}

export interface PdfExtraction {
  readonly pageCount: number
  readonly pages: readonly ExtractedPage[]
  /** Pages with too little text to be usable — candidates for OCR. */
  readonly emptyPages: readonly number[]
  /** True when the document as a whole needs OCR to be worth reading. */
  readonly needsOcr: boolean
  readonly title: string | null
}

/** Below this, a page is a scan or a drawing rather than text. */
const MIN_USEFUL_CHARS = 40

interface TextItem {
  str?: string
  transform?: number[]
  hasEOL?: boolean
}

/**
 * Reassemble a page's text items into lines.
 *
 * pdf.js hands back positioned fragments, not lines. Concatenating them blindly
 * runs a whole datasheet table into one string, which destroys the evidence
 * quotes a reviewer needs to recognise. Grouping by Y keeps rows intact.
 */
export function itemsToText(items: readonly TextItem[]): string {
  const rows = new Map<number, Array<{ x: number; s: string }>>()

  for (const item of items) {
    const s = item.str ?? ''
    if (!s) continue
    const t = item.transform
    const x = Array.isArray(t) ? (t[4] ?? 0) : 0
    const y = Array.isArray(t) ? (t[5] ?? 0) : 0
    // Round Y so fragments on the same visual line land in the same bucket.
    const key = Math.round(y / 2) * 2
    const row = rows.get(key) ?? []
    row.push({ x, s })
    rows.set(key, row)
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left: top of page first
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((c) => c.s)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  // The legacy build avoids pdf.js reaching for browser globals and workers.
  const pdfjs = nodeRequire('pdfjs-dist/legacy/build/pdf.mjs') as {
    getDocument(src: unknown): { promise: Promise<PdfDocument> }
  }

  const doc = await pdfjs.getDocument({
    // A copy, deliberately. pdf.js *transfers* the buffer it is handed, which
    // detaches the caller's array — the same bytes then cannot be stored, hashed
    // or read a second time. Copying costs one allocation and removes a whole
    // class of "worked the first time" bugs.
    data: new Uint8Array(bytes),
    // A datasheet needs none of these, and each is a way for a hostile PDF to
    // reach outside the document.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise

  const pages: ExtractedPage[] = []
  const emptyPages: number[] = []

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    const text = itemsToText(content.items as TextItem[])
    const chars = text.replace(/\s/g, '').length
    if (chars < MIN_USEFUL_CHARS) emptyPages.push(n)
    pages.push({
      page: n,
      text,
      method: chars < MIN_USEFUL_CHARS ? 'none' : 'text-layer',
      chars,
    })
    page.cleanup?.()
  }

  let title: string | null = null
  try {
    const meta = await doc.getMetadata()
    const info = meta?.info as { Title?: string } | undefined
    title = info?.Title?.trim() || null
  } catch {
    title = null
  }

  await doc.destroy?.()

  return {
    pageCount: doc.numPages,
    pages,
    emptyPages,
    // If most of the document produced no text, it is a scan and the text layer
    // alone is not worth extracting from. Saying so beats extracting nonsense.
    needsOcr: pages.length > 0 && emptyPages.length > pages.length / 2,
    title,
  }
}

interface PdfDocument {
  numPages: number
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>
    cleanup?(): void
  }>
  getMetadata(): Promise<{ info?: unknown } | undefined>
  destroy?(): Promise<void>
}

/**
 * Pick the pages most likely to hold a given parameter.
 *
 * A 90-page datasheet does not fit in a local model's context, and sending all
 * of it would be slow and worse. Scoring by term hits keeps the prompt to the
 * few pages that actually mention what we are looking for.
 */
export function rankPagesFor(
  pages: readonly ExtractedPage[],
  terms: readonly string[],
  limit = 6,
): ExtractedPage[] {
  const needles = terms
    .flatMap((t) => t.toLowerCase().split(/[^a-z0-9µ]+/))
    .filter((t) => t.length > 2)

  const scored = pages.map((p) => {
    const hay = p.text.toLowerCase()
    let score = 0
    for (const n of needles) {
      let from = 0
      for (;;) {
        const at = hay.indexOf(n, from)
        if (at < 0) break
        score++
        from = at + n.length
      }
    }
    return { page: p, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.page.page - b.page.page)
    .slice(0, limit)
    .map((s) => s.page)
}
