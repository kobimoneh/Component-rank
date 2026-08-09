import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SqlDriver } from './driver.js'

/**
 * Migrations are numbered SQL files applied in order inside one transaction each,
 * tracked with SQLite's `user_version`. A failed migration rolls back completely
 * rather than leaving a half-migrated database.
 */

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

/** Load migrations from a directory of `NNN_name.sql` files. */
export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  const migrations: Migration[] = []
  for (const file of files) {
    const m = /^(\d+)_(.+)\.sql$/.exec(file)
    if (!m) throw new Error(`Migration filename must be NNN_name.sql: ${file}`)
    const version = Number(m[1])
    const name = m[2] ?? file
    if (migrations.some((x) => x.version === version)) {
      throw new Error(`Duplicate migration version ${version} (${file})`)
    }
    migrations.push({ version, name, sql: readFileSync(join(dir, file), 'utf8') })
  }
  return migrations.sort((a, b) => a.version - b.version)
}

export function currentVersion(db: SqlDriver): number {
  return Number(db.pragma('user_version') ?? 0)
}

export interface MigrateResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly string[]
}

export function migrate(db: SqlDriver, migrations: readonly Migration[]): MigrateResult {
  const from = currentVersion(db)
  const applied: string[] = []

  for (const m of migrations) {
    if (m.version <= from) continue
    db.transaction(() => {
      db.exec(m.sql)
      // user_version cannot be parameterised, hence the interpolation; the value
      // comes from a filename matched against ^\d+$, never from user input.
      db.setPragma('user_version', m.version)
    })
    applied.push(`${m.version}_${m.name}`)
  }

  return { from, to: currentVersion(db), applied }
}

/** Refuse to open a database written by a newer build rather than corrupting it. */
export function assertNotNewerThan(db: SqlDriver, latest: number): void {
  const v = currentVersion(db)
  if (v > latest) {
    throw new Error(
      `This database is at schema version ${v}, but this build only knows up to ${latest}. ` +
        `Update the application rather than opening it with an older version.`,
    )
  }
}
