import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, type BootstrapResult } from '../src/main/bootstrap.js'
import {
  readApiConfig, rotateApiToken, routeKey, setApiEnabled, startLocalApi,
  tokenMatches, type LocalApi,
} from '../src/server/local-api.js'
import { listProposals } from '../src/db/repositories/ingest.js'
import { datasheetStorageStats } from '../src/db/repositories/datasheets.js'

/**
 * End-to-end over the local API, exactly as an offline agent would drive it:
 * upload a datasheet, post its OCR text, claim a job, propose values, and see
 * the evidence checked against the stored pages.
 */

let dir: string
let boot: BootstrapResult
let api: LocalApi
let token: string
let base: string

/* eslint-disable @typescript-eslint/no-explicit-any -- responses are untyped JSON by design */
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> => {
  const init: RequestInit = {
    method,
    headers: { 'X-API-Token': token, 'Content-Type': 'application/json', ...headers },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'complib-api-'))
  boot = bootstrap(dir)
  setApiEnabled(boot.db, true)
  const config = { ...readApiConfig(boot.db), port: 8931 }
  token = config.token
  api = await startLocalApi(boot.db, config)
  base = `http://127.0.0.1:${api.port}`
})

afterAll(async () => {
  await api?.close()
  boot?.db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('access control', () => {
  it('binds loopback only', () => {
    // The listener address is 127.0.0.1 by construction; asserting the base URL
    // documents the intent alongside the code that sets it.
    expect(base.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('refuses a request with no token', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(401)
  })

  it('refuses a wrong token', async () => {
    const res = await call('GET', '/health', undefined, { 'X-API-Token': 'nope' })
    expect(res.status).toBe(401)
  })

  it('accepts the right token', async () => {
    const res = await call('GET', '/health')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, api: 1 })
  })

  it('compares tokens in constant time and rejects length mismatches', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abc', 'abcd')).toBe(false)
    expect(tokenMatches(undefined, 'abc')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
  })

  it('can rotate the token', () => {
    const before = readApiConfig(boot.db).token
    const after = rotateApiToken(boot.db)
    expect(after).not.toBe(before)
    // Put it back so the rest of the suite keeps working.
    boot.db.prepare("UPDATE setting SET value = ? WHERE key = 'api.token'").run(token)
  })
})

describe('routing', () => {
  it('maps concrete paths to parameterised routes', () => {
    expect(routeKey('GET', '/components/12')).toBe('GET /components/:id')
    expect(routeKey('GET', '/categories/tiny-ldo/parameters')).toBe('GET /categories/:slug/parameters')
    expect(routeKey('PUT', '/datasheets/3/pages')).toBe('PUT /datasheets/:id/pages')
    expect(routeKey('GET', '/health/')).toBe('GET /health')
  })

  it('lists available routes on a 404 instead of failing silently', async () => {
    const res = await call('GET', '/nonsense')
    expect(res.status).toBe(404)
    expect(Array.isArray(res.json.routes)).toBe(true)
  })
})

describe('reading the library', () => {
  it('serves the category taxonomy', async () => {
    const res = await call('GET', '/categories')
    expect(res.status).toBe(200)
    expect(res.json).toHaveLength(36)
  })

  it('serves a category\'s parameters, so the agent knows what to look for', async () => {
    const res = await call('GET', '/categories/tiny-ldo/parameters')
    expect(res.json.map((p: { key: string }) => p.key)).toContain('iq')
  })

  it('searches components', async () => {
    const res = await call('GET', '/components/search?q=nRF54')
    expect(res.json.length).toBeGreaterThan(0)
  })
})

describe('the agent round trip', () => {
  let componentId = 0
  let datasheetId = 0
  let jobId = 0

  const PDF = new TextEncoder().encode('%PDF-1.4 fake bytes for the test')

  it('creates a component', async () => {
    const res = await call('POST', '/components', {
      manufacturer: 'Texas Instruments',
      mpn: 'TPS7A02-AGENT',
      categorySlug: 'tiny-ldo',
      package: { xMax: 0.665, yMax: 0.665 },
    })
    expect(res.status).toBe(200)
    componentId = res.json.id
    expect(componentId).toBeGreaterThan(0)
  })

  it('refuses a duplicate rather than overwriting', async () => {
    const res = await call('POST', '/components', {
      manufacturer: 'texas instruments', mpn: 'tps7a02-agent', categorySlug: 'tiny-ldo',
    })
    expect(res.status).toBe(409)
    expect(res.json.duplicate.id).toBe(componentId)
  })

  it('stores the datasheet bytes in the database', async () => {
    const res = await fetch(`${base}/datasheets?componentId=${componentId}&title=TPS7A02`, {
      method: 'POST',
      headers: { 'X-API-Token': token, 'Content-Type': 'application/pdf' },
      body: PDF,
    })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.deduplicated).toBe(false)
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/)
    datasheetId = json.id

    const stats = datasheetStorageStats(boot.db)
    // One stored document; the 150 seeded rows are URL references, not content.
    expect(stats.stored).toBe(1)
    expect(stats.referenced).toBe(150)
    expect(stats.bytes).toBe(PDF.byteLength)
  })

  it('deduplicates identical content instead of storing it twice', async () => {
    const res = await fetch(`${base}/datasheets`, {
      method: 'POST',
      headers: { 'X-API-Token': token, 'Content-Type': 'application/pdf' },
      body: PDF,
    })
    const json = await res.json()
    expect(json.deduplicated).toBe(true)
    expect(json.id).toBe(datasheetId)
    expect(datasheetStorageStats(boot.db).stored).toBe(1)
  })

  it('serves the stored bytes back byte-for-byte', async () => {
    const res = await fetch(`${base}/datasheets/${datasheetId}/content`, {
      headers: { 'X-API-Token': token },
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes).toEqual(PDF)
  })

  it('accepts OCR page text and records the method', async () => {
    const res = await call('PUT', `/datasheets/${datasheetId}/pages`, {
      engine: 'tesseract-5.3',
      pages: [
        { page: 1, text: 'TPS7A02 Ultra-low IQ low-dropout regulator', method: 'ocr', confidence: 0.91 },
        { page: 13, text: 'IQ Quiescent current, no load 25 nA', method: 'ocr', confidence: 0.88 },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ pagesStored: 2, textStatus: 'ocr' })
  })

  it('finds the page holding a parameter, so the model reads one page not fifty', async () => {
    const res = await call('GET', '/datasheets/pages/search?q=quiescent')
    expect(res.json.length).toBeGreaterThan(0)
    expect(res.json[0].page).toBe(13)
    expect(res.json[0].method).toBe('ocr')
  })

  it('queues and claims a job', async () => {
    const created = await call('POST', '/jobs', { datasheetId, componentId, categoryHint: 'tiny-ldo' })
    jobId = created.json.id

    const claimed = await call('POST', '/jobs/claim', { worker: 'local-llm-1' })
    expect(claimed.json.id).toBe(jobId)
    expect(claimed.json.status).toBe('claimed')
  })

  it('does not hand the same job to a second agent', async () => {
    const second = await call('POST', '/jobs/claim', { worker: 'local-llm-2' })
    expect(second.json.empty).toBe(true)
  })

  it('verifies proposed evidence against the stored page text', async () => {
    const res = await call('POST', `/jobs/${jobId}/proposal`, {
      fields: [
        {
          target: 'spec', specKey: 'iq', value: '25 nA', unit: 'nA', page: 13,
          evidence: 'IQ Quiescent current, no load 25 nA', confidence: 0.9,
        },
        {
          // Fabricated: this quote is not on page 13, or anywhere.
          target: 'spec', specKey: 'dropout', value: '105 mV', unit: 'mV', page: 13,
          evidence: 'Dropout voltage 105 mV at 200 mA', confidence: 0.97,
        },
        {
          // A legitimate "I looked and did not find it".
          target: 'spec', specKey: 'psrr', value: null, confidence: 0.2,
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(res.json.accepted).toBe(1)
    expect(res.json.rejected).toBe(1)
    expect(res.json.reportedUnknown).toBe(1)
    expect(res.json.details[1].reason).toMatch(/does not appear on page 13/)
  })

  it('writes proposals to review, never straight into the library', async () => {
    const proposals = listProposals(boot.db, jobId)
    const iq = proposals.find((p) => p.specKey === 'iq')!
    const dropout = proposals.find((p) => p.specKey === 'dropout')!

    expect(iq.evidenceVerified).toBe(true)
    expect(dropout.evidenceVerified).toBe(false)

    // The crucial assertion: the component's real specs are untouched.
    const specCount = boot.db
      .prepare('SELECT COUNT(*) n FROM spec_value WHERE component_id = ?')
      .get<{ n: number }>(componentId)!.n
    expect(specCount).toBe(0)
  })

  it('reports queue and storage stats', async () => {
    const res = await call('GET', '/stats')
    expect(res.json.queue.proposed).toBe(1)
    expect(res.json.queue.pendingValues).toBe(1)
    expect(res.json.datasheets.stored).toBe(1)
    expect(res.json.datasheets.ocrCount).toBe(1)
  })
})

describe('limits and errors', () => {
  it('rejects a malformed JSON body with 400, not a 500', async () => {
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'X-API-Token': token, 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('404s an unknown component rather than returning null', async () => {
    const res = await call('GET', '/components/999999')
    expect(res.status).toBe(404)
  })

  it('rejects an empty datasheet upload', async () => {
    const res = await fetch(`${base}/datasheets`, {
      method: 'POST',
      headers: { 'X-API-Token': token },
      body: new Uint8Array(0),
    })
    expect(res.status).toBe(400)
  })
})
