import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { loadPaneLayout, savePaneLayout, type PaneLayout } from '../workspace/layoutPrefs'
import { api } from '../api'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { NavTree } from './NavTree'
import { ResizablePane } from './ResizablePane'
import { PageCanvas, type PageEditorState } from './PageCanvas'
import { DiagramCanvas, type DiagramEditorState } from './DiagramCanvas'
import { SlideCanvas, type SlideEditorState } from './SlideCanvas'
import { AttachmentCanvas, type AttachmentEditorState } from './AttachmentCanvas'
import { PropertiesPane } from './PropertiesPane'
import { SettingsPanel } from './SettingsPanel'
import { UsersPage } from './UsersPage'
import { StatsPage } from './StatsPage'
import { HelpPanel } from './HelpPanel'
import { ExportMenu } from './ExportMenu'
import { WorkspaceToolbar } from './WorkspaceToolbar'
import { SearchPalette } from './SearchPalette'
import { NamePromptDialog } from './NamePromptDialog'
import {
  ATTACHMENT_ACCEPT,
  attachmentIcon,
  attachmentTypeLabel,
  dragHasFiles,
  formatFileSize,
} from '../media/attachments'
import { useAttachmentUpload } from '../hooks/useAttachmentUpload'
import { useFileDropZone } from '../hooks/useFileDropZone'

export function WorkspaceShell() {
  const location = useLocation()
  const params = useParams()
  const { themeDef } = useTheme()
  const { books, shelves, expandBook, syncSelectionFromRoute } = useWorkspace()
  const [layout, setLayout] = useState<PaneLayout>(() => loadPaneLayout())
  const [pageState, setPageState] = useState<PageEditorState | null>(null)
  const [diagramState, setDiagramState] = useState<DiagramEditorState | null>(null)
  const [slideState, setSlideState] = useState<SlideEditorState | null>(null)
  const [attachmentState, setAttachmentState] = useState<AttachmentEditorState | null>(null)
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

  /**
   * Swallow file drops that miss a drop zone.
   *
   * A file dropped on plain page chrome is, by default, a *navigation*: the
   * browser leaves the workspace and opens the file. That costs whatever was
   * unsaved in the editor, and it is an easy miss now that dragging documents
   * in is a normal thing to do. Nothing here handles the file — the zones that
   * do stopPropagation before this ever runs — it only refuses the default.
   *
   * Scoped to file drags, so dragging selected text inside a textarea and the
   * tree's own item drags are untouched.
   */
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
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
    if (location.pathname.startsWith('/users')) return 'users' as const
    if (location.pathname.startsWith('/stats')) return 'stats' as const
    if (location.pathname.startsWith('/help')) return 'help' as const
    if (params.pageId) return 'page' as const
    if (params.diagramId) return 'diagram' as const
    if (params.deckId) return 'slides' as const
    if (params.attachmentId) return 'attachment' as const
    if (params.bookId) return 'book' as const
    if (params.shelfId) return 'shelf' as const
    return 'welcome' as const
  }, [
    location.pathname,
    params.shelfId,
    params.bookId,
    params.pageId,
    params.diagramId,
    params.deckId,
    params.attachmentId,
  ])

  // Keep toolbar selection aligned with the route (folders stick until route changes).
  useEffect(() => {
    syncSelectionFromRoute({
      view,
      shelfId: params.shelfId,
      bookId: params.bookId,
      pageId: params.pageId,
      diagramId: params.diagramId,
      deckId: params.deckId,
      attachmentId: params.attachmentId,
    })
  }, [
    view,
    params.shelfId,
    params.bookId,
    params.pageId,
    params.diagramId,
    params.deckId,
    params.attachmentId,
    syncSelectionFromRoute,
  ])

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
    if (view === 'users') return [{ label: 'Users' }]
    if (view === 'stats') return [{ label: 'Statistics' }]
    if (view === 'help') return [{ label: 'About & Help' }]
    const book = books.find((b) => b.id === params.bookId)
    const crumbs: { label: string; to?: string }[] = [{ label: 'Library', to: '/' }]
    // A shelf is the level above books, so it goes in front of the book crumb
    // whether we are sitting on the shelf or somewhere below it.
    const shelfId = params.shelfId ?? book?.shelfId ?? null
    const shelf = shelfId ? shelves.find((s) => s.id === shelfId) : undefined
    if (shelf) crumbs.push({ label: shelf.title, to: `/shelves/${shelf.id}` })
    if (book) {
      crumbs.push({ label: book.title, to: `/books/${book.id}` })
      if (params.pageId) {
        const page = book.pages.find((p) => p.id === params.pageId)
        crumbs.push({ label: page?.title ?? pageState?.title ?? 'Page' })
      } else if (params.diagramId) {
        const diagram = book.diagrams.find((d) => d.id === params.diagramId)
        crumbs.push({ label: diagram?.title ?? diagramState?.title ?? 'Diagram' })
      } else if (params.deckId) {
        const deck = book.slideDecks.find((d) => d.id === params.deckId)
        crumbs.push({ label: deck?.title ?? slideState?.title ?? 'Slides' })
      } else if (params.attachmentId) {
        const file = book.attachments.find((a) => a.id === params.attachmentId)
        crumbs.push({ label: file?.title ?? attachmentState?.title ?? 'File' })
      }
    }
    return crumbs
  }, [
    view,
    books,
    shelves,
    params.shelfId,
    params.bookId,
    params.pageId,
    params.diagramId,
    params.deckId,
    params.attachmentId,
    pageState?.title,
    diagramState?.title,
    slideState?.title,
    attachmentState?.title,
  ])

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
          <AppMenu view={view} />
        </div>
      </header>

      <WorkspaceToolbar
        view={view}
        shelfId={params.shelfId}
        bookId={params.bookId}
        pageId={params.pageId}
        diagramId={params.diagramId}
        deckId={params.deckId}
        attachmentId={params.attachmentId}
        pageState={pageState}
        diagramState={diagramState}
        slideState={slideState}
        attachmentState={attachmentState}
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
          {view === 'users' && <UsersPage />}
          {view === 'stats' && <StatsPage />}
          {view === 'help' && <HelpPanel />}
          {view === 'welcome' && <WelcomeCanvas />}
          {view === 'shelf' && <ShelfOverview shelfId={params.shelfId!} />}
          {view === 'book' && <BookOverview bookId={params.bookId!} />}
          {view === 'page' && <PageCanvas onStateChange={setPageState} />}
          {view === 'diagram' && <DiagramCanvas onStateChange={setDiagramState} />}
          {view === 'slides' && <SlideCanvas onStateChange={setSlideState} />}
          {view === 'attachment' && <AttachmentCanvas onStateChange={setAttachmentState} />}
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
          <PropertiesPane
            pageState={pageState}
            diagramState={diagramState}
            slideState={slideState}
            attachmentState={attachmentState}
            view={view}
          />
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
 * The header's utility pages (Users, Statistics, Help, Settings) behind one
 * dropdown — four standalone buttons were crowding out the things used all day.
 * Role gating is per item, so the menu itself always exists: Users is admin-only
 * and pointless with sign-in off; Statistics is useful with sign-in off too —
 * every visitor is effectively an admin there — so canManageUsers alone gates it.
 */
