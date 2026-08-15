import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import type { UserRole } from '../types'

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The one part of account management every signed-in user can reach: their own
 * password. Rendered in Settings; managing *other* accounts lives on the
 * admin-only /users page (UsersPage.tsx).
 *
 * The whole section is behind sign-in being *enabled* — accounts exist either
 * way, but managing logins nobody is asked for is a settings screen that does
 * nothing, and explaining that costs more than hiding it.
 */
export function UsersPanel() {
  const { authEnabled, canManageUsers, user: me } = useAuth()

  if (!authEnabled) {
    return (
      <p className="muted sm">
        Sign-in is off, so every visitor has full access and accounts are not used. Set{' '}
        <code>BeeDocs__Auth__Enabled=true</code> on the API to turn it on — you will then be asked
        to create the administrator account the first time the app loads.
      </p>
    )
  }

  return (
    <div className="users-panel">
      <AccountCard />
      {canManageUsers ? (
        <p className="muted sm">
          Other accounts are managed on the <Link to="/users">Users page</Link>.
        </p>
      ) : (
        <p className="muted sm">
          You are signed in as <strong>{me?.displayName || me?.username}</strong> (
          {ROLE_LABELS[me?.role ?? 'viewer']}). Only an admin can manage accounts.
        </p>
      )}
    </div>
  )
}

/** Change your own password. Available to every role, including viewers. */
function AccountCard() {
  const { user, apply } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (!user) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    // Checked here as well as on the server because the server cannot see it:
    // it only ever receives the one value, so a typo would be saved silently.
    if (next !== confirm) {
      setError('The two new passwords do not match.')
      return
    }

    setBusy(true)
    setError(null)
    setDone(false)
    try {
      apply(await api.changeOwnPassword(current, next))
      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="users-card">
      <header className="users-card-head">
        <div>
          <h3>Your account</h3>
          <p className="muted sm">
            {user.displayName || user.username} · <span className={`role-pill ${user.role}`}>{ROLE_LABELS[user.role]}</span>
          </p>
        </div>
      </header>

      {user.mustChangePassword && (
        <p className="users-notice">
          This account still uses the password it was given. Set your own below.
        </p>
      )}

      <form className="users-form" onSubmit={submit}>
        <label className="users-field">
          <span>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
            required
          />
        </label>
        <label className="users-field">
          <span>New password</span>
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
        <label className="users-field">
          <span>Repeat new password</span>
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

        <div className="users-form-actions">
          <button type="submit" className="btn primary sm" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
          {done && <span className="users-ok">Password changed. Other sessions were signed out.</span>}
          {error && (
            <span className="users-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </form>
    </section>
  )
}
