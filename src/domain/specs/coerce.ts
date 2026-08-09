import type { SpecDefinition } from '../categories/model.js'
import { parseQuantity } from '../units/parse.js'

/**
 * Turn what the user typed into typed, canonical spec columns.
 *
 * Refuses rather than guessing: text that does not parse for the definition's
 * type comes back as an error the form shows, never as a coerced number. An
 * empty input is a legitimate answer meaning "unknown", and clears the value.
 */

export interface SpecValueColumns {
  readonly kind: SpecDefinition['type']
  readonly numMin: number | null
  readonly numTyp: number | null
  readonly numMax: number | null
  readonly canonicalUnit: string | null
  readonly displayUnit: string | null
  readonly boolVal: number | null
  readonly textVal: string | null
  readonly enumVal: string | null
}

export type CoerceResult =
  | { readonly ok: true; readonly columns: SpecValueColumns; readonly cleared: boolean }
  | { readonly ok: false; readonly error: string }

const EMPTY: Omit<SpecValueColumns, 'kind'> = {
  numMin: null, numTyp: null, numMax: null,
  canonicalUnit: null, displayUnit: null,
  boolVal: null, textVal: null, enumVal: null,
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'supported', 'present'])
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'none', 'not supported', 'absent'])

export function coerceSpecInput(def: SpecDefinition, raw: string): CoerceResult {
  const text = raw.trim()
  if (text === '') {
    return { ok: true, columns: { kind: def.type, ...EMPTY }, cleared: true }
  }

  switch (def.type) {
    case 'scalar':
    case 'range': {
      const q = parseQuantity(text, def.dimension ? { preferred: def.dimension } : {})
      if (!q) {
        const hint = def.unit ? ` Try something like "12 ${def.unit}"` : ''
        return {
          ok: false,
          error: `"${text}" is not a value for ${def.name}.${hint}${def.type === 'range' ? ' Ranges look like "1.5–5.5 V".' : ''}`,
        }
      }
      return {
        ok: true,
        cleared: false,
        columns: {
          kind: def.type,
          numMin: q.min,
          numTyp: q.typ,
          numMax: q.max,
          canonicalUnit: def.dimension ?? null,
          displayUnit: q.displayUnit || (def.unit ?? null),
          boolVal: null, textVal: null, enumVal: null,
        },
      }
    }

    case 'number': {
      const n = Number(text.replace(/[,\s]/g, ''))
      if (!Number.isFinite(n)) {
        return { ok: false, error: `"${text}" is not a number for ${def.name}.` }
      }
      return {
        ok: true,
        cleared: false,
        columns: { kind: 'number', ...EMPTY, numTyp: n, displayUnit: def.unitLabel ?? null },
      }
    }

    case 'bool': {
      const lowered = text.toLowerCase()
      if (TRUE_WORDS.has(lowered)) {
        return { ok: true, cleared: false, columns: { kind: 'bool', ...EMPTY, boolVal: 1 } }
      }
      if (FALSE_WORDS.has(lowered)) {
        return { ok: true, cleared: false, columns: { kind: 'bool', ...EMPTY, boolVal: 0 } }
      }
      return { ok: false, error: `${def.name} is yes or no, not "${text}".` }
    }

    case 'enum': {
      const allowed = def.enumValues ?? []
      const hit = allowed.find((v) => v.toLowerCase() === text.toLowerCase())
      if (!hit) {
        return {
          ok: false,
          error: `${def.name} must be one of: ${allowed.join(', ')}.`,
        }
      }
      return { ok: true, cleared: false, columns: { kind: 'enum', ...EMPTY, enumVal: hit } }
    }

    default:
      return { ok: true, cleared: false, columns: { kind: 'text', ...EMPTY, textVal: text } }
  }
}

/** Parse a `2.5 x 2.0 x 0.8 mm` style entry into millimetres. */
export function parseDimensionTriplet(
  raw: string,
): { x: number; y: number; z: number | null } | null {
  const text = raw.trim().replace(/[×X]/g, 'x').replace(/\s+/g, ' ')
  const m = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?\s*(mm)?$/i.exec(text)
  if (!m) return null
  const x = Number(m[1])
  const y = Number(m[2])
  const z = m[3] === undefined ? null : Number(m[3])
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null
  if (z !== null && (!Number.isFinite(z) || z <= 0)) return null
  return { x, y, z }
}
