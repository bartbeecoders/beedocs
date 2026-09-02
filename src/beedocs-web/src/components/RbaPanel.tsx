import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import type { RbaSettings, RbaTestResult } from '../types'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The RBA login provider — corporate sign-in instead of local passwords.
 * Enable/disable and configuration live server-side (`/api/settings/rba`) and
 * apply to the next login without a restart; the admin's own session survives
 * the switch, which is what makes turning it back off after a mistake possible.
 */
export function RbaPanel() {
  const { refresh } = useAuth()
  const { t } = useI18n()

  const [settings, setSettings] = useState<RbaSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  // The form's draft, seeded from the server answer.
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [applicationCd, setApplicationCd] = useState('DOC')
  const [plantCd, setPlantCd] = useState('')
  const [syncRoles, setSyncRoles] = useState(true)
  const [offline, setOffline] = useState(false)
  const [jwks, setJwks] = useState('')
  const [jwksError, setJwksError] = useState<string | null>(null)
  const [fetchingJwks, setFetchingJwks] = useState(false)

  const jwksUrl = `${baseUrl.replace(/\/+$/, '')}/.well-known/jwks.json`

  // Connection test
  const [testUser, setTestUser] = useState('')
  const [testPassword, setTestPassword] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RbaTestResult | null>(null)

  const seed = (s: RbaSettings) => {
    setSettings(s)
    setEnabled(s.enabled)
    setBaseUrl(s.baseUrl)
    setApplicationCd(s.applicationCd)
    setPlantCd(s.plantCd)
    setSyncRoles(s.syncRoles)
    setOffline(s.offline)
    setJwks(s.jwks)
  }

  useEffect(() => {
    api
      .getRbaSettings()
      .then(seed)
      .catch((e) => setError(errText(e)))
  }, [])

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      seed(
        await api.updateRbaSettings({
          enabled,
          baseUrl,
          applicationCd,
          plantCd,
          syncRoles,
          offline,
          jwks,
          timeoutSeconds: settings?.timeoutSeconds ?? 15,
        }),
      )
      setSaved(true)
      // rbaEnabled feeds the login screen and the password card app-wide.
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const revert = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      seed(await api.clearRbaSettings())
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    setError(null)
    try {
      setTestResult(await api.testRba(testUser.trim(), testPassword))
    } catch (e) {
      setError(errText(e))
    } finally {
      setTesting(false)
    }
  }

  if (!settings && !error) return <p className="muted sm">{t('common.loading')}</p>

  return (
    <div className="rba-panel">
      <p className="muted sm">{t('providers.rbaIntro', { code: applicationCd || 'DOC' })}</p>

      {settings?.source === 'config' && (
        <p className="muted sm">{t('providers.rbaConfigNote')}</p>
      )}

      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>{t('providers.rbaEnable')}</span>
      </label>

      <div className="users-form" style={{ marginTop: 8 }}>
        <label className="users-field">
          <span>{t('providers.rbaBaseUrl')}</span>
          <input
            type="url"
            placeholder="https://rba.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        </label>
        <label className="users-field">
          <span>{t('providers.rbaAppCode')}</span>
          <input
            value={applicationCd}
            onChange={(e) => setApplicationCd(e.target.value)}
            disabled={busy}
            maxLength={3}
            spellCheck={false}
          />
        </label>
        <label className="users-field">
          <span>{t('providers.rbaPlantCode')}</span>
          <input value={plantCd} onChange={(e) => setPlantCd(e.target.value)} disabled={busy} spellCheck={false} />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={syncRoles && !offline}
            onChange={(e) => setSyncRoles(e.target.checked)}
            disabled={busy || offline}
          />
          <span>{t('providers.rbaSyncRoles')}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={offline}
            onChange={(e) => setOffline(e.target.checked)}
            disabled={busy}
          />
          <span>{t('providers.rbaOffline')}</span>
        </label>
        {offline && (
          <>
            <p className="muted sm">{t('providers.rbaOfflineHint', { url: jwksUrl })}</p>
            <label className="users-field">
              <span>{t('providers.rbaJwks')}</span>
              <textarea
                value={jwks}
                onChange={(e) => setJwks(e.target.value)}
                disabled={busy}
                rows={4}
                spellCheck={false}
                placeholder='{"keys":[{"kty":"RSA", …}]}'
                style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
              />
            </label>
            <div>
              <button
                type="button"
                className="btn sm"
                disabled={busy || fetchingJwks || !baseUrl.trim()}
                onClick={async () => {
                  // This browser sits on the network RBA lives on — the whole
                  // reason offline mode exists — so it can fill the field itself.
                  setFetchingJwks(true)
                  setJwksError(null)
                  try {
                    const res = await fetch(jwksUrl)
                    if (!res.ok) throw new Error(String(res.status))
                    setJwks(JSON.stringify(await res.json()))
                  } catch {
                    setJwksError(t('providers.rbaJwksFetchFailed', { url: jwksUrl }))
                  } finally {
                    setFetchingJwks(false)
                  }
                }}
              >
                {fetchingJwks ? t('providers.testing') : t('providers.rbaJwksFetch')}
              </button>
            </div>
            {jwksError && (
              <p className="sm" role="alert" style={{ color: 'var(--danger)' }}>
                {jwksError}
              </p>
            )}
          </>
        )}
      </div>

      {enabled && !settings?.enabled && (
        <p className="users-notice">
          {t('providers.rbaAdminNotice', {
            group: `${(applicationCd || 'DOC').toUpperCase()}_ADMIN`,
          })}
        </p>
      )}

      <div className="users-form-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn sm primary" disabled={busy} onClick={save}>
          {busy ? t('common.saving') : t('providers.rbaSave')}
        </button>
        {settings?.source === 'settings' && (
          <button type="button" className="btn sm" disabled={busy} onClick={revert}>
            {t('providers.rbaRevert')}
          </button>
        )}
        {saved && <span className="users-ok">{t('providers.rbaSaved')}</span>}
      </div>

      <div className="users-form" style={{ marginTop: 12 }}>
        <p className="muted sm" style={{ marginBottom: 4 }}>
          {t('providers.rbaTestBlurb')}
        </p>
        <div className="field-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder={t('providers.rbaTestUser')}
            value={testUser}
            onChange={(e) => setTestUser(e.target.value)}
            disabled={testing}
            autoComplete="off"
            style={{ flex: '1 1 160px' }}
          />
          <input
            type="password"
            placeholder={t('providers.rbaTestPassword')}
            value={testPassword}
            onChange={(e) => setTestPassword(e.target.value)}
            disabled={testing}
            autoComplete="new-password"
            style={{ flex: '1 1 160px' }}
          />
          <button type="button" className="btn sm" disabled={testing} onClick={test}>
            {testing ? t('providers.testing') : t('providers.testConnection')}
          </button>
        </div>
        {testResult && (
          <p className={testResult.status === 'success' || testResult.status === 'reachable' ? 'users-ok sm' : 'sm'}
             style={testResult.reachable ? undefined : { color: 'var(--danger)' }}
             role="status">
            {testResult.message}
          </p>
        )}
      </div>

      {error && (
        <p className="sm" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
