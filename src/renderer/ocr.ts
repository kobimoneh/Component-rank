import { createWorker, type Worker } from 'tesseract.js'
import * as pdfjs from 'pdfjs-dist'

/**
 * OCR, in the renderer.
 *
 * Electron's renderer is a real browser, which is exactly what this needs: a
 * canvas to render PDF pages onto, and WebAssembly to run Tesseract. Doing it
 * here means no native modules, no build step, and no separate worker script —
 * dropping a scanned datasheet just works.
 *
 * Every asset is bundled. Tesseract.js would otherwise fetch its worker, its
 * wasm core and the language data from a CDN on first use, which would make the
 * feature fail on exactly the offline machine it is meant for.
 */

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf/pdf.worker.min.mjs', window.location.href).href

const OCR_PATHS = {
  workerPath: new URL('./ocr/worker.min.js', window.location.href).href,
  corePath: new URL('./ocr/', window.location.href).href,
  langPath: new URL('./ocr/', window.location.href).href,
}

export interface OcrPage {
  readonly page: number
  readonly text: string
  readonly confidence: number
}

export interface OcrProgress {
  readonly page: number
  readonly totalPages: number
  readonly phase: string
  /** 0..1 across the whole job, for a progress bar that does not lie. */
  readonly fraction: number
}

/**
 * Render one page to a canvas and read it.
 *
 * The scale matters more than anything else here: datasheet body text is small,
 * and Tesseract on a 1x render of a 612pt page produces mush. 2.5x is the
 * cheapest setting that reliably reads 7pt table text.
 */
const RENDER_SCALE = 2.5

export async function ocrPdfPages(
  bytes: Uint8Array,
  pages: readonly number[],
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrPage[]> {
  if (pages.length === 0) return []

  // A copy: pdf.js transfers the buffer it is handed, which would detach the
  // caller's array and break anything that reads the same bytes afterwards.
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise

  let worker: Worker | null = null
  const out: OcrPage[] = []

  try {
    worker = await createWorker('eng', 1, {
      ...OCR_PATHS,
      logger: (m: { status?: string; progress?: number }) => {
        if (!onProgress) return
        const done = out.length
        const within = typeof m.progress === 'number' ? m.progress : 0
        onProgress({
          page: pages[Math.min(done, pages.length - 1)] ?? 0,
          totalPages: pages.length,
          phase: m.status ?? 'recognising',
          fraction: Math.min(1, (done + within) / pages.length),
        })
      },
    })

    for (const pageNumber of pages) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: RENDER_SCALE })

      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not get a 2D canvas context for rendering')

      // Scans are usually dark-on-light already, but a transparent background
      // renders as black and Tesseract reads nothing from it.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)

      // pdf.js 4's RenderParameters does not declare `canvas`, but newer
      // builds accept it; the cast keeps both happy without silencing the file.
      await page.render({ canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise

      const { data } = await worker.recognize(canvas)
      out.push({
        page: pageNumber,
        text: data.text ?? '',
        confidence: typeof data.confidence === 'number' ? data.confidence / 100 : 0,
      })

      page.cleanup()
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    if (worker) await worker.terminate()
    await doc.destroy()
  }

  return out
}

/** Pages worth running OCR on: those the text layer could not read. */
export function pagesNeedingOcr(
  pageChars: ReadonlyArray<{ page: number; chars: number }>,
  limit = 25,
): number[] {
  return pageChars
    .filter((p) => p.chars < 40)
    .map((p) => p.page)
    .slice(0, limit)
}
