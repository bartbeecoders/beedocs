import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useI18n, type MessageKey } from '../i18n'
import type { UserRole } from '../types'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function roleKey(role: UserRole | undefined): MessageKey {
  return `common.${role ?? 'viewer'}` as MessageKey
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
  const { t } = useI18n()

  if (!authEnabled) {
    return (
      <p className="muted sm">
        {t('users.authOffBefore')} <code>BeeDocs__Auth__Enabled=true</code>{' '}
        {t('users.authOffAfter')}
      </p>
    )
  }

  return (
    <div className="users-panel">
      <AccountCard />
      <GitEmailCard />
      {canManageUsers ? (
        <p className="muted sm">
          {t('users.otherAccountsPrefix')} <Link to="/users">{t('users.usersPage')}</Link>
          {t('users.otherAccountsSuffix')}
        </p>
      ) : (
        <p className="muted sm">
          {t('users.signedInAs')} <strong>{me?.displayName || me?.username}</strong> (
          {t(roleKey(me?.role))}). {t('users.onlyAdminManages')}
        </p>
      )}
    </div>
  )
}

/**
 * Your git author email — the identity git-integration commits carry into git
 * history. Self-service for every role: the server refuses commits until one is
 * set, and this is where that refusal points.
 */
function GitEmailCard() {
  const { user, apply } = useAuth()
  const { t } = useI18n()
  const [value, setValue] = useState(user?.gitEmail ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (!user) return null

  const dirty = value.trim() !== (user.gitEmail ?? '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !dirty) return
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      apply(await api.setGitEmail(value.trim()))
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
          <h3>{t('users.gitIdentity')}</h3>
          <p className="muted sm">
            {t('users.gitLeadBefore')} <strong>{user.displayName || user.username}</strong>{' '}
            {t('users.gitLeadAfter')}
          </p>
        </div>
      </header>

      <form className="users-form" onSubmit={submit}>
        <label className="users-field">
          <span>{t('users.gitEmail')}</span>
          <input
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="you@example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="users-form-actions">
          <button type="submit" className="btn primary sm" disabled={busy || !dirty}>
            {busy ? t('common.saving') : t('users.saveGitEmail')}
          </button>
          {done && <span className="users-ok">{t('common.saved')}</span>}
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

/** Change your own password. Available to every role, including viewers. */
function AccountCard() {
  const { user, apply, rbaEnabled } = useAuth()
  const { t } = useI18n()
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
      setError(t('users.passwordMismatch'))
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
          <h3>{t('users.yourAccount')}</h3>
          <p className="muted sm">
            {user.displayName || user.username} ·{' '}
            <span className={`role-pill ${user.role}`}>{t(roleKey(user.role))}</span>
          </p>
        </div>
      </header>

      {/* In RBA mode the form stays: local (integrated) accounts remain a
          supported sign-in path. An RBA-provisioned account cannot use it —
          its stored password is a random token nobody knows. */}
      {rbaEnabled && <p className="muted sm">{t('users.rbaPasswordNote')}</p>}
      <>
      {user.mustChangePassword && (
        <p className="users-notice">{t('users.mustChangeNotice')}</p>
      )}

      <form className="users-form" onSubmit={submit}>
        <label className="users-field">
          <span>{t('users.currentPassword')}</span>
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
        <label className="users-field">
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

        <div className="users-form-actions">
          <button type="submit" className="btn primary sm" disabled={busy}>
            {busy ? t('common.saving') : t('users.changePassword')}
          </button>
          {done && <span className="users-ok">{t('users.passwordChanged')}</span>}
          {error && (
            <span className="users-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </form>
      </>
    </section>
  )
}
