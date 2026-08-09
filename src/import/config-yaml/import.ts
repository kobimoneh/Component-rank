import { parse as parseYaml } from 'yaml'
import type {
  Category,
  CategoryRanking,
  RankingRequirement,
  RankingRule,
  SpecDefinition,
} from '../../domain/categories/model.js'
import { isVirtualField } from '../../domain/categories/model.js'
import { SpecLexicon, normalizePhrase } from './lexicon.js'

/**
 * Importer for component-report/config.yaml.
 *
 * Two things the source file does that a naive reader gets wrong:
 *
 *  1. `key_parameters` entries containing ": " are parsed by YAML as **dicts**,
 *     not strings. Three real entries do this, and two of them carry hard
 *     constraints ("must be < 6 mA", "must include ~400 MHz"). Reading them as
 *     strings throws or silently drops the constraint.
 *
 *  2. `metric` is prose describing an ordered ranking, not a field name.
 */

export interface RawCategory {
  name: string
  slug: string
  description?: string
  metric?: string
  key_parameters?: unknown[]
  best_in_class?: string[]
  manufacturers?: string[]
}

export interface ImportOptions {
  /** Group assignment for the nav rail; falls back to a slug heuristic. */
  readonly groupFor?: (category: RawCategory) => string
}

export interface ImportReport {
  readonly categories: readonly Category[]
  /** Distinct source phrases the lexicon did not recognise. */
  readonly unmappedPhrases: readonly string[]
  /** Phrases that arrived as YAML dicts and were flattened back to text. */
  readonly flattenedPhrases: readonly string[]
  readonly categoriesWithUnresolvedRanking: readonly string[]
  readonly phraseCount: number
  readonly matchedPhraseCount: number
}

/**
 * Flatten a `key_parameters` list item into text.
 *
 * A plain string passes through. A dict — produced when the source text contained
 * `": "` — is rebuilt as `key: value` so the constraint survives verbatim.
 */
export function flattenKeyParameter(item: unknown): { text: string; wasFlattened: boolean } | null {
  if (typeof item === 'string') return { text: item, wasFlattened: false }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      parts.push(v === null || v === undefined ? k : `${k}: ${String(v)}`)
    }
    if (parts.length === 0) return null
    return { text: parts.join('; '), wasFlattened: true }
  }
  if (typeof item === 'number' || typeof item === 'boolean') {
    return { text: String(item), wasFlattened: false }
  }
  return null
}

const GROUP_RULES: ReadonlyArray<{ test: RegExp; group: string }> = [
  { test: /^(tiny-ldo|buck-|mini-load-switch|power-)/, group: 'Power' },
  { test: /^(ble-mcu|smallest-mcu|smallest-zephyr)/, group: 'MCU' },
  { test: /^(ble-transceiver|wifi-|uwb-|cellular|gnss)/, group: 'Wireless' },
  { test: /^rf-/, group: 'RF' },
  { test: /^fpga-/, group: 'FPGA' },
  { test: /^(flash-|memory-|sram|dram)/, group: 'Memory' },
  { test: /connector/, group: 'Connectors' },
  { test: /^(pcie-|usb-|interface-)/, group: 'Interface' },
]

function inferGroup(c: RawCategory): string {
  for (const rule of GROUP_RULES) {
    if (rule.test.test(c.slug)) return rule.group
  }
  return 'Other'
}

/**
 * Turn `metric:` prose into ordered ranking rules.
 *
 * "Smallest package footprint (mm²); then lowest quiescent current (Iq)" becomes
 * two rules. Clauses that cannot be resolved to a known field are left out of the
 * rules and the prose is kept, so the category shows what it is *meant* to rank by
 * even when the app cannot do it automatically yet.
 */
