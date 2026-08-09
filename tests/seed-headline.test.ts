import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHeadline } from '../src/import/seed/headline.js'

interface RawPart { mpn: string; manufacturer: string; headline: string; datasheet_url: string }
interface RawCategory { slug: string; parts?: RawPart[] }

const PARTS: RawCategory[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../resources/component-report/parts-2026-06.json', import.meta.url)), 'utf8'),
)

describe('headline dimension parsing', () => {
  it('reads an explicit millimetre pair', () => {
    const r = parseHeadline('0.41 mm^2 (0.64x0.64 mm DSBGA)')
    expect(r.xMm).toBe(0.64)
    expect(r.yMm).toBe(0.64)
    expect(r.statedAreaMm2).toBe(0.41)
    expect(r.packageName).toBe('DSBGA')
    expect(r.areaMismatch).toBe(false)
  })

  it('handles the package-first and dimension-first orderings', () => {
    expect(parseHeadline('0.77 mm^2 (TSNP-6-2, 0.7 x 1.1 mm)')).toMatchObject({ xMm: 0.7, yMm: 1.1 })
    expect(parseHeadline('1.40 x 1.48 mm WLCSP (2.07 mm^2)')).toMatchObject({ xMm: 1.4, yMm: 1.48 })
    expect(parseHeadline('13.98 mm^2 (4.87 x 2.87 mm WLBGA)')).toMatchObject({ xMm: 4.87, yMm: 2.87 })
  })

  it('NEVER infers dimensions from a package code', () => {
    // The real datum that proves the rule: the imperial 0403 footprint is not
    // 0.99 mm². Inferring a size from the code would fabricate a wrong number.
    const r = parseHeadline('0.99 mm^2 (0403)')
    expect(r.xMm).toBeNull()
    expect(r.yMm).toBeNull()
    expect(r.statedAreaMm2).toBe(0.99)
    expect(r.packageName).toBe('0403')

    const imperial = parseHeadline('0.50 mm^2 (0402)')
    expect(imperial.xMm).toBeNull()
    expect(imperial.packageName).toBe('0402')
  })

  it('returns nothing dimensional for prose with no numbers we trust', () => {
    const r = parseHeadline('0.99 mm^2 BAW')
    expect(r.xMm).toBeNull()
    expect(r.statedAreaMm2).toBe(0.99)
  })

  it('reads connector pitch and height', () => {
    const r = parseHeadline('0.175 mm pitch, 0.6 mm height, 32-pos')
    expect(r.pitchMm).toBe(0.175)
    expect(r.heightMm).toBe(0.6)
    expect(r.xMm).toBeNull()
  })

  it('flags a stated area that disagrees with the stated dimensions', () => {
    expect(parseHeadline('9.00 mm^2 (2.0 x 2.0 mm QFN)').areaMismatch).toBe(true)
    // Rounding in the prose is tolerated: 0.64 x 0.64 = 0.4096, stated as 0.41.
    expect(parseHeadline('0.41 mm^2 (0.64x0.64 mm)').areaMismatch).toBe(false)
  })

  it('is safe on empty and junk input', () => {
    for (const junk of ['', null, undefined, 'n/a', '???']) {
      const r = parseHeadline(junk as string)
      expect(r.xMm).toBeNull()
      expect(r.yMm).toBeNull()
    }
  })
})

describe('coverage over the real 2026-06 report', () => {
  const all = PARTS.flatMap((c) => c.parts ?? [])

  it('has 160 parts across all categories', () => {
    expect(all).toHaveLength(160)
    expect(all.every((p) => p.mpn && p.manufacturer)).toBe(true)
  })

  it('recovers explicit dimensions for most parts, and stays silent for the rest', () => {
    const parsed = all.map((p) => parseHeadline(p.headline))
    const withDims = parsed.filter((r) => r.xMm !== null && r.yMm !== null)
    const withArea = parsed.filter((r) => r.statedAreaMm2 !== null)

    // Enough to make the app immediately useful…
    expect(withDims.length).toBeGreaterThan(90)
    // …and the remainder genuinely lack a millimetre pair, so they stay Unknown
    // rather than being guessed from a package code.
    expect(withDims.length).toBeLessThan(all.length)
    expect(withArea.length).toBeGreaterThan(withDims.length)
  })

  it('never produces a zero or negative dimension', () => {
    for (const p of all) {
      const r = parseHeadline(p.headline)
      if (r.xMm !== null) expect(r.xMm).toBeGreaterThan(0)
      if (r.yMm !== null) expect(r.yMm).toBeGreaterThan(0)
    }
  })

  it('flags the few headlines whose stated area contradicts their dimensions', () => {
    const mismatches = all
      .map((p) => ({ mpn: p.mpn, headline: p.headline, r: parseHeadline(p.headline) }))
      .filter((x) => x.r.areaMismatch)
    // These must be surfaced for review rather than silently imported.
    expect(mismatches.length).toBeLessThan(20)
  })
})