function AppMenu({ view }: { view: string }) {
  const { authEnabled, canManageUsers } = useAuth()
  const [open, setOpen] = useState(false)

  // Click-outside and Escape, because the popover has no backdrop to catch either.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.ws-app-menu')) setOpen(false)
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

  const items = [
    ...(authEnabled && canManageUsers ? [{ to: '/users', view: 'users', label: 'Users' }] : []),
    ...(canManageUsers ? [{ to: '/stats', view: 'stats', label: 'Statistics' }] : []),
    { to: '/help', view: 'help', label: 'About & Help' },
    { to: '/settings', view: 'settings', label: 'Settings' },
  ]
  const onOne = items.some((item) => item.view === view)

  return (
    <div className="ws-app-menu">
      <button
        type="button"
        className={`btn ghost sm ${onOne ? 'active-nav' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Users, statistics, help and settings"
      >
        Menu
        <span className="ws-app-menu-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <nav className="ws-user-popover ws-app-menu-popover" aria-label="Workspace pages">
          {items.map((item) => (
            <Link
              key={item.view}
              to={item.to}
              className={`ws-app-menu-item ${view === item.view ? 'active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  )
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

/**
 * A shelf has no content of its own, so its canvas is the list of books on it
 * and a way to add another.
 */
function ShelfOverview({ shelfId }: { shelfId: string }) {
  const navigate = useNavigate()
  const { canWrite } = useAuth()
  const { shelves, books, createBook } = useWorkspace()
  const shelf = shelves.find((s) => s.id === shelfId)
  const [prompt, setPrompt] = useState(false)

  if (!shelf) {
    return <div className="canvas-message muted">Loading shelf…</div>
  }

  const shelved = books
    .filter((b) => b.shelfId === shelfId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))

  return (
    <div className="book-overview">
      <div className="book-overview-head">
        <h1>📚 {shelf.title}</h1>
      </div>
      {shelf.description && <p className="muted lead">{shelf.description}</p>}
      <p className="muted sm">
        Website:{' '}
        <a href={withBase(bookshelfSitePath(shelf.slug))} target="_blank" rel="noreferrer">
          {withBase(bookshelfSitePath(shelf.slug))}
        </a>
        {shelf.published ? ' · published' : ' · unpublished preview'}
      </p>
      <div className="overview-stats">
        <div className="stat">
          <span className="stat-value">{shelved.length}</span>
          <span className="stat-label">Books</span>
        </div>
      </div>

      {shelved.length > 0 ? (
        <ul className="shelf-book-list">
          {shelved.map((b) => (
            <li key={b.id}>
              <Link to={`/books/${b.id}`} className="shelf-book-link">
                <span aria-hidden>📘</span>
                <span className="shelf-book-title">{b.title}</span>
                {b.description && <span className="muted sm">{b.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {canWrite
            ? 'No books on this shelf yet. Create one, or drag an existing book onto the shelf in the library tree.'
            : 'No books on this shelf yet.'}
        </p>
      )}

      <div className="row" style={{ gap: '0.5rem', marginTop: '1rem' }}>
        <a className="btn primary sm" href={withBase(bookshelfSitePath(shelf.slug))} target="_blank" rel="noreferrer">
          Open website
        </a>
        {canWrite && (
          <button type="button" className="btn sm" onClick={() => setPrompt(true)}>
            New book on this shelf
          </button>
        )}
      </div>

      <NamePromptDialog
        open={prompt}
        title="New book"
        label="Book title"
        placeholder="e.g. Platform Architecture"
        confirmLabel="Create book"
        onSubmit={async (title) => {
          const b = await createBook(title, undefined, shelfId)
          void navigate(`/books/${b.id}`)
        }}
        onClose={() => setPrompt(false)}
      />
    </div>
  )
}

function BookOverview({ bookId }: { bookId: string }) {
  const navigate = useNavigate()
  const { canWrite } = useAuth()
  const { books, createPage, createDiagram, createSlideDeck } = useWorkspace()
  const book = books.find((b) => b.id === bookId)
  const [prompt, setPrompt] = useState<'page' | 'diagram' | 'slides' | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { uploadingIn, error: uploadError, clearError, upload } = useAttachmentUpload()
  // The whole overview is the drop target, not a dedicated strip: this page is
  // where someone goes to see what a book holds, so it is where they arrive
  // holding a document.
  const fileDrop = useFileDropZone({
    enabled: canWrite,
    onFiles: (files) => void upload(bookId, files),
  })
  const uploading = uploadingIn === bookId

  if (!book) {
    return <div className="canvas-message muted">Loading book…</div>
  }

  return (
    <div
      className={`book-overview${fileDrop.dragging ? ' file-drop-over' : ''}`}
      {...fileDrop.dropProps}
    >
      {fileDrop.dragging && (
        <div className="file-drop-overlay">
          <span aria-hidden>📎</span>
          <strong>Drop to add to “{book.title}”</strong>
          <span className="muted sm">PDF, Word, PowerPoint, Excel, archives and images</span>
        </div>
      )}
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
        <div className="stat">
          <span className="stat-value">{book.slideDecks.length}</span>
          <span className="stat-label">Slide decks</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.attachments.length}</span>
          <span className="stat-label">Files</span>
        </div>
      </div>
      <p className="muted">
        Choose a page or diagram from the tree to open it in the editor. Properties appear on the
        right.
        {canWrite && ' Drop a PDF or Office document anywhere on this page to file it here.'}
      </p>

      {book.attachments.length > 0 && (
        <>
          <h2 className="book-overview-subhead">Files</h2>
          <ul className="attachment-list">
            {book.attachments.map((a) => (
              <li key={a.id}>
                <Link to={`/books/${bookId}/files/${a.id}`} className="attachment-list-link">
                  <span aria-hidden>{attachmentIcon(a.fileName, a.contentType)}</span>
                  <span className="attachment-list-title">{a.title}</span>
                  <span className="muted sm">
                    {attachmentTypeLabel(a.fileName, a.contentType)} · {formatFileSize(a.sizeBytes)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {canWrite && (
        <div className="row" style={{ gap: '0.5rem', marginTop: '1rem' }}>
          <button type="button" className="btn primary sm" onClick={() => setPrompt('page')}>
            New page
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('diagram')}>
            New diagram
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('slides')}>
            New slides
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            title="Upload a PDF, Word, PowerPoint or other document into this book"
          >
            {uploading ? 'Uploading…' : 'Upload file'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              void upload(bookId, e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      )}
      {uploadError && (
        <div className="banner error compact" onClick={clearError} role="alert">
          {uploadError}
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
      <NamePromptDialog
        open={prompt === 'slides'}
        title="New slides"
        label="Presentation title"
        placeholder="e.g. Architecture review"
        confirmLabel="Create slides"
        onSubmit={async (title) => {
          const d = await createSlideDeck(bookId, title)
          void navigate(`/books/${bookId}/slides/${d.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
    </div>
  )
}
