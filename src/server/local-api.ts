import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { SqlDriver } from '../db/driver.js'
import { listCategories } from '../db/repositories/categories.js'
import { listSpecDefs } from '../db/repositories/spec-defs.js'
import { categoryColumns, listCategoryRows, searchComponents } from '../db/repositories/components.js'
import { componentDetail } from '../db/repositories/component-detail.js'
import { createComponent } from '../db/repositories/mutations.js'
import {
  datasheetStorageStats, getDatasheetBytes, getDatasheetPages, listDatasheets,
  searchPages, setDatasheetPages, storeDatasheet,
} from '../db/repositories/datasheets.js'
import {
  claimNextJob, enqueueJob, failJob, listJobs, listProposals, queueStats, submitProposal,
} from '../db/repositories/ingest.js'

/**
 * Local API for an offline ingestion agent.
 *
 * Design constraints, in order of importance:
 *
 *  1. **Loopback only.** The listener binds 127.0.0.1. It is not reachable from
 *     the network, by configuration and not by firewall.
 *  2. **Off by default.** It starts only when explicitly enabled in settings.
 *  3. **Token required.** A random token is generated on first enable; every
 *     request must present it. Comparison is constant-time.
 *  4. **Propose, never apply.** No endpoint writes a confirmed specification.
 *     An agent can create components and upload datasheets, but every extracted
 *     value lands in the review queue with its evidence already checked.
 *
 * No web framework: this is a handful of routes and adding a dependency tree to
 * the trusted process to save fifty lines is a bad trade.
 */

export const API_ENABLED_KEY = 'api.enabled'
export const API_TOKEN_KEY = 'api.token'
export const API_PORT_KEY = 'api.port'
export const DEFAULT_PORT = 8917

const MAX_BODY_BYTES = 64 * 1024 * 1024 // a datasheet, not a disk image

export interface ApiConfig {
  readonly enabled: boolean
  readonly token: string
  readonly port: number
}

function getSetting(db: SqlDriver, key: string): string | null {
  return db.prepare('SELECT value FROM setting WHERE key = ?').get<{ value: string }>(key)?.value ?? null
}

