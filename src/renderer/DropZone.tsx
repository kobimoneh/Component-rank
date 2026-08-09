import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { IngestOutcomeDto } from '../shared/ipc.js'

interface Props {
  readonly onStart: () => void
  readonly onDone: (outcome: IngestOutcomeDto) => void
  readonly onError: (message: string) => void
}

/**
 * Drop a PDF anywhere on the window.
 *
 * The renderer has no filesystem access, so the file is read here as bytes and
 * handed to the main process base64-encoded. That keeps the security boundary
 * intact: nothing in the renderer ever holds a path.
 */
export function DropZone({ onStart, onDone, onError }: Props): JSX.Element | null {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')

  const ingest = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        onError(`${file.name} is not a PDF.`)
        return
      }
      setBusy(true)
      setFileName(file.name)
      onStart()
      try {
        const buffer = await file.arrayBuffer()
        // btoa needs a binary string; chunk it so a big datasheet does not blow
        // the argument limit of String.fromCharCode.
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }
        const outcome = await window.api.ingestDatasheet({
          fileName: file.name,
          dataBase64: btoa(binary),
        })
        onDone(outcome)
      } catch (err) {
        onError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [onDone, onError, onStart],
  )

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

  if (busy) {
    return (
      <div className="dropzone busy" aria-live="polite">
        <div className="dropzone-inner">
          <div className="spinner" aria-hidden />
          <div className="dropzone-title">Reading {fileName}</div>
          <div className="hint">
            Storing the document, extracting its text, then asking the model.
            Nothing is saved to the library until you review it.
          </div>
        </div>
      </div>
    )
  }

  if (!over) return null

  return (
    <div className="dropzone" aria-hidden>
      <div className="dropzone-inner">
        <div className="dropzone-title">Drop a datasheet</div>
        <div className="hint">PDF · stored in the database, then read</div>
      </div>
    </div>
  )
}
