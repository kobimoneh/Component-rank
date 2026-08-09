import type { SqlDriver } from '../../db/driver.js'
import { normalizeMpn, upsertManufacturer } from '../../db/repositories/components.js'
import { parseHeadline } from './headline.js'

/**
 * Seed the database from a component-report `parts.json`.
 *
 * What is imported as fact: MPN, manufacturer, datasheet URL, category, 1 k price.
 * These came from a real search and are verifiable by clicking the datasheet link.
 *
 * What is imported as *unverified*: dimensions parsed from the prose `headline`,
 * which a language model wrote. They are stored with `is_unverified = 1`, render
 * greyed and dashed, and are excluded from ranking until confirmed.
 *
 * What is never imported: anything requiring inference. A package code does not
 * become a size. Prose with no explicit millimetre pair yields no dimensions.
 */

export interface RawSeedPart {
  readonly mpn: string
  readonly manufacturer: string
  readonly role?: string
  readonly headline?: string
  readonly price_1k?: string
  readonly datasheet_url?: string
  readonly note?: string
}

export interface RawSeedCategory {
  readonly slug: string
  readonly name?: string
  readonly parts?: readonly RawSeedPart[]
}

export interface SeedReport {
  readonly created: number
  /** Parts already present that were linked to an additional category. */
  readonly crossListed: number
  readonly withDimensions: number
  readonly withoutDimensions: number
  readonly unknownCategories: readonly string[]
}

/** "~$0.40" -> 0.40; anything unparseable stays null rather than becoming 0. */
export function parsePrice(text: string | undefined | null): number | null {
  if (!text) return null
  const m = /(\d+(?:\.\d+)?)/.exec(text.replace(/,/g, ''))
  if (!m?.[1]) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

export function seedFromParts(
  db: SqlDriver,
  categories: readonly RawSeedCategory[],
  now = new Date().toISOString(),
): SeedReport {
  let created = 0
  let crossListed = 0
  let withDims = 0
  let withoutDims = 0
  const unknownCategories = new Set<string>()

  db.transaction(() => {
    const catStmt = db.prepare('SELECT id FROM category WHERE slug = ?')
    const dupStmt = db.prepare('SELECT id FROM component WHERE manufacturer_id = ? AND mpn_norm = ?')
    const linkCategory = db.prepare(
      'INSERT OR IGNORE INTO component_category (component_id, category_id, is_primary) VALUES (?,?,?)',
    )
    const insertComponent = db.prepare(`
      INSERT INTO component (manufacturer_id, mpn, mpn_norm, category_id, lifecycle,
                             price_1k_usd, notes, origin, created_at, updated_at)
      VALUES (?,?,?,?, 'unknown', ?, ?, 'imported', ?, ?)
    `)
    const insertPackage = db.prepare(`
      INSERT INTO package (component_id, type, name, x_nom, y_nom, z_nom,
                           origin, is_unverified, unverified_reason)
      VALUES (?,?,?,?,?,?, 'imported', 1, ?)
    `)
    const insertDatasheet = db.prepare(`
      INSERT INTO datasheet (component_id, url, added_at) VALUES (?,?,?)
    `)

    for (const cat of categories) {
      const row = catStmt.get<{ id: number }>(cat.slug)
      if (!row) {
        if (cat.parts && cat.parts.length > 0) unknownCategories.add(cat.slug)
        continue
      }
      for (const part of cat.parts ?? []) {
        if (!part.mpn || !part.manufacturer) continue
        const manufacturerId = upsertManufacturer(db, part.manufacturer)
        const mpnNorm = normalizeMpn(part.mpn)
        const existing = dupStmt.get<{ id: number }>(manufacturerId, mpnNorm)
        if (existing) {
          // Cross-listed: the same part appears in more than one category of the
          // report. Record the extra membership rather than dropping the part
          // from a category it genuinely belongs to.
          linkCategory.run(existing.id, row.id, 0)
          crossListed++
          continue
        }

        const parsed = parseHeadline(part.headline)
        const noteParts: string[] = []
        if (part.note) noteParts.push(part.note)
        if (part.headline) noteParts.push(`Imported summary: ${part.headline}`)
        if (part.role) noteParts.push(`component-report role: ${part.role}`)

        const componentId = insertComponent.run(
          manufacturerId,
          part.mpn.trim(),
          mpnNorm,
          row.id,
          parsePrice(part.price_1k),
          noteParts.join('\n'),
          now,
          now,
        ).lastInsertRowid

        // Only an explicit millimetre pair becomes a dimension. Everything else
        // stays Unknown; the prose is preserved in the notes above.
        if (parsed.xMm !== null && parsed.yMm !== null) {
          insertPackage.run(
            componentId,
            null,
            parsed.packageName,
            parsed.xMm,
            parsed.yMm,
            parsed.heightMm,
            'Parsed from a component-report summary, not read from the datasheet.',
          )
          withDims++
        } else {
          if (parsed.packageName) {
            insertPackage.run(
              componentId, null, parsed.packageName, null, null, null,
              'Package name only; no dimensions stated in the source summary.',
            )
          }
          withoutDims++
        }

        linkCategory.run(componentId, row.id, 1)
        if (part.datasheet_url) insertDatasheet.run(componentId, part.datasheet_url, now)
        created++
      }
    }
  })

  return {
    created,
    crossListed,
    withDimensions: withDims,
    withoutDimensions: withoutDims,
    unknownCategories: [...unknownCategories],
  }
}
