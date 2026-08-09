import { z } from 'zod'
import type { PageText, ExtractedClaim } from '../extraction/evidence.js'

/**
 * The one extraction interface.
 *
 * Provider-specific code exists only in the implementations below this file.
 * Nothing else in the application knows whether a datasheet was read by the
 * local Claude CLI or the Anthropic API.
 *
 * Phase 5 status: the contract, schemas and validation are real and tested. The
 * providers are declared but not yet wired to a model — `isAvailable()` reports
 * honestly, and the UI disables datasheet ingestion rather than offering
 * something that does not work.
 */

export type ProviderId = 'claude-cli' | 'anthropic-api'

/** Model output is validated against this before it can reach the database. */
export const ClaimSchema = z.object({
  specKey: z.string().min(1),
  // null is a legitimate, expected answer meaning "I looked and did not find it".
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().nullable(),
  page: z.number().int().positive().nullable(),
  evidence: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})

export const PackageVariantSchema = z.object({
  name: z.string().min(1),
  orderingCodeFragment: z.string().nullable(),
  pinCount: z.number().int().positive().nullable(),
  xMin: z.number().positive().nullable(),
  xNom: z.number().positive().nullable(),
  xMax: z.number().positive().nullable(),
  yMin: z.number().positive().nullable(),
  yNom: z.number().positive().nullable(),
  yMax: z.number().positive().nullable(),
  zMin: z.number().positive().nullable(),
  zNom: z.number().positive().nullable(),
  zMax: z.number().positive().nullable(),
  page: z.number().int().positive().nullable(),
  evidence: z.string().nullable(),
})

export const SuggestedExternalSchema = z.object({
  name: z.string().min(1),
  function: z.string(),
  qty: z.number().int().positive(),
  necessity: z.enum(['required', 'recommended', 'optional', 'configuration']),
  valueText: z.string().nullable(),
  packageName: z.string().nullable(),
  xMm: z.number().positive().nullable(),
  yMm: z.number().positive().nullable(),
  page: z.number().int().positive().nullable(),
  evidence: z.string().nullable(),
})

export const ExtractionResultSchema = z.object({
  manufacturer: z.string().nullable(),
  mpn: z.string().nullable(),
  productName: z.string().nullable(),
  categorySlug: z.string().nullable(),
  categoryConfidence: z.number().min(0).max(1),
  /** Every package the datasheet documents. More than one means we must ask. */
  packageVariants: z.array(PackageVariantSchema),
  claims: z.array(ClaimSchema),
  suggestedExternals: z.array(SuggestedExternalSchema),
})

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>
export type PackageVariant = z.infer<typeof PackageVariantSchema>
export type SuggestedExternal = z.infer<typeof SuggestedExternalSchema>

export interface ExtractionRequest {
  readonly pages: readonly PageText[]
  /** The MPN the user typed, if any — used to pick the right package variant. */
  readonly mpnHint: string | null
  /** Candidate categories with their spec definitions, so the model knows what matters. */
  readonly categories: ReadonlyArray<{
    readonly slug: string
    readonly name: string
    readonly description: string
    readonly specs: ReadonlyArray<{ key: string; name: string; unit: string | null; ai: string | null }>
  }>
}

export interface ProviderStatus {
  readonly id: ProviderId
  readonly available: boolean
  /** Why it is unavailable, shown verbatim in the UI. */
  readonly reason: string | null
}

export interface ExtractionProvider {
  readonly id: ProviderId
  status(): Promise<ProviderStatus>
  extract(request: ExtractionRequest): Promise<ExtractionResult>
}

export class ProviderUnavailableError extends Error {
  constructor(readonly providerId: ProviderId, message: string) {
    super(message)
    this.name = 'ProviderUnavailableError'
  }
}

/**
 * Validate raw model output before anything downstream sees it.
 * A malformed extraction is an error you see, not a half-populated component.
 */
export function parseExtractionResult(raw: unknown): ExtractionResult {
  return ExtractionResultSchema.parse(raw)
}

/** Convert validated claims into the shape the evidence verifier consumes. */
export function toClaims(result: ExtractionResult): ExtractedClaim[] {
  return result.claims.map((c) => ({
    specKey: c.specKey,
    value: c.value,
    unit: c.unit,
    page: c.page,
    evidence: c.evidence,
    confidence: c.confidence,
  }))
}

/**
 * Does the entered MPN unambiguously select one documented package?
 * If not, the import flow must ask rather than guess — attaching the wrong
 * physical size to a part would be a defect in the field this app exists for.
 */
export function resolvePackageVariant(
  variants: readonly PackageVariant[],
  mpnHint: string | null,
): { readonly resolved: PackageVariant | null; readonly mustAsk: boolean; readonly candidates: readonly PackageVariant[] } {
  if (variants.length === 0) return { resolved: null, mustAsk: false, candidates: [] }
  if (variants.length === 1) return { resolved: variants[0]!, mustAsk: false, candidates: variants }

  if (mpnHint) {
    const upper = mpnHint.toUpperCase()
    const matches = variants.filter(
      (v) => v.orderingCodeFragment && upper.includes(v.orderingCodeFragment.toUpperCase()),
    )
    if (matches.length === 1) return { resolved: matches[0]!, mustAsk: false, candidates: variants }
    if (matches.length > 1) return { resolved: null, mustAsk: true, candidates: matches }
  }
  return { resolved: null, mustAsk: true, candidates: variants }
}
