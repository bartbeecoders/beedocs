import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useI18n, type MessageKey } from '../i18n'
import { refreshUserDirectory } from '../hooks/useUserDirectory'
import type { User, UserRole } from '../types'
import '../styles/users.css'

const ROLE_IDS: UserRole[] = ['admin', 'editor', 'viewer']

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Null when there is no valid date — the caller renders its own "never". */
function formatDate(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString()
}

/**
 * The dedicated account-management page at /users. Admin-only: the API answers
 * /api/users only to admins, so for anyone else this page explains rather than
 * rendering a list of guaranteed 403s. Your *own* account (password change)
 * stays in Settings, which every role can reach.
 */
export function UsersPage() {
  const { authEnabled, canManageUsers, user: me, rbaEnabled } = useAuth()
  const { t } = useI18n()

  return (
    <div className="settings-panel users-page">
      <header className="settings-header">
        <h1>{t('common.users')}</h1>
        <p className="muted">{t('users.pageLead')}</p>
      </header>

      {!authEnabled ? (
        <section className="settings-section">
          <p className="muted sm">
            {t('users.authOffBefore')} <code>BeeDocs__Auth__Enabled=true</code>{' '}
            {t('users.authOffAfter')}
          </p>
        </section>
      ) : !canManageUsers ? (
        <section className="settings-section">
          <p className="muted sm">
            {t('users.signedInAs')} <strong>{me?.displayName || me?.username}</strong> (
            {t(`common.${me?.role ?? 'viewer'}` as MessageKey)}). {t('users.onlyAdminManages')}{' '}
            {t('users.ownPasswordPrefix')} <Link to="/settings/account">{t('common.settings')}</Link>
            {t('users.ownPasswordSuffix')}
          </p>
        </section>
      ) : (
        <section className="settings-section">
          {rbaEnabled && <p className="users-notice">{t('users.rbaNotice')}</p>}
          <UserList meId={me?.id ?? null} />
        </section>
      )}
    </div>
  )
}

