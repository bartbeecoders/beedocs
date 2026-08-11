import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api, onUnauthorized } from '../api'
import type { AuthState, User } from '../types'

/**
 * What the app assumes before /api/auth/me answers, and what it falls back to
 * when that call fails outright. Wide open on purpose: sign-in is opt-in
 * server-side, and an instance that never enabled it must not show a login
 * screen because one fetch lost a race with a restart.
 */
const OPEN: AuthState = {
  authEnabled: false,
  authenticated: true,
  via: 'open',
  user: null,
  permissions: { canRead: true, canWrite: true, canManageUsers: true },
  setupRequired: false,
}

type AuthCtx = {
  /** Null until the first /api/auth/me settles — the shell shows a splash meanwhile. */
  state: AuthState | null
  user: User | null
  /** True only when sign-in is enabled *and* nobody is signed in. */
  needsLogin: boolean
  /**
   * The instance has no accounts at all and sign-in is on: it is unclaimed, and
   * the setup screen shows instead of the login form. Both conditions matter —
   * an instance running openly has never needed an account and must not be
   * interrupted to create one.
   */
  needsSetup: boolean
  canWrite: boolean
  canManageUsers: boolean
  /** Whether to show sign-in affordances at all (hidden entirely when auth is off). */
  authEnabled: boolean
  login: (username: string, password: string) => Promise<void>
  /** Claim an unclaimed instance. Signs the new admin in on success. */
  setup: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-read /api/auth/me — after a self password change, or a 401 from anywhere. */
  refresh: () => Promise<void>
  /** Replace the cached state from a response that already carries it (login, password change). */
  apply: (next: AuthState) => void
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)

  // A 401 can arrive from several in-flight requests at once when a session
  // dies. Without this they would each queue their own /api/auth/me.
  const refreshing = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async () => {
    if (refreshing.current) return refreshing.current

    const run = (async () => {
      try {
        setState(await api.getAuthState())
      } catch {
        // The server is unreachable or too old to know this route. Either way,
        // locking the user out of a workspace that may not even be gated would
        // be the wrong guess.
        setState(OPEN)
      } finally {
        refreshing.current = null
      }
    })()

    refreshing.current = run
    return run
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Any 401 outside /api/auth/* means the session this app thought it had is
  // gone. Re-reading is enough: needsLogin flips and the shell swaps in the
  // login screen with everything else left where it was.
  useEffect(() => onUnauthorized(() => void refresh()), [refresh])

  const login = useCallback(async (username: string, password: string) => {
    setState(await api.login(username, password))
  }, [])

  const setup = useCallback(async (username: string, password: string, displayName?: string) => {
    setState(await api.setup(username, password, displayName))
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      // Whatever the server said, this browser is done with the session — and if
      // the call failed because the cookie was already invalid, re-reading is
      // exactly the right response anyway.
      await refresh()
    }
  }, [refresh])

  const value = useMemo<AuthCtx>(() => {
    const resolved = state ?? OPEN
    const needsSetup = resolved.authEnabled && resolved.setupRequired
    return {
      state,
      user: resolved.user,
      // Setup outranks login: with no accounts there is nothing to sign in to.
      needsLogin: resolved.authEnabled && !resolved.authenticated && !needsSetup,
      needsSetup,
      canWrite: resolved.permissions.canWrite,
      canManageUsers: resolved.permissions.canManageUsers,
      authEnabled: resolved.authEnabled,
      login,
      setup,
      logout,
      refresh,
      apply: setState,
    }
  }, [state, login, setup, logout, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
