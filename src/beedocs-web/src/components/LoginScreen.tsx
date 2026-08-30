import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useBranding } from '../branding'
import { withApiBase } from '../basePath'

/**
 * The whole app when sign-in is enabled and nobody is signed in. It renders
 * instead of the workspace rather than over it, so no library fetch is made
 * before there is a session to make it with — every one of them would 401.
 *
 * With RBA on the form offers two methods: the corporate (RBA) account —
 * credentials go from this browser straight to RBA — and the classic local
 * BeeDocs account, kept as an explicit fallback so an unreachable RBA can
 * never lock a local admin out of the instance that configured it.
 */
export function LoginScreen({ version }: { version?: string | null }) {
  const { login, rbaEnabled } = useAuth()
  const { t } = useI18n()
  const { branding } = useBranding()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Only meaningful while rbaEnabled — without RBA every login is local. */
  const [useLocalAccount, setUseLocalAccount] = useState(false)

  const rbaMode = rbaEnabled && !useLocalAccount

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      await login(username, password, useLocalAccount)
      // No navigation and no state reset: needsLogin flips to false and the
      // shell renders the workspace on the route the user asked for.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPassword('')
      setBusy(false)
    }
  }

  const switchMethod = () => {
    setUseLocalAccount((v) => !v)
    setError(null)
    setPassword('')
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-mark" aria-hidden>
            {branding.logoUrl ? (
              <img className="login-logo" src={withApiBase(branding.logoUrl)} alt="" />
            ) : (
              '🐝'
            )}
          </span>
          <span className="login-title">{branding.title}</span>
          {version && <span className="ws-version-pill">v{version}</span>}
        </div>

        <p className="muted sm login-lead">
          {rbaMode
            ? t('auth.leadRba')
            : rbaEnabled
              ? t('auth.leadLocal')
              : t('auth.leadDefault')}
        </p>

        <label className="login-field">
          <span>{t('auth.username')}</span>
          <input
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="login-field">
          <span>{t('auth.password')}</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        {/* role="alert" so a screen reader hears the rejection — the field
            clearing under the cursor is otherwise the only feedback. */}
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn primary login-submit" disabled={busy}>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </button>

        {rbaEnabled && (
          <button type="button" className="login-method-switch" onClick={switchMethod} disabled={busy}>
            {useLocalAccount
              ? t('auth.useRbaInstead')
              : t('auth.useLocalInstead')}
          </button>
        )}

        <p className="muted sm login-hint">
          {rbaMode ? t('auth.hintRba') : t('auth.hintLocal')}
        </p>
      </form>
    </div>
  )
}