function putSetting(db: SqlDriver, key: string, value: string): void {
  db.prepare(`
    INSERT INTO setting (key, value) VALUES (?,?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function readApiConfig(db: SqlDriver): ApiConfig {
  let token = getSetting(db, API_TOKEN_KEY)
  if (!token) {
    token = randomBytes(24).toString('base64url')
    putSetting(db, API_TOKEN_KEY, token)
  }
  return {
    enabled: getSetting(db, API_ENABLED_KEY) === 'true',
    token,
    port: Number(getSetting(db, API_PORT_KEY) ?? DEFAULT_PORT) || DEFAULT_PORT,
  }
}

export function setApiEnabled(db: SqlDriver, enabled: boolean): void {
  putSetting(db, API_ENABLED_KEY, enabled ? 'true' : 'false')
}

export function rotateApiToken(db: SqlDriver): string {
  const token = randomBytes(24).toString('base64url')
  putSetting(db, API_TOKEN_KEY, token)
  return token
}

/** Constant-time token comparison, so the token cannot be guessed by timing. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

interface Ctx {
  readonly db: SqlDriver
  readonly url: URL
  readonly body: Buffer
  json<T>(): T
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>

/** `METHOD /path` → handler. Path segments starting with `:` are parameters. */
const ROUTES: Record<string, Handler> = {
  'GET /health': () => ({ ok: true, api: 1 }),

  'GET /categories': ({ db }) =>
    listCategories(db).map((c) => ({
      slug: c.slug, name: c.name, group: c.group, componentCount: c.componentCount,
    })),

  'GET /categories/:slug/parameters': ({ db, url }) =>
    listSpecDefs(db, url.pathname.split('/')[2] ?? ''),

  'GET /categories/:slug/columns': ({ db, url }) =>
    categoryColumns(db, url.pathname.split('/')[2] ?? ''),

  'GET /categories/:slug/components': ({ db, url }) =>
    listCategoryRows(db, url.pathname.split('/')[2] ?? '', url.searchParams.get('q') ?? undefined),

  'GET /components/search': ({ db, url }) =>
    searchComponents(db, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 50)),

  'GET /components/:id': ({ db, url }) => {
    const id = Number(url.pathname.split('/')[2])
    const detail = componentDetail(db, id)
    if (!detail) throw new HttpError(404, `No component ${id}`)
    return detail
  },

  'POST /components': ({ db, json }) => {
    const body = json<Parameters<typeof createComponent>[1]>()
    const result = createComponent(db, body)
    if (!result.ok) throw new HttpError(409, 'Duplicate', { duplicate: result.duplicate })
    return { id: result.id }
  },

  'GET /datasheets': ({ db, url }) => {
    const componentId = url.searchParams.get('componentId')
    return listDatasheets(db, componentId ? Number(componentId) : undefined)
  },

  'POST /datasheets': ({ db, url, body }) => {
    if (body.byteLength === 0) throw new HttpError(400, 'Empty body; POST the PDF bytes')
    const componentId = url.searchParams.get('componentId')
    return storeDatasheet(db, {
      content: new Uint8Array(body),
      componentId: componentId ? Number(componentId) : null,
      title: url.searchParams.get('title'),
      url: url.searchParams.get('url'),
      mime: url.searchParams.get('mime') ?? 'application/pdf',
      source: 'agent',
    })
  },

  'GET /datasheets/:id/content': ({ db, url }) => {
    const id = Number(url.pathname.split('/')[2])
    const bytes = getDatasheetBytes(db, id)
    if (!bytes) throw new HttpError(404, `No stored content for datasheet ${id}`)
    return new Binary(bytes, 'application/pdf')
  },

  'GET /datasheets/:id/pages': ({ db, url }) =>
    getDatasheetPages(db, Number(url.pathname.split('/')[2])),

  'PUT /datasheets/:id/pages': ({ db, url, json }) => {
    const id = Number(url.pathname.split('/')[2])
    const body = json<{ engine?: string; pages: Array<{ page: number; text: string; method?: string; confidence?: number }> }>()
    if (!Array.isArray(body.pages)) throw new HttpError(400, 'Expected { pages: [...] }')
    return setDatasheetPages(
      db, id,
      body.pages.map((p) => ({
        page: p.page,
        text: p.text ?? '',
        method: (p.method ?? 'text-layer') as 'ocr',
        confidence: p.confidence ?? null,
      })),
      body.engine ?? null,
    )
  },

  'GET /datasheets/pages/search': ({ db, url }) =>
    searchPages(db, url.searchParams.get('q') ?? '', Number(url.searchParams.get('limit') ?? 25)),

  'POST /jobs': ({ db, json }) => {
    const body = json<{ datasheetId?: number; componentId?: number; mpnHint?: string; categoryHint?: string }>()
    return { id: enqueueJob(db, body) }
  },

  'GET /jobs': ({ db, url }) =>
    listJobs(db, (url.searchParams.get('status') as 'queued') ?? undefined,
      Number(url.searchParams.get('limit') ?? 100)),

  'POST /jobs/claim': ({ db, json }) => {
    const body = json<{ worker?: string }>()
    const job = claimNextJob(db, body.worker ?? 'agent')
    return job ?? { empty: true }
  },

  'POST /jobs/:id/proposal': ({ db, url, json }) => {
    const id = Number(url.pathname.split('/')[2])
    const body = json<{ fields: Parameters<typeof submitProposal>[2] }>()
    if (!Array.isArray(body.fields)) throw new HttpError(400, 'Expected { fields: [...] }')
    return submitProposal(db, id, body.fields)
  },

  'GET /jobs/:id/proposal': ({ db, url }) =>
    listProposals(db, Number(url.pathname.split('/')[2])),

  'POST /jobs/:id/fail': ({ db, url, json }) => {
    const id = Number(url.pathname.split('/')[2])
    const body = json<{ error?: string }>()
    failJob(db, id, body.error ?? 'unspecified')
    return { ok: true }
  },

  'GET /stats': ({ db }) => ({
    queue: queueStats(db),
    datasheets: datasheetStorageStats(db),
  }),
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: unknown) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Marker for a handler returning raw bytes rather than JSON. */
export class Binary {
  constructor(readonly bytes: Uint8Array, readonly mime: string) {}
}

/** Normalize a concrete path to its route key: /components/12 → /components/:id */
export function routeKey(method: string, pathname: string): string {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  const shaped = parts.map((p, i) => {
    if (/^\d+$/.test(p)) return ':id'
    // /categories/<slug>/... — the second segment is a slug, not a literal.
    if (i === 1 && parts[0] === 'categories') return ':slug'
    return p
  })
  return `${method} /${shaped.join('/')}`
}

export interface LocalApi {
  readonly port: number
  close(): Promise<void>
}

export function startLocalApi(db: SqlDriver, config: ApiConfig): Promise<LocalApi> {
  const server: Server = createServer((req, res) => {
    void handle(db, config, req, res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1 explicitly: never 0.0.0.0, never the LAN.
    server.listen(config.port, '127.0.0.1', () => {
      resolve({
        port: config.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

async function handle(
  db: SqlDriver,
  config: ApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const send = (status: number, payload: unknown, mime = 'application/json'): void => {
    if (payload instanceof Binary) {
      res.writeHead(status, { 'Content-Type': payload.mime, 'Content-Length': payload.bytes.byteLength })
      res.end(Buffer.from(payload.bytes))
      return
    }
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': mime, 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${config.port}`)

    if (!tokenMatches(req.headers['x-api-token'] as string | undefined, config.token)) {
      send(401, { error: 'Missing or invalid X-API-Token' })
      return
    }

    const key = routeKey(req.method ?? 'GET', url.pathname)
    const handler = ROUTES[key]
    if (!handler) {
      send(404, { error: `No route ${key}`, routes: Object.keys(ROUTES) })
      return
    }

    const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req)
    const ctx: Ctx = {
      db, url, body,
      json<T>(): T {
        if (body.byteLength === 0) return {} as T
        try {
          return JSON.parse(body.toString('utf8')) as T
        } catch {
          throw new HttpError(400, 'Body is not valid JSON')
        }
      },
    }

    const result = await handler(ctx)
    send(200, result)
  } catch (err) {
    if (err instanceof HttpError) {
      send(err.status, { error: err.message, ...(err.extra ?? {}) })
      return
    }
    send(500, { error: (err as Error).message })
  }
}
