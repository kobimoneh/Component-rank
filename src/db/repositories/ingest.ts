import type { SqlDriver } from '../driver.js'
import { verifyAll, type ExtractedClaim, type PageText } from '../../extraction/evidence.js'
import { getDatasheetPages } from './datasheets.js'

/**
 * The ingestion queue an offline agent works through.
 *
 * The contract is deliberately one-way: an agent may propose, never apply.
 * Everything it produces lands in `proposed_value` with its evidence already
 * checked against the stored page text, and a human accepts or rejects it.
 *
 * This is what makes "run it against a big database with a local model" safe:
 * the model can be wrong at scale, and being wrong at scale only ever creates
 * a review queue, never a corrupted library.
 */

const now = (): string => new Date().toISOString()

export type JobStatus = 'queued' | 'claimed' | 'proposed' | 'applied' | 'rejected' | 'failed'

export interface Job {
  readonly id: number
  readonly datasheetId: number | null
  readonly componentId: number | null
  readonly mpnHint: string | null
  readonly categoryHint: string | null
  readonly status: JobStatus
  readonly claimedBy: string | null
  readonly error: string | null
  readonly createdAt: string
}

export function enqueueJob(
  db: SqlDriver,
  input: {
    datasheetId?: number | null
    componentId?: number | null
    mpnHint?: string | null
    categoryHint?: string | null
  },
): number {
  const ts = now()
  return db
    .prepare(`
      INSERT INTO ingest_job (datasheet_id, component_id, mpn_hint, category_hint,
                              status, created_at, updated_at)
      VALUES (?,?,?,?, 'queued', ?, ?)
    `)
    .run(
      input.datasheetId ?? null, input.componentId ?? null,
      input.mpnHint ?? null, input.categoryHint ?? null, ts, ts,
    ).lastInsertRowid
}

/**
 * Atomically claim the oldest queued job.
 *
 * The UPDATE ... WHERE status='queued' is the lock: two agents polling at once
 * cannot both take the same job, because the second one changes no rows.
 */
export function claimNextJob(db: SqlDriver, worker: string): Job | null {
  let claimed: Job | null = null
  db.transaction(() => {
    const next = db
      .prepare("SELECT id FROM ingest_job WHERE status = 'queued' ORDER BY id LIMIT 1")
      .get<{ id: number }>()
    if (!next) return
    const res = db
      .prepare(`
        UPDATE ingest_job SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `)
      .run(worker, now(), now(), next.id)
    if (res.changes === 0) return
    claimed = getJob(db, next.id)
  })
  return claimed
}

export function getJob(db: SqlDriver, id: number): Job | null {
  return (
    db
      .prepare(`
        SELECT id, datasheet_id AS datasheetId, component_id AS componentId,
               mpn_hint AS mpnHint, category_hint AS categoryHint, status,
               claimed_by AS claimedBy, error, created_at AS createdAt
        FROM ingest_job WHERE id = ?
      `)
      .get<Job>(id) ?? null
  )
}

export function listJobs(db: SqlDriver, status?: JobStatus, limit = 100): Job[] {
  const sql = `
    SELECT id, datasheet_id AS datasheetId, component_id AS componentId,
           mpn_hint AS mpnHint, category_hint AS categoryHint, status,
           claimed_by AS claimedBy, error, created_at AS createdAt
    FROM ingest_job ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?
  `
  return status
    ? db.prepare(sql).all<Job>(status, limit)
    : db.prepare(sql).all<Job>(limit)
}

