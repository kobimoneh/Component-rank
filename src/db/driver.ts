import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite'

/**
 * `node:sqlite` is a prefix-only builtin: `module.builtinModules` lists
 * "node:sqlite" but not "sqlite". Vite strips the prefix before checking that
 * list, decides it is a package named "sqlite", and fails to resolve it — in the
 * test runner and in the Electron main bundle alike. Loading it through
 * createRequire keeps it out of static analysis entirely. The `import type`
 * above is erased at compile time, so it costs nothing at runtime.
 */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncClass
}
type DatabaseSync = DatabaseSyncClass

/**
 * Thin driver over node:sqlite.
 *
 * node:sqlite is built into the Node that Electron 43 bundles (24.18.1 — the same
 * version this repo's tests run on), so there is no native module to rebuild, no
 * node-gyp on the Windows packaging path, and the tests exercise exactly the
 * driver the app ships with.
 *
 * Everything is synchronous, which is what you want in the Electron main process
 * for a local database: no await ceremony, and transactions are trivially correct.
 */

export interface RunResult {
  readonly changes: number
  readonly lastInsertRowid: number
}

export interface SqlStatement {
  run(...params: readonly unknown[]): RunResult
  get<T = Record<string, unknown>>(...params: readonly unknown[]): T | undefined
  all<T = Record<string, unknown>>(...params: readonly unknown[]): T[]
}

export interface SqlDriver {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  transaction<T>(fn: () => T): T
  pragma(name: string): unknown
  setPragma(name: string, value: string | number): void
  close(): void
}

class NodeSqliteStatement implements SqlStatement {
  constructor(private readonly stmt: ReturnType<DatabaseSync['prepare']>) {}

  run(...params: readonly unknown[]): RunResult {
    const r = this.stmt.run(...(params as never[]))
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  get<T = Record<string, unknown>>(...params: readonly unknown[]): T | undefined {
    return this.stmt.get(...(params as never[])) as T | undefined
  }

  all<T = Record<string, unknown>>(...params: readonly unknown[]): T[] {
    return this.stmt.all(...(params as never[])) as T[]
  }
}

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    // Foreign keys are off by default in SQLite; without this, cascade deletes
    // silently do nothing and orphaned spec rows accumulate.
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): SqlStatement {
    return new NodeSqliteStatement(this.db.prepare(sql))
  }

  /** Nestable transaction; inner scopes use savepoints. */
  transaction<T>(fn: () => T): T {
    const name = `sp_${this.depth}`
    const begin = this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`
    const commit = this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`
    const rollback = this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`

    this.db.exec(begin)
    this.depth++
    try {
      const out = fn()
      this.depth--
      this.db.exec(commit)
      return out
    } catch (err) {
      this.depth--
      this.db.exec(rollback)
      throw err
    }
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
    if (!row) return undefined
    return Object.values(row)[0]
  }

  setPragma(name: string, value: string | number): void {
    this.db.exec(`PRAGMA ${name} = ${value}`)
  }

  close(): void {
    this.db.close()
  }
}

export function openDatabase(filename: string): SqlDriver {
  return new NodeSqliteDriver(filename)
}

export function openInMemory(): SqlDriver {
  return new NodeSqliteDriver(':memory:')
}
