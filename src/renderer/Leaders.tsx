import type { JSX } from 'react'
import type { LeaderBoardDto } from '../shared/ipc.js'

interface Props {
  readonly board: LeaderBoardDto | null
  readonly onOpen: (componentId: number) => void
  readonly onMenu?: (e: React.MouseEvent, leader: LeaderBoardDto['leaders'][number]) => void
}

/**
 * "Who is best at what."
 *
 * One tile per parameter that has a direction, naming the part that leads on it.
 * This is also the accessible counterpart to the table's best/worst tinting:
 * the same information stated in plain text, so identity is never colour-alone.
 *
 * A parameter with no direction gets no tile — declaring a "best" switching
 * frequency would assert a preference the data does not support.
 */
export function Leaders({ board, onOpen, onMenu }: Props): JSX.Element | null {
  if (!board) return null

  if (board.leaders.length === 0) {
    return (
      <div className="leaders-empty">
        No leaders yet — no part in this category has a confirmed value for any ranked
        parameter. Confirm a part&apos;s dimensions, or enter a specification, and it appears here.
      </div>
    )
  }

  return (
    <div className="leaders" role="list" aria-label="Best part per parameter">
      {board.leaders.map((l) => (
        <button
          key={l.key}
          className="leader"
          role="listitem"
          onClick={() => onOpen(l.componentId)}
          onContextMenu={(e) => onMenu?.(e, l)}
          title={
            `${l.mpn} — ${l.manufacturer}\n` +
            `Best of ${l.contenders} part${l.contenders === 1 ? '' : 's'} with a value` +
            (l.skippedUnverified > 0
              ? `\n${l.skippedUnverified} excluded as unverified`
              : '') +
            (l.tied ? `\nTied with ${l.tiedWith} other${l.tiedWith === 1 ? '' : 's'}` : '')
          }
        >
          <div className="leader-label">
            <span className="leader-dir">{l.better === 'lower' ? '↓' : '↑'}</span>
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {l.better === 'lower' ? 'Lowest' : 'Highest'} {l.label}
            </span>
          </div>
          <div className="leader-mpn">{l.mpn}</div>
          <div className="leader-value">
            {l.valueText}
            {l.unit && !l.valueText.includes(l.unit) ? ` ${l.unit}` : ''}
            {l.tied && <span className="leader-tied"> · tied</span>}
          </div>
        </button>
      ))}
    </div>
  )
}
