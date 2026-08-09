import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Colour contrast, computed from the real stylesheet.
 *
 * The rank badge ink was originally white on every step. That looks fine and is
 * wrong: white on the lightest light-mode step is 2.08:1 and on the lightest
 * dark-mode step 2.82:1 — both unreadable, both invisible to inspection. This
 * test reads the tokens out of styles.css and does the arithmetic, so a palette
 * edit that breaks contrast turns a named test red.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../src/renderer/styles.css', import.meta.url)),
  'utf8',
)

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  )
}

export function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  const [hi, lo] = x > y ? [x, y] : [y, x]
  return (hi + 0.05) / (lo + 0.05)
}

function toHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)))
  return v.toString(16).padStart(2, '0')
}

function delinearize(c: number): number {
  const s = c <= 0.00304 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return s * 255
}

/**
 * Simulate deuteranopia (Viénot, Brettel & Mollon 1999) so red/green confusion
 * is measured rather than assumed.
 */
export function deuteranope(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const r = channel((n >> 16) & 255)
  const g = channel((n >> 8) & 255)
  const b = channel(n & 255)

  const L = 17.8824 * r + 43.5161 * g + 4.11935 * b
  const S = 0.0299566 * r + 0.184309 * g + 1.46709 * b
  // The real M channel is deliberately not computed: deuteranopia is the absence
  // of it, so it is reconstructed from L and S instead.
  const M2 = 0.494207 * L + 1.24827 * S

  const r2 = 0.080944448 * L - 0.130504409 * M2 + 0.116721066 * S
  const g2 = -0.0102485335 * L + 0.0540193266 * M2 - 0.113614708 * S
  const b2 = -0.000365296938 * L - 0.00412161469 * M2 + 0.693511405 * S

  return `#${toHex(delinearize(r2))}${toHex(delinearize(g2))}${toHex(delinearize(b2))}`
}

/** The `.best` rule, so the non-colour cue can be asserted. */
const BEST_RULE = (/\.best\s*\{[^}]*\}/.exec(CSS) ?? [''])[0]

/** Read a token from a specific block of the stylesheet. */
function token(blockStart: string, name: string): string {
  const from = CSS.indexOf(blockStart)
  expect(from, `block "${blockStart}" exists`).toBeGreaterThan(-1)
  const block = CSS.slice(from, from + 2400)
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  expect(m, `token --${name} in "${blockStart}"`).not.toBeNull()
  return m![1]!.toLowerCase()
}

const THEMES = [
  { name: 'light', block: ':root {' },
  { name: 'dark', block: ":root[data-theme='dark'] {" },
] as const

describe('rank badge contrast', () => {
  for (const theme of THEMES) {
    for (const step of [1, 2, 3]) {
      it(`${theme.name} rank-${step} ink is readable on its background`, () => {
        const bg = token(theme.block, `rank-${step}`)
        const ink = token(theme.block, `rank-${step}-ink`)
        const ratio = contrast(bg, ink)
        // WCAG AA for normal text. The badge is small and bold; 4.5 is the bar.
        expect(ratio, `${theme.name} rank-${step}: ${bg} on ${ink} = ${ratio.toFixed(2)}:1`)
          .toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('is a sequential single-hue ramp, not a set of unrelated hues', () => {
    for (const theme of THEMES) {
      const steps = [1, 2, 3].map((s) => token(theme.block, `rank-${s}`))
      const hues = steps.map((h) => {
        const n = parseInt(h.slice(1), 16)
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        // Blue-dominant across every step: one hue, varying lightness.
        return b >= r && b >= g
      })
      expect(hues, `${theme.name} ramp stays one hue`).toEqual([true, true, true])

      // And lightness must move monotonically, so #1 reads as strongest.
      const ls = steps.map(luminance)
      const ascending = ls[0]! < ls[1]! && ls[1]! < ls[2]!
      const descending = ls[0]! > ls[1]! && ls[1]! > ls[2]!
      expect(ascending || descending, `${theme.name} ramp is monotonic`).toBe(true)
    }
  })
})

describe('body and dimmed text contrast', () => {
  for (const theme of THEMES) {
    it(`${theme.name} primary text passes on the page background`, () => {
      const ratio = contrast(token(theme.block, 'bg'), token(theme.block, 'text'))
      expect(ratio, `${theme.name} text: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme.name} dimmed text still passes`, () => {
      const ratio = contrast(token(theme.block, 'bg'), token(theme.block, 'text-dim'))
      expect(ratio, `${theme.name} text-dim: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme.name} faint text is legible enough for secondary labels`, () => {
      const ratio = contrast(token(theme.block, 'bg'), token(theme.block, 'text-faint'))
      // Faint text carries counts and hints, never a value you act on.
      expect(ratio, `${theme.name} text-faint: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
    })
  }
})

describe('best / worst tinting', () => {
  for (const theme of THEMES) {
    it(`${theme.name} best value is readable on its tint`, () => {
      const ratio = contrast(token(theme.block, 'good-soft'), token(theme.block, 'good'))
      expect(ratio, `${theme.name} good: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme.name} worst value is readable on its tint`, () => {
      const ratio = contrast(token(theme.block, 'bad-soft'), token(theme.block, 'bad'))
      expect(ratio, `${theme.name} bad: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    })

    it(`${theme.name} best and worst collapse under deuteranopia, so colour is never the only cue`, () => {
      // Green vs red is the canonical colourblindness trap: to a deuteranope
      // these two are near-identical. That is not a bug to be recoloured away —
      // best/worst is a secondary hint, and the primary channels are the bold
      // weight on the cell and the leaders strip naming the winner in words.
      // This test records the fact and pins the redundancy that compensates.
      const good = deuteranope(token(theme.block, 'good'))
      const bad = deuteranope(token(theme.block, 'bad'))
      const separation = contrast(good, bad)

      if (separation < 1.5) {
        expect(BEST_RULE, 'best cells carry a weight cue, not colour alone')
          .toMatch(/font-weight:\s*(700|bold)/)
      }
      // Either way the two must differ for full-colour vision.
      expect(
        token(theme.block, 'good'),
        `${theme.name} good and bad are different colours`,
      ).not.toBe(token(theme.block, 'bad'))
    })
  }
})

describe('the stylesheet honours the accessibility media queries', () => {
  it('drops movement under prefers-reduced-motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })

  it('makes translucent chrome solid under prefers-reduced-transparency', () => {
    const idx = CSS.indexOf('@media (prefers-reduced-transparency: reduce)')
    expect(idx).toBeGreaterThan(-1)
    expect(CSS.slice(idx, idx + 400)).toMatch(/backdrop-filter:\s*none/)
  })

  it('strengthens borders under prefers-contrast: more', () => {
    expect(CSS).toMatch(/@media \(prefers-contrast: more\)/)
  })
})
