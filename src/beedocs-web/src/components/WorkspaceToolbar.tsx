import { Children, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { TreeSelection } from '../workspace/selection'
import { ExportMenu } from './ExportMenu'
import { ImportDialog } from './ImportDialog'
import { NamePromptDialog, type NamePromptSelect } from './NamePromptDialog'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'
import type { SlideEditorState } from './SlideCanvas'

export type WorkspaceView =
  | 'welcome'
  | 'shelf'
  | 'book'
  | 'page'
  | 'diagram'
  | 'slides'
  | 'settings'
  | 'users'
  | 'stats'
  | 'help'

type Props = {
  view: WorkspaceView
  shelfId?: string
  bookId?: string
  pageId?: string
  diagramId?: string
  deckId?: string
  pageState?: PageEditorState | null
  diagramState?: DiagramEditorState | null
  slideState?: SlideEditorState | null
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
  pageState,
  diagramState,
  slideState,
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
    deleteBook,
    deletePage,
    deleteFolder,
    deleteDiagram,
    deleteSlideDeck,
    renameFolder,
    movePage,
    refreshTree,
  } = useWorkspace()
  const navigate = useNavigate()
  // Viewers can read everything and change nothing. The API enforces that on its
  // own; hiding the buttons here is so the toolbar shows what this account can
  // actually do rather than a row of guaranteed 403s.
  const { canWrite } = useAuth()
  const [importOpen, setImportOpen] = useState<{ targetBookId?: string } | null>(null)
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null)

  const context = useMemo(
    () =>
      resolveToolbarContext(
        view,
        selection,
        books,
        shelves,
        shelfId,
        bookId,
        pageId,
        diagramId,
        deckId,
      ),
    [view, selection, books, shelves, shelfId, bookId, pageId, diagramId, deckId],
  )

  if (view === 'settings' || view === 'users' || view === 'stats' || view === 'help') {
    const meta =
      view === 'settings'
        ? { icon: ICONS.settings, label: 'Settings' }
        : view === 'users'
          ? { icon: ICONS.users, label: 'Users' }
          : view === 'stats'
            ? { icon: ICONS.stats, label: 'Statistics' }
            : { icon: ICONS.help, label: 'About & Help' }
    return (
      <div className="ws-toolbar" role="toolbar" aria-label="Workspace actions">
        <div className={`ws-toolbar-context ws-toolbar-context--${view}`}>
          <span className="ws-toolbar-context-icon" aria-hidden>
            {meta.icon}
          </span>
          <span className="ws-toolbar-context-label">{meta.label}</span>
        </div>
        <Sep />
        <Group>
          <Link to="/" className="btn ghost sm">
            ← Back to library
          </Link>
        </Group>
      </div>
    )
  }

  return (
    <div className="ws-toolbar" role="toolbar" aria-label="Workspace actions">
      <div
        className={`ws-toolbar-context ws-toolbar-context--${context.kind}`}
        title={context.title}
      >
        <span className="ws-toolbar-context-icon" aria-hidden>
          {context.icon}
        </span>
        <span className="ws-toolbar-context-label">{context.title}</span>
        {context.dirtyHint && (
          <span className="ws-toolbar-dirty" title="Unsaved changes" aria-label="Unsaved changes" />
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
                      title: 'New book',
                      label: 'Book title',
                      placeholder: 'e.g. Platform architecture',
                      confirmLabel: 'Create book',
                      run: async (title) => {
                        const book = await createBook(title)
                        setSelection({ kind: 'book', bookId: book.id })
                        void navigate(`/books/${book.id}`)
                      },
                    })
                  }
                >
                  New book
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  title="A shelf groups related books"
                  onClick={() =>
                    setNamePrompt({
                      title: 'New shelf',
                      label: 'Shelf name',
                      placeholder: 'e.g. Platform',
                      confirmLabel: 'Create shelf',
                      run: async (title) => {
                        const shelf = await createShelf(title)
                        setSelection({ kind: 'shelf', shelfId: shelf.id })
                        void navigate(`/shelves/${shelf.id}`)
                      },
                    })
                  }
                >
                  New shelf
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setImportOpen({})}>
                  Import
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
              title="Refresh library"
            >
              Refresh library
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
                      title: 'New book',
                      label: 'Book title',
                      placeholder: 'e.g. Platform architecture',
                      confirmLabel: 'Create book',
                      run: async (title) => {
                        const book = await createBook(title, undefined, context.shelfId)
                        setSelection({ kind: 'book', bookId: book.id })
                        void navigate(`/books/${book.id}`)
                      },
                    })
                  }
                >
                  New book on shelf
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: 'Rename shelf',
                      label: 'Shelf name',
                      defaultValue: context.title,
                      confirmLabel: 'Rename',
                      run: async (title) => {
                        await renameShelf(context.shelfId, title)
                      },
                    })
                  }
                >
                  Rename
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
                Open shelf
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
                  title="Open this shelf as a website"
                >
                  Open website
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
                  if (
                    !confirm(
                      `Delete shelf “${context.title}”? Its books are kept and move to the library root.`,
                    )
                  )
                    return
                  void deleteShelf(context.shelfId).then(() => {
                    setSelection({ kind: 'none' })
                    void navigate('/')
                  })
                }}
              >
                Delete shelf
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
                      title: 'New page',
                      label: 'Page title',
                      placeholder: 'e.g. System Context',
                      confirmLabel: 'Create page',
                      run: async (title) => {
                        const p = await createPage(context.bookId, title)
                        void navigate(`/books/${context.bookId}/pages/${p.id}`)
                      },
                    })
                  }
                >
                  New page
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: 'New folder',
                      label: 'Folder name',
                      placeholder: 'e.g. Design',
                      confirmLabel: 'Create folder',
                      run: async (title) => {
                        await createFolder(context.bookId, title)
                      },
                    })
                  }
                >
                  New folder
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: 'New diagram',
                      label: 'Diagram title',
                      placeholder: 'e.g. Network overview',
                      confirmLabel: 'Create diagram',
                      run: async (title) => {
                        const d = await createDiagram(context.bookId, title)
                        void navigate(`/books/${context.bookId}/diagrams/${d.id}`)
                      },
                    })
                  }
                >
                  New diagram
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
                        title: 'New slides',
                        label: 'Presentation title',
                        placeholder: 'e.g. Architecture review',
                        confirmLabel: 'Create slides',
                        select: templates.length
                          ? {
                              label: 'Template',
                              options: [
                                { value: '', label: 'Blank deck' },
                                ...templates.map((t) => ({
                                  value: t.id,
                                  label: `${t.name} (${t.slideCount} slide${t.slideCount === 1 ? '' : 's'})`,
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
                  New slides
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
                  Import…
                </button>
            </>
          )}
            {(view !== 'book' || bookId !== context.bookId) && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void navigate(`/books/${context.bookId}`)}
              >
                Open book
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
                    if (!confirm(`Delete book “${context.title}”?`)) return
                    void deleteBook(context.bookId).then(() => {
                      setSelection({ kind: 'none' })
                      if (bookId === context.bookId) void navigate('/')
                    })
                  }}
                >
                  Delete book
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
                      title: 'New page',
                      label: 'Page title',
                      placeholder: 'e.g. System Context',
                      confirmLabel: 'Create page',
                      run: async (title) => {
                        const p = await createPage(context.bookId, title, context.chapterId)
                        void navigate(`/books/${context.bookId}/pages/${p.id}`)
                      },
                    })
                  }
                >
                  New page in folder
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() =>
                    setNamePrompt({
                      title: 'Rename folder',
                      label: 'Folder name',
                      defaultValue: context.title,
                      confirmLabel: 'Rename',
                      run: async (t) => {
                        await renameFolder(context.chapterId, context.bookId, t)
                      },
                    })
                  }
                >
                  Rename folder
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
                    if (
                      !confirm(
                        `Delete folder “${context.title}”? Pages inside move to the book root.`,
                      )
                    ) {
                      return
                    }
                    void deleteFolder(context.chapterId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                    })
                  }}
                >
                  Delete folder
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
                Open
              </button>
            )}
            {canWrite && (
            <>
              {context.chapterId != null && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="Move this page to the book root"
                    onClick={() => {
                      void movePage({
                        pageId: context.pageId,
                        bookId: context.bookId,
                        chapterId: null,
                      })
                    }}
                  >
                    Move to root
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
              <span className="ws-toolbar-status muted sm">Unsaved changes</span>
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
                    if (!confirm(`Delete page “${context.title}”?`)) return
                    void deletePage(context.pageId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                      if (pageId === context.pageId) void navigate(`/books/${context.bookId}`)
                    })
                  }}
                >
                  Delete page
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
                Open
              </button>
            )}
            {view === 'diagram' && diagramId === context.diagramId && (
              <span className="ws-toolbar-status muted sm">Editing diagram</span>
            )}
          </Group>
          {diagramState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">Unsaved changes</span>
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
                    if (!confirm(`Delete diagram “${context.title}”?`)) return
                    void deleteDiagram(context.diagramId, context.bookId).then(() => {
                      setSelection({ kind: 'book', bookId: context.bookId })
                      if (diagramId === context.diagramId)
                        void navigate(`/books/${context.bookId}`)
                    })
                  }}
                >
                  Delete diagram
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
                Open
              </button>
            )}
            {view === 'slides' && deckId === context.deckId && slideState && (
              <button
                type="button"
                className="btn primary sm"
                onClick={() => slideState.present()}
                title="Start the presentation"
              >
                ▶ Present
              </button>
            )}
          </Group>
          {slideState?.dirty && (
            <>
              <Sep />
              <span className="ws-toolbar-status muted sm">Unsaved changes</span>
            </>
          )}
          <span className="ws-toolbar-spacer" />
          {canWrite && (
            <Group>
              <button
                type="button"
                className="btn ghost danger sm"
                onClick={() => {
                  if (!confirm(`Delete slide deck “${context.title}”?`)) return
                  void deleteSlideDeck(context.deckId, context.bookId).then(() => {
                    setSelection({ kind: 'book', bookId: context.bookId })
                    if (deckId === context.deckId) void navigate(`/books/${context.bookId}`)
                  })
                }}
              >
                Delete slides
              </button>
            </Group>
          )}
        </>
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

