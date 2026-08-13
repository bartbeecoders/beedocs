import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ApiKeyStatus } from '../types'

/** 40 URL-safe characters from the browser's CSPRNG — same shape as a generated secret elsewhere. */
function randomKey(): string {
  const bytes = new Uint8Array(30)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '')
}

/**
 * The shared publish API key — what apps and the MCP server send as
 * `Authorization: Bearer` / `X-Api-Key`. Stored server-side and write-only:
 * after saving, only the last four characters remain visible, so the key must
 * be copied to the publishing app before it leaves this screen.
 */
export function ApiKeyPanel() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedNote, setSavedNote] = useState(false)

  useEffect(() => {
    api
      .getApiKeyStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const submit = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.setApiKey(value))
      setDraft('')
      setCopied(false)
      setSavedNote(value !== '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
    } catch {
      // Clipboard can be unavailable (http, permissions) — the key is still on screen.
    }
  }

  const statusLine = !status
    ? 'Loading…'
    : status.source === 'settings'
      ? `A key is set from this page (ends in …${status.keyHint}).`
      : status.source === 'config'
        ? `A key from the server configuration (BeeDocs__ApiKey) is active (ends in …${status.keyHint}). Saving one here overrides it — no restart needed.`
        : 'No key set — apps can publish without authentication, and with sign-in enabled they cannot publish at all.'

  return (
    <div className="api-key-panel">
      <p className="muted sm">
        Apps and the MCP server authenticate with this key (<code>Authorization: Bearer</code> or{' '}
        <code>X-Api-Key</code>). It is stored server-side and never shown again after saving —
        copy it to the publishing app first.
      </p>
      <p className={status && !status.hasKey ? 'sm' : 'muted sm'}>{statusLine}</p>

      <div className="field-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={draft}
          placeholder="New API key"
          autoComplete="off"
          spellCheck={false}
          style={{ flex: '1 1 260px', fontFamily: 'monospace' }}
          onChange={(e) => {
            setDraft(e.target.value)
            setCopied(false)
          }}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => setDraft(randomKey())}>
          Generate
        </button>
        <button type="button" className="btn sm" disabled={busy || draft.trim() === ''} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || draft.trim() === ''}
          onClick={() => submit(draft)}
        >
          Save key
        </button>
        {status?.source === 'settings' && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => submit('')}>
            Clear stored key
          </button>
        )}
      </div>

      {savedNote && (
        <p className="muted sm settings-hint">
          Saved — it takes effect immediately. Update every publishing app (and the MCP server&apos;s{' '}
          <code>BEEDOCS_API_KEY</code>) with the new key.
        </p>
      )}
      {error && (
        <p className="sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
