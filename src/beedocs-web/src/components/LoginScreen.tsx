import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'

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
            🐝
          </span>
          <span className="login-title">BeeDocs</span>
          {version && <span className="ws-version-pill">v{version}</span>}
        </div>

        <p className="muted sm login-lead">
          {rbaMode
            ? 'Sign in with your corporate (RBA) account to open the documentation workspace.'
            : rbaEnabled
              ? 'Sign in with a local BeeDocs account.'
              : 'Sign in to open the documentation workspace.'}
        </p>

        <label className="login-field">
          <span>Username</span>
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
          <span>Password</span>
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
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {rbaEnabled && (
          <button type="button" className="login-method-switch" onClick={switchMethod} disabled={busy}>
            {useLocalAccount
              ? 'Use your corporate (RBA) account instead'
              : 'Use a local BeeDocs account instead'}
          </button>
        )}

        <p className="muted sm login-hint">
          {rbaMode
            ? 'Access is granted through RBA — ask to be added to a DOC group if sign-in is refused.'
            : 'Forgotten your password? An admin can reset it from Settings → Users & roles.'}
        </p>
      </form>
    </div>
  )
}
