import type { JSX } from 'react'

/**
 * The mark, matching resources/icon.svg.
 *
 * It is the product in one glyph: a package footprint (solid die with pads)
 * inside the gross solution boundary (dashed, because it is an estimate).
 * Package size inside, board size outside — the distinction the whole
 * application exists to make.
 */
export function Logo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      role="img"
      aria-label="Component Library"
      style={{ flex: 'none', display: 'block' }}
    >
      <rect
        x="30" y="30" width="196" height="196" rx="16"
        fill="none" stroke="currentColor" strokeOpacity="0.5"
        strokeWidth="10" strokeDasharray="20 15" strokeLinecap="round"
      />
      <rect x="88" y="88" width="80" height="80" rx="12" fill="currentColor" />
      <g fill="currentColor">
        <rect x="99" y="60" width="12" height="20" rx="4" />
        <rect x="122" y="60" width="12" height="20" rx="4" />
        <rect x="145" y="60" width="12" height="20" rx="4" />
        <rect x="99" y="176" width="12" height="20" rx="4" />
        <rect x="122" y="176" width="12" height="20" rx="4" />
        <rect x="145" y="176" width="12" height="20" rx="4" />
        <rect x="60" y="99" width="20" height="12" rx="4" />
        <rect x="60" y="122" width="20" height="12" rx="4" />
        <rect x="60" y="145" width="20" height="12" rx="4" />
        <rect x="176" y="99" width="20" height="12" rx="4" />
        <rect x="176" y="122" width="20" height="12" rx="4" />
        <rect x="176" y="145" width="20" height="12" rx="4" />
      </g>
      {/* Pin-1 marker, as on a real package */}
      <circle cx="103" cy="103" r="7" fill="var(--bg-sunken, #0a0d12)" />
    </svg>
  )
}
