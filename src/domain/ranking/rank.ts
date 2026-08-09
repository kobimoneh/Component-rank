import type { RankingRequirement, RankingRule } from '../categories/model.js'

/**
 * Ranking.
 *
 * Two rules shape everything here:
 *
 *  - A component missing the ranking field is not a component with a value of zero.
 *    It ranks last (or is excluded), never first.
 *  - A component failing a hard requirement is excluded from the ranking but stays
 *    visible, carrying the name of the requirement it missed. Rows that silently
 *    vanish are how a table loses your trust.
 */

export interface RankableRow {
  readonly id: number
  /** Canonical numeric values by field ref (spec key or `@virtual`). */
  readonly numeric: Readonly<Record<string, number | null>>
  /** Canonical range bounds by field ref, for `covers` requirements. */
  readonly ranges?: Readonly<Record<string, { min: number | null; max: number | null }>>
  readonly bools?: Readonly<Record<string, boolean | null>>
  /**
   * Fields whose value exists but has not been verified. Excluded from ranking so
   * unconfirmed seed data cannot win a category.
   */
  readonly unverifiedFields?: readonly string[]
}

export interface RankedRow {
  readonly id: number
  /** 1-based rank, or null when the row takes no rank. */
  readonly rank: number | null
  readonly failedRequirements: readonly string[]
  /** Why the row has no rank, for the UI tooltip. */
  readonly unrankedReason: string | null
}

function valueFor(row: RankableRow, field: string): number | null {
  if (row.unverifiedFields?.includes(field)) return null
  const direct = row.numeric[field]
  if (direct !== undefined && direct !== null) return direct
  const range = row.ranges?.[field]
  if (range) return range.max ?? range.min ?? null
  const b = row.bools?.[field]
  if (b !== undefined && b !== null) return b ? 1 : 0
  return null
}

export function evaluateRequirements(
  row: RankableRow,
  requirements: readonly RankingRequirement[],
  /** Converts a requirement's stated value+unit into canonical units. */
  toCanonical: (value: number, unit: string) => number,
): string[] {
  const failed: string[] = []
  for (const req of requirements) {
    const target = req.unit ? toCanonical(req.value, req.unit) : req.value

    if (req.op === 'covers') {
      const range = row.ranges?.[req.field]
      const lo = range?.min ?? null
      const hi = range?.max ?? null
      // Unknown coverage is not a pass. It is also not a definitive fail — but a
      // hard requirement means "prove it", so an unproven row does not rank.
      if (lo === null || hi === null || target < lo || target > hi) failed.push(req.note)
      continue
    }

    const v = valueFor(row, req.field)
    if (v === null) {
      failed.push(req.note)
      continue
    }
    const ok =
      req.op === '<' ? v < target
      : req.op === '<=' ? v <= target
      : req.op === '>' ? v > target
      : req.op === '>=' ? v >= target
      : v === target
    if (!ok) failed.push(req.note)
  }
  return failed
}

/**
 * Rank rows by ordered rules.
 *
 * Ties share a rank and the next rank skips accordingly (1, 2, 2, 4), which is what
 * an engineer expects when two parts are genuinely the same size.
 */
export function rankComponents(
  rows: readonly RankableRow[],
  rules: readonly RankingRule[],
  requirements: readonly RankingRequirement[] = [],
  toCanonical: (value: number, unit: string) => number = (v) => v,
): RankedRow[] {
  const evaluated = rows.map((row) => ({
    row,
    failed: evaluateRequirements(row, requirements, toCanonical),
  }))

  if (rules.length === 0) {
    return evaluated.map((e) => ({
      id: e.row.id,
      rank: null,
      failedRequirements: e.failed,
      unrankedReason: 'This category has no ranking rules yet.',
    }))
  }

  const primary = rules[0]!
  const eligible: typeof evaluated = []
  const out = new Map<number, RankedRow>()

  for (const e of evaluated) {
    if (e.failed.length > 0) {
      out.set(e.row.id, {
        id: e.row.id,
        rank: null,
        failedRequirements: e.failed,
        unrankedReason: `Does not meet: ${e.failed.join('; ')}`,
      })
      continue
    }
    const primaryValue = valueFor(e.row, primary.field)
    if (primaryValue === null) {
      const unverified = e.row.unverifiedFields?.includes(primary.field)
      out.set(e.row.id, {
        id: e.row.id,
        rank: null,
        failedRequirements: [],
        unrankedReason: unverified
          ? `${primary.field} is unverified, so this part is not ranked.`
          : `${primary.field} is unknown.`,
      })
      if (primary.missing === 'exclude') continue
      continue
    }
    eligible.push(e)
  }

  const cmp = (a: RankableRow, b: RankableRow): number => {
    for (const rule of rules) {
      const av = valueFor(a, rule.field)
      const bv = valueFor(b, rule.field)
      if (av === null && bv === null) continue
      if (av === null) return 1
      if (bv === null) return -1
      if (av !== bv) return rule.direction === 'asc' ? av - bv : bv - av
    }
    return 0
  }

  const sorted = [...eligible].sort((x, y) => cmp(x.row, y.row) || x.row.id - y.row.id)

  let rank = 0
  let seen = 0
  let previous: RankableRow | null = null
  for (const e of sorted) {
    seen++
    if (previous === null || cmp(previous, e.row) !== 0) rank = seen
    out.set(e.row.id, { id: e.row.id, rank, failedRequirements: [], unrankedReason: null })
    previous = e.row
  }

  return rows.map(
    (r) =>
      out.get(r.id) ?? { id: r.id, rank: null, failedRequirements: [], unrankedReason: 'Not ranked.' },
  )
}
