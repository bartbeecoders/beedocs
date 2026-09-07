import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useBranding } from '../branding'
import { withApiBase } from '../basePath'
import { api } from '../api'

/**
 * Full-screen gate after login when the account still has a temporary password.
 * The workspace is not mounted until the change succeeds — the API also refuses
 * other routes while `mustChangePassword` is set.
 */
export function ChangePasswordScreen({ version }: { version?: string | null }) {
  const { apply, logout, user } = useAuth()
  const { t } = useI18n()
  const { branding } = useBranding()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (next !== confirm) {
      setError(t('users.passwordMismatch'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      apply(await api.changeOwnPassword(current, next))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
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

        <p className="muted sm login-lead">{t('auth.mustChangeLead')}</p>
        {user && (
          <p className="muted sm">
            {user.displayName || user.username}
          </p>
        )}

        <label className="login-field">
          <span>{t('users.currentPassword')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
            required
            autoFocus
          />
        </label>
        <label className="login-field">
          <span>{t('users.newPassword')}</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
            required
          />
        </label>
        <label className="login-field">
          <span>{t('users.repeatNewPassword')}</span>
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

        <p className="muted sm">{t('auth.mustChangeHint')}</p>

        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? t('common.saving') : t('users.changePassword')}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={() => void logout()}
        >
          {t('shell.signOut')}
        </button>
      </form>
    </div>
  )
}