/**
 * Prefer explicit tree selection (esp. folders); fall back to route params.
 */
function resolveToolbarContext(
  view: WorkspaceView,
  selection: TreeSelection,
  books: BookLike[],
  shelves: ShelfLike[],
  shelfId?: string,
  bookId?: string,
  pageId?: string,
  diagramId?: string,
  deckId?: string,
): ToolbarContext {
  if (selection.kind === 'folder') {
    const book = books.find((b) => b.id === selection.bookId)
    const folder = book?.chapters.find((c) => c.id === selection.chapterId)
    return {
      kind: 'folder',
      icon: ICONS.folder,
      title: folder?.title ?? 'Folder',
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
      title: page?.title ?? 'Page',
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
      title: diagram?.title ?? 'Diagram',
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
      title: deck?.title ?? 'Slides',
      bookId: bId,
      deckId: dId,
    }
  }

  if (selection.kind === 'book' || (view === 'book' && bookId)) {
    const bId = selection.kind === 'book' ? selection.bookId : bookId!
    const book = books.find((b) => b.id === bId)
    return {
      kind: 'book',
      icon: ICONS.book,
      title: book?.title ?? 'Book',
      bookId: bId,
    }
  }

  if (selection.kind === 'shelf' || (view === 'shelf' && shelfId)) {
    const sId = selection.kind === 'shelf' ? selection.shelfId : shelfId!
    const shelf = shelves.find((s) => s.id === sId)
    return {
      kind: 'shelf',
      icon: ICONS.library,
      title: shelf?.title ?? 'Shelf',
      shelfId: sId,
    }
  }

  return { kind: 'library', icon: ICONS.library, title: 'Library' }
}
