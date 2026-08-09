import { describe, it, expect } from 'vitest'
import {
  axis,
  footprint,
  formatArea,
  formatDimensions,
  icArea,
  nominalPackage,
  type PackageDimensions,
} from '../src/domain/physical/package.js'
import {
  computeSolutionSize,
  estimateRectangle,
  externalArea,
} from '../src/domain/gross-size/estimate.js'
import {
  DEFAULT_ESTIMATOR_SETTINGS,
  type ExternalPart,
  type SolutionProfile,
} from '../src/domain/gross-size/model.js'

function ext(over: Partial<ExternalPart> & { name: string }): ExternalPart {
  return {
    id: over.name,
    function: '',
    qty: 1,
    necessity: 'required',
    valueText: null,
    packageName: null,
    xMm: null,
    yMm: null,
    zMm: null,
    included: true,
    notes: null,
    sourceRef: null,
    ...over,
  }
}

function profile(externals: ExternalPart[], override: SolutionProfile['override'] = null): SolutionProfile {
  return { id: 'p', name: 'Recommended', isDefault: true, notes: null, externals, override }
}

// 0402 imperial = 1.0 × 0.5 mm; 0603 = 1.6 × 0.8 mm.
const C0402 = { xMm: 1.0, yMm: 0.5 }
const C0603 = { xMm: 1.6, yMm: 0.8 }

describe('maximum dimensions win over nominal (rule 6)', () => {
  it('uses the max pair, not the nominal pair, when both are specified', () => {
    const pkg: PackageDimensions = {
      x: axis(2.4, 2.5, 2.6),
      y: axis(1.9, 2.0, 2.1),
      z: axis(null, 0.8, 0.85),
    }
    const fp = footprint(pkg)!
    expect(fp.x.value).toBe(2.6)
    expect(fp.y.value).toBe(2.1)
    expect(fp.basis).toBe('max')
    // The nominal pair would give 5.00 mm². Silently using it understates by 9%.
    expect(icArea(pkg)).toBeCloseTo(5.46, 10)
    expect(formatArea(icArea(pkg))).toBe('5.46 mm²')
  })

  it('falls back to nominal only when no maximum exists, and says so', () => {
    const pkg = nominalPackage(2.5, 2.0, 0.8)
    const fp = footprint(pkg)!
    expect(fp.basis).toBe('nominal')
    expect(icArea(pkg)).toBeCloseTo(5.0, 10)
    expect(formatDimensions(pkg, { withBasis: true })).toBe('2.50 × 2.00 × 0.80 mm (nominal)')
  })

  it('reports a mixed basis rather than implying uniform precision', () => {
    const pkg: PackageDimensions = {
      x: axis(null, 2.5, 2.6),
      y: axis(null, 2.0, null),
      z: axis(null, null, null),
    }
    expect(footprint(pkg)!.basis).toBe('mixed')
  })

  it('an unknown axis leaves the area unknown instead of ranking the part smallest', () => {
    const pkg: PackageDimensions = { x: axis(null, 2.5, null), y: axis(null, null, null), z: axis(null, null, null) }
    expect(footprint(pkg)).toBeNull()
    expect(icArea(pkg)).toBeNull()
    expect(formatDimensions(pkg)).toBe('Unknown')
  })
})

