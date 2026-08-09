import type { SqlDriver } from '../db/driver.js'
import {
  addExternal, applyExtraction, createComponent, createProfile, setPackage,
  type ExtractedField,
} from '../db/repositories/mutations.js'

/**
 * Turning an approved review into a real component.
 *
 * This is the only path from a proposal into the library, and it runs after a
 * human has looked at every field. Values the reviewer edited are written as
 * `manual`; values they accepted untouched are written as `extracted` with
 * their provenance.
 */

export interface ApprovedIdentity {
  readonly manufacturer: string
  readonly mpn: string
  readonly family?: string | null
  readonly categorySlug: string | null
  readonly datasheetId: number | null
  readonly whereUsed?: string
}

export interface ApprovedPackage {
  readonly name?: string | null
  readonly type?: string | null
  readonly pinCount?: number | null
  readonly xMin?: number | null; readonly xNom?: number | null; readonly xMax?: number | null
  readonly yMin?: number | null; readonly yNom?: number | null; readonly yMax?: number | null
  readonly zMin?: number | null; readonly zNom?: number | null; readonly zMax?: number | null
}

export interface ApprovedField {
  readonly specKey: string
  readonly value: string
  readonly page: number | null
  readonly evidence: string | null
  readonly confidence: number
  /** True when the reviewer typed this value rather than accepting the model's. */
  readonly edited: boolean
}

export interface ApprovedExternal {
  readonly name: string
  readonly function?: string
  readonly qty?: number
  readonly necessity?: 'required' | 'recommended' | 'optional' | 'configuration'
  readonly valueText?: string | null
  readonly packageName?: string | null
  readonly xMm?: number | null
  readonly yMm?: number | null
}

export interface ApprovedReview {
  readonly jobId: number
  readonly identity: ApprovedIdentity
  readonly package: ApprovedPackage | null
  readonly fields: readonly ApprovedField[]
  readonly externals: readonly ApprovedExternal[]
  /** Existing component to update instead of creating a new one. */
  readonly componentId?: number | null
}

export interface ApplyResult {
  readonly ok: boolean
  readonly componentId: number | null
  readonly created: boolean
  readonly written: number
  readonly keptManual: number
  readonly rejected: number
  readonly outcomes: ReadonlyArray<{ specKey: string; status: string; reason: string | null }>
  readonly error: string | null
  readonly duplicate: { id: number; mpn: string; manufacturer: string } | null
}

export function applyReview(db: SqlDriver, review: ApprovedReview): ApplyResult {
  const empty = {
    written: 0, keptManual: 0, rejected: 0,
    outcomes: [] as ApplyResult['outcomes'], duplicate: null, error: null,
  }

  let componentId = review.componentId ?? null
  let created = false

  if (componentId === null) {
    const result = createComponent(db, {
      manufacturer: review.identity.manufacturer,
      mpn: review.identity.mpn,
      family: review.identity.family ?? null,
      categorySlug: review.identity.categorySlug,
      lifecycle: 'unknown',
      ...(review.package ?? {}),
    })
    if (!result.ok) {
      return {
        ...empty, ok: false, componentId: null, created: false,
        duplicate: result.duplicate,
        error: `${result.duplicate.manufacturer} ${result.duplicate.mpn} already exists.`,
      }
    }
    componentId = result.id
    created = true
  }

  // Dimensions from the review are confirmed by the person who just looked at
  // the mechanical drawing, so they are manual and verified.
  if (review.package) setPackage(db, componentId, review.package)

  if (review.identity.whereUsed !== undefined) {
    db.prepare('UPDATE component SET where_used = ?, updated_at = ? WHERE id = ?')
      .run(review.identity.whereUsed, new Date().toISOString(), componentId)
  }

  if (review.identity.datasheetId !== null) {
    db.prepare('UPDATE datasheet SET component_id = ? WHERE id = ?')
      .run(componentId, review.identity.datasheetId)
  }

  const categoryId = db
    .prepare('SELECT category_id AS id FROM component WHERE id = ?')
    .get<{ id: number | null }>(componentId)?.id ?? null

  let outcomes: ApplyResult['outcomes'] = []
  if (categoryId !== null && review.fields.length > 0) {
    const extracted: ExtractedField[] = review.fields.map((f) => ({
      specKey: f.specKey,
      raw: f.value,
      confidence: f.confidence,
      page: f.page,
      evidence: f.evidence,
      // A reviewer who edited or confirmed a value has supplied the evidence
      // themselves; the machine check has already run before this point.
      evidenceVerified: true,
    }))

    outcomes = applyExtraction(db, componentId, categoryId, extracted, {
      // The reviewer saw the conflict and chose to keep the new value.
      acceptManualOverwrites: review.fields.filter((f) => f.edited).map((f) => f.specKey),
    })
  }

  if (review.externals.length > 0) {
    const profileId = createProfile(db, componentId, 'From datasheet', true)
    for (const e of review.externals) {
      addExternal(db, profileId, {
        name: e.name,
        function: e.function ?? '',
        qty: e.qty ?? 1,
        necessity: e.necessity ?? 'required',
        valueText: e.valueText ?? null,
        packageName: e.packageName ?? null,
        xMm: e.xMm ?? null,
        yMm: e.yMm ?? null,
        sourceRef: 'Suggested from the datasheet and approved on import',
      })
    }
  }

  db.prepare("UPDATE ingest_job SET status = 'applied', component_id = ?, updated_at = ? WHERE id = ?")
    .run(componentId, new Date().toISOString(), review.jobId)
  db.prepare("UPDATE proposed_value SET status = 'accepted' WHERE job_id = ? AND status = 'pending'")
    .run(review.jobId)

  return {
    ok: true,
    componentId,
    created,
    written: outcomes.filter((o) => o.status === 'written').length,
    keptManual: outcomes.filter((o) => o.status === 'kept-manual').length,
    rejected: outcomes.filter((o) => o.status === 'rejected').length,
    outcomes: outcomes.map((o) => ({ specKey: o.specKey, status: o.status, reason: o.reason })),
    error: null,
    duplicate: null,
  }
}

export function discardReview(db: SqlDriver, jobId: number): void {
  db.transaction(() => {
    db.prepare("UPDATE ingest_job SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), jobId)
    db.prepare("UPDATE proposed_value SET status = 'rejected' WHERE job_id = ?").run(jobId)
  })
}
