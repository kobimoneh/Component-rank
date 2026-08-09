import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, type SqlDriver } from '../db/driver.js'
import { assertNotNewerThan, currentVersion, loadMigrations, migrate } from '../db/migrate.js'
import { syncCategories, type SyncReport } from '../db/repositories/categories.js'
import { SpecLexicon } from '../import/config-yaml/lexicon.js'
import { importCategories } from '../import/config-yaml/import.js'
import { seedFromParts, type RawSeedCategory, type SeedReport } from '../import/seed/seed.js'

/**
 * Application bootstrap: open the database, migrate, and on first run import the
 * component-report taxonomy and seed parts.
 *
 * Resource files are bundled with the app so first run works entirely offline.
 */

export interface BootstrapResult {
  readonly db: SqlDriver
  readonly databasePath: string
  readonly schemaVersion: number
  readonly sync: SyncReport | null
  readonly seed: SeedReport | null
  readonly warnings: string[]
}

function resourceDir(): string {
  // Packaged: resources are copied next to the app. Dev: read from the repo.
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'resources') : null
  if (packaged && existsSync(join(packaged, 'spec-lexicon.yaml'))) return packaged
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    join(here, '../../resources'),
    join(here, '../../../resources'),
    join(process.cwd(), 'resources'),
  ]) {
    if (existsSync(join(candidate, 'spec-lexicon.yaml'))) return candidate
  }
  throw new Error('Could not locate the resources directory (spec-lexicon.yaml not found).')
}

function migrationsDir(): string {
  // Migrations live under resources/ so they are bundled by electron-builder's
  // extraResources and resolvable from the compiled main bundle, which does not
  // sit next to src/.
  const dir = join(resourceDir(), 'migrations')
  if (!existsSync(dir)) throw new Error(`Could not locate database migrations at ${dir}`)
  return dir
}

export function bootstrap(userDataDir: string): BootstrapResult {
  const warnings: string[] = []
  mkdirSync(userDataDir, { recursive: true })
  const databasePath = join(userDataDir, 'components.sqlite')
  const isFirstRun = !existsSync(databasePath)

  const db = openDatabase(databasePath)
  const migrations = loadMigrations(migrationsDir())
  assertNotNewerThan(db, migrations.length)
  migrate(db, migrations)

  let sync: SyncReport | null = null
  let seed: SeedReport | null = null

  const res = resourceDir()
  const lexiconPath = join(res, 'spec-lexicon.yaml')
  const configPath = join(res, 'component-report', 'config.yaml')
  const partsPath = join(res, 'component-report', 'parts-2026-06.json')

  try {
    const lexicon = SpecLexicon.fromYaml(readFileSync(lexiconPath, 'utf8'))
    const report = importCategories(readFileSync(configPath, 'utf8'), lexicon)
    if (report.unmappedPhrases.length > 0) {
      warnings.push(
        `${report.unmappedPhrases.length} category parameters could not be typed and need attention.`,
      )
    }
    sync = syncCategories(db, report.categories)
  } catch (err) {
    // A failed taxonomy import must not stop the app from opening an existing
    // database — you can still browse what you already have.
    warnings.push(`Category import failed: ${(err as Error).message}`)
  }

  if (isFirstRun) {
    try {
      const parts = JSON.parse(readFileSync(partsPath, 'utf8')) as RawSeedCategory[]
      seed = seedFromParts(db, parts)
    } catch (err) {
      warnings.push(`Seed import failed: ${(err as Error).message}`)
    }
  }

  return { db, databasePath, schemaVersion: currentVersion(db), sync, seed, warnings }
}