describe('IC area and gross solution size stay distinct (rules 7 and 8)', () => {
  const ic = nominalPackage(3.0, 3.0, 0.9)

  it('gross component area exceeds IC area once an external is included', () => {
    const p = profile([
      ext({ name: 'CIN 10 µF', ...C0603 }),
      ext({ name: 'COUT 10 µF', ...C0603 }),
    ])
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    expect(s.icAreaMm2).toBeCloseTo(9.0, 10)
    expect(s.externalAreaMm2).toBeCloseTo(2 * 1.28, 10)
    expect(s.grossComponentAreaMm2).toBeCloseTo(9.0 + 2.56, 10)
    expect(s.grossComponentAreaMm2!).toBeGreaterThan(s.icAreaMm2!)
  })

  it('the estimated rectangle is larger than the raw sum of part areas', () => {
    const p = profile([ext({ name: 'CIN', ...C0603 }), ext({ name: 'COUT', ...C0603 })])
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    // Courtyards and routing allowance mean D must exceed C; a D <= C would mean
    // the estimator was quietly reporting component area as board area.
    expect(s.estimate!.areaMm2).toBeGreaterThan(s.grossComponentAreaMm2!)
  })

  it('exposes the four measurements as separate fields', () => {
    const s = computeSolutionSize({ icPackage: ic, profile: profile([ext({ name: 'C', ...C0402 })]) })
    expect(Object.keys(s)).toEqual(
      expect.arrayContaining(['icAreaMm2', 'externalAreaMm2', 'grossComponentAreaMm2', 'estimate', 'effective']),
    )
    expect(s.icAreaMm2).not.toBe(s.estimate!.areaMm2)
  })
})

describe('externals drive the calculation', () => {
  const ic = nominalPackage(2.0, 2.0)

  it('excluding an external removes its contribution and restores it on re-include', () => {
    const included = profile([ext({ name: 'L1', xMm: 2.0, yMm: 1.6 }), ext({ name: 'C1', ...C0402 })])
    const withBoth = computeSolutionSize({ icPackage: ic, profile: included })

    const excluded = profile([
      ext({ name: 'L1', xMm: 2.0, yMm: 1.6, included: false }),
      ext({ name: 'C1', ...C0402 }),
    ])
    const withOne = computeSolutionSize({ icPackage: ic, profile: excluded })

    expect(withOne.externalAreaMm2).toBeCloseTo(0.5, 10)
    expect(withBoth.externalAreaMm2).toBeCloseTo(3.7, 10)
    expect(withOne.estimate!.areaMm2).toBeLessThan(withBoth.estimate!.areaMm2)

    const reIncluded = computeSolutionSize({ icPackage: ic, profile: included })
    expect(reIncluded.estimate!.areaMm2).toBeCloseTo(withBoth.estimate!.areaMm2, 12)
  })

  it('multiplies by quantity', () => {
    const one = externalArea([ext({ name: 'C', ...C0402, qty: 1 })])
    const four = externalArea([ext({ name: 'C', ...C0402, qty: 4 })])
    expect(four).toBeCloseTo(one! * 4, 10)
  })

  it('names included externals it could not count instead of silently dropping them', () => {
    const p = profile([ext({ name: '32 MHz crystal' }), ext({ name: 'C1', ...C0402 })])
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    expect(s.estimate!.undimensionedParts).toEqual(['32 MHz crystal'])
    expect(s.warnings.join(' ')).toMatch(/32 MHz crystal/)
  })

  it('returns null external area when nothing countable is included', () => {
    expect(externalArea([])).toBeNull()
    expect(externalArea([ext({ name: 'X', included: false, ...C0402 })])).toBeNull()
  })
})

