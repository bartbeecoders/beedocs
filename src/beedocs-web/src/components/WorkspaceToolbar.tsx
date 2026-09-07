import { Children, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { useAuth } from '../auth/AuthContext'
import { useI18n, type TFunction } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { TreeSelection } from '../workspace/selection'
import { ExportMenu } from './ExportMenu'
import { ImportDialog } from './ImportDialog'
import { NamePromptDialog, type NamePromptSelect } from './NamePromptDialog'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'
import type { SlideEditorState } from './SlideCanvas'
import type { KanbanEditorState } from './KanbanCanvas'
import type { ProjectEditorState } from './ProjectCanvas'
import type { NoteEditorState } from './NoteCanvas'
import type { AttachmentEditorState } from './AttachmentCanvas'
import { ATTACHMENT_ACCEPT, attachmentIcon } from '../media/attachments'
import { useAttachmentUpload } from '../hooks/useAttachmentUpload'

export type WorkspaceView =
  | 'welcome'
  | 'shelf'
  | 'book'
  | 'page'
  | 'diagram'
  | 'slides'
  | 'kanban'
  | 'project'
  | 'note'
  | 'attachment'
  | 'settings'
  | 'users'
  | 'stats'
  | 'help'
  | 'gitRepo'
  | 'gitFile'

type Props = {
  view: WorkspaceView
  shelfId?: string
  bookId?: string
  pageId?: string
  diagramId?: string
  deckId?: string
  boardId?: string
  planId?: string
  noteId?: string
  attachmentId?: string
  pageState?: PageEditorState | null
  diagramState?: DiagramEditorState | null
  slideState?: SlideEditorState | null
  kanbanState?: KanbanEditorState | null
  projectState?: ProjectEditorState | null
  noteState?: NoteEditorState | null
  attachmentState?: AttachmentEditorState | null
}

type NamePrompt = {
  title: string
  label: string
  placeholder?: string
  defaultValue?: string
  confirmLabel: string
  select?: NamePromptSelect
  run: (value: string, selected?: string) => Promise<void>
}

function Sep() {
  return <span className="ws-toolbar-sep" aria-hidden />
}

/** Skip empty groups so separators don't stack when actions are conditional. */
function Group({ children }: { children: ReactNode }) {
  // Children.toArray already drops null/undefined/booleans
  const items = Children.toArray(children)
  if (items.length === 0) return null
  return <div className="ws-toolbar-group">{items}</div>
}


function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      {children}
    </svg>
  )
}

