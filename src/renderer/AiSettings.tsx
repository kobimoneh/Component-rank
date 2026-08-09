import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AiSettings as Settings, ProviderStatusInfo } from '../shared/ipc.js'

interface Props {
  readonly open: boolean
  readonly onClose: () => void
  readonly onChanged: () => void
}

/**
 * Where you point the app at a model.
 *
 * Everything here runs on your machine. "Local model" means an
 * OpenAI-compatible server — llama.cpp, Ollama, LM Studio, vLLM all speak it —
 * so pointing at one is a URL, not a plugin.
 */
export function AiSettingsPanel({ open, onClose, onChanged }: Props): JSX.Element | null {
  const [settings, setSettings] = useState<Settings>({
    provider: 'none', baseUrl: 'http://127.0.0.1:11434/v1', model: '', claudeBin: '',
  })
  const [status, setStatus] = useState<ProviderStatusInfo | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!open) return
    void window.api.getAiSettings().then((s) => {
      setSettings({ provider: s.provider, baseUrl: s.baseUrl, model: s.model, claudeBin: s.claudeBin })
      setStatus(s.status)
    })
  }, [open])

  if (!open) return null

  const save = (): void => {
    setTesting(true)
    void window.api.setAiSettings(settings).then((s) => {
      setStatus(s)
      setTesting(false)
      onChanged()
    })
  }

  return (
    <>
      <div className="scrim" data-open="true" onClick={onClose} aria-hidden />
      <div className="modal" style={{ width: 'min(620px, 94vw)' }} role="dialog" aria-label="Extraction model">
        <div className="modal-head">
          <strong>Extraction model</strong>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="field-grid">
            <label>Provider</label>
            <select
              value={settings.provider}
              onChange={(e) => setSettings({ ...settings, provider: e.target.value as Settings['provider'] })}
            >
              <option value="none">None — store datasheets, enter values by hand</option>
              <option value="local-openai">Local model (OpenAI-compatible server)</option>
              <option value="claude-cli">Claude CLI</option>
            </select>

            {settings.provider === 'local-openai' && (
              <>
                <label>Server URL</label>
                <input
                  value={settings.baseUrl}
                  onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                  placeholder="http://127.0.0.1:11434/v1"
                />
                <label>Model</label>
                <input
                  value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                  placeholder="qwen2.5:7b"
                />
              </>
            )}

            {settings.provider === 'claude-cli' && (
              <>
                <label>Claude binary</label>
                <input
                  value={settings.claudeBin}
                  onChange={(e) => setSettings({ ...settings, claudeBin: e.target.value })}
                  placeholder="/home/you/.local/bin/claude"
                />
              </>
            )}
          </div>

          {settings.provider === 'local-openai' && (
            <div className="hint" style={{ marginTop: 10 }}>
              Works with anything that serves <code>/v1/chat/completions</code>:
              <br />Ollama <code>http://127.0.0.1:11434/v1</code> ·
              llama.cpp <code>http://127.0.0.1:8080/v1</code> ·
              LM Studio <code>http://127.0.0.1:1234/v1</code>
            </div>
          )}

          {status && (
            <div className={`callout${status.available ? ' ok' : ''}`} style={{ marginTop: 14 }}>
              <strong>{status.available ? 'Reachable' : 'Not reachable'}</strong>
              {status.reason && <div className="hint" style={{ marginTop: 4 }}>{status.reason}</div>}
            </div>
          )}

          <div className="section-title">What the model is and is not trusted with</div>
          <div className="hint">
            It reads the datasheet text and proposes values. Every value it proposes must quote
            the datasheet verbatim, and that quote is checked against the page it cites before
            you ever see it marked verified. Nothing reaches the library until you press Save on
            the review screen. Confidence is shown, never acted on.
          </div>
        </div>

        <div className="modal-foot">
          <span className="hint">Runs entirely on your machine.</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={save} disabled={testing}>
            {testing ? 'Testing…' : 'Save and test'}
          </button>
        </div>
      </div>
    </>
  )
}
