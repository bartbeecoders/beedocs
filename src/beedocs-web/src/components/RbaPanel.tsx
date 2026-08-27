import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
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

  if (!settings && !error) return <p className="muted sm">Loading…</p>

  return (
    <div className="rba-panel">
      <p className="muted sm">
        With RBA on, sign-in uses corporate credentials: the browser sends them directly to the RBA
        service (never through BeeDocs) and hands BeeDocs the resulting token, which is verified and
        mapped from the account&apos;s <code>{applicationCd || 'DOC'}</code> groups to a role
        (admin / editor / viewer); the account is provisioned on first login. Local passwords are
        disabled while it is on. The base URL must be reachable from users&apos; browsers <em>and</em>{' '}
        from the BeeDocs server, and RBA&apos;s <code>CorsUrls</code> must include this app&apos;s
        origin.
      </p>

      {settings?.source === 'config' && (
        <p className="muted sm">
          Current values come from the server configuration (<code>BeeDocs__Rba</code>). Saving here
          stores them in BeeDocs and overrides the configuration — no restart needed.
        </p>
      )}

      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
        <span>Use RBA (corporate sign-in) as the login provider</span>
      </label>

      <div className="users-form" style={{ marginTop: 8 }}>
        <label className="users-field">
          <span>RBA base URL</span>
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
          <span>Application code</span>
          <input
            value={applicationCd}
            onChange={(e) => setApplicationCd(e.target.value)}
            disabled={busy}
            maxLength={3}
            spellCheck={false}
          />
        </label>
        <label className="users-field">
          <span>Plant code (optional — empty accepts any plant)</span>
          <input value={plantCd} onChange={(e) => setPlantCd(e.target.value)} disabled={busy} spellCheck={false} />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={syncRoles}
            onChange={(e) => setSyncRoles(e.target.checked)}
            disabled={busy}
          />
          <span>Re-sync roles from RBA groups on every login</span>
        </label>
      </div>

      {enabled && !settings?.enabled && (
        <p className="users-notice">
          Before signing out, make sure your own RBA account holds an admin group (e.g.{' '}
          <code>{(applicationCd || 'DOC').toUpperCase()}_ADMIN</code>) — with RBA on, it is the only
          way back to this page. Your current session stays valid either way.
        </p>
      )}

      <div className="users-form-actions" style={{ marginTop: 8 }}>
        <button type="button" className="btn sm primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save sign-in settings'}
        </button>
        {settings?.source === 'settings' && (
          <button type="button" className="btn sm" disabled={busy} onClick={revert}>
            Revert to server configuration
          </button>
        )}
        {saved && <span className="users-ok">Saved — applies to the next sign-in.</span>}
      </div>

      <div className="users-form" style={{ marginTop: 12 }}>
        <p className="muted sm" style={{ marginBottom: 4 }}>
          Test the connection using the settings saved above. Leave the fields empty to only check
          that RBA is reachable; with credentials it reports the role that account would get.
          Nothing is created or changed by a test.
        </p>
        <div className="field-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            placeholder="Username (optional)"
            value={testUser}
            onChange={(e) => setTestUser(e.target.value)}
            disabled={testing}
            autoComplete="off"
            style={{ flex: '1 1 160px' }}
          />
          <input
            type="password"
            placeholder="Password (optional)"
            value={testPassword}
            onChange={(e) => setTestPassword(e.target.value)}
            disabled={testing}
            autoComplete="new-password"
            style={{ flex: '1 1 160px' }}
          />
          <button type="button" className="btn sm" disabled={testing} onClick={test}>
            {testing ? 'Testing…' : 'Test connection'}
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
