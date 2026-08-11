import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { refreshUserDirectory } from '../hooks/useUserDirectory'
import type { User, UserRole } from '../types'

const ROLES: { id: UserRole; label: string; hint: string }[] = [
  { id: 'admin', label: 'Admin', hint: 'Everything, plus accounts and AI provider settings' },
  { id: 'editor', label: 'Editor', hint: 'Create, edit and delete books, pages and diagrams' },
  { id: 'viewer', label: 'Viewer', hint: 'Read, search and export — no changes' },
]

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatDate(value: string | null): string {
  if (!value) return 'never'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleDateString()
}

/**
 * Account management, plus the one part of it every signed-in user can reach:
 * their own password. Rendered in Settings.
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
        <UserList meId={me?.id ?? null} />
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

function UserList({ meId }: { meId: string | null }) {
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
          <h3>Accounts</h3>
          <p className="muted sm">Who can reach this instance, and with what authority.</p>
        </div>
        <button type="button" className="btn sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : 'Add user'}
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
            Retry
          </button>
        </p>
      )}

      {loading && users.length === 0 ? (
        <p className="muted sm">Loading accounts…</p>
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
            {user.email ? ` · ${user.email}` : ''} · last sign-in {formatDate(user.lastLoginAt)}
          </span>
        </span>
        <span className={`role-pill ${user.role}`}>{ROLE_LABELS[user.role]}</span>
        {!user.enabled && <span className="users-flag">Disabled</span>}
        {user.mustChangePassword && user.enabled && (
          <span className="users-flag warn" title="Still using an assigned password">
            Temp password
          </span>
        )}
      </button>

      {open && (
        <div className="users-row-body">
          <div className="users-controls">
            <label className="users-field inline">
              <span>Role</span>
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
                {ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
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
              <span>Enabled</span>
            </label>
          </div>

          <p className="muted sm">{ROLES.find((r) => r.id === user.role)?.hint}</p>

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
              Generate new password
            </button>

            <span className="users-or">or</span>

            <input
              type="password"
              className="users-inline-input"
              placeholder="Set a password…"
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
              Set
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
                    Delete permanently
                  </button>
                  <button type="button" className="btn ghost sm" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn ghost danger sm"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              ))}
          </div>

          {generated && (
            <p className="users-generated">
              New password for <strong>{user.username}</strong>: <code>{generated}</code>
              <span className="muted sm"> — shown once. Copy it now; only the hash is stored.</span>
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
          <span>Username</span>
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
          <span>Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="users-field">
          <span>Email (optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label className="users-field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={busy}>
            {ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="users-field">
          <span>Password</span>
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

      <p className="muted sm">{ROLES.find((r) => r.id === role)?.hint}</p>

      <div className="users-form-actions">
        <button type="submit" className="btn primary sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>
          Cancel
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
