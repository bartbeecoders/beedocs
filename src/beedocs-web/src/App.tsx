import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom'
import { ThemeProvider } from './theme'
import { WorkspaceProvider } from './workspace/WorkspaceContext'
import { WorkspaceShell } from './components/WorkspaceShell'
import { getRouterBasename } from './basePath'

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
const router = createBrowserRouter(
  [
    {
      element: (
        <WorkspaceProvider>
          <Outlet />
        </WorkspaceProvider>
      ),
      children: [
        { path: '/', element: <WorkspaceShell /> },
        { path: '/settings', element: <WorkspaceShell /> },
        { path: '/help', element: <WorkspaceShell /> },
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
