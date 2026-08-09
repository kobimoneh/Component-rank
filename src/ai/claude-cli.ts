import { access, constants } from 'node:fs/promises'
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResult,
  ProviderStatus,
} from './provider.js'
import { ProviderUnavailableError } from './provider.js'

/**
 * Local Claude CLI provider.
 *
 * Matches `component-report`'s `backend: cli` — it uses your subscription rather
 * than API credits.
 *
 * Security (spec section 46): the command is built as an argv **array** and
 * spawned without a shell. The flag set is fixed. No user-controlled value ever
 * becomes part of a command string; the datasheet text is written to a temporary
 * file and passed as a path, never interpolated.
 */

/** The only flags this provider is ever allowed to pass. */
const ALLOWED_FLAGS = ['-p', '--output-format', '--model'] as const

export interface ClaudeCliOptions {
  readonly binaryPath: string
  readonly model?: string
  readonly timeoutMs?: number
}

export class ClaudeCliProvider implements ExtractionProvider {
  readonly id = 'claude-cli' as const

  constructor(private readonly options: ClaudeCliOptions) {}

  async status(): Promise<ProviderStatus> {
    const path = this.options.binaryPath
    if (!path) {
      return { id: this.id, available: false, reason: 'No Claude CLI path is configured.' }
    }
    try {
      await access(path, constants.X_OK)
    } catch {
      return {
        id: this.id,
        available: false,
        reason: `Claude CLI not found or not executable at ${path}.`,
      }
    }
    return {
      id: this.id,
      available: false,
      reason: 'Datasheet extraction is not implemented yet (phase 5).',
    }
  }

  /**
   * Build the argv for a run. Exported behaviour, kept pure and testable so the
   * "no shell, fixed flags" guarantee can be asserted rather than asserted about.
   */
  buildArgv(promptFilePath: string): string[] {
    const argv = ['-p', `@${promptFilePath}`, '--output-format', 'json']
    if (this.options.model) argv.push('--model', this.options.model)
    return argv
  }

  async extract(_request: ExtractionRequest): Promise<ExtractionResult> {
    const status = await this.status()
    throw new ProviderUnavailableError(this.id, status.reason ?? 'Not available.')
  }
}

/** Every flag the provider can emit must be on the allow-list. */
export function argvFlagsAreAllowed(argv: readonly string[]): boolean {
  return argv
    .filter((token) => token.startsWith('-'))
    .every((flag) => (ALLOWED_FLAGS as readonly string[]).includes(flag))
}