function UserList({ meId }: { meId: string | null }) {
  const { t } = useI18n()
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** id of the row whose reset/edit panel is open */
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // Owner pickers read a cached directory; a rename, a new account or a
      // disable has to reach them too.
      refreshUserDirectory()
      setUsers(await api.listUsers())
      setError(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="users-card">
      <header className="users-card-head">
        <div>
          <h3>{t('users.accounts')}</h3>
          <p className="muted sm">{t('users.accountsLead')}</p>
        </div>
        <button type="button" className="btn sm" onClick={() => setAdding((v) => !v)}>
          {adding ? t('common.cancel') : t('users.addUser')}
        </button>
      </header>

      {adding && (
        <NewUserForm
          onCancel={() => setAdding(false)}
          onCreated={async () => {
            setAdding(false)
            await load()
          }}
        />
      )}

      {error && (
        <p className="users-error" role="alert">
          {error}{' '}
          <button type="button" className="btn ghost sm" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </p>
      )}

      {loading && users.length === 0 ? (
        <p className="muted sm">{t('users.loadingAccounts')}</p>
      ) : (
        <ul className="users-list">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              isSelf={u.id === meId}
              open={openId === u.id}
              onToggle={() => setOpenId((id) => (id === u.id ? null : u.id))}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function UserRow({
  user,
  isSelf,
  open,
  onToggle,
  onChanged,
}: {
  user: User
  isSelf: boolean
  open: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Non-null after a generated reset: the one and only time this string exists. */
  const [generated, setGenerated] = useState<string | null>(null)
  const [manualPassword, setManualPassword] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`users-row ${user.enabled ? '' : 'disabled'}`}>
      <button type="button" className="users-row-head" onClick={onToggle} aria-expanded={open}>
        <span className="users-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="users-identity">
          <strong>{user.displayName || user.username}</strong>
          <span className="muted sm">
            {user.username}
            {user.email ? ` · ${user.email}` : ''} ·{' '}
            {t('users.lastSignIn', { when: formatDate(user.lastLoginAt) ?? t('users.never') })}
          </span>
        </span>
        <span className={`role-pill ${user.role}`}>{t(`common.${user.role}` as MessageKey)}</span>
        {!user.enabled && <span className="users-flag">{t('users.disabled')}</span>}
        {user.mustChangePassword && user.enabled && (
          <span className="users-flag warn" title={t('users.tempPasswordTitle')}>
            {t('users.tempPassword')}
          </span>
        )}
      </button>

      {open && (
        <div className="users-row-body">
          <div className="users-controls">
            <label className="users-field inline">
              <span>{t('users.role')}</span>
              <select
                value={user.role}
                disabled={busy}
                onChange={(e) =>
                  void run(async () => {
                    await api.updateUser(user.id, { role: e.target.value as UserRole })
                    await onChanged()
                  })
                }
              >
                {ROLE_IDS.map((r) => (
                  <option key={r} value={r}>
                    {t(`common.${r}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>

            <label className="check-row">
              <input
                type="checkbox"
                checked={user.enabled}
                disabled={busy}
                onChange={(e) =>
                  void run(async () => {
                    await api.updateUser(user.id, { enabled: e.target.checked })
                    await onChanged()
                  })
                }
              />
              <span>{t('users.enabled')}</span>
            </label>
          </div>

          <p className="muted sm">{t(`users.roleHint.${user.role}` as MessageKey)}</p>

          <div className="users-actions">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api.setUserPassword(user.id, {})
                  setGenerated(result.password)
                  await onChanged()
                })
              }
            >
              {t('users.generatePassword')}
            </button>

            <span className="users-or">{t('users.or')}</span>

            <input
              type="password"
              className="users-inline-input"
              placeholder={t('users.setPasswordPlaceholder')}
              autoComplete="new-password"
              minLength={8}
              value={manualPassword}
              disabled={busy}
              onChange={(e) => setManualPassword(e.target.value)}
            />
            <button
              type="button"
              className="btn sm"
              disabled={busy || manualPassword.length < 8}
              onClick={() =>
                void run(async () => {
                  await api.setUserPassword(user.id, { password: manualPassword })
                  setManualPassword('')
                  setGenerated(null)
                  await onChanged()
                })
              }
            >
              {t('users.set')}
            </button>

            {/* Two clicks, not a confirm() — a browser dialog inside the
                workspace blocks everything, and this is destructive. */}
            {!isSelf &&
              (confirmDelete ? (
                <>
                  <button
                    type="button"
                    className="btn danger sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.deleteUser(user.id)
                        await onChanged()
                      })
                    }
                  >
                    {t('users.deletePermanently')}
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => setConfirmDelete(false)}>
                    {t('users.keep')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn ghost danger sm"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t('common.delete')}
                </button>
              ))}
          </div>

          {generated && (
            <p className="users-generated">
              {t('users.newPasswordFor', { name: user.username })} <code>{generated}</code>
              <span className="muted sm"> {t('users.shownOnce')}</span>
            </p>
          )}

          {error && (
            <p className="users-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  )
}

function NewUserForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<void> }) {
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>('viewer')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      await api.createUser({
        username,
        password,
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        role,
        // The admin picked this password, so its owner should replace it.
        mustChangePassword: true,
      })
      await onCreated()
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  return (
    <form className="users-form new-user" onSubmit={submit}>
      <div className="users-form-grid">
        <label className="users-field">
          <span>{t('auth.username')}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jane.doe"
            autoComplete="off"
            required
            disabled={busy}
          />
        </label>
        <label className="users-field">
          <span>{t('users.displayName')}</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="users-field">
          <span>{t('users.emailOptional')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="users-field">
          <span>{t('users.role')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={busy}>
            {ROLE_IDS.map((r) => (
              <option key={r} value={r}>
                {t(`common.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="users-field">
          <span>{t('auth.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            required
            disabled={busy}
          />
        </label>
      </div>

      <p className="muted sm">{t(`users.roleHint.${role}` as MessageKey)}</p>

      <div className="users-form-actions">
        <button type="submit" className="btn primary sm" disabled={busy}>
          {busy ? t('setup.creating') : t('users.createUser')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        {error && (
          <span className="users-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}
