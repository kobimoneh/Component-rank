/**
 * Evidence verification — the anti-hallucination mechanism.
 *
 * A prompt saying "do not invent values" is a request, not a guarantee. This is
 * the guarantee: every extracted field must carry a verbatim quote and the page
 * it came from, and that quote is searched for in the text actually extracted
 * from that page. A value whose quote is not found is never stored as confirmed.
 *
 * To fabricate a number, a model would also have to fabricate a quote that
 * happens to appear in the PDF. That turns an unfalsifiable claim into a
 * checkable one — and this is a pure function, testable without a model.
 */

export interface PageText {
  readonly page: number
  readonly text: string
}

export interface ExtractedClaim {
  readonly specKey: string
  readonly value: string | number | boolean | null
  readonly unit: string | null
  readonly page: number | null
  readonly evidence: string | null
  readonly confidence: number
}

export type VerificationStatus =
  | 'verified'
  | 'no-evidence'
  | 'page-missing'
  | 'not-found'
  | 'null-value'

export interface VerifiedClaim extends ExtractedClaim {
  readonly status: VerificationStatus
  readonly verified: boolean
  /** Where in the page text the quote was found, for highlighting. */
  readonly matchIndex: number | null
  readonly explanation: string
}

/**
 * Normalize for comparison. PDF text extraction mangles whitespace, hyphenates
 * across line breaks, and substitutes unicode dashes and micro signs, so an
 * exact string compare would reject honest evidence.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/­/g, '') // soft hyphen
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/μ/g, 'µ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Minimum quote length that counts as evidence. */
const MIN_EVIDENCE_CHARS = 4

export function verifyClaim(claim: ExtractedClaim, pages: readonly PageText[]): VerifiedClaim {
  const base = { ...claim, matchIndex: null as number | null }

  // A null value is a legitimate, expected answer: the model looked and did not
  // find it. It needs no evidence and is not a failure.
  if (claim.value === null) {
    return {
      ...base,
      status: 'null-value',
      verified: false,
      explanation: 'Reported as not found. Stored as Unknown.',
    }
  }

  if (!claim.evidence || claim.evidence.trim().length < MIN_EVIDENCE_CHARS) {
    return {
      ...base,
      status: 'no-evidence',
      verified: false,
      explanation: 'No supporting quote was given, so the value cannot be confirmed.',
    }
  }

  const needle = normalizeForMatch(claim.evidence)

  if (claim.page === null) {
    // No page cited: accept a match anywhere, but say so.
    for (const p of pages) {
      const idx = normalizeForMatch(p.text).indexOf(needle)
      if (idx >= 0) {
        return {
          ...base,
          page: p.page,
          status: 'verified',
          verified: true,
          matchIndex: idx,
          explanation: `Quote found on page ${p.page}, though the extraction did not cite a page.`,
        }
      }
    }
    return {
      ...base,
      status: 'not-found',
      verified: false,
      explanation: 'The quote does not appear anywhere in the extracted text.',
    }
  }

  const page = pages.find((p) => p.page === claim.page)
  if (!page) {
    return {
      ...base,
      status: 'page-missing',
      verified: false,
      explanation: `Page ${claim.page} was cited but no text was extracted from it.`,
    }
  }

  const idx = normalizeForMatch(page.text).indexOf(needle)
  if (idx < 0) {
    // Give the benefit of the doubt to an adjacent page — tables straddle pages.
    for (const neighbour of pages.filter((p) => Math.abs(p.page - claim.page!) === 1)) {
      const nIdx = normalizeForMatch(neighbour.text).indexOf(needle)
      if (nIdx >= 0) {
        return {
          ...base,
          page: neighbour.page,
          status: 'verified',
          verified: true,
          matchIndex: nIdx,
          explanation: `Quote found on page ${neighbour.page}, adjacent to the cited page ${claim.page}.`,
        }
      }
    }
    return {
      ...base,
      status: 'not-found',
      verified: false,
      explanation: `The quote does not appear on page ${claim.page}.`,
    }
  }

  return {
    ...base,
    status: 'verified',
    verified: true,
    matchIndex: idx,
    explanation: `Quote confirmed on page ${claim.page}.`,
  }
}

export interface VerificationSummary {
  readonly claims: readonly VerifiedClaim[]
  readonly verified: number
  readonly rejected: number
  readonly reportedUnknown: number
}

export function verifyAll(
  claims: readonly ExtractedClaim[],
  pages: readonly PageText[],
): VerificationSummary {
  const out = claims.map((c) => verifyClaim(c, pages))
  return {
    claims: out,
    verified: out.filter((c) => c.verified).length,
    rejected: out.filter((c) => !c.verified && c.status !== 'null-value').length,
    reportedUnknown: out.filter((c) => c.status === 'null-value').length,
  }
}
