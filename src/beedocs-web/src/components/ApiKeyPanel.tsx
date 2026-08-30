import { useEffect, useState } from 'react'
import { api } from '../api'
import { useI18n } from '../i18n'
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
  const { t } = useI18n()
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
    ? t('common.loading')
    : status.source === 'settings'
      ? t('providers.apiKeySetFromPage', { hint: status.keyHint ?? '' })
      : status.source === 'config'
        ? t('providers.apiKeyFromConfig', { hint: status.keyHint ?? '' })
        : t('providers.apiKeyNone')

  return (
    <div className="api-key-panel">
      <p className="muted sm">{t('providers.apiKeyIntro')}</p>
      <p className={status && !status.hasKey ? 'sm' : 'muted sm'}>{statusLine}</p>

      <div className="field-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={draft}
          placeholder={t('providers.apiKeyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          style={{ flex: '1 1 260px', fontFamily: 'monospace' }}
          onChange={(e) => {
            setDraft(e.target.value)
            setCopied(false)
          }}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => setDraft(randomKey())}>
          {t('providers.generate')}
        </button>
        <button type="button" className="btn sm" disabled={busy || draft.trim() === ''} onClick={copy}>
          {copied ? t('providers.copied') : t('common.copy')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || draft.trim() === ''}
          onClick={() => submit(draft)}
        >
          {t('providers.saveKey')}
        </button>
        {status?.source === 'settings' && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => submit('')}>
            {t('providers.clearStoredKey')}
          </button>
        )}
      </div>

      {savedNote && (
        <p className="muted sm settings-hint">{t('providers.apiKeySavedNote')}</p>
      )}
      {error && (
        <p className="sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
