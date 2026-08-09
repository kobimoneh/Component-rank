import { describe, it, expect } from 'vitest'
import { rankComponents, evaluateRequirements, type RankableRow } from '../src/domain/ranking/rank.js'
import { toCanonical } from '../src/domain/units/index.js'
import type { RankingRequirement, RankingRule } from '../src/domain/categories/model.js'

const AREA_THEN_IQ: RankingRule[] = [
  { field: '@ic_area', direction: 'asc', missing: 'last' },
  { field: 'iq', direction: 'asc', missing: 'last' },
]

function row(id: number, area: number | null, iq: number | null, extra: Partial<RankableRow> = {}): RankableRow {
  return { id, numeric: { '@ic_area': area, iq }, ...extra }
}

describe('ordered ranking rules', () => {
  it('ranks by area, then by Iq on a tie', () => {
    const rows = [
      row(1, 0.41, 250e-9),
      row(2, 0.41, 25e-9),
      row(3, 0.49, 10e-6),
    ]
    const ranked = rankComponents(rows, AREA_THEN_IQ)
    expect(ranked.find((r) => r.id === 2)!.rank).toBe(1)
    expect(ranked.find((r) => r.id === 1)!.rank).toBe(2)
    expect(ranked.find((r) => r.id === 3)!.rank).toBe(3)
  })

  it('gives genuinely equal parts the same rank and skips the next', () => {
    const rows = [row(1, 1.0, 1e-6), row(2, 1.0, 1e-6), row(3, 2.0, 1e-6)]
    const ranked = rankComponents(rows, AREA_THEN_IQ)
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3])
  })

  it('honours descending rules', () => {
    const rules: RankingRule[] = [{ field: 'flash', direction: 'desc', missing: 'last' }]
    const rows: RankableRow[] = [
      { id: 1, numeric: { flash: 256 } },
      { id: 2, numeric: { flash: 1024 } },
    ]
    const ranked = rankComponents(rows, rules)
    expect(ranked.find((r) => r.id === 2)!.rank).toBe(1)
  })
})

describe('missing data never ranks first (rule 4)', () => {
  it('leaves a component with an unknown primary field unranked, not rank 1', () => {
    const rows = [row(1, null, 1e-9), row(2, 5.0, 1e-6)]
    const ranked = rankComponents(rows, AREA_THEN_IQ)
    const unknown = ranked.find((r) => r.id === 1)!
    expect(unknown.rank).toBeNull()
    expect(unknown.unrankedReason).toMatch(/unknown/i)
    // The part with a real, larger area still takes rank 1.
    expect(ranked.find((r) => r.id === 2)!.rank).toBe(1)
  })

  it('sorts a missing secondary field last without losing the rank', () => {
    const rows = [row(1, 1.0, null), row(2, 1.0, 5e-9)]
    const ranked = rankComponents(rows, AREA_THEN_IQ)
    expect(ranked.find((r) => r.id === 2)!.rank).toBe(1)
    expect(ranked.find((r) => r.id === 1)!.rank).toBe(2)
  })
})

describe('unverified values are excluded from ranking (rule 5)', () => {
  it('does not let unconfirmed seed dimensions win a category', () => {
    const rows = [
      // Imported from report prose; tiny, but unverified.
      row(1, 0.1, 1e-9, { unverifiedFields: ['@ic_area'] }),
      row(2, 5.0, 1e-6),
    ]
    const ranked = rankComponents(rows, AREA_THEN_IQ)
    const seeded = ranked.find((r) => r.id === 1)!
    expect(seeded.rank).toBeNull()
    expect(seeded.unrankedReason).toMatch(/unverified/i)
    expect(ranked.find((r) => r.id === 2)!.rank).toBe(1)
  })

  it('ranks the same part once its dimensions are confirmed', () => {
    const confirmed = [row(1, 0.1, 1e-9), row(2, 5.0, 1e-6)]
    const ranked = rankComponents(confirmed, AREA_THEN_IQ)
    expect(ranked.find((r) => r.id === 1)!.rank).toBe(1)
  })
})

describe('hard requirements exclude but do not hide (rf-lna-400mhz)', () => {
  const REQS: RankingRequirement[] = [
    { field: 'isupply', op: '<', value: 6, unit: 'mA', note: 'on current must be under 6 mA' },
    { field: 'band_coverage', op: 'covers', value: 400, unit: 'MHz', note: 'coverage must include ~400 MHz' },
  ]
  const conv = (v: number, u: string): number => toCanonical(v, u)

  const passing: RankableRow = {
    id: 1,
    numeric: { '@ic_area': 2.0, isupply: 4e-3 },
    ranges: { band_coverage: { min: 300e6, max: 500e6 } },
  }
  const tooHungry: RankableRow = {
    id: 2,
    numeric: { '@ic_area': 1.0, isupply: 9e-3 },
    ranges: { band_coverage: { min: 300e6, max: 500e6 } },
  }
  const wrongBand: RankableRow = {
    id: 3,
    numeric: { '@ic_area': 0.5, isupply: 2e-3 },
    ranges: { band_coverage: { min: 2.4e9, max: 2.5e9 } },
  }

  it('excludes the parts that miss a constraint even when they are smaller', () => {
    const ranked = rankComponents([passing, tooHungry, wrongBand], AREA_THEN_IQ, REQS, conv)
    expect(ranked.find((r) => r.id === 1)!.rank).toBe(1)
    expect(ranked.find((r) => r.id === 2)!.rank).toBeNull()
    expect(ranked.find((r) => r.id === 3)!.rank).toBeNull()
  })

  it('says which requirement was missed instead of hiding the row', () => {
    const ranked = rankComponents([passing, tooHungry, wrongBand], AREA_THEN_IQ, REQS, conv)
    expect(ranked).toHaveLength(3) // every input row still comes back
    expect(ranked.find((r) => r.id === 2)!.failedRequirements).toEqual(['on current must be under 6 mA'])
    expect(ranked.find((r) => r.id === 3)!.failedRequirements).toEqual(['coverage must include ~400 MHz'])
  })

  it('compares the requirement in canonical units, not the stated ones', () => {
    // 4 mA passes "< 6 mA"; the raw numbers 0.004 and 6 would not.
    const failed = evaluateRequirements(passing, REQS, conv)
    expect(failed).toEqual([])
  })

  it('treats unproven coverage as not meeting a hard requirement', () => {
    const unknown: RankableRow = { id: 4, numeric: { '@ic_area': 0.2, isupply: 1e-3 } }
    const ranked = rankComponents([passing, unknown], AREA_THEN_IQ, REQS, conv)
    expect(ranked.find((r) => r.id === 4)!.rank).toBeNull()
  })
})

describe('categories with no resolvable ranking', () => {
  it('returns no ranks and explains why, rather than inventing an order', () => {
    const ranked = rankComponents([row(1, 1, 1), row(2, 2, 2)], [])
    expect(ranked.every((r) => r.rank === null)).toBe(true)
    expect(ranked[0]!.unrankedReason).toMatch(/no ranking rules/i)
  })
})

describe('determinism', () => {
  it('is stable for equal rows regardless of input order', () => {
    const a = [row(3, 1, 1), row(1, 1, 1), row(2, 1, 1)]
    const first = rankComponents(a, AREA_THEN_IQ)
    const second = rankComponents([...a].reverse(), AREA_THEN_IQ)
    const byId = (rs: typeof first): number[] => [...rs].sort((x, y) => x.id - y.id).map((r) => r.rank!)
    expect(byId(first)).toEqual(byId(second))
  })
})