const ICONS = {
  library: (
    <Icon>
      <path
        d="M3 2.5h3.2A1.3 1.3 0 0 1 7.5 3.8v9.2L5 11.5 2.5 13V3.8A1.3 1.3 0 0 1 3.8 2.5H3Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 2.5H12a1.3 1.3 0 0 1 1.3 1.3v9.2L11 11.5 8.5 13V2.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  book: (
    <Icon>
      <path
        d="M3.5 2.5h7.2A1.8 1.8 0 0 1 12.5 4.3v9.2H5.2A1.7 1.7 0 0 0 3.5 13.2V2.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path d="M3.5 12.2h9" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M6 5.2h4.2M6 7.6h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </Icon>
  ),
  folder: (
    <Icon>
      <path
        d="M2.5 5.2V4.2A1.2 1.2 0 0 1 3.7 3h2.1l1.2 1.4h5.3A1.2 1.2 0 0 1 13.5 5.6v6.2A1.2 1.2 0 0 1 12.3 13H3.7A1.2 1.2 0 0 1 2.5 11.8V5.2Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </Icon>
  ),
  page: (
    <Icon>
      <path
        d="M4.2 2.5h5.1L11.8 5v8.5A1 1 0 0 1 10.8 14.5H4.2A1 1 0 0 1 3.2 13.5v-10A1 1 0 0 1 4.2 2.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path d="M9.2 2.6V5.2h2.5" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M5.5 8h5M5.5 10.4h3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </Icon>
  ),
  diagram: (
    <Icon>
      <circle cx="4.2" cy="4.2" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.8" cy="4.8" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="11.6" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 5.1 10.2 5.6M5.2 5.6 7.2 10.2M11 6.2 9 10.2" stroke="currentColor" strokeWidth="1.25" />
    </Icon>
  ),
  slides: (
    <Icon>
      <rect x="2.2" y="3" width="11.6" height="8" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <path d="M8 11v2.4M5.6 14.2l2.4-.8 2.4.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M4.6 5.4h4.5M4.6 7.4h6.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </Icon>
  ),
  kanban: (
    <Icon>
      <rect x="2" y="3" width="3.4" height="10" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
      <rect x="6.3" y="3" width="3.4" height="7" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
      <rect x="10.6" y="3" width="3.4" height="8.5" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
    </Icon>
  ),
  project: (
    <Icon>
      <rect x="2" y="3.2" width="12" height="9.6" rx="1.2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4.2 10.2 6.6 7.4 8.4 8.8 11.6 5.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  ),
  note: (
    <Icon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M8 2.4v1.3M8 12.3v1.3M2.4 8h1.3M12.3 8h1.3M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Icon>
  ),
  users: (
    <Icon>
      <circle cx="5.8" cy="5.4" r="2.1" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M2.4 13.2c.3-2.3 1.7-3.5 3.4-3.5s3.1 1.2 3.4 3.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <circle cx="11.2" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M10.8 9.8c1.6.2 2.5 1.2 2.8 2.9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </Icon>
  ),
  stats: (
    <Icon>
      <path
        d="M3 13.2V9.4M6.4 13.2V5.6M9.8 13.2V7.5M13.2 13.2V3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </Icon>
  ),
  help: (
    <Icon>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M6.3 6.2a1.8 1.8 0 1 1 2.4 2.1c-.5.3-.9.7-.9 1.3"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.4" r="0.7" fill="currentColor" />
    </Icon>
  ),
} as const

/**
 * Context-dependent action bar under the workspace header.
 * Mirrors NavTree context menus; create/rename use prompt for speed.
 */
export function WorkspaceToolbar({
  view,
  shelfId,
  bookId,
  pageId,
  diagramId,
  deckId,
  boardId,
  planId,
  noteId,
  attachmentId,
  pageState,
  diagramState,
  slideState,
  kanbanState,
  projectState,
  noteState,
  attachmentState,
}: Props) {
  const {
    books,
    shelves,
    selection,
    setSelection,
    createBook,
    createShelf,
    deleteShelf,
    renameShelf,
    createPage,
    createFolder,
    createDiagram,
    createSlideDeck,
    createKanbanBoard,
    createProjectPlan,
    createNote,
    deleteBook,
    deletePage,
    deleteFolder,
    deleteDiagram,
    deleteSlideDeck,
    deleteKanbanBoard,
    deleteProjectPlan,
    deleteNote,
    deleteAttachment,
    renameFolder,
    movePage,
    refreshTree,
  } = useWorkspace()
  const navigate = useNavigate()
  // Viewers can read everything and change nothing. The API enforces that on its
  // own; hiding the buttons here is so the toolbar shows what this account can
  // actually do rather than a row of guaranteed 403s.
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [importOpen, setImportOpen] = useState<{ targetBookId?: string } | null>(null)
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadBookRef = useRef<string | null>(null)
  const { uploadingIn, error: uploadError, clearError, upload } = useAttachmentUpload()
  const uploading = uploadingIn !== null

  const context = useMemo(
    () =>
      resolveToolbarContext(
        view,
        selection,
        books,
        shelves,
        t,
        shelfId,
        bookId,
        pageId,
        diagramId,
        deckId,
        boardId,
        planId,
        noteId,
        attachmentId,
      ),
    [view, selection, books, shelves, t, shelfId, bookId, pageId, diagramId, deckId, boardId, planId, noteId, attachmentId],
  )

  if (view === 'settings' || view === 'users' || view === 'stats' || view === 'help') {
    const meta =
      view === 'settings'
        ? { icon: ICONS.settings, label: t('common.settings') }
        : view === 'users'
          ? { icon: ICONS.users, label: t('common.users') }
          : view === 'stats'
            ? { icon: ICONS.stats, label: t('shell.statistics') }
            : { icon: ICONS.help, label: t('shell.aboutHelp') }
    return (
      <div className="ws-toolbar" role="toolbar" aria-label={t('shell.workspaceActions')}>
        <div className={`ws-toolbar-context ws-toolbar-context--${view}`}>
          <span className="ws-toolbar-context-icon" aria-hidden>
            {meta.icon}
          </span>
          <span className="ws-toolbar-context-label">{meta.label}</span>
        </div>
        <Sep />
        <Group>
          <Link to="/" className="btn ghost sm">
            ← {t('shell.backToLibrary')}
          </Link>
        </Group>
      </div>
    )
  }

  return (
    <div className="ws-toolbar" role="toolbar" aria-label={t('shell.workspaceActions')}>
      <div
        className={`ws-toolbar-context ws-toolbar-context--${context.kind}`}
        title={context.title}
      >
        <span className="ws-toolbar-context-icon" aria-hidden>
          {context.icon}
        </span>
        <span className="ws-toolbar-context-label">{context.title}</span>
        {context.dirtyHint && (
          <span
            className="ws-toolbar-dirty"
            title={t('shell.unsavedChanges')}
            aria-label={t('shell.unsavedChanges')}
          />
        )}
      </div>

      <Sep />

      {context.kind === 'library' && (
        <>
          {/* Viewers get the library read-only, so buttons that would 403 are not drawn */}
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newBook'),
                      label: t('shell.bookTitle'),
                      placeholder: t('shell.bookPlaceholder'),
                      confirmLabel: t('shell.createBook'),
                      run: async (title) => {
                        const book = await createBook(title)
                        setSelection({ kind: 'book', bookId: book.id })
                        void navigate(`/books/${book.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newBook')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  title={t('shell.newShelfTooltip')}
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newShelf'),
                      label: t('shell.shelfName'),
                      placeholder: t('shell.shelfPlaceholder'),
                      confirmLabel: t('shell.createShelf'),
                      run: async (title) => {
                        const shelf = await createShelf(title)
                        setSelection({ kind: 'shelf', shelfId: shelf.id })
                        void navigate(`/shelves/${shelf.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newShelf')}
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setImportOpen({})}>
                  {t('shell.import')}
                </button>
              </Group>
              <Sep />
            </>
          )}
          <Group>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void refreshTree()}
              title={t('shell.refreshLibrary')}
            >
              {t('shell.refreshLibrary')}
            </button>
          </Group>
        </>
      )}

      {context.kind === 'shelf' && (
        <>
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newBook'),
                      label: t('shell.bookTitle'),
                      placeholder: t('shell.bookPlaceholder'),
                      confirmLabel: t('shell.createBook'),
                      run: async (title) => {
                        const book = await createBook(title, undefined, context.shelfId)
                        setSelection({ kind: 'book', bookId: book.id })
                        void navigate(`/books/${book.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newBookOnShelf')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.renameShelf'),
                      label: t('shell.shelfName'),
                      defaultValue: context.title,
                      confirmLabel: t('common.rename'),
                      run: async (title) => {
                        await renameShelf(context.shelfId, title)
                      },
                    })
                  }
                >
                  {t('common.rename')}
                </button>
              </Group>
              <Sep />
            </>
          )}
          <Group>
            {(view !== 'shelf' || shelfId !== context.shelfId) && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void navigate(`/shelves/${context.shelfId}`)}
              >
                {t('shell.openShelf')}
              </button>
            )}
            {(() => {
              const shelf = shelves.find((s) => s.id === context.shelfId)
              if (!shelf) return null
              return (
                <a
                  className="btn ghost sm"
                  href={withBase(bookshelfSitePath(shelf.slug))}
                  target="_blank"
                  rel="noreferrer"
                  title={t('shell.openWebsiteTooltip')}
                >
                  {t('shell.openWebsite')}
                </a>
              )
            })()}
          </Group>
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteShelfConfirm', { name: context.title }))) return
                  void deleteShelf(context.shelfId).then(() => {
                    setSelection({ kind: 'none' })
                    void navigate('/')
                  })
                }}
              >
                {t('shell.deleteShelf')}
              </button>
            </Group>
          )}
        </>
      )}

      {context.kind === 'book' && (
        <>
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newPage'),
                      label: t('shell.pageTitle'),
                      placeholder: t('shell.pagePlaceholder'),
                      confirmLabel: t('shell.createPage'),
                      run: async (title) => {
                        const p = await createPage(context.bookId, title)
                        void navigate(`/books/${context.bookId}/pages/${p.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newPage')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newFolder'),
                      label: t('shell.folderName'),
                      placeholder: t('shell.folderPlaceholder'),
                      confirmLabel: t('shell.createFolder'),
                      run: async (title) => {
                        await createFolder(context.bookId, title)
                      },
                    })
                  }
                >
                  {t('shell.newFolder')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newDiagram'),
                      label: t('shell.diagramTitle'),
                      placeholder: t('shell.diagramPlaceholder'),
                      confirmLabel: t('shell.createDiagram'),
                      run: async (title) => {
                        const d = await createDiagram(context.bookId, title)
                        void navigate(`/books/${context.bookId}/diagrams/${d.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newDiagram')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    void (async () => {
                      // Offer saved layouts alongside the blank deck. A failed
                      // fetch degrades to the plain title prompt.
                      const templates = await api.listSlideTemplates().catch(() => [])
                      setNamePrompt({
                        title: t('shell.newSlides'),
                        label: t('shell.presentationTitle'),
                        placeholder: t('shell.slidesPlaceholder'),
                        confirmLabel: t('shell.createSlides'),
                        select: templates.length
                          ? {
                              label: t('shell.template'),
                              options: [
                                { value: '', label: t('shell.blankDeck') },
                                ...templates.map((tpl) => ({
                                  value: tpl.id,
                                  label: `${tpl.name} (${
                                    tpl.slideCount === 1
                                      ? t('shell.slideCount.one', { count: tpl.slideCount })
                                      : t('shell.slideCount.other', { count: tpl.slideCount })
                                  })`,
                                })),
                              ],
                            }
                          : undefined,
                        run: async (title, templateId) => {
                          const d = await createSlideDeck(context.bookId, title, templateId)
                          void navigate(`/books/${context.bookId}/slides/${d.id}`)
                        },
                      })
                    })()
                  }
                >
                  {t('shell.newSlides')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newKanban'),
                      label: t('shell.kanbanTitle'),
                      placeholder: t('shell.kanbanPlaceholder'),
                      confirmLabel: t('shell.createKanban'),
                      run: async (title) => {
                        const b = await createKanbanBoard(context.bookId, title)
                        void navigate(`/books/${context.bookId}/kanban/${b.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newKanban')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newProject'),
                      label: t('shell.projectTitle'),
                      placeholder: t('shell.projectPlaceholder'),
                      confirmLabel: t('shell.createProject'),
                      run: async (title) => {
                        const p = await createProjectPlan(context.bookId, title)
                        void navigate(`/books/${context.bookId}/project/${p.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newProject')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newNote'),
                      label: t('shell.noteTitle'),
                      placeholder: t('shell.notePlaceholder'),
                      confirmLabel: t('shell.createNote'),
                      run: async (title) => {
                        const n = await createNote(context.bookId, title)
                        void navigate(`/books/${context.bookId}/notes/${n.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newNote')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={uploading}
                  onClick={() => {
                    uploadBookRef.current = context.bookId
                    uploadInputRef.current?.click()
                  }}
                  title={t('shell.uploadTooltip')}
                >
                  {uploading ? t('shell.uploading') : t('shell.uploadFile')}
                </button>
              </Group>
              <Sep />
            </>
          )}
          <Group>
            <ExportMenu scope="book" id={context.bookId} title={context.title} />
            {canWrite && (
            <>
              <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setImportOpen({ targetBookId: context.bookId })}
                >
                  {t('shell.import')}…
                </button>
            </>
          )}
            {(view !== 'book' || bookId !== context.bookId) && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void navigate(`/books/${context.bookId}`)}
              >
                {t('shell.openBook')}
              </button>
            )}
          </Group>
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn ghost danger sm"
                  onClick={() => {
                    if (!confirm(t('shell.deleteBookConfirm', { name: context.title }))) return
                    void deleteBook(context.bookId).then(() => {
                      setSelection({ kind: 'none' })
                      if (bookId === context.bookId) void navigate('/')
                    })
                  }}
                >
                  {t('shell.deleteBook')}
                </button>
              </Group>
            </>
          )}
        </>
      )}

      {context.kind === 'folder' && (
        <>
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.newPage'),
                      label: t('shell.pageTitle'),
                      placeholder: t('shell.pagePlaceholder'),
                      confirmLabel: t('shell.createPage'),
                      run: async (title) => {
                        const p = await createPage(context.bookId, title, context.chapterId)
                        void navigate(`/books/${context.bookId}/pages/${p.id}`)
                      },
                    })
                  }
                >
                  {t('shell.newPageInFolder')}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: t('shell.renameFolder'),
                      label: t('shell.folderName'),
                      defaultValue: context.title,
                      confirmLabel: t('common.rename'),
                      run: async (name) => {
                        await renameFolder(context.chapterId, context.bookId, name)
                      },
                    })
                  }
                >
                  {t('shell.renameFolder')}
                </button>
              </Group>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn ghost danger sm"
                  onClick={() => {
                    if (!confirm(t('shell.deleteFolderConfirm', { name: context.title }))) {
                      return
                    }
                    void deleteFolder(context.chapterId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                    })
                  }}
                >
                  {t('shell.deleteFolder')}
                </button>
              </Group>
            </>
          )}
        </>
      )}

      {context.kind === 'page' && (
        <>
          <Group>
            {(view !== 'page' || pageId !== context.pageId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/pages/${context.pageId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
            {canWrite && (
            <>
              {context.chapterId != null && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    title={t('shell.moveToRootTooltip')}
                    onClick={() => {
                      void movePage({
                        pageId: context.pageId,
                        bookId: context.bookId,
                        chapterId: null,
                      })
                    }}
                  >
                    {t('shell.moveToRoot')}
                  </button>
                )}
            </>
          )}
          </Group>
          <Sep />
          <Group>
            <ExportMenu scope="page" id={context.pageId} title={context.title} />
          </Group>
          {pageState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn ghost danger sm"
                  onClick={() => {
                    if (!confirm(t('shell.deletePageConfirm', { name: context.title }))) return
                    void deletePage(context.pageId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                      if (pageId === context.pageId) void navigate(`/books/${context.bookId}`)
                    })
                  }}
                >
                  {t('shell.deletePage')}
                </button>
              </Group>
            </>
          )}
        </>
      )}

      {context.kind === 'diagram' && (
        <>
          <Group>
            {(view !== 'diagram' || diagramId !== context.diagramId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/diagrams/${context.diagramId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
            {view === 'diagram' && diagramId === context.diagramId && (
              <span className="ws-toolbar-status muted sm">{t('shell.editingDiagram')}</span>
            )}
          </Group>
          {diagramState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <>
              <Group>
                <button
                  type="button"
                  className="btn ghost danger sm"
                  onClick={() => {
                    if (!confirm(t('shell.deleteDiagramConfirm', { name: context.title }))) return
                    void deleteDiagram(context.diagramId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                      if (diagramId === context.diagramId)
                        void navigate(`/books/${context.bookId}`)
                    })
                  }}
                >
                  {t('shell.deleteDiagram')}
                </button>
              </Group>
            </>
          )}
        </>
      )}

      {context.kind === 'slides' && (
        <>
          <Group>
            {(view !== 'slides' || deckId !== context.deckId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/slides/${context.deckId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
            {view === 'slides' && deckId === context.deckId && slideState && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => slideState.present()}
                title={t('shell.presentTooltip')}
              >
                ▶ {t('shell.present')}
              </button>
            )}
          </Group>
          {slideState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteSlidesConfirm', { name: context.title }))) return
                  void deleteSlideDeck(context.deckId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (deckId === context.deckId) void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                {t('shell.deleteSlides')}
              </button>
            </Group>
          )}
        </>
      )}

      {context.kind === 'kanban' && (
        <>
          <Group>
            {(view !== 'kanban' || boardId !== context.boardId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/kanban/${context.boardId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
          </Group>
          {kanbanState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteKanbanConfirm', { name: context.title }))) return
                  void deleteKanbanBoard(context.boardId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (boardId === context.boardId) void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                {t('shell.deleteKanban')}
              </button>
            </Group>
          )}
        </>
      )}

      {context.kind === 'project' && (
        <>
          <Group>
            {(view !== 'project' || planId !== context.planId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/project/${context.planId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
          </Group>
          {projectState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteProjectConfirm', { name: context.title }))) return
                  void deleteProjectPlan(context.planId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (planId === context.planId) void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                {t('shell.deleteProject')}
              </button>
            </Group>
          )}
        </>
      )}

      {context.kind === 'note' && (
        <>
          <Group>
            {(view !== 'note' || noteId !== context.noteId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => void navigate(`/books/${context.bookId}/notes/${context.noteId}`)}
              >
                {t('common.open')}
              </button>
            )}
          </Group>
          {noteState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteNoteConfirm', { name: context.title }))) return
                  void deleteNote(context.noteId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (noteId === context.noteId) void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                {t('shell.deleteNote')}
              </button>
            </Group>
          )}
        </>
      )}

      {context.kind === 'attachment' && (
        <>
          <Group>
            {(view !== 'attachment' || attachmentId !== context.attachmentId) && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() =>
                  void navigate(`/books/${context.bookId}/files/${context.attachmentId}`)
                }
              >
                {t('common.open')}
              </button>
            )}
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                const a = document.createElement('a')
                a.href = api.attachmentUrl(context.attachmentId)
                a.download = ''
                a.click()
              }}
            >
              {t('common.download')}
            </button>
            {canWrite && view === 'attachment' && attachmentId === context.attachmentId && attachmentState && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => attachmentState.replaceFile()}
              >
                {t('shell.replaceFile')}
              </button>
            )}
          </Group>
          {attachmentState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">{t('shell.unsavedChanges')}</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(t('shell.deleteFileConfirm', { name: context.title }))) return
                  void deleteAttachment(context.attachmentId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (attachmentId === context.attachmentId)
                      void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                {t('shell.deleteFile')}
              </button>
            </Group>
          )}
        </>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          void upload(uploadBookRef.current ?? '', e.target.files)
          // Reset, or picking the same file twice in a row fires no change event.
          e.target.value = ''
        }}
      />

      {uploadError && (
        <span className="ws-toolbar-status error sm" onClick={clearError} role="alert">
          {uploadError}
        </span>
      )}

      {importOpen && (
        <ImportDialog
          defaultTargetBookId={importOpen.targetBookId}
          onClose={() => setImportOpen(null)}
        />
      )}
      <NamePromptDialog
        open={Boolean(namePrompt)}
        title={namePrompt?.title ?? ''}
        label={namePrompt?.label}
        placeholder={namePrompt?.placeholder}
        defaultValue={namePrompt?.defaultValue}
        confirmLabel={namePrompt?.confirmLabel}
        select={namePrompt?.select}
        onSubmit={async (value, selected) => {
          if (!namePrompt) return
          await namePrompt.run(value, selected)
        }}
        onClose={() => setNamePrompt(null)}
      />
    </div>
  )
}

