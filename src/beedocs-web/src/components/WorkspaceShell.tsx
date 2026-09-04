import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTheme } from '../theme'
import { useI18n, type MessageKey } from '../i18n'
import { useBranding } from '../branding'
import { withApiBase } from '../basePath'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { loadPaneLayout, savePaneLayout, type PaneLayout } from '../workspace/layoutPrefs'
import { api } from '../api'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { FavoritesPanel } from './FavoritesPanel'
import { GitTree } from './GitTree'
import { GitFileCanvas, GitRepoCanvas } from './GitCanvas'
import { useGitRepos } from '../hooks/useGitRepos'
import { NavTree } from './NavTree'
import { ResizablePane } from './ResizablePane'
import { PageCanvas, type PageEditorState } from './PageCanvas'
import { DiagramCanvas, type DiagramEditorState } from './DiagramCanvas'
import { SlideCanvas, type SlideEditorState } from './SlideCanvas'
import { KanbanCanvas, type KanbanEditorState } from './KanbanCanvas'
import { ProjectCanvas, type ProjectEditorState } from './ProjectCanvas'
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
  const { t } = useI18n()
  const { branding } = useBranding()
  const { books, shelves, expandBook, syncSelectionFromRoute } = useWorkspace()
  const gitRepos = useGitRepos()
  const [layout, setLayout] = useState<PaneLayout>(() => loadPaneLayout())
  const [pageState, setPageState] = useState<PageEditorState | null>(null)
  const [diagramState, setDiagramState] = useState<DiagramEditorState | null>(null)
  const [slideState, setSlideState] = useState<SlideEditorState | null>(null)
  const [kanbanState, setKanbanState] = useState<KanbanEditorState | null>(null)
  const [projectState, setProjectState] = useState<ProjectEditorState | null>(null)
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
    // Git routes carry repoId; the /files/ segment separates a file canvas
    // from the repo's front page.
    if (params.repoId) {
      return location.pathname.includes('/files/') ? ('gitFile' as const) : ('gitRepo' as const)
    }
    if (params.pageId) return 'page' as const
    if (params.diagramId) return 'diagram' as const
    if (params.deckId) return 'slides' as const
    if (params.boardId) return 'kanban' as const
    if (params.planId) return 'project' as const
    if (params.attachmentId) return 'attachment' as const
    if (params.bookId) return 'book' as const
    if (params.shelfId) return 'shelf' as const
    return 'welcome' as const
  }, [
    location.pathname,
    params.repoId,
    params.shelfId,
    params.bookId,
    params.pageId,
    params.diagramId,
    params.deckId,
    params.boardId,
    params.planId,
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
      boardId: params.boardId,
      planId: params.planId,
      attachmentId: params.attachmentId,
    })
  }, [
    view,
    params.shelfId,
    params.bookId,
    params.pageId,
    params.diagramId,
    params.deckId,
    params.boardId,
    params.planId,
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
    if (view === 'settings') return [{ label: t('common.settings') }]
    if (view === 'users') return [{ label: t('common.users') }]
    if (view === 'stats') return [{ label: t('shell.statistics') }]
    if (view === 'help') return [{ label: t('shell.aboutHelp') }]
    if (view === 'gitRepo' || view === 'gitFile') {
      const repo = gitRepos?.find((r) => r.id === params.repoId)
      const crumbs: { label: string; to?: string }[] = [{ label: t('shell.library'), to: '/' }]
      crumbs.push({
        label: repo?.name ?? t('common.repository'),
        to: view === 'gitFile' ? `/git/${params.repoId}` : undefined,
      })
      if (view === 'gitFile' && params['*']) {
        crumbs.push({ label: decodeURIComponent(params['*'].split('/').pop() ?? '') })
      }
      return crumbs
    }
    const book = books.find((b) => b.id === params.bookId)
    const crumbs: { label: string; to?: string }[] = [{ label: t('shell.library'), to: '/' }]
    // A shelf is the level above books, so it goes in front of the book crumb
    // whether we are sitting on the shelf or somewhere below it.
    const shelfId = params.shelfId ?? book?.shelfId ?? null
    const shelf = shelfId ? shelves.find((s) => s.id === shelfId) : undefined
    if (shelf) crumbs.push({ label: shelf.title, to: `/shelves/${shelf.id}` })
    if (book) {
      crumbs.push({ label: book.title, to: `/books/${book.id}` })
      if (params.pageId) {
        const page = book.pages.find((p) => p.id === params.pageId)
        crumbs.push({ label: page?.title ?? pageState?.title ?? t('common.page') })
      } else if (params.diagramId) {
        const diagram = book.diagrams.find((d) => d.id === params.diagramId)
        crumbs.push({ label: diagram?.title ?? diagramState?.title ?? t('common.diagram') })
      } else if (params.deckId) {
        const deck = book.slideDecks.find((d) => d.id === params.deckId)
        crumbs.push({ label: deck?.title ?? slideState?.title ?? t('common.slides') })
      } else if (params.boardId) {
        const board = book.kanbanBoards.find((d) => d.id === params.boardId)
        crumbs.push({ label: board?.title ?? kanbanState?.title ?? t('common.kanban') })
      } else if (params.planId) {
        const plan = book.projectPlans.find((d) => d.id === params.planId)
        crumbs.push({ label: plan?.title ?? projectState?.title ?? t('common.project') })
      } else if (params.attachmentId) {
        const file = book.attachments.find((a) => a.id === params.attachmentId)
        crumbs.push({ label: file?.title ?? attachmentState?.title ?? t('shell.file') })
      }
    }
    return crumbs
  }, [
    view,
    books,
    shelves,
    gitRepos,
    params,
    pageState?.title,
    diagramState?.title,
    slideState?.title,
    attachmentState?.title,
    t,
  ])

  return (
    <div className="workspace">
      <header className="ws-header">
        <div className="ws-header-left">
          <Link to="/" className="brand">
            <span className="brand-mark" aria-hidden>
              {branding.logoUrl ? (
                <img className="brand-logo" src={withApiBase(branding.logoUrl)} alt="" />
              ) : (
                '🐝'
              )}
            </span>
            <span className="brand-text">{branding.title}</span>
          </Link>
          {version && (
            <span className="ws-version-pill" title={t('shell.buildVersion', { version })}>
              v{version}
            </span>
          )}
          <nav className="ws-breadcrumb" aria-label={t('shell.breadcrumb')}>
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
            title={t('shell.searchTooltip')}
          >
            <span aria-hidden="true">{'⌕'}</span>
            <span className="ws-search-trigger-text">{t('common.search')}</span>
            <kbd>Ctrl K</kbd>
          </button>
          <span className="ws-theme-pill" title={t('shell.activeTheme')}>
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
        boardId={params.boardId}
        planId={params.planId}
        attachmentId={params.attachmentId}
        pageState={pageState}
        diagramState={diagramState}
        slideState={slideState}
        kanbanState={kanbanState}
        projectState={projectState}
        attachmentState={attachmentState}
      />

      <div className="ws-body">
        <ResizablePane
          side="left"
          title={t('shell.library')}
          width={layout.leftWidth}
          collapsed={layout.leftCollapsed}
          onResize={(leftWidth) => patchLayout({ leftWidth })}
          onToggle={() => patchLayout({ leftCollapsed: !layout.leftCollapsed })}
        >
          <FavoritesPanel />
          <NavTree />
          <GitTree />
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
          {view === 'kanban' && <KanbanCanvas onStateChange={setKanbanState} />}
          {view === 'project' && <ProjectCanvas onStateChange={setProjectState} />}
          {view === 'attachment' && <AttachmentCanvas onStateChange={setAttachmentState} />}
          {view === 'gitRepo' && <GitRepoCanvas />}
          {view === 'gitFile' && <GitFileCanvas />}
        </main>

        <ResizablePane
          side="right"
          title={t('shell.properties')}
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
            kanbanState={kanbanState}
            projectState={projectState}
            attachmentState={attachmentState}
            view={view}
          />
        </ResizablePane>
      </div>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}