export function parseMetric(
  metric: string,
  specs: readonly SpecDefinition[],
  virtuals: readonly string[],
): CategoryRanking {
  const prose = (metric ?? '').trim()
  const rules: RankingRule[] = []
  if (!prose) {
    return { metricProse: '', rules: [], requirements: [], unresolved: true }
  }

  // Split on the ordering language the source file uses consistently.
  const clauses = prose
    .split(/;|\bthen\b|,\s*then\b/i)
    .map((c) => c.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  for (const clause of clauses) {
    const field = resolveClauseField(clause, specs, virtuals)
    if (!field) continue
    if (seen.has(field.field)) continue
    seen.add(field.field)
    rules.push(field)
  }

  return {
    metricProse: prose,
    rules,
    requirements: [],
    unresolved: rules.length === 0,
  }
}

const SIZE_WORDS = /(footprint|package size|solution size|area|smallest|size)/i
const GROSS_WORDS = /(total solution|solution footprint|total footprint|whole solution)/i

function resolveClauseField(
  clause: string,
  specs: readonly SpecDefinition[],
  virtuals: readonly string[],
): RankingRule | null {
  const norm = normalizePhrase(clause)

  // Direction words present in the source prose.
  const wantsLow = /\b(smallest|lowest|least|lower|minimum|min|fewest)\b/.test(norm)
  const wantsHigh = /\b(largest|highest|most|greatest|maximum|max|best)\b/.test(norm)

  // Size clauses map to the virtual area fields.
  if (SIZE_WORDS.test(clause)) {
    const field = GROSS_WORDS.test(clause) ? '@gross_area' : '@ic_area'
    if (virtuals.includes(field) || field === '@ic_area') {
      return { field, direction: 'asc', missing: 'last' }
    }
  }

  // Otherwise look for a spec whose name or key appears in the clause.
  let best: SpecDefinition | null = null
  for (const spec of specs) {
    const nameHit = norm.includes(normalizePhrase(spec.name))
    const keyHit = norm.includes(spec.key.replace(/_/g, ' '))
    if (!nameHit && !keyHit) continue
    if (!best || spec.name.length > best.name.length) best = spec
  }
  if (!best) return null
  if (best.type === 'text') return null

  const direction: RankingRule['direction'] = wantsLow
    ? 'asc'
    : wantsHigh
      ? 'desc'
      : best.better === 'higher'
        ? 'desc'
        : 'asc'

  return { field: best.key, direction, missing: 'last' }
}

/** Merge spec definitions, first definition wins on key collision. */
function mergeSpecs(target: SpecDefinition[], incoming: readonly SpecDefinition[]): void {
  for (const spec of incoming) {
    if (target.some((s) => s.key === spec.key)) continue
    target.push(spec)
  }
}

export function importCategories(
  configYaml: string,
  lexicon: SpecLexicon,
  opts: ImportOptions = {},
): ImportReport {
  const raw = parseYaml(configYaml) as { categories?: RawCategory[]; manufacturers?: string[] }
  const globalManufacturers = raw?.manufacturers ?? []
  const rawCategories = raw?.categories ?? []
  if (rawCategories.length === 0) {
    throw new Error('config.yaml defines no categories')
  }

  const categories: Category[] = []
  const unmapped = new Set<string>()
  const flattened = new Set<string>()
  const unresolvedRanking: string[] = []
  let phraseCount = 0
  let matchedCount = 0

  for (const rc of rawCategories) {
    if (!rc?.name || !rc?.slug) {
      throw new Error(`Each category needs 'name' and 'slug'. Got: ${JSON.stringify(rc)}`)
    }

    const specs: SpecDefinition[] = []
    const virtuals: string[] = []
    const requirements: RankingRequirement[] = []
    const importNotes: string[] = []

    for (const item of rc.key_parameters ?? []) {
      const flat = flattenKeyParameter(item)
      if (!flat) continue
      phraseCount++
      if (flat.wasFlattened) {
        flattened.add(flat.text)
        importNotes.push(`Hard constraint from source: ${flat.text}`)
      }

      const resolved = lexicon.resolve(flat.text)
      if (resolved.matched) matchedCount++
      else unmapped.add(flat.text)

      mergeSpecs(specs, resolved.specs)
      for (const v of resolved.virtuals) {
        if (isVirtualField(v) && !virtuals.includes(v)) virtuals.push(v)
      }
      if (resolved.requirement) requirements.push(resolved.requirement)
    }

    const ranking = parseMetric(rc.metric ?? '', specs, virtuals)
    const withRequirements: CategoryRanking = { ...ranking, requirements }
    if (withRequirements.unresolved) unresolvedRanking.push(rc.slug)

    categories.push({
      slug: rc.slug,
      name: rc.name,
      group: opts.groupFor ? opts.groupFor(rc) : inferGroup(rc),
      description: (rc.description ?? '').trim(),
      ranking: withRequirements,
      specs,
      manufacturers: rc.manufacturers ?? globalManufacturers,
      referenceParts: rc.best_in_class ?? [],
      importNotes,
    })
  }

  return {
    categories,
    unmappedPhrases: [...unmapped],
    flattenedPhrases: [...flattened],
    categoriesWithUnresolvedRanking: unresolvedRanking,
    phraseCount,
    matchedPhraseCount: matchedCount,
  }
}