type BookLike = {
  id: string
  title: string
  pages: { id: string; title: string; chapterId?: string | null }[]
  diagrams: { id: string; title: string }[]
  slideDecks: { id: string; title: string }[]
  kanbanBoards: { id: string; title: string }[]
  projectPlans: { id: string; title: string }[]
  notes: { id: string; title: string }[]
  attachments: { id: string; title: string; fileName: string; contentType: string; sizeBytes: number }[]
  chapters: { id: string; title: string }[]
}

type ShelfLike = { id: string; title: string; bookCount: number }

type ToolbarContext =
  | { kind: 'library'; icon: ReactNode; title: string; dirtyHint?: string }
  | {
      kind: 'shelf'
      icon: ReactNode
      title: string
      shelfId: string
      dirtyHint?: string
    }
  | {
      kind: 'book'
      icon: ReactNode
      title: string
      bookId: string
      dirtyHint?: string
    }
  | {
      kind: 'folder'
      icon: ReactNode
      title: string
      bookId: string
      chapterId: string
      dirtyHint?: string
    }
  | {
      kind: 'page'
      icon: ReactNode
      title: string
      bookId: string
      pageId: string
      chapterId: string | null
      dirtyHint?: string
    }
  | {
      kind: 'diagram'
      icon: ReactNode
      title: string
      bookId: string
      diagramId: string
      dirtyHint?: string
    }
  | {
      kind: 'slides'
      icon: ReactNode
      title: string
      bookId: string
      deckId: string
      dirtyHint?: string
    }
  | {
      kind: 'kanban'
      icon: ReactNode
      title: string
      bookId: string
      boardId: string
      dirtyHint?: string
    }
  | {
      kind: 'project'
      icon: ReactNode
      title: string
      bookId: string
      planId: string
      dirtyHint?: string
    }
  | {
      kind: 'note'
      icon: ReactNode
      title: string
      bookId: string
      noteId: string
      dirtyHint?: string
    }
  | {
      kind: 'attachment'
      icon: ReactNode
      title: string
      bookId: string
      attachmentId: string
      dirtyHint?: string
    }