export function failJob(db: SqlDriver, id: number, error: string): void {
  db.prepare("UPDATE ingest_job SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .run(error, now(), id)
}

export interface ProposalField {
  readonly target: 'spec' | 'package' | 'identity' | 'external'
  readonly specKey?: string | null
  readonly value: string | number | boolean | null
  readonly unit?: string | null
  readonly page?: number | null
  readonly evidence?: string | null
  readonly confidence: number
}

export interface SubmitResult {
  readonly jobId: number
  readonly accepted: number
  readonly rejected: number
  readonly reportedUnknown: number
  readonly details: ReadonlyArray<{
    readonly specKey: string | null
    readonly status: 'pending' | 'rejected'
    readonly reason: string
  }>
}

/**
 * Record an agent's proposal.
 *
 * Every field's evidence is verified against the stored page text before it is
 * written, and an unverifiable field is stored as rejected with the reason.
 * Nothing here touches `spec_value`; acceptance is a separate, human step.
 */
export function submitProposal(
  db: SqlDriver,
  jobId: number,
  fields: readonly ProposalField[],
): SubmitResult {
  const job = getJob(db, jobId)
  if (!job) throw new Error(`No ingest job ${jobId}`)

  const pages: PageText[] = job.datasheetId
    ? getDatasheetPages(db, job.datasheetId).map((p) => ({ page: p.page, text: p.text }))
    : []

  const claims: ExtractedClaim[] = fields.map((f) => ({
    specKey: f.specKey ?? f.target,
    value: f.value,
    unit: f.unit ?? null,
    page: f.page ?? null,
    evidence: f.evidence ?? null,
    confidence: f.confidence,
  }))
  const verified = verifyAll(claims, pages)

  const details: Array<{ specKey: string | null; status: 'pending' | 'rejected'; reason: string }> = []
  let accepted = 0
  let rejected = 0

  db.transaction(() => {
    const insert = db.prepare(`
      INSERT INTO proposed_value (job_id, component_id, target, spec_key, raw_value, unit,
                                  page, evidence, evidence_verified, confidence, status,
                                  conflict, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)

    fields.forEach((f, i) => {
      const v = verified.claims[i]!
      const isNull = f.value === null
      const status = v.verified ? 'pending' : 'rejected'
      if (v.verified) accepted++
      else if (!isNull) rejected++

      // If the component already holds a manual value, flag the conflict now so
      // the review screen can show it rather than discovering it on apply.
      let conflict: string | null = null
      if (job.componentId && f.target === 'spec' && f.specKey) {
        const current = db
          .prepare(`
            SELECT v.origin FROM spec_value v
            JOIN spec_def d ON d.id = v.spec_def_id
            WHERE v.component_id = ? AND d.key = ?
          `)
          .get<{ origin: string }>(job.componentId, f.specKey)
        if (current?.origin === 'manual') conflict = 'A manual value already exists for this field.'
      }

      insert.run(
        jobId, job.componentId, f.target, f.specKey ?? null,
        f.value === null ? null : String(f.value), f.unit ?? null,
        v.page, f.evidence ?? null, v.verified ? 1 : 0, f.confidence,
        status, conflict, now(),
      )

      details.push({
        specKey: f.specKey ?? null,
        status: status as 'pending' | 'rejected',
        reason: v.explanation,
      })
    })

    db.prepare("UPDATE ingest_job SET status = 'proposed', updated_at = ? WHERE id = ?")
      .run(now(), jobId)
  })

  return {
    jobId,
    accepted,
    rejected,
    reportedUnknown: verified.reportedUnknown,
    details,
  }
}

export interface PendingProposal {
  readonly id: number
  readonly jobId: number
  readonly componentId: number | null
  readonly target: string
  readonly specKey: string | null
  readonly rawValue: string | null
  readonly unit: string | null
  readonly page: number | null
  readonly evidence: string | null
  readonly evidenceVerified: boolean
  readonly confidence: number
  readonly conflict: string | null
}

interface ProposalRow extends Omit<PendingProposal, 'evidenceVerified'> {
  evidenceVerified: number
}

export function listProposals(db: SqlDriver, jobId: number): PendingProposal[] {
  return db
    .prepare(`
      SELECT id, job_id AS jobId, component_id AS componentId, target,
             spec_key AS specKey, raw_value AS rawValue, unit, page, evidence,
             evidence_verified AS evidenceVerified, confidence, conflict
      FROM proposed_value WHERE job_id = ? ORDER BY id
    `)
    .all<ProposalRow>(jobId)
    .map((p) => ({ ...p, evidenceVerified: p.evidenceVerified === 1 }))
}

export interface QueueStats {
  readonly queued: number
  readonly claimed: number
  readonly proposed: number
  readonly failed: number
  readonly pendingValues: number
}

export function queueStats(db: SqlDriver): QueueStats {
  const count = (sql: string, ...p: unknown[]): number =>
    db.prepare(sql).get<{ n: number }>(...p)?.n ?? 0
  return {
    queued: count("SELECT COUNT(*) n FROM ingest_job WHERE status='queued'"),
    claimed: count("SELECT COUNT(*) n FROM ingest_job WHERE status='claimed'"),
    proposed: count("SELECT COUNT(*) n FROM ingest_job WHERE status='proposed'"),
    failed: count("SELECT COUNT(*) n FROM ingest_job WHERE status='failed'"),
    pendingValues: count("SELECT COUNT(*) n FROM proposed_value WHERE status='pending'"),
  }
}
