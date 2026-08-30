import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useBranding } from '../branding'
import { withApiBase } from '../basePath'

/**
 * The one-time first-run screen: an instance with no accounts is unclaimed, and
 * whoever fills this in becomes its administrator with a password they chose.
 *
 * It replaces the login form rather than sitting alongside it — there is nothing
 * to sign in to yet — and disappears for good the moment the account exists,
 * because the server stops reporting `setupRequired`.
 */
export function SetupScreen({ version }: { version?: string | null }) {
  const { setup } = useAuth()
  const { t } = useI18n()
  const { branding } = useBranding()
  const [username, setUsername] = useState('admin')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    // The server only ever receives one of the two, so a typo would otherwise be
    // saved silently — and this is the one password nobody can reset for you.
    if (password !== confirm) {
      setError(t('setup.mismatch'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      await setup(username, password, displayName)
      // No navigation: setup signs the account in, so needsSetup and needsLogin
      // both go false and the shell renders the workspace.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
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
          <span className="login-title">{t('setup.welcome', { title: branding.title })}</span>
          {version && <span className="ws-version-pill">v{version}</span>}
        </div>

        <p className="muted sm login-lead">
{t('setup.lead')}
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
          <span>{t('setup.displayName')}</span>
          <input
            name="displayName"
            autoComplete="name"
            placeholder="Jane Doe"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="login-field">
          <span>{t('auth.password')}</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="login-field">
          <span>{t('setup.repeatPassword')}</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            required
          />
        </label>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn primary login-submit" disabled={busy}>
          {busy ? t('setup.creating') : t('setup.create')}
        </button>

        <p className="muted sm login-hint">
{t('setup.hint')}
        </p>
      </form>
    </div>
  )
}
