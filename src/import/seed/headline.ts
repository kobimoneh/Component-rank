/**
 * Parse the prose `headline` field from component-report's parts.json.
 *
 * Examples from the real data:
 *   "0.41 mm^2 (0.64x0.64 mm DSBGA)"
 *   "0.77 mm^2 (TSNP-6-2, 0.7 x 1.1 mm)"
 *   "1.40 x 1.48 mm WLCSP (2.07 mm^2)"
 *   "0.50 mm^2 (0402)"
 *   "0.99 mm^2 BAW"
 *   "0.175 mm pitch, 0.6 mm height, 32-pos"
 *
 * These strings were written by a language model summarising a search result. They
 * are a useful starting point and nothing more, so everything this function returns
 * is marked unverified by the caller.
 *
 * Hard rule: dimensions come only from an explicit `W x H mm` pair. A package code
 * is never used to infer a size. The real data contains "0.99 mm² (0403)", and the
 * imperial 0403 footprint is not 0.99 mm² — inferring from the code would
 * manufacture a wrong number in the one field this whole application is about.
 */

export interface ParsedHeadline {
  /** Only set when an explicit millimetre pair was present. */
  readonly xMm: number | null
  readonly yMm: number | null
  /** Area as stated in the text. Recorded for cross-checking, not as dimensions. */
  readonly statedAreaMm2: number | null
  /** Package name or code if one is recognisable. */
  readonly packageName: string | null
  /** Contact pitch, for connectors. */
  readonly pitchMm: number | null
  /** Stated height. */
  readonly heightMm: number | null
  /** True when the stated area disagrees with x*y by more than 5%. */
  readonly areaMismatch: boolean
}

const NUM = String.raw`\d+(?:\.\d+)?`

/** `0.64x0.64 mm`, `0.7 x 1.1 mm`, `4.87 × 2.87 mm` */
const DIM_PAIR = new RegExp(String.raw`(${NUM})\s*[x×X]\s*(${NUM})\s*mm`, 'i')

/** `0.41 mm^2`, `2.07 mm²`, `151 mm2` */
const AREA = new RegExp(String.raw`(${NUM})\s*mm\s*(?:\^?2|²)`, 'i')

const PITCH = new RegExp(String.raw`(${NUM})\s*mm\s*pitch`, 'i')
const HEIGHT = new RegExp(String.raw`(${NUM})\s*mm\s*(?:height|thick)`, 'i')

/**
 * A package designator: mostly uppercase letters, optionally with digits and
 * hyphens — DSBGA, WLCSP-4-P8, TSNP-6-2, FCSG325, 285-csfBGA, or a bare imperial
 * code like 0402.
 */
const PACKAGE_TOKENS = [
  /\b(\d{4})\b(?!\s*(?:mm|x|×))/, // imperial code: 0402, 0603
  /\b([A-Z][A-Za-z]*BGA(?:-[A-Za-z0-9]+)*)\b/,
  /\b(WLCSP(?:-[A-Za-z0-9]+)*)\b/i,
  /\b(WL?CSP(?:-[A-Za-z0-9]+)*)\b/i,
  /\b([A-Z]{2,}(?:-?\d+)*(?:-[A-Za-z0-9]+)*)\b/,
]

function num(m: RegExpMatchArray | null, i = 1): number | null {
  if (!m) return null
  const raw = m[i]
  if (raw === undefined) return null
  const v = Number(raw)
  return Number.isFinite(v) ? v : null
}

const NOT_A_PACKAGE = new Set([
  'MM', 'GHZ', 'MHZ', 'KHZ', 'MA', 'UA', 'NA', 'DBM', 'DB', 'MW', 'UW',
  'AND', 'THE', 'WITH', 'FOR', 'POS', 'PIN', 'BALL', 'BALLS', 'FULL',
  'COVERING', 'TYP', 'MAX', 'MIN',
])

function findPackage(text: string): string | null {
  // Prefer a token inside parentheses, which is where these strings put it.
  const paren = /\(([^)]*)\)/.exec(text)
  const haystacks = paren?.[1] ? [paren[1], text] : [text]
  for (const hay of haystacks) {
    for (const re of PACKAGE_TOKENS) {
      const m = re.exec(hay)
      const tok = m?.[1]
      if (!tok) continue
      if (NOT_A_PACKAGE.has(tok.toUpperCase())) continue
      if (/^\d+$/.test(tok) && tok.length !== 4) continue
      return tok
    }
  }
  return null
}

export function parseHeadline(headline: string | null | undefined): ParsedHeadline {
  const empty: ParsedHeadline = {
    xMm: null, yMm: null, statedAreaMm2: null,
    packageName: null, pitchMm: null, heightMm: null, areaMismatch: false,
  }
  if (!headline) return empty

  const text = headline.replace(/\u00A0/g, ' ').trim()

  const dims = DIM_PAIR.exec(text)
  const xMm = num(dims, 1)
  const yMm = num(dims, 2)
  const statedAreaMm2 = num(AREA.exec(text))
  const pitchMm = num(PITCH.exec(text))
  const heightMm = num(HEIGHT.exec(text))

  let areaMismatch = false
  if (xMm !== null && yMm !== null && statedAreaMm2 !== null) {
    const computed = xMm * yMm
    // The prose rounds heavily (0.64 x 0.64 = 0.4096 stated as 0.41), so allow 5%.
    areaMismatch = Math.abs(computed - statedAreaMm2) / statedAreaMm2 > 0.05
  }

  return {
    xMm, yMm, statedAreaMm2,
    packageName: findPackage(text),
    pitchMm, heightMm, areaMismatch,
  }
}
