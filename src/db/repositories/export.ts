import type { SqlDriver } from '../driver.js'
import { categoryColumns, listCategoryRows } from './components.js'

/**
 * Export and backup.
 *
 * The database is one SQLite file you own. These exports exist so the data is
 * also readable without this application at all — a stated requirement, and the
 * reason there is no cloud anything here.
 */

export interface ExportBundle {
  readonly formatVersion: 1
  readonly exportedAt: string
  readonly schemaVersion: number
  readonly categories: unknown[]
  readonly manufacturers: unknown[]
  readonly components: unknown[]
  readonly packages: unknown[]
  readonly specDefs: unknown[]
  readonly specValues: unknown[]
  readonly solutionProfiles: unknown[]
  readonly externalParts: unknown[]
  readonly datasheets: unknown[]
  readonly provenance: unknown[]
  readonly tags: unknown[]
  readonly memberships: unknown[]
}

/** Full-fidelity JSON export, including provenance and profiles. */
export function exportJson(db: SqlDriver, now = new Date().toISOString()): ExportBundle {
  const all = (table: string): unknown[] => db.prepare(`SELECT * FROM ${table}`).all()
  return {
    formatVersion: 1,
    exportedAt: now,
    schemaVersion: Number(db.pragma('user_version') ?? 0),
    categories: all('category'),
    manufacturers: all('manufacturer'),
    components: all('component'),
    packages: all('package'),
    specDefs: all('spec_def'),
    specValues: all('spec_value'),
    solutionProfiles: all('solution_profile'),
    externalParts: all('external_part'),
    datasheets: all('datasheet'),
    provenance: all('provenance'),
    tags: all('component_tag'),
    memberships: all('component_category'),
  }
}

function csvCell(value: string | null): string {
  if (value === null) return ''
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * CSV of a category table, as displayed — units in the header, so a cell is
 * never an ambiguous bare number.
 */
export function exportCategoryCsv(db: SqlDriver, slug: string): string {
  const columns = categoryColumns(db, slug)
  const rows = listCategoryRows(db, slug)

  const header = ['Rank', ...columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label))]
  const lines = [header.map(csvCell).join(',')]

  for (const row of rows) {
    const cells = [
      row.rank === null ? '' : String(row.rank),
      ...columns.map((c) => {
        const cell = row.cells[c.key]
        if (!cell?.text) return ''
        // Mark unverified values in the export too, so a spreadsheet does not
        // launder them into facts.
        return cell.unverified ? `${cell.text} (unverified)` : cell.text
      }),
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return lines.join('\n')
}

export interface BackupCheck {
  readonly ok: boolean
  readonly schemaVersion: number
  readonly reason: string | null
}

/** Refuse to restore a backup this build cannot read, rather than half-migrating. */
export function checkBackup(bundle: Pick<ExportBundle, 'formatVersion' | 'schemaVersion'>, latestSchema: number): BackupCheck {
  if (bundle.formatVersion !== 1) {
    return { ok: false, schemaVersion: bundle.schemaVersion, reason: `Unknown export format ${bundle.formatVersion}.` }
  }
  if (bundle.schemaVersion > latestSchema) {
    return {
      ok: false,
      schemaVersion: bundle.schemaVersion,
      reason: `This backup is from schema version ${bundle.schemaVersion}; this build only knows up to ${latestSchema}.`,
    }
  }
  return { ok: true, schemaVersion: bundle.schemaVersion, reason: null }
}