/** The three fixed roles have glossary entries; anything else renders raw. */
const ROLE_KEYS: Record<string, MessageKey> = {
  admin: 'common.admin',
  editor: 'common.editor',
  viewer: 'common.viewer',
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
  const { t } = useI18n()
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
    ...(authEnabled && canManageUsers
      ? [{ to: '/users', view: 'users', label: t('common.users') }]
      : []),
    ...(canManageUsers ? [{ to: '/stats', view: 'stats', label: t('shell.statistics') }] : []),
    { to: '/help', view: 'help', label: t('shell.aboutHelp') },
    { to: '/settings', view: 'settings', label: t('common.settings') },
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
        title={t('shell.appMenuTooltip')}
      >
        {t('shell.menu')}
        <span className="ws-app-menu-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <nav className="ws-user-popover ws-app-menu-popover" aria-label={t('shell.workspacePages')}>
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
  const { t } = useI18n()
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
        title={t('shell.signedInAs', { name: user.username })}
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
          <span className={`role-pill ${user.role}`}>
            {ROLE_KEYS[user.role] ? t(ROLE_KEYS[user.role]) : user.role}
          </span>
          <Link to="/settings/account" className="btn ghost sm" onClick={() => setOpen(false)}>
            {t('shell.accountSettings')}
          </Link>
          <button type="button" className="btn sm" onClick={() => void logout()}>
            {t('shell.signOut')}
          </button>
        </div>
      )}
    </div>
  )
}

