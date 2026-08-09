import { parse as parseYaml } from 'yaml'
import type { Better, SpecDefinition, SpecType, RankingRequirement, RequirementOp } from '../../domain/categories/model.js'
import type { DimensionId } from '../../domain/units/dimensions.js'

/**
 * The lexicon translates component-report's free-text `key_parameters` into typed
 * spec definitions. It is data, not code, so adding a phrase never needs a release.
 */

export interface LexiconEmit {
  readonly virtual?: string
  readonly key?: string
  readonly name?: string
  readonly type?: SpecType
  readonly dimension?: DimensionId
  readonly unit?: string
  readonly unitLabel?: string
  readonly better?: Better
  readonly enumValues?: readonly string[]
  readonly table?: boolean
  readonly ai?: string
}

export interface LexiconEntry {
  readonly match: string
  readonly aliases?: readonly string[]
  readonly emits: readonly LexiconEmit[]
  readonly requirement?: {
    readonly field: string
    readonly op: RequirementOp
    readonly value: number
    readonly unit: string
    readonly note: string
  }
}

export interface Lexicon {
  readonly version: number
  readonly entries: readonly LexiconEntry[]
}

/**
 * Normalize a phrase for matching: case, whitespace and punctuation variance in
 * the source file must not cause a miss. `Package footprint (mm²)` and
 * `package footprint (mm2)` are the same key.
 */
export function normalizePhrase(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/μ/g, 'µ')
    .replace(/²/g, '2')
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9<>=+.~/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ResolvedPhrase {
  readonly matched: boolean
  readonly virtuals: readonly string[]
  readonly specs: readonly SpecDefinition[]
  readonly requirement: RankingRequirement | null
}

export class SpecLexicon {
  private readonly byPhrase = new Map<string, LexiconEntry>()

  constructor(private readonly lexicon: Lexicon) {
    for (const entry of lexicon.entries) {
      this.byPhrase.set(normalizePhrase(entry.match), entry)
      for (const alias of entry.aliases ?? []) {
        this.byPhrase.set(normalizePhrase(alias), entry)
      }
    }
  }

  static fromYaml(text: string): SpecLexicon {
    const raw = parseYaml(text) as Lexicon
    if (!raw || !Array.isArray(raw.entries)) {
      throw new Error('spec-lexicon.yaml: expected a top-level `entries:` list')
    }
    return new SpecLexicon(raw)
  }

  get size(): number {
    return this.byPhrase.size
  }

  /** Every phrase the lexicon knows, for coverage reporting. */
  phrases(): string[] {
    return [...this.byPhrase.keys()]
  }

  /**
   * Resolve one `key_parameters` entry.
   *
   * An unmatched phrase yields a single untyped `text` spec flagged `unmapped`,
   * so it stays visible and editable rather than being dropped or guessed at.
   */
  resolve(phrase: string): ResolvedPhrase {
    const entry = this.byPhrase.get(normalizePhrase(phrase))
    if (!entry) {
      return {
        matched: false,
        virtuals: [],
        specs: [
          {
            key: fallbackKey(phrase),
            name: phrase,
            type: 'text',
            better: 'none',
            table: false,
            filterable: false,
            sortable: false,
            unmapped: true,
            sourcePhrase: phrase,
          },
        ],
        requirement: null,
      }
    }

    const virtuals: string[] = []
    const specs: SpecDefinition[] = []
    for (const emit of entry.emits) {
      if (emit.virtual) {
        virtuals.push(emit.virtual)
        continue
      }
      if (!emit.key) continue
      const type: SpecType = emit.type ?? 'text'
      const numeric = type === 'scalar' || type === 'range' || type === 'number'
      specs.push({
        key: emit.key,
        name: emit.name ?? emit.key,
        type,
        ...(emit.dimension ? { dimension: emit.dimension } : {}),
        ...(emit.unit ? { unit: emit.unit } : {}),
        ...(emit.unitLabel ? { unitLabel: emit.unitLabel } : {}),
        better: emit.better ?? 'none',
        ...(emit.enumValues ? { enumValues: emit.enumValues } : {}),
        table: emit.table ?? false,
        filterable: true,
        sortable: numeric || type === 'enum' || type === 'bool',
        ...(emit.ai ? { ai: emit.ai } : {}),
        unmapped: false,
        sourcePhrase: phrase,
      })
    }

    return {
      matched: true,
      virtuals,
      specs,
      requirement: entry.requirement
        ? {
            field: entry.requirement.field,
            op: entry.requirement.op,
            value: entry.requirement.value,
            unit: entry.requirement.unit,
            note: entry.requirement.note,
          }
        : null,
    }
  }
}

/** Deterministic snake_case key for an unmapped phrase. */
export function fallbackKey(phrase: string): string {
  const base = normalizePhrase(phrase)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return base ? `x_${base}` : 'x_unnamed'
}
