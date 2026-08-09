import { describe, it, expect } from 'vitest'
import {
  normalizeForMatch,
  verifyAll,
  verifyClaim,
  type ExtractedClaim,
  type PageText,
} from '../src/extraction/evidence.js'
import {
  ExtractionResultSchema,
  parseExtractionResult,
  resolvePackageVariant,
  type PackageVariant,
} from '../src/ai/provider.js'
import { ClaudeCliProvider, argvFlagsAreAllowed } from '../src/ai/claude-cli.js'

const PAGES: PageText[] = [
  { page: 12, text: 'ELECTRICAL CHARACTERISTICS\nVIN  Input voltage range  1.5  —  5.5  V' },
  { page: 13, text: 'IQ  Quiescent current, no load   25   nA\nDropout at 200 mA   105   mV' },
  { page: 43, text: 'MECHANICAL DATA\nD  Package width  0.615  0.640  0.665  mm' },
]

const claim = (over: Partial<ExtractedClaim>): ExtractedClaim => ({
  specKey: 'iq', value: 25, unit: 'nA', page: 13,
  evidence: 'IQ  Quiescent current, no load   25   nA', confidence: 0.9, ...over,
})

describe('evidence verification is a mechanism, not a promise', () => {
  it('confirms a quote that really is on the cited page', () => {
    const v = verifyClaim(claim({}), PAGES)
    expect(v.verified).toBe(true)
    expect(v.status).toBe('verified')
    expect(v.matchIndex).toBeGreaterThanOrEqual(0)
    expect(v.explanation).toMatch(/page 13/)
  })

  it('rejects a fabricated quote even at high confidence', () => {
    const v = verifyClaim(claim({ value: 5, evidence: 'IQ Quiescent current 5 nA', confidence: 0.99 }), PAGES)
    expect(v.verified).toBe(false)
    expect(v.status).toBe('not-found')
    expect(v.explanation).toMatch(/does not appear on page 13/)
  })

  it('rejects a value with no supporting quote', () => {
    expect(verifyClaim(claim({ evidence: null }), PAGES).status).toBe('no-evidence')
    expect(verifyClaim(claim({ evidence: '  ' }), PAGES).status).toBe('no-evidence')
  })

  it('rejects a citation to a page that produced no text', () => {
    expect(verifyClaim(claim({ page: 99 }), PAGES).status).toBe('page-missing')
  })

  it('treats a null value as a legitimate "not found", not a failure', () => {
    const v = verifyClaim(claim({ value: null, evidence: null }), PAGES)
    expect(v.status).toBe('null-value')
    expect(v.verified).toBe(false)
    expect(v.explanation).toMatch(/Unknown/)
  })

  it('survives the whitespace mangling PDF extraction produces', () => {
    const v = verifyClaim(claim({ evidence: 'IQ Quiescent current,   no load 25 nA' }), PAGES)
    expect(v.verified).toBe(true)
  })

  it('normalizes unicode dashes, quotes and micro signs', () => {
    expect(normalizeForMatch('1.5 — 5.5 µV')).toBe(normalizeForMatch('1.5 - 5.5 μV'))
    expect(normalizeForMatch('soft­hyphen')).toBe('softhyphen')
  })

  it('accepts a quote found one page away, since tables straddle pages', () => {
    const v = verifyClaim(claim({ page: 12, evidence: 'Dropout at 200 mA   105   mV' }), PAGES)
    expect(v.verified).toBe(true)
    expect(v.page).toBe(13)
    expect(v.explanation).toMatch(/adjacent/)
  })

  it('does not accept a quote two pages away', () => {
    const v = verifyClaim(claim({ page: 43, evidence: 'VIN  Input voltage range' }), PAGES)
    expect(v.verified).toBe(false)
  })

  it('summarises a mixed batch honestly', () => {
    const summary = verifyAll(
      [
        claim({}),
        claim({ specKey: 'dropout', page: 13, evidence: 'Dropout at 200 mA   105   mV' }),
        claim({ specKey: 'psrr', evidence: 'PSRR 60 dB at 1 kHz' }),
        claim({ specKey: 'vout_range', value: null, evidence: null }),
      ],
      PAGES,
    )
    expect(summary.verified).toBe(2)
    expect(summary.rejected).toBe(1)
    expect(summary.reportedUnknown).toBe(1)
  })
})