function WelcomeCanvas() {
  const { canWrite } = useAuth()
  const { t } = useI18n()
  return (
    <div className="welcome-canvas">
      <div className="welcome-card">
        <h1>{t('shell.welcomeTitle')}</h1>
        <p className="muted">
          {canWrite ? t('shell.welcomeLeadWrite') : t('shell.welcomeLeadRead')}
        </p>
        {/* The three steps are an author's onboarding; a read-only account is
            being told to do things its role forbids. */}
        {canWrite && (
          <ul className="welcome-steps">
            <li>
              <strong>1.</strong> {t('shell.welcomeStep1')}
            </li>
            <li>
              <strong>2.</strong> {t('shell.welcomeStep2')}
            </li>
            <li>
              <strong>3.</strong> {t('shell.welcomeStep3')}
            </li>
          </ul>
        )}
        <p className="muted sm">
          {t('shell.welcomeHelpBefore')} <Link to="/help">{t('shell.aboutHelp')}</Link>{' '}
          {t('shell.welcomeHelpAfter')}
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
  const { t } = useI18n()
  const { shelves, books, createBook } = useWorkspace()
  const shelf = shelves.find((s) => s.id === shelfId)
  const [prompt, setPrompt] = useState(false)

  if (!shelf) {
    return <div className="canvas-message muted">{t('shell.loadingShelf')}</div>
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
        {t('shell.website')}{' '}
        <a href={withBase(bookshelfSitePath(shelf.slug))} target="_blank" rel="noreferrer">
          {withBase(bookshelfSitePath(shelf.slug))}
        </a>
        {` · ${shelf.published ? t('shell.published') : t('shell.unpublishedPreview')}`}
      </p>
      <div className="overview-stats">
        <div className="stat">
          <span className="stat-value">{shelved.length}</span>
          <span className="stat-label">{t('common.books')}</span>
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
          {canWrite ? t('shell.shelfEmptyWrite') : t('shell.shelfEmptyRead')}
        </p>
      )}

      <div className="row" style={{ gap: '0.5rem', marginTop: '1rem' }}>
        <a className="btn primary sm" href={withBase(bookshelfSitePath(shelf.slug))} target="_blank" rel="noreferrer">
          {t('shell.openWebsite')}
        </a>
        {canWrite && (
          <button type="button" className="btn sm" onClick={() => setPrompt(true)}>
            {t('shell.newBookOnShelf')}
          </button>
        )}
      </div>

      <NamePromptDialog
        open={prompt}
        title={t('shell.newBook')}
        label={t('shell.bookTitle')}
        placeholder={t('shell.bookPlaceholder')}
        confirmLabel={t('shell.createBook')}
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
  const { t } = useI18n()
  const { books, createPage, createDiagram, createSlideDeck, createKanbanBoard, createProjectPlan } = useWorkspace()
  const book = books.find((b) => b.id === bookId)
  const [prompt, setPrompt] = useState<'page' | 'diagram' | 'slides' | 'kanban' | 'project' | null>(null)
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
    return <div className="canvas-message muted">{t('shell.loadingBook')}</div>
  }

  return (
    <div
      className={`book-overview${fileDrop.dragging ? ' file-drop-over' : ''}`}
      {...fileDrop.dropProps}
    >
      {fileDrop.dragging && (
        <div className="file-drop-overlay">
          <span aria-hidden>📎</span>
          <strong>{t('shell.dropToAdd', { name: book.title })}</strong>
          <span className="muted sm">{t('shell.dropTypes')}</span>
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
          <span className="stat-label">{t('common.pages')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.diagrams.length}</span>
          <span className="stat-label">{t('common.diagrams')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.slideDecks.length}</span>
          <span className="stat-label">{t('common.slideDecks')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.kanbanBoards.length}</span>
          <span className="stat-label">{t('common.kanbanBoards')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.projectPlans.length}</span>
          <span className="stat-label">{t('common.projectPlans')}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{book.attachments.length}</span>
          <span className="stat-label">{t('shell.files')}</span>
        </div>
      </div>
      <p className="muted">
        {t('shell.bookHint')}
        {canWrite && ` ${t('shell.bookHintDrop')}`}
      </p>

      {book.attachments.length > 0 && (
        <>
          <h2 className="book-overview-subhead">{t('shell.files')}</h2>
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
            {t('shell.newPage')}
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('diagram')}>
            {t('shell.newDiagram')}
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('slides')}>
            {t('shell.newSlides')}
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('kanban')}>
            {t('shell.newKanban')}
          </button>
          <button type="button" className="btn sm" onClick={() => setPrompt('project')}>
            {t('shell.newProject')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            title={t('shell.uploadTooltip')}
          >
            {uploading ? t('shell.uploading') : t('shell.uploadFile')}
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
        title={t('shell.newPage')}
        label={t('shell.pageTitle')}
        placeholder={t('shell.pagePlaceholder')}
        confirmLabel={t('shell.createPage')}
        onSubmit={async (title) => {
          const p = await createPage(bookId, title)
          void navigate(`/books/${bookId}/pages/${p.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
      <NamePromptDialog
        open={prompt === 'diagram'}
        title={t('shell.newDiagram')}
        label={t('shell.diagramTitle')}
        placeholder={t('shell.diagramPlaceholder')}
        confirmLabel={t('shell.createDiagram')}
        onSubmit={async (title) => {
          const d = await createDiagram(bookId, title)
          void navigate(`/books/${bookId}/diagrams/${d.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
      <NamePromptDialog
        open={prompt === 'slides'}
        title={t('shell.newSlides')}
        label={t('shell.presentationTitle')}
        placeholder={t('shell.slidesPlaceholder')}
        confirmLabel={t('shell.createSlides')}
        onSubmit={async (title) => {
          const d = await createSlideDeck(bookId, title)
          void navigate(`/books/${bookId}/slides/${d.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
      <NamePromptDialog
        open={prompt === 'kanban'}
        title={t('shell.newKanban')}
        label={t('shell.kanbanTitle')}
        placeholder={t('shell.kanbanPlaceholder')}
        confirmLabel={t('shell.createKanban')}
        onSubmit={async (title) => {
          const b = await createKanbanBoard(bookId, title)
          void navigate(`/books/${bookId}/kanban/${b.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
      <NamePromptDialog
        open={prompt === 'project'}
        title={t('shell.newProject')}
        label={t('shell.projectTitle')}
        placeholder={t('shell.projectPlaceholder')}
        confirmLabel={t('shell.createProject')}
        onSubmit={async (title) => {
          const p = await createProjectPlan(bookId, title)
          void navigate(`/books/${bookId}/project/${p.id}`)
        }}
        onClose={() => setPrompt(null)}
      />
    </div>
  )
}
