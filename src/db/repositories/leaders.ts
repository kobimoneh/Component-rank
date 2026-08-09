import type { SqlDriver } from '../driver.js'
import { categoryColumns, listCategoryRows } from './components.js'

/**
 * "Who is best at what?"
 *
 * For every parameter in a category that has a defined direction, find the part
 * that leads on it. This is the question an engineer actually opens a category
 * to answer, and it is cheap to compute from rows already on screen.
 *
 * Only parameters with `better: lower | higher` produce a leader. A parameter
 * with no direction has no "best" — declaring one would assert a preference the
 * data does not support.
 */

export interface Leader {
  readonly key: string
  readonly label: string
  readonly unit: string | null
  readonly better: 'lower' | 'higher'
  readonly componentId: number
  readonly mpn: string
  readonly manufacturer: string
  readonly valueText: string
  readonly value: number
  /** True when more than one part shares the leading value. */
  readonly tied: boolean
  readonly tiedWith: number
  /** How many parts had a usable value for this parameter at all. */
  readonly contenders: number
  /** Parts excluded because their value is unverified. */
  readonly skippedUnverified: number
}

export interface LeaderBoard {
  readonly slug: string
  readonly leaders: readonly Leader[]
  /** Parameters that could have a leader but nobody has data for yet. */
  readonly noData: ReadonlyArray<{ key: string; label: string }>
}

export function categoryLeaders(db: SqlDriver, slug: string): LeaderBoard {
  const columns = categoryColumns(db, slug).filter((c) => c.numeric && c.better !== 'none')
  const rows = listCategoryRows(db, slug)

  const leaders: Leader[] = []
  const noData: Array<{ key: string; label: string }> = []

  for (const col of columns) {
    const better = col.better as 'lower' | 'higher'

    let skippedUnverified = 0
    const candidates = rows.flatMap((r) => {
      const cell = r.cells[col.key]
      if (!cell || cell.sort === null) return []
      // An unverified number does not get to win an argument.
      if (cell.unverified) {
        skippedUnverified++
        return []
      }
      return [{ row: r, value: cell.sort, text: cell.text ?? String(cell.sort) }]
    })

    if (candidates.length === 0) {
      noData.push({ key: col.key, label: col.label })
      continue
    }

    const bestValue = candidates.reduce(
      (acc, c) => (better === 'lower' ? Math.min(acc, c.value) : Math.max(acc, c.value)),
      candidates[0]!.value,
    )
    const winners = candidates.filter((c) => c.value === bestValue)
    // Deterministic pick among ties, so the strip does not flicker between reads.
    const winner = [...winners].sort((a, b) => a.row.mpn.localeCompare(b.row.mpn))[0]!

    leaders.push({
      key: col.key,
      label: col.label,
      unit: col.unit,
      better,
      componentId: winner.row.id,
      mpn: winner.row.mpn,
      manufacturer: winner.row.manufacturer,
      valueText: winner.text,
      value: bestValue,
      tied: winners.length > 1,
      tiedWith: winners.length - 1,
      contenders: candidates.length,
      skippedUnverified,
    })
  }

  return { slug, leaders, noData }
}