describe('model output is validated before it can reach the database', () => {
  const valid = {
    manufacturer: 'Texas Instruments',
    mpn: 'TPS7A0233PYCHR',
    productName: 'TPS7A02',
    categorySlug: 'tiny-ldo',
    categoryConfidence: 0.95,
    packageVariants: [],
    claims: [{ specKey: 'iq', value: 25, unit: 'nA', page: 13, evidence: 'x', confidence: 0.9 }],
    suggestedExternals: [],
  }

  it('accepts a well-formed result', () => {
    expect(() => parseExtractionResult(valid)).not.toThrow()
  })

  it('accepts null values, because "not found" is a real answer', () => {
    const withNull = { ...valid, claims: [{ ...valid.claims[0]!, value: null, unit: null, page: null, evidence: null }] }
    expect(() => parseExtractionResult(withNull)).not.toThrow()
  })

  it('rejects a confidence outside 0..1 rather than clamping it', () => {
    const bad = { ...valid, claims: [{ ...valid.claims[0]!, confidence: 1.4 }] }
    expect(() => parseExtractionResult(bad)).toThrow()
  })

  it('rejects a negative package dimension', () => {
    const bad = {
      ...valid,
      packageVariants: [{
        name: 'DSBGA', orderingCodeFragment: null, pinCount: 4,
        xMin: null, xNom: -1, xMax: null, yMin: null, yNom: null, yMax: null,
        zMin: null, zNom: null, zMax: null, page: null, evidence: null,
      }],
    }
    expect(() => parseExtractionResult(bad)).toThrow()
  })

  it('rejects a missing required field instead of defaulting it', () => {
    const { categoryConfidence: _drop, ...missing } = valid
    expect(() => ExtractionResultSchema.parse(missing)).toThrow()
  })
})

describe('exact package variant selection (rule 11)', () => {
  const variant = (name: string, frag: string | null, x: number): PackageVariant => ({
    name, orderingCodeFragment: frag, pinCount: null,
    xMin: null, xNom: x, xMax: null, yMin: null, yNom: x, yMax: null,
    zMin: null, zNom: null, zMax: null, page: null, evidence: null,
  })

  it('uses the single variant when a datasheet documents only one', () => {
    const r = resolvePackageVariant([variant('DSBGA-4', 'YCH', 0.64)], null)
    expect(r.mustAsk).toBe(false)
    expect(r.resolved!.name).toBe('DSBGA-4')
  })

  it('picks the variant the ordering code names', () => {
    const r = resolvePackageVariant(
      [variant('DSBGA-4', 'YCH', 0.64), variant('SOT-23-5', 'DBV', 2.9)],
      'TPS7A0233PYCHR',
    )
    expect(r.mustAsk).toBe(false)
    expect(r.resolved!.name).toBe('DSBGA-4')
  })

  it('asks rather than guessing when the MPN does not disambiguate', () => {
    const r = resolvePackageVariant(
      [variant('QFN-32', null, 5.0), variant('WLCSP-30', null, 2.5), variant('BGA-49', null, 3.5)],
      'NRF54L15',
    )
    expect(r.mustAsk).toBe(true)
    expect(r.resolved).toBeNull()
    expect(r.candidates).toHaveLength(3)
  })

  it('asks when the ordering code matches more than one variant', () => {
    const r = resolvePackageVariant(
      [variant('QFN-32', 'CA', 5.0), variant('WLCSP-30', 'CAA', 2.5)],
      'NRF54L15-CAAA-R',
    )
    expect(r.mustAsk).toBe(true)
    expect(r.candidates).toHaveLength(2)
  })
})

describe('Claude CLI provider safety (spec section 46)', () => {
  const provider = new ClaudeCliProvider({ binaryPath: '/home/user/.local/bin/claude', model: 'claude-opus-4-8' })

  it('builds an argv array with only allow-listed flags', () => {
    const argv = provider.buildArgv('/tmp/prompt-123.txt')
    expect(Array.isArray(argv)).toBe(true)
    expect(argvFlagsAreAllowed(argv)).toBe(true)
    expect(argv).toContain('--output-format')
  })

  it('never embeds a shell metacharacter from a path into a command string', () => {
    const argv = provider.buildArgv('/tmp/a b; rm -rf ~/.ssh/prompt.txt')
    // The nasty path is one argv element, not concatenated into a command line.
    expect(argv.filter((a) => a.includes('rm -rf'))).toHaveLength(1)
    expect(argvFlagsAreAllowed(argv)).toBe(true)
  })

  it('rejects a flag that is not on the allow-list', () => {
    expect(argvFlagsAreAllowed(['-p', 'x', '--dangerously-skip-permissions'])).toBe(false)
  })

  it('reports unavailability honestly instead of pretending to work', async () => {
    const status = await provider.status()
    expect(status.available).toBe(false)
    expect(status.reason).toBeTruthy()
    await expect(provider.extract({ pages: [], mpnHint: null, categories: [] })).rejects.toThrow()
  })

  it('says so clearly when the binary is missing', async () => {
    const missing = new ClaudeCliProvider({ binaryPath: '/nonexistent/claude' })
    const status = await missing.status()
    expect(status.reason).toMatch(/not found|not executable/i)
  })
})
