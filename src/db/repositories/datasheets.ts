import { createHash } from 'node:crypto'
import type { SqlDriver } from '../driver.js'

/**
 * Datasheet storage.
 *
 * The PDF bytes live in the database, not on a path beside it. The stated
 * requirement is that the database is yours and portable — a file reference
 * breaks that the moment the folder moves or the machine changes.
 *
 * Page text is stored with the method that produced it, because a page read by
 * OCR is less trustworthy than one with a real text layer, and evidence
 * verification needs the text to check a quote against at all.
 */

export type PageMethod = 'text-layer' | 'ocr' | 'vision' | 'none'

export interface StoredDatasheet {
  readonly id: number
  readonly componentId: number | null
  readonly title: string | null
  readonly url: string | null
  readonly sha256: string
  readonly byteSize: number
  readonly mime: string
  readonly pageCount: number | null
  readonly textStatus: string
  readonly ocrEngine: string | null
  readonly source: string
  readonly ingestedAt: string | null
  readonly pagesStored: number
}

export interface StoreDatasheetInput {
  readonly componentId?: number | null
  readonly title?: string | null
  readonly url?: string | null
  readonly mime?: string
  readonly source?: string
  readonly content: Uint8Array
  readonly pageCount?: number | null
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface StoreResult {
  readonly id: number
  /** True when a datasheet with this exact content already existed. */
  readonly deduplicated: boolean
  readonly sha256: string
}

/**
 * Store a datasheet, deduplicating on content hash.
 *
 * The same PDF uploaded twice is one row. Re-uploading an identical file for a
 * different component links the existing bytes rather than storing them again.
 */
export function storeDatasheet(
  db: SqlDriver,
  input: StoreDatasheetInput,
  now = new Date().toISOString(),
): StoreResult {
  const hash = sha256Of(input.content)
  const existing = db
    .prepare('SELECT id, component_id FROM datasheet WHERE sha256 = ? LIMIT 1')
    .get<{ id: number; component_id: number | null }>(hash)

  if (existing) {
    // Attach to a component if this upload names one and the stored row has none.
    if (input.componentId && existing.component_id === null) {
      db.prepare('UPDATE datasheet SET component_id = ? WHERE id = ?')
        .run(input.componentId, existing.id)
    }
    return { id: existing.id, deduplicated: true, sha256: hash }
  }

  const id = db
    .prepare(`
      INSERT INTO datasheet (component_id, title, url, sha256, content, byte_size, mime,
                             page_count, source, text_status, added_at, ingested_at)
      VALUES (?,?,?,?,?,?,?,?,?, 'none', ?, ?)
    `)
    .run(
      input.componentId ?? null, input.title ?? null, input.url ?? null, hash,
      input.content, input.content.byteLength, input.mime ?? 'application/pdf',
      input.pageCount ?? null, input.source ?? 'manual', now, now,
    ).lastInsertRowid

  return { id, deduplicated: false, sha256: hash }
}

export function getDatasheetBytes(db: SqlDriver, id: number): Uint8Array | null {
  const row = db
    .prepare('SELECT content FROM datasheet WHERE id = ?')
    .get<{ content: Uint8Array | null }>(id)
  return row?.content ?? null
}

export interface PageInput {
  readonly page: number
  readonly text: string
  readonly method?: PageMethod
  readonly confidence?: number | null
}

/**
 * Replace the extracted text for a datasheet.
 *
 * `text_status` records the weakest method used across all pages, so a document
 * that needed OCR anywhere is never presented as if it had a clean text layer.
 */
export function setDatasheetPages(
  db: SqlDriver,
  datasheetId: number,
  pages: readonly PageInput[],
  engine: string | null = null,
): { pagesStored: number; textStatus: string } {
  let status = 'none'
  db.transaction(() => {
    db.prepare('DELETE FROM datasheet_page WHERE datasheet_id = ?').run(datasheetId)
    const insert = db.prepare(`
      INSERT INTO datasheet_page (datasheet_id, page, text, method, confidence)
      VALUES (?,?,?,?,?)
    `)
    const methods = new Set<PageMethod>()
    for (const p of pages) {
      const method = p.method ?? 'text-layer'
      methods.add(method)
      insert.run(datasheetId, p.page, p.text, method, p.confidence ?? null)
    }
    // Weakest wins: vision < ocr < text-layer.
    status = methods.has('vision') ? 'vision'
      : methods.has('ocr') ? 'ocr'
      : methods.has('text-layer') ? 'text-layer'
      : 'none'

    db.prepare(`
      UPDATE datasheet SET text_status = ?, ocr_engine = ?, page_count = ? WHERE id = ?
    `).run(status, engine, pages.length, datasheetId)
  })
  return { pagesStored: pages.length, textStatus: status }
}

export function getDatasheetPages(
  db: SqlDriver,
  datasheetId: number,
): Array<{ page: number; text: string; method: string; confidence: number | null }> {
  return db
    .prepare(`
      SELECT page, text, method, confidence FROM datasheet_page
      WHERE datasheet_id = ? ORDER BY page
    `)
    .all<{ page: number; text: string; method: string; confidence: number | null }>(datasheetId)
}

export function listDatasheets(db: SqlDriver, componentId?: number): StoredDatasheet[] {
  const sql = `
    SELECT d.id, d.component_id AS componentId, d.title, d.url, d.sha256,
           COALESCE(d.byte_size, 0) AS byteSize, d.mime, d.page_count AS pageCount,
           d.text_status AS textStatus, d.ocr_engine AS ocrEngine, d.source,
           d.ingested_at AS ingestedAt,
           (SELECT COUNT(*) FROM datasheet_page p WHERE p.datasheet_id = d.id) AS pagesStored
    FROM datasheet d
    ${componentId === undefined ? '' : 'WHERE d.component_id = ?'}
    ORDER BY d.id DESC
  `
  return componentId === undefined
    ? db.prepare(sql).all<StoredDatasheet>()
    : db.prepare(sql).all<StoredDatasheet>(componentId)
}

export interface PageHit {
  readonly datasheetId: number
  readonly page: number
  readonly snippet: string
  readonly method: string
}

/**
 * Find pages mentioning a term. An agent uses this to locate the page holding a
 * parameter before extracting it, instead of sending a whole datasheet to a model.
 */
export function searchPages(db: SqlDriver, query: string, limit = 25): PageHit[] {
  const q = query.trim()
  if (!q) return []
  try {
    return db
      .prepare(`
        SELECT p.datasheet_id AS datasheetId, p.page, p.method,
               snippet(datasheet_page_fts, 0, '[', ']', '…', 18) AS snippet
        FROM datasheet_page_fts
        JOIN datasheet_page p ON p.id = datasheet_page_fts.rowid
        WHERE datasheet_page_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all<PageHit>(q, limit)
  } catch {
    // A malformed FTS expression is a bad query, not a crash.
    return []
  }
}

export function deleteDatasheet(db: SqlDriver, id: number): void {
  db.prepare('DELETE FROM datasheet WHERE id = ?').run(id)
}

export interface StorageStats {
  /** Datasheets whose bytes are in the database. */
  readonly stored: number
  /** Datasheets we only have a URL for — a link, not a document. */
  readonly referenced: number
  readonly bytes: number
  readonly withText: number
  readonly ocrCount: number
}

/**
 * Size of the stored corpus.
 *
 * `stored` and `referenced` are counted separately on purpose: the seed import
 * creates 150 rows that are URL links with no content, and reporting those as
 * "150 datasheets" would overstate what the database actually holds.
 */
export function datasheetStorageStats(db: SqlDriver): StorageStats {
  const row = db
    .prepare(`
      SELECT SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS stored,
             SUM(CASE WHEN content IS NULL AND url IS NOT NULL THEN 1 ELSE 0 END) AS referenced,
             COALESCE(SUM(byte_size), 0) AS bytes,
             SUM(CASE WHEN text_status != 'none' THEN 1 ELSE 0 END) AS withText,
             SUM(CASE WHEN text_status = 'ocr' THEN 1 ELSE 0 END) AS ocrCount
      FROM datasheet
    `)
    .get<StorageStats>()
  return {
    stored: row?.stored ?? 0,
    referenced: row?.referenced ?? 0,
    bytes: row?.bytes ?? 0,
    withText: row?.withText ?? 0,
    ocrCount: row?.ocrCount ?? 0,
  }
}
