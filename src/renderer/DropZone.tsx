import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { IngestOutcomeDto } from '../shared/ipc.js'
import { ocrPdfPages, pagesNeedingOcr, type OcrProgress } from './ocr.js'

interface Props {
  /** Set by the Add panel to force the file picker open. */
  readonly pickToken: number
  readonly onStart: () => void
  readonly onDone: (outcome: IngestOutcomeDto) => void
  readonly onError: (message: string) => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; file: string }
  | { kind: 'ocr'; file: string; progress: OcrProgress }
  | { kind: 'rereading'; file: string }

/**
 * Drop a PDF anywhere on the window, or pick one.
 *
 * When the text layer is missing — a scanned datasheet — the pages are rendered
 * and OCR'd here in the renderer, then sent back for a second read. That is why
 * OCR lives in the UI process: Electron's renderer is a real browser, so it has
 * a canvas to render onto and WebAssembly to run Tesseract, with no native
 * modules and no separate worker script.
 *
 * The renderer never sees a file path — the bytes are read here and handed over
 * base64-encoded, so the security boundary stays intact.
 */
export function DropZone({ pickToken, onStart, onDone, onError }: Props): JSX.Element | null {
  const [over, setOver] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const ingest = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        onError(`${file.name} is not a PDF.`)
        return
      }
      setPhase({ kind: 'reading', file: file.name })
      onStart()

      try {
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)

        // Chunked, because String.fromCharCode(...bigArray) blows the argument
        // limit on a real datasheet.
        let binary = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }

        let outcome = await window.api.ingestDatasheet({
          fileName: file.name,
          dataBase64: btoa(binary),
        })

        // A scan, or a document with unreadable pages: OCR them and read again.
        const blank = pagesNeedingOcr(outcome.pageChars)
        if (blank.length > 0) {
          const ocr = await ocrPdfPages(bytes, blank, (progress) =>
            setPhase({ kind: 'ocr', file: file.name, progress }),
          )
          if (ocr.length > 0) {
            setPhase({ kind: 'rereading', file: file.name })
            const second = await window.api.submitOcr({
              jobId: outcome.jobId,
              datasheetId: outcome.datasheetId,
              pages: ocr,
            })
            // Keep the first run's stored/text stages in front of the OCR ones,
            // so the review screen shows the whole story.
            outcome = {
              ...second,
              stages: [outcome.stages[0]!, ...second.stages],
            }
          }
        }

        onDone(outcome)
      } catch (err) {
        onError((err as Error).message)
      } finally {
        setPhase({ kind: 'idle' })
      }
    },
    [onDone, onError, onStart],
  )

  const pick = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/pdf,.pdf'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) void ingest(file)
    }
    input.click()
  }, [ingest])

  // `pick` is stable enough to depend on: it only changes when `ingest` does,
  // and `ingest` only changes when its callbacks do.
  useEffect(() => {
    if (pickToken > 0) pick()
  }, [pickToken, pick])

  useEffect(() => {
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      setOver(true)
    }
    const onDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setOver(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      setOver(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) void ingest(file)
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [ingest])

  if (phase.kind !== 'idle') {
    const ocr = phase.kind === 'ocr' ? phase.progress : null
    return (
      <div className="dropzone busy" aria-live="polite">
        <div className="dropzone-inner">
          <div className="spinner" aria-hidden />
          <div className="dropzone-title">
            {phase.kind === 'reading' && `Reading ${phase.file}`}
            {phase.kind === 'ocr' && `Scanning ${phase.file}`}
            {phase.kind === 'rereading' && 'Reading the OCR text'}
          </div>

          {ocr ? (
            <>
              <div className="hint">
                No text layer — running OCR. Page {Math.min(
                  Math.round(ocr.fraction * ocr.totalPages) + 1, ocr.totalPages,
                )} of {ocr.totalPages} · {ocr.phase}
              </div>
              <div className="progress" aria-hidden>
                <div className="progress-bar" style={{ width: `${Math.round(ocr.fraction * 100)}%` }} />
              </div>
            </>
          ) : (
            <div className="hint">
              Storing the document, extracting its text, then asking the model.
              Nothing is saved to the library until you review it.
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!over) return null

  return (
    <div className="dropzone" aria-hidden>
      <div className="dropzone-inner">
        <div className="dropzone-title">Drop a datasheet</div>
        <div className="hint">PDF · scanned pages are OCR&apos;d automatically</div>
      </div>
    </div>
  )
}
