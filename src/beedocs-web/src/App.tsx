import { useEffect, useState } from 'react'
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom'
import { ThemeProvider } from './theme'
import { WorkspaceProvider } from './workspace/WorkspaceContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { WorkspaceShell } from './components/WorkspaceShell'
import { LoginScreen } from './components/LoginScreen'
import { SetupScreen } from './components/SetupScreen'
import { api } from './api'
import { getRouterBasename } from './basePath'
import './styles/users.css'

/**
 * A data router, not <BrowserRouter>, for one reason: `useBlocker`. The AI
 * provider form holds a pasted API key that is not recoverable once dropped, and
 * only the router sees every way out of the page — programmatic navigations from
 * the Ctrl+K search palette and the tree's context menus, plus Back/Forward,
 * which fire neither a click nor beforeunload. A document-level click guard only
 * ever caught anchors.
 *
 * Built once at module scope: rebuilding it on render would remount the tree and
 * throw the very state the blocker exists to protect.
 *
 * The shell renders for every route, so the layout route carries the providers
 * and each path resolves to the same component — React keeps its state across
 * navigations because the element type and position never change.
 */
/**
 * Sign-in stands between the router and the workspace, not inside it.
 *
 * WorkspaceProvider loads the library the moment it mounts, so rendering it for
 * a visitor with no session means a burst of requests that all 401 before the
 * login form is even on screen. Mounting it only once there is a session keeps
 * that from happening — and because the router (and therefore the route) is
 * untouched underneath, signing in lands on the page that was asked for.
 */
function AuthGate() {
  const { state, needsLogin, needsSetup } = useAuth()
  const [version, setVersion] = useState<string | null>(null)

  // /api/version is anonymous, so this is the one thing worth knowing before
  // signing in: which build is asking for the password.
  useEffect(() => {
    if (!needsLogin && !needsSetup) return
    let cancelled = false
    api
      .getVersion()
      .then((v) => !cancelled && setVersion(v.version))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [needsLogin, needsSetup])

  // Blank rather than a spinner: /api/auth/me is a local round trip, and a
  // flash of "loading" on every reload of an ungated instance is worse than a
  // frame of nothing.
  if (state === null) return null

  // An instance with no accounts is unclaimed: the first person here creates the
  // admin rather than being asked to sign in as one that does not exist.
  if (needsSetup) return <SetupScreen version={version} />

  if (needsLogin) return <LoginScreen version={version} />

  return (
    <WorkspaceProvider>
      <Outlet />
    </WorkspaceProvider>
  )
}

const router = createBrowserRouter(
  [
    {
      element: (
        <AuthProvider>
          <AuthGate />
        </AuthProvider>
      ),
      children: [
        { path: '/', element: <WorkspaceShell /> },
        { path: '/settings', element: <WorkspaceShell /> },
        { path: '/help', element: <WorkspaceShell /> },
        { path: '/shelves/:shelfId', element: <WorkspaceShell /> },
        { path: '/books/:bookId', element: <WorkspaceShell /> },
        { path: '/books/:bookId/pages/:pageId', element: <WorkspaceShell /> },
        { path: '/books/:bookId/diagrams/:diagramId', element: <WorkspaceShell /> },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: getRouterBasename() },
)

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}