describe('manual override always wins (rule 9)', () => {
  const ic = nominalPackage(3.0, 3.0)
  const externals = [ext({ name: 'C1', ...C0603 }), ext({ name: 'L1', xMm: 2.0, yMm: 1.6 })]

  it('reports the manual figure and marks its origin', () => {
    const p = profile(externals, { widthMm: 5.2, heightMm: 4.4, areaMm2: null, note: 'measured on rev B' })
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    expect(s.effective!.origin).toBe('manual')
    expect(s.effective!.widthMm).toBe(5.2)
    expect(s.effective!.heightMm).toBe(4.4)
    expect(s.effective!.areaMm2).toBeCloseTo(22.88, 9)
  })

  it('still computes the estimate alongside, without overwriting the manual value', () => {
    const p = profile(externals, { widthMm: 5.2, heightMm: 4.4, areaMm2: null, note: null })
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    expect(s.estimate).not.toBeNull()
    expect(s.estimate!.areaMm2).not.toBeCloseTo(22.88, 6)
    expect(s.effective!.origin).toBe('manual')
    expect(s.effective!.areaMm2).toBeCloseTo(22.88, 9)
  })

  it('recomputing repeatedly never drifts away from the manual value', () => {
    const p = profile(externals, { widthMm: 5.2, heightMm: 4.4, areaMm2: null, note: null })
    let last = computeSolutionSize({ icPackage: ic, profile: p })
    for (let i = 0; i < 5; i++) {
      const next = computeSolutionSize({ icPackage: ic, profile: p })
      expect(next.effective).toEqual(last.effective)
      last = next
    }
  })

  it('falls back to the estimate when the override is cleared', () => {
    const s = computeSolutionSize({ icPackage: ic, profile: profile(externals, null) })
    expect(s.effective!.origin).toBe('estimated')
  })

  it('an area-only override is honoured without inventing width and height', () => {
    const p = profile(externals, { widthMm: null, heightMm: null, areaMm2: 30, note: null })
    const s = computeSolutionSize({ icPackage: ic, profile: p })
    expect(s.effective).toEqual({ widthMm: null, heightMm: null, areaMm2: 30, origin: 'manual' })
  })
})

describe('the estimator is deterministic and explains itself', () => {
  const ic = nominalPackage(3.0, 3.0)
  const externals = [
    ext({ name: 'C1', ...C0402 }),
    ext({ name: 'C2', ...C0402 }),
    ext({ name: 'L1', xMm: 2.0, yMm: 1.6 }),
  ]

  it('gives the same answer every time', () => {
    const input = { icPackage: ic, profile: profile(externals) }
    const first = estimateRectangle(input)!
    for (let i = 0; i < 10; i++) {
      expect(estimateRectangle(input)).toEqual(first)
    }
  })

  it('does not depend on the order the externals were entered', () => {
    const a = estimateRectangle({ icPackage: ic, profile: profile(externals) })!
    const b = estimateRectangle({ icPackage: ic, profile: profile([...externals].reverse()) })!
    expect(b.areaMm2).toBeCloseTo(a.areaMm2, 12)
  })

  it('carries the assumptions that produced it', () => {
    const e = estimateRectangle({ icPackage: ic, profile: profile(externals) })!
    expect(e.settings).toEqual(DEFAULT_ESTIMATOR_SETTINGS)
    expect(e.partCount).toBe(4)
  })

  it('a bigger courtyard produces a bigger board', () => {
    const tight = estimateRectangle({
      icPackage: ic,
      profile: profile(externals),
      settings: { ...DEFAULT_ESTIMATOR_SETTINGS, courtyardMarginMm: 0.1 },
    })!
    const loose = estimateRectangle({
      icPackage: ic,
      profile: profile(externals),
      settings: { ...DEFAULT_ESTIMATOR_SETTINGS, courtyardMarginMm: 0.5 },
    })!
    expect(loose.areaMm2).toBeGreaterThan(tight.areaMm2)
  })

  it('returns null when there is nothing to place', () => {
    expect(estimateRectangle({ icPackage: null, profile: profile([]) })).toBeNull()
    const s = computeSolutionSize({ icPackage: null, profile: profile([]) })
    expect(s.effective).toBeNull()
    expect(s.grossComponentAreaMm2).toBeNull()
  })

  it('an LDO with only CIN and COUT stays small', () => {
    // TPS7A02-class: 0.64 × 0.64 mm DSBGA plus two 0402 caps.
    const ldo = computeSolutionSize({
      icPackage: nominalPackage(0.64, 0.64),
      profile: profile([ext({ name: 'CIN', ...C0402 }), ext({ name: 'COUT', ...C0402 })]),
    })
    expect(ldo.icAreaMm2).toBeCloseTo(0.4096, 6)
    expect(ldo.grossComponentAreaMm2).toBeCloseTo(0.4096 + 1.0, 6)
    // The board area is several times the die footprint — the point of the feature.
    expect(ldo.estimate!.areaMm2).toBeGreaterThan(ldo.icAreaMm2! * 3)
  })
})
