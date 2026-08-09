import type {
  ExtractionProvider, ExtractionRequest, ExtractionResult, ProviderStatus,
} from './provider.js'
import { ProviderUnavailableError, parseExtractionResult } from './provider.js'

/**
 * Local OpenAI-compatible provider.
 *
 * This is what "my own model running offline" means in practice: llama.cpp's
 * server, Ollama, LM Studio and vLLM all speak `POST /v1/chat/completions`.
 * Pointing at one of those is a URL in settings, not a plugin.
 *
 * Nothing here reaches the internet unless the configured base URL does.
 */

export interface LocalOpenAiOptions {
  /** e.g. http://127.0.0.1:11434/v1 (Ollama) or http://127.0.0.1:8080/v1 (llama.cpp) */
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly timeoutMs?: number
  /** Rough context budget in characters, to decide how much datasheet to send. */
  readonly contextChars?: number
}

export const EXTRACTION_SYSTEM_PROMPT = `You extract electronic component specifications from datasheet text.

Rules, in order of importance:

1. NEVER invent a value. If the text does not state it, return null. A null is a
   correct, expected answer and is preferred over a plausible guess.
2. Every non-null value MUST include "evidence": a VERBATIM substring copied from
   the page text you were given, and "page": the page number it came from.
   Paraphrasing fails verification and the value will be discarded.
3. For package dimensions, prefer the MAXIMUM specified dimension. Datasheet
   mechanical tables give MIN/NOM/MAX; report max when present and say which in
   the evidence.
4. If the datasheet documents several package variants, list them all in
   packageVariants. Do not guess which one an ordering code refers to.
5. Values keep their units as written: "25 nA", "1.5-5.5 V", "128 Mbit".

Reply with JSON only. No prose, no markdown fences.`

export function buildExtractionPrompt(request: ExtractionRequest): string {
  const category = request.categories[0]
  const params = (category?.specs ?? [])
    .map((s) => `  - ${s.key}: ${s.name}${s.unit ? ` (${s.unit})` : ''}${s.ai ? ` — ${s.ai}` : ''}`)
    .join('\n')

  const pages = request.pages
    .map((p) => `--- PAGE ${p.page} ---\n${p.text}`)
    .join('\n\n')

  return `Part number hint: ${request.mpnHint ?? '(unknown — determine it from the text)'}
Candidate category: ${category ? `${category.slug} — ${category.name}` : '(determine it)'}

Parameters to extract for this category:
${params || '  (none defined)'}

Return JSON of exactly this shape:
{
  "manufacturer": string|null,
  "mpn": string|null,
  "productName": string|null,
  "categorySlug": string|null,
  "categoryConfidence": 0..1,
  "packageVariants": [{
    "name": string, "orderingCodeFragment": string|null, "pinCount": number|null,
    "xMin": number|null, "xNom": number|null, "xMax": number|null,
    "yMin": number|null, "yNom": number|null, "yMax": number|null,
    "zMin": number|null, "zNom": number|null, "zMax": number|null,
    "page": number|null, "evidence": string|null
  }],
  "claims": [{
    "specKey": string, "value": string|number|boolean|null, "unit": string|null,
    "page": number|null, "evidence": string|null, "confidence": 0..1
  }],
  "suggestedExternals": [{
    "name": string, "function": string, "qty": number,
    "necessity": "required"|"recommended"|"optional"|"configuration",
    "valueText": string|null, "packageName": string|null,
    "xMm": number|null, "yMm": number|null,
    "page": number|null, "evidence": string|null
  }]
}

Datasheet text:

${pages}`
}

/** Pull JSON out of a reply that may be wrapped in prose or fences. */
export function extractJsonObject(reply: string): unknown {
  const trimmed = reply.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    // Fall back to the outermost balanced braces — small models like to chat.
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1))
    }
    throw new Error('Model reply contained no JSON object')
  }
}

export class LocalOpenAiProvider implements ExtractionProvider {
  readonly id = 'local-openai' as const

  constructor(private readonly options: LocalOpenAiOptions) {}

  async status(): Promise<ProviderStatus> {
    if (!this.options.baseUrl) {
      return { id: this.id, available: false, reason: 'No local model URL configured.' }
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      const res = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/models`, {
        headers: this.headers(),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        return { id: this.id, available: false, reason: `Model server returned ${res.status}.` }
      }
      return { id: this.id, available: true, reason: null }
    } catch (err) {
      return {
        id: this.id,
        available: false,
        reason: `Cannot reach ${this.options.baseUrl}: ${(err as Error).message}`,
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const status = await this.status()
    if (!status.available) throw new ProviderUnavailableError(this.id, status.reason ?? 'Unavailable')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000)

    try {
      const res = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          temperature: 0,
          // Servers that support it will honour this; those that do not ignore
          // it, which is why extractJsonObject is forgiving.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: buildExtractionPrompt(request) },
          ],
        }),
      })

      if (!res.ok) {
        throw new Error(`Model server returned ${res.status}: ${await res.text()}`)
      }

      const payload = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = payload.choices?.[0]?.message?.content
      if (!content) throw new Error('Model reply had no content')

      // Validated against the schema before anything downstream sees it.
      return parseExtractionResult(extractJsonObject(content))
    } finally {
      clearTimeout(timer)
    }
  }
}