/**
 * Prefer explicit tree selection (esp. folders); fall back to route params.
 */
function resolveToolbarContext(
  view: WorkspaceView,
  selection: TreeSelection,
  books: BookLike[],
  shelves: ShelfLike[],
  t: TFunction,
  shelfId?: string,
  bookId?: string,
  pageId?: string,
  diagramId?: string,
  deckId?: string,
  boardId?: string,
  planId?: string,
  noteId?: string,
  attachmentId?: string,
): ToolbarContext {
  if (selection.kind === 'folder') {
    const book = books.find((b) => b.id === selection.bookId)
    const folder = book?.chapters.find((c) => c.id === selection.chapterId)
    return {
      kind: 'folder',
      icon: ICONS.folder,
      title: folder?.title ?? t('shell.folder'),
      bookId: selection.bookId,
      chapterId: selection.chapterId,
    }
  }

  if (selection.kind === 'page' || (view === 'page' && bookId && pageId)) {
    const bId = selection.kind === 'page' ? selection.bookId : bookId!
    const pId = selection.kind === 'page' ? selection.pageId : pageId!
    const book = books.find((b) => b.id === bId)
    const page = book?.pages.find((p) => p.id === pId)
    return {
      kind: 'page',
      icon: ICONS.page,
      title: page?.title ?? t('common.page'),
      bookId: bId,
      pageId: pId,
      chapterId: page?.chapterId ?? null,
    }
  }

  if (selection.kind === 'diagram' || (view === 'diagram' && bookId && diagramId)) {
    const bId = selection.kind === 'diagram' ? selection.bookId : bookId!
    const dId = selection.kind === 'diagram' ? selection.diagramId : diagramId!
    const book = books.find((b) => b.id === bId)
    const diagram = book?.diagrams.find((d) => d.id === dId)
    return {
      kind: 'diagram',
      icon: ICONS.diagram,
      title: diagram?.title ?? t('common.diagram'),
      bookId: bId,
      diagramId: dId,
    }
  }

  if (selection.kind === 'slides' || (view === 'slides' && bookId && deckId)) {
    const bId = selection.kind === 'slides' ? selection.bookId : bookId!
    const dId = selection.kind === 'slides' ? selection.deckId : deckId!
    const book = books.find((b) => b.id === bId)
    const deck = book?.slideDecks.find((d) => d.id === dId)
    return {
      kind: 'slides',
      icon: ICONS.slides,
      title: deck?.title ?? t('common.slides'),
      bookId: bId,
      deckId: dId,
    }
  }

  if (selection.kind === 'kanban' || (view === 'kanban' && bookId && boardId)) {
    const bId = selection.kind === 'kanban' ? selection.bookId : bookId!
    const kId = selection.kind === 'kanban' ? selection.boardId : boardId!
    const book = books.find((b) => b.id === bId)
    const board = book?.kanbanBoards.find((d) => d.id === kId)
    return {
      kind: 'kanban',
      icon: ICONS.kanban,
      title: board?.title ?? t('common.kanban'),
      bookId: bId,
      boardId: kId,
    }
  }

  if (selection.kind === 'project' || (view === 'project' && bookId && planId)) {
    const bId = selection.kind === 'project' ? selection.bookId : bookId!
    const pId = selection.kind === 'project' ? selection.planId : planId!
    const book = books.find((b) => b.id === bId)
    const plan = book?.projectPlans.find((d) => d.id === pId)
    return {
      kind: 'project',
      icon: ICONS.project,
      title: plan?.title ?? t('common.project'),
      bookId: bId,
      planId: pId,
    }
  }

  if (selection.kind === 'note' || (view === 'note' && bookId && noteId)) {
    const bId = selection.kind === 'note' ? selection.bookId : bookId!
    const nId = selection.kind === 'note' ? selection.noteId : noteId!
    const book = books.find((b) => b.id === bId)
    const note = book?.notes.find((d) => d.id === nId)
    return {
      kind: 'note',
      icon: ICONS.note,
      title: note?.title ?? t('common.note'),
      bookId: bId,
      noteId: nId,
    }
  }

  if (selection.kind === 'attachment' || (view === 'attachment' && bookId && attachmentId)) {
    const bId = selection.kind === 'attachment' ? selection.bookId : bookId!
    const aId = selection.kind === 'attachment' ? selection.attachmentId : attachmentId!
    const book = books.find((b) => b.id === bId)
    const file = book?.attachments.find((a) => a.id === aId)
    return {
      kind: 'attachment',
      // No SVG in ICONS for this one on purpose: a file's identity is its
      // format, and the per-format glyph says more than one generic paperclip.
      icon: <span aria-hidden>{attachmentIcon(file?.fileName ?? '', file?.contentType)}</span>,
      title: file?.title ?? t('shell.file'),
      bookId: bId,
      attachmentId: aId,
    }
  }

  if (selection.kind === 'book' || (view === 'book' && bookId)) {
    const bId = selection.kind === 'book' ? selection.bookId : bookId!
    const book = books.find((b) => b.id === bId)
    return {
      kind: 'book',
      icon: ICONS.book,
      title: book?.title ?? t('common.book'),
      bookId: bId,
    }
  }

  if (selection.kind === 'shelf' || (view === 'shelf' && shelfId)) {
    const sId = selection.kind === 'shelf' ? selection.shelfId : shelfId!
    const shelf = shelves.find((s) => s.id === sId)
    return {
      kind: 'shelf',
      icon: ICONS.library,
      title: shelf?.title ?? t('common.shelf'),
      shelfId: sId,
    }
  }

  return { kind: 'library', icon: ICONS.library, title: t('shell.library') }
}
