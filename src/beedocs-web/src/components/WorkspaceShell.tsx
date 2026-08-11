import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { loadPaneLayout, savePaneLayout, type PaneLayout } from '../workspace/layoutPrefs'
import { api } from '../api'
import { NavTree } from './NavTree'
import { ResizablePane } from './ResizablePane'
import { PageCanvas, type PageEditorState } from './PageCanvas'
import { DiagramCanvas, type DiagramEditorState } from './DiagramCanvas'
import { PropertiesPane } from './PropertiesPane'
import { SettingsPanel } from './SettingsPanel'
import { HelpPanel } from './HelpPanel'
import { ExportMenu } from './ExportMenu'
import { WorkspaceToolbar } from './WorkspaceToolbar'
import { SearchPalette } from './SearchPalette'
import { NamePromptDialog } from './NamePromptDialog'

export function WorkspaceShell() {
  const location = useLocation()
  const params = useParams()
  const { themeDef } = useTheme()
  const { books, expandBook, syncSelectionFromRoute } = useWorkspace()
  const [layout, setLayout] = useState<PaneLayout>(() => loadPaneLayout())
  const [pageState, setPageState] = useState<PageEditorState | null>(null)
  const [diagramState, setDiagramState] = useState<DiagramEditorState | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  // Ctrl/Cmd+K from anywhere, including while typing in the editor — search is
  // navigation, not text entry, so it outranks whatever has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Which build is live. Fetched once; failure is non-fatal — the pill just
  // stays hidden rather than blocking the shell.
  useEffect(() => {
    let cancelled = false
    api
      .getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v.version)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const view = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return 'settings' as const
    if (location.pathname.startsWith('/help')) return 'help' as const
    if (params.pageId) return 'page' as const
    if (params.diagramId) return 'diagram' as const
    if (params.bookId) return 'book' as const
    return 'welcome' as const
  }, [location.pathname, params.bookId, params.pageId, params.diagramId])

  // Keep toolbar selection aligned with the route (folders stick until route changes).
  useEffect(() => {
    syncSelectionFromRoute({
      view,
      bookId: params.bookId,
      pageId: params.pageId,
      diagramId: params.diagramId,
    })
  }, [view, params.bookId, params.pageId, params.diagramId, syncSelectionFromRoute])

  // Expand book when navigating into it
  useEffect(() => {
    if (params.bookId) void expandBook(params.bookId)
  }, [params.bookId, expandBook])

  const patchLayout = useCallback((partial: Partial<PaneLayout>) => {
    setLayout((prev) => {
      const next = { ...prev, ...partial }
      savePaneLayout(next)
      return next
    })
  }, [])

  const breadcrumb = useMemo(() => {
    if (view === 'settings') return [{ label: 'Settings' }]
    if (view === 'help') return [{ label: 'About & Help' }]
    const book = books.find((b) => b.id === params.bookId)
    const crumbs: { label: string; to?: string }[] = [{ label: 'Library', to: '/' }]
    if (book) {
      crumbs.push({ label: book.title, to: `/books/${book.id}` })
      if (params.pageId) {
        const page = book.pages.find((p) => p.id === params.pageId)
        crumbs.push({ label: page?.title ?? pageState?.title ?? 'Page' })
      } else if (params.diagramId) {
        const diagram = book.diagrams.find((d) => d.id === params.diagramId)
        crumbs.push({ label: diagram?.title ?? diagramState?.title ?? 'Diagram' })
      }
    }
    return crumbs
  }, [view, books, params.bookId, params.pageId, params.diagramId, pageState?.title, diagramState?.title])

  return (
    <div className="workspace">
      <header className="ws-header">
        <div className="ws-header-left">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>
              🐝
            </span>
            <span className="brand-text">BeeDocs</span>
          </Link>
          {version && (
            <span className="ws-version-pill" title={`Build ${version}`}>
              v{version}
            </span>
          )}
          <nav className="ws-breadcrumb" aria-label="Breadcrumb">
            {breadcrumb.map((c, i) => (
              <span key={`${c.label}-${i}`} className="ws-crumb">
                {i > 0 && <span className="ws-crumb-sep">/</span>}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
              </span>
            ))}
          </nav>
        </div>
        <div className="ws-header-right">
          <button
            type="button"
            className="ws-search-trigger"
            onClick={() => setSearchOpen(true)}
            title="Search the library (Ctrl+K)"
          >
            <span aria-hidden="true">{'⌕'}</span>
            <span className="ws-search-trigger-text">Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <span className="ws-theme-pill" title="Active theme">
            {themeDef.label}
          </span>
          <UserMenu />
          <Link to="/help" className={`btn ghost sm ${view === 'help' ? 'active-nav' : ''}`}>
            Help
          </Link>
          <Link
            to="/settings"
            className={`btn ghost sm ${view === 'settings' ? 'active-nav' : ''}`}
          >
            Settings
          </Link>
        </div>
      </header>

      <WorkspaceToolbar
        view={view}
        bookId={params.bookId}
        pageId={params.pageId}
        diagramId={params.diagramId}
        pageState={pageState}
        diagramState={diagramState}
      />

      <div className="ws-body">
        <ResizablePane
          side="left"
          title="Library"
          width={layout.leftWidth}
          collapsed={layout.leftCollapsed}
          onResize={(leftWidth) => patchLayout({ leftWidth })}
          onToggle={() => patchLayout({ leftCollapsed: !layout.leftCollapsed })}
        >
          <NavTree />
        </ResizablePane>

        <main className="ws-center">
          {view === 'settings' && (
            <SettingsPanel
              onResetPanes={() =>
                setLayout({
                  leftWidth: 280,
                  rightWidth: 300,
                  leftCollapsed: false,
                  rightCollapsed: false,
                })
              }
            />
          )}
          {view === 'help' && <HelpPanel />}
          {view === 'welcome' && <WelcomeCanvas />}
          {view === 'book' && <BookOverview bookId={params.bookId!} />}
          {view === 'page' && <PageCanvas onStateChange={setPageState} />}
          {view === 'diagram' && <DiagramCanvas onStateChange={setDiagramState} />}
        </main>

        <ResizablePane
          side="right"
          title="Properties"
          width={layout.rightWidth}
          collapsed={layout.rightCollapsed}
          min={200}
          max={480}
          onResize={(rightWidth) => patchLayout({ rightWidth })}
          onToggle={() => patchLayout({ rightCollapsed: !layout.rightCollapsed })}
        >
          <PropertiesPane pageState={pageState} diagramState={diagramState} view={view} />
        </ResizablePane>
      </div>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

/**
 * Who is signed in, and the way out. Renders nothing when sign-in is disabled —
 * there is no account to name and no session to end, and an "anonymous" chip in
 * the header of a single-user instance is pure noise.
 */
function UserMenu() {
  const { authEnabled, user, logout } = useAuth()
  const [open, setOpen] = useState(false)

  // Click-outside and Escape, because the popover has no backdrop to catch either.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ws-user-menu')) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!authEnabled || !user) return null

  const name = user.displayName || user.username
  const initials = name.slice(0, 2).toUpperCase()

  return (
    <div className="ws-user-menu">
      <button
        type="button"
        className="ws-user-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Signed in as ${user.username}`}
      >
        <span className="ws-user-avatar" aria-hidden>
          {initials}
        </span>
        <span className="ws-user-name">{name}</span>
      </button>

      {open && (
        <div className="ws-user-popover">
          <strong>{name}</strong>
          <span className="muted sm">{user.username}</span>
          <span className={`role-pill ${user.role}`}>{ROLE_LABELS[user.role] ?? user.role}</span>
          <Link to="/settings" className="btn ghost sm" onClick={() => setOpen(false)}>
            Account &amp; settings
          </Link>
          <button type="button" className="btn sm" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function WelcomeCanvas() {
  const { canWrite } = useAuth()
  return (
    <div className="welcome-canvas">
      <div className="welcome-card">
        <h1>Architecture documentation workspace</h1>
        <p className="muted">
          {canWrite
            ? 'Select a book in the library, or create one. Edit pages in the center canvas with live Markdown, Mermaid, BeeDiagram, images, PDFs, and 3D model embeds.'
            : 'Select a book in the library to read it. Pages render Markdown, Mermaid, BeeDiagram, images, PDFs, and 3D model embeds.'}
        </p>
        {/* The three steps are an author's onboarding; a read-only account is
            being told to do things its role forbids. */}
        {canWrite && (
          <ul className="welcome-steps">
            <li>
              <strong>1.</strong> Create a book in the left library
            </li>
            <li>
              <strong>2.</strong> Add pages for C4 / design notes
            </li>
            <li>
              <strong>3.</strong> Attach BeeDiagrams and embed them in Markdown
            </li>
          </ul>
        )}
        <p className="muted sm">
          New here? Read <Link to="/help">About &amp; Help</Link> — including how to connect an AI
          agent to this instance over MCP.
        </p>
      </div>
    </div>
  )
}

function BookOverview({ bookId }: { bookId: string }) {
  const navigate = useNavigate()
  const { canWrite } = useAuth()
  const { books, createPage, createDiagram } = useWorkspace()
  const book = books.find((b) => b.id === bookId)
  const [prompt, setPrompt] = useState<'page' | 'diagram' | null>(null)

  if (!book) {
    return <div className="canvas-message muted">Loading book…</div>
  }

  return (
    <div className="book-overview">
      <div className="book-overview-head">
        <h1>{book.title}</h1>
        <ExportMenu scope="book" id={book.id} title={book.title} />
      </div>
      {book.description && <p className="muted lead">{book.description}</p>}
      <div className="overview-stats">
        <div className="stat">
          <span className="stat-value">{book.pages.length}</span>
          <span className="stat-label">Pages</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.diagrams.length}</span>
          <span className="stat-label">Diagrams</span>
        </div>
      </div>
      <p className="muted">
        Choose a page or diagram from the tree to open it in the editor. Properties appear on the
        right.
      </p>
      {canWrite && (
        <div className="row" style={{ gap: '0.5rem', marginTop: '1rem' }}>
          <button type="button" className="btn primary sm" onClick={() => setPrompt('page')}>
            New page
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('diagram')}>
            New diagram
          </button>
        </div>
      )}

      <NamePromptDialog
        open={prompt === 'page'}
        title="New page"
        label="Page title"
        placeholder="e.g. System Context"
        confirmLabel="Create page"
        onSubmit={async (title) => {
          const p = await createPage(bookId, title)
          void navigate(`/books/${bookId}/pages/${p.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
      <NamePromptDialog
        open={prompt === 'diagram'}
        title="New diagram"
        label="Diagram title"
        placeholder="e.g. Network overview"
        confirmLabel="Create diagram"
        onSubmit={async (title) => {
          const d = await createDiagram(bookId, title)
          void navigate(`/books/${bookId}/diagrams/${d.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
    </div>
  )
}
