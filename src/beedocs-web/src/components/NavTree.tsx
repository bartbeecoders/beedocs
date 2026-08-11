import { useEffect, useRef, useState, type FormEvent } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { exportBookToPdf, exportPageToPdf } from '../export/pdf'
import { ImportDialog } from './ImportDialog'
import type { ExportFormat } from '../types'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace, type TreeBook } from '../workspace/WorkspaceContext'
import type { TreeSelection } from '../workspace/selection'
import type { Chapter, DiagramSummary, PageSummary } from '../types'

type CtxMenu =
  | {
      kind: 'book'
      bookId: string
      title: string
      x: number
      y: number
    }
  | {
      kind: 'folder'
      bookId: string
      chapterId: string
      title: string
      x: number
      y: number
    }
  | {
      kind: 'page'
      bookId: string
      pageId: string
      title: string
      chapterId: string | null
      x: number
      y: number
    }
  | {
      kind: 'diagram'
      bookId: string
      diagramId: string
      title: string
      x: number
      y: number
    }

type DragPayload =
  | { type: 'page'; pageId: string; bookId: string; chapterId: string | null }
  | { type: 'folder'; chapterId: string; bookId: string }

type Creating =
  | { bookId: string; kind: 'page'; chapterId?: string | null }
  | { bookId: string; kind: 'diagram' }
  | { bookId: string; kind: 'folder' }

export function NavTree() {
  const {
    books,
    loading,
    error,
    selection,
    setSelection,
    toggleBook,
    createBook,
    createPage,
    createFolder,
    createDiagram,
    deleteBook,
    deletePage,
    deleteFolder,
    deleteDiagram,
    renameFolder,
    movePage,
    toggleFolder,
    refreshTree,
  } = useWorkspace()
  const navigate = useNavigate()
  const params = useParams()
  const { canWrite } = useAuth()
  const [newBookOpen, setNewBookOpen] = useState(false)
  const [bookTitle, setBookTitle] = useState('')
  const [creatingIn, setCreatingIn] = useState<Creating | null>(null)
  const [childTitle, setChildTitle] = useState('')
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [busyExport, setBusyExport] = useState(false)
  const [importOpen, setImportOpen] = useState<{ targetBookId?: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  /**
   * Run one export from a context menu. PDF is rendered in the browser (it is
   * the only route that can rasterise diagrams); the rest stream from the API.
   */
  const runExport = (
    scope: 'book' | 'page',
    id: string,
    format: ExportFormat | 'pdf',
  ) => {
    setBusyExport(true)
    const job =
      format === 'pdf'
        ? scope === 'book'
          ? exportBookToPdf(id)
          : exportPageToPdf(id)
        : api.downloadExport(scope === 'book' ? 'books' : 'pages', id, format).then(() => undefined)

    void job
      .catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusyExport(false)
        setMenu(null)
      })
  }

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent, next: CtxMenu) => {
    e.preventDefault()
    e.stopPropagation()
    const pad = 8
    const w = 200
    const h = 280
    setMenu({
      ...next,
      x: Math.min(e.clientX, window.innerWidth - w - pad),
      y: Math.min(e.clientY, window.innerHeight - h - pad),
    })
  }

  const onCreateBook = async (e: FormEvent) => {
    e.preventDefault()
    if (!bookTitle.trim()) return
    const book = await createBook(bookTitle.trim())
    setBookTitle('')
    setNewBookOpen(false)
    void navigate(`/books/${book.id}`)
  }

  const onCreateChild = async (e: FormEvent) => {
    e.preventDefault()
    if (!creatingIn || !childTitle.trim()) return
    const { bookId, kind } = creatingIn
    if (kind === 'page') {
      const page = await createPage(bookId, childTitle.trim(), creatingIn.chapterId)
      setChildTitle('')
      setCreatingIn(null)
      void navigate(`/books/${bookId}/pages/${page.id}`)
    } else if (kind === 'folder') {
      await createFolder(bookId, childTitle.trim())
      setChildTitle('')
      setCreatingIn(null)
    } else {
      const diagram = await createDiagram(bookId, childTitle.trim())
      setChildTitle('')
      setCreatingIn(null)
      void navigate(`/books/${bookId}/diagrams/${diagram.id}`)
    }
  }

  const parseDrag = (e: React.DragEvent): DragPayload | null => {
    try {
      const raw = e.dataTransfer.getData('application/x-beedocs-tree') || e.dataTransfer.getData('text/plain')
      if (!raw) return null
      return JSON.parse(raw) as DragPayload
    } catch {
      return null
    }
  }

  const onDragStart = (e: React.DragEvent, payload: DragPayload) => {
    e.dataTransfer.setData('application/x-beedocs-tree', JSON.stringify(payload))
    e.dataTransfer.setData('text/plain', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'move'
  }

  const dropOnFolder = async (bookId: string, chapterId: string | null, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const payload = parseDrag(e)
    if (!payload || payload.bookId !== bookId) return
    if (payload.type === 'page') {
      const book = books.find((b) => b.id === bookId)
      const siblings = (book?.pages ?? []).filter(
        (p) => (p.chapterId ?? null) === chapterId && p.id !== payload.pageId,
      )
      await movePage({
        pageId: payload.pageId,
        bookId,
        chapterId,
        sortOrder: siblings.length,
      })
    }
  }

  const dropReorderPage = async (
    bookId: string,
    target: PageSummary,
    place: 'before' | 'after',
    e: React.DragEvent,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const payload = parseDrag(e)
    if (!payload || payload.type !== 'page' || payload.bookId !== bookId) return
    if (payload.pageId === target.id) return
    const chapterId = target.chapterId ?? null
    const book = books.find((b) => b.id === bookId)
    const siblings = (book?.pages ?? [])
      .filter((p) => (p.chapterId ?? null) === chapterId)
      .sort((a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title))
    const without = siblings.filter((p) => p.id !== payload.pageId)
    const idx = without.findIndex((p) => p.id === target.id)
    const insertAt = place === 'before' ? idx : idx + 1
    const reordered = [...without]
    const moving = (book?.pages ?? []).find((p) => p.id === payload.pageId)
    if (!moving) return
    reordered.splice(Math.max(0, insertAt), 0, { ...moving, chapterId })
    // Persist sort orders
    for (let i = 0; i < reordered.length; i++) {
      const p = reordered[i]
      if (p.id === payload.pageId || p.sortOrder !== i || (p.chapterId ?? null) !== chapterId) {
        await movePage({ pageId: p.id, bookId, chapterId, sortOrder: i })
      }
    }
  }

  const menuStyle = menu
    ? {
        position: 'fixed' as const,
        left: Math.max(8, menu.x),
        top: Math.max(8, menu.y),
        zIndex: 1200,
      }
    : undefined

  return (
    <div className="nav-tree">
      <div className="nav-tree-actions">
        {/* A read-only account gets a library to browse, not to add to. */}
        {canWrite && (
          <>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => setNewBookOpen((v) => !v)}
            >
              New book
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => setImportOpen({})}
              title="Import a BeeDocs archive, a zip of Markdown, or a single .md file"
            >
              Import
            </button>
          </>
        )}
        <button type="button" className="icon-btn" onClick={() => void refreshTree()} title="Refresh">
          ↻
        </button>
      </div>

      {newBookOpen && (
        <form className="inline-form" onSubmit={(e) => void onCreateBook(e)}>
          <input
            autoFocus
            value={bookTitle}
            onChange={(e) => setBookTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setBookTitle('')
                setNewBookOpen(false)
              }
            }}
            placeholder="Book title"
          />
          <button type="submit" className="btn primary sm">
            Create
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setBookTitle('')
              setNewBookOpen(false)
            }}
          >
            Cancel
          </button>
        </form>
      )}

      {error && <div className="banner error compact">{error}</div>}
      {loading && <p className="muted sm">Loading library…</p>}

      <ul className="tree-root">
        {books.map((book) => (
          <BookNode
            key={book.id}
            book={book}
            params={params}
            selection={selection}
            setSelection={setSelection}
            dragOver={dragOver}
            setDragOver={setDragOver}
            creatingIn={creatingIn}
            setCreatingIn={setCreatingIn}
            childTitle={childTitle}
            setChildTitle={setChildTitle}
            onCreateChild={onCreateChild}
            toggleBook={toggleBook}
            toggleFolder={toggleFolder}
            openMenu={openMenu}
            onDragStart={onDragStart}
            dropOnFolder={dropOnFolder}
            dropReorderPage={dropReorderPage}
          />
        ))}
      </ul>

      {!loading && books.length === 0 && (
        <div className="empty-tree">
          <p>No books yet.</p>
          <p className="muted sm">
            {canWrite
              ? 'Create a book to start documenting architecture.'
              : 'Nothing has been published to this instance yet.'}
          </p>
        </div>
      )}

      {menu && (
        <div ref={menuRef} className="tree-context-menu" style={menuStyle} role="menu">
          {menu.kind === 'book' && (
            <>
              <div className="tree-context-heading">{menu.title}</div>
              <MenuItem
                label="New page"
                write
                onClick={() => {
                  setCreatingIn({ bookId: menu.bookId, kind: 'page' })
                  setMenu(null)
                }}
              />
              <MenuItem
                label="New folder"
                write
                onClick={() => {
                  setCreatingIn({ bookId: menu.bookId, kind: 'folder' })
                  setMenu(null)
                }}
              />
              <MenuItem
                label="New diagram"
                write
                onClick={() => {
                  setCreatingIn({ bookId: menu.bookId, kind: 'diagram' })
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <ExportItems
                busy={busyExport}
                onPick={(format) => runExport('book', menu.bookId, format)}
              />
              <MenuItem
                label="Import into this book…"
                write
                onClick={() => {
                  setImportOpen({ targetBookId: menu.bookId })
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <MenuItem
                label="Open book"
                onClick={() => {
                  void navigate(`/books/${menu.bookId}`)
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <MenuItem
                label="Delete book"
                write
                danger
                onClick={() => {
                  if (confirm(`Delete book “${menu.title}”?`)) {
                    void deleteBook(menu.bookId).then(() => {
                      if (params.bookId === menu.bookId) void navigate('/')
                    })
                  }
                  setMenu(null)
                }}
              />
            </>
          )}
          {menu.kind === 'folder' && (
            <>
              <div className="tree-context-heading">📁 {menu.title}</div>
              <MenuItem
                label="New page in folder"
                write
                onClick={() => {
                  setCreatingIn({ bookId: menu.bookId, kind: 'page', chapterId: menu.chapterId })
                  setMenu(null)
                }}
              />
              <MenuItem
                label="Rename folder"
                write
                onClick={() => {
                  const t = window.prompt('Folder name', menu.title)?.trim()
                  if (t) void renameFolder(menu.chapterId, menu.bookId, t)
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <MenuItem
                label="Delete folder"
                write
                danger
                onClick={() => {
                  if (
                    confirm(
                      `Delete folder “${menu.title}”? Pages inside move to the book root.`,
                    )
                  ) {
                    void deleteFolder(menu.chapterId, menu.bookId)
                  }
                  setMenu(null)
                }}
              />
            </>
          )}
          {menu.kind === 'page' && (
            <>
              <div className="tree-context-heading">📄 {menu.title}</div>
              <MenuItem
                label="Open"
                onClick={() => {
                  void navigate(`/books/${menu.bookId}/pages/${menu.pageId}`)
                  setMenu(null)
                }}
              />
              <MenuItem
                label="Move to book root"
                write
                disabled={menu.chapterId == null}
                onClick={() => {
                  void movePage({
                    pageId: menu.pageId,
                    bookId: menu.bookId,
                    chapterId: null,
                  })
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <ExportItems
                busy={busyExport}
                onPick={(format) => runExport('page', menu.pageId, format)}
              />
              <div className="tree-context-sep" />
              <MenuItem
                label="Delete page"
                write
                danger
                onClick={() => {
                  if (confirm(`Delete page “${menu.title}”?`)) {
                    void deletePage(menu.pageId, menu.bookId).then(() => {
                      if (params.pageId === menu.pageId) void navigate(`/books/${menu.bookId}`)
                    })
                  }
                  setMenu(null)
                }}
              />
            </>
          )}
          {menu.kind === 'diagram' && (
            <>
              <div className="tree-context-heading">⬡ {menu.title}</div>
              <MenuItem
                label="Open"
                onClick={() => {
                  void navigate(`/books/${menu.bookId}/diagrams/${menu.diagramId}`)
                  setMenu(null)
                }}
              />
              <div className="tree-context-sep" />
              <MenuItem
                label="Delete diagram"
                write
                danger
                onClick={() => {
                  if (confirm(`Delete diagram “${menu.title}”?`)) {
                    void deleteDiagram(menu.diagramId, menu.bookId).then(() => {
                      if (params.diagramId === menu.diagramId)
                        void navigate(`/books/${menu.bookId}`)
                    })
                  }
                  setMenu(null)
                }}
              />
            </>
          )}
        </div>
      )}

      {importOpen && (
        <ImportDialog
          defaultTargetBookId={importOpen.targetBookId}
          onClose={() => setImportOpen(null)}
        />
      )}
    </div>
  )
}

/** The four export formats, shared by the book and page context menus. */
function ExportItems({
  busy,
  onPick,
}: {
  busy: boolean
  onPick: (format: ExportFormat | 'pdf') => void
}) {
  const formats: { format: ExportFormat | 'pdf'; label: string }[] = [
    { format: 'pdf', label: 'PDF' },
    { format: 'markdown', label: 'Markdown' },
    { format: 'docx', label: 'Word (.docx)' },
    { format: 'archive', label: 'BeeDocs archive' },
  ]
  return (
    <>
      <div className="tree-context-heading sub">{busy ? 'Exporting…' : 'Export as'}</div>
      {formats.map((f) => (
        <MenuItem
          key={f.format}
          label={f.label}
          disabled={busy}
          onClick={() => onPick(f.format)}
        />
      ))}
    </>
  )
}

function MenuItem({
  label,
  onClick,
  danger,
  disabled,
  write,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /**
   * This item changes something. A read-only account never sees it — disabling
   * instead would show a menu of things the account is being refused, and the
   * check lives here so each of the eleven call sites stays one line.
   */
  write?: boolean
}) {
  const { canWrite } = useAuth()
  if (write && !canWrite) return null

  return (
    <button
      type="button"
      role="menuitem"
      className={`tree-context-item${danger ? ' danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function BookNode({
  book,
  params,
  selection,
  setSelection,
  dragOver,
  setDragOver,
  creatingIn,
  setCreatingIn,
  childTitle,
  setChildTitle,
  onCreateChild,
  toggleBook,
  toggleFolder,
  openMenu,
  onDragStart,
  dropOnFolder,
  dropReorderPage,
}: {
  book: TreeBook
  params: Readonly<Partial<Record<string, string>>>
  selection: TreeSelection
  setSelection: (next: TreeSelection) => void
  dragOver: string | null
  setDragOver: (v: string | null) => void
  creatingIn: Creating | null
  setCreatingIn: (v: Creating | null) => void
  childTitle: string
  setChildTitle: (v: string) => void
  onCreateChild: (e: FormEvent) => void
  toggleBook: (id: string) => Promise<void>
  toggleFolder: (bookId: string, chapterId: string) => void
  openMenu: (e: React.MouseEvent, next: CtxMenu) => void
  onDragStart: (e: React.DragEvent, payload: DragPayload) => void
  dropOnFolder: (bookId: string, chapterId: string | null, e: React.DragEvent) => Promise<void>
  dropReorderPage: (
    bookId: string,
    target: PageSummary,
    place: 'before' | 'after',
    e: React.DragEvent,
  ) => Promise<void>
}) {
  const bookActive =
    (params.bookId === book.id && !params.pageId && !params.diagramId) ||
    (selection.kind === 'book' && selection.bookId === book.id)
  const rootPages = book.pages
    .filter((p) => !p.chapterId)
    .sort((a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title))
  const folders = [...book.chapters].sort(
    (a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title),
  )
  const rootDropId = `book-root:${book.id}`

  return (
    <li key={book.id} className="tree-book">
      <div
        className={`tree-row ${bookActive ? 'active' : ''}${dragOver === rootDropId ? ' drag-over' : ''}`}
        onContextMenu={(e) =>
          openMenu(e, { kind: 'book', bookId: book.id, title: book.title, x: e.clientX, y: e.clientY })
        }
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(rootDropId)
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => void dropOnFolder(book.id, null, e)}
      >
        <button
          type="button"
          className="tree-twist"
          aria-expanded={book.expanded}
          onClick={() => void toggleBook(book.id)}
        >
          {book.expanded ? '▾' : '▸'}
        </button>
        <NavLink
          to={`/books/${book.id}`}
          className="tree-label book"
          onClick={() => setSelection({ kind: 'book', bookId: book.id })}
        >
          <span className="tree-icon">📘</span>
          <span className="tree-text">{book.title}</span>
        </NavLink>
      </div>

      {book.expanded && (
        <ul className="tree-children">
          {book.loading && <li className="muted sm">Loading…</li>}
          {creatingIn?.bookId === book.id && (
            <li>
              <form className="inline-form nested" onSubmit={(e) => void onCreateChild(e)}>
                <input
                  autoFocus
                  value={childTitle}
                  onChange={(e) => setChildTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setCreatingIn(null)
                  }}
                  placeholder={
                    creatingIn.kind === 'page'
                      ? 'Page title'
                      : creatingIn.kind === 'folder'
                        ? 'Folder name'
                        : 'Diagram title'
                  }
                />
                <button type="submit" className="btn primary sm">
                  Add
                </button>
                <button type="button" className="btn ghost sm" onClick={() => setCreatingIn(null)}>
                  Cancel
                </button>
              </form>
            </li>
          )}

          {folders.map((folder) => (
            <FolderNode
              key={folder.id}
              book={book}
              folder={folder}
              pages={book.pages
                .filter((p) => p.chapterId === folder.id)
                .sort((a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title))}
              expanded={book.expandedFolders.has(folder.id)}
              params={params}
              selection={selection}
              setSelection={setSelection}
              dragOver={dragOver}
              setDragOver={setDragOver}
              creatingIn={creatingIn}
              toggleFolder={toggleFolder}
              openMenu={openMenu}
              onDragStart={onDragStart}
              dropOnFolder={dropOnFolder}
              dropReorderPage={dropReorderPage}
            />
          ))}

          {rootPages.length > 0 && <li className="tree-group-label">Pages</li>}
          {rootPages.map((p) => (
            <PageRow
              key={p.id}
              bookId={book.id}
              page={p}
              active={params.pageId === p.id || (selection.kind === 'page' && selection.pageId === p.id)}
              dragOver={dragOver}
              setDragOver={setDragOver}
              openMenu={openMenu}
              onDragStart={onDragStart}
              dropReorderPage={dropReorderPage}
              onSelect={() => setSelection({ kind: 'page', bookId: book.id, pageId: p.id })}
            />
          ))}

          {book.diagrams.length > 0 && <li className="tree-group-label">Diagrams</li>}
          {book.diagrams.map((d) => (
            <DiagramRow
              key={d.id}
              bookId={book.id}
              diagram={d}
              active={
                params.diagramId === d.id ||
                (selection.kind === 'diagram' && selection.diagramId === d.id)
              }
              openMenu={openMenu}
              onSelect={() =>
                setSelection({ kind: 'diagram', bookId: book.id, diagramId: d.id })
              }
            />
          ))}

          {!book.loading &&
            book.pages.length === 0 &&
            book.diagrams.length === 0 &&
            book.chapters.length === 0 &&
            creatingIn?.bookId !== book.id && (
              <li className="muted sm tree-empty">
                Empty book — right-click for New page / folder
              </li>
            )}
        </ul>
      )}
    </li>
  )
}

function FolderNode({
  book,
  folder,
  pages,
  expanded,
  params,
  selection,
  setSelection,
  dragOver,
  setDragOver,
  creatingIn,
  toggleFolder,
  openMenu,
  onDragStart,
  dropOnFolder,
  dropReorderPage,
}: {
  book: TreeBook
  folder: Chapter
  pages: PageSummary[]
  expanded: boolean
  params: Readonly<Partial<Record<string, string>>>
  selection: TreeSelection
  setSelection: (next: TreeSelection) => void
  dragOver: string | null
  setDragOver: (v: string | null) => void
  creatingIn: Creating | null
  toggleFolder: (bookId: string, chapterId: string) => void
  openMenu: (e: React.MouseEvent, next: CtxMenu) => void
  onDragStart: (e: React.DragEvent, payload: DragPayload) => void
  dropOnFolder: (bookId: string, chapterId: string | null, e: React.DragEvent) => Promise<void>
  dropReorderPage: (
    bookId: string,
    target: PageSummary,
    place: 'before' | 'after',
    e: React.DragEvent,
  ) => Promise<void>
}) {
  const { canWrite } = useAuth()
  const dropId = `folder:${folder.id}`
  const folderSelected =
    selection.kind === 'folder' && selection.chapterId === folder.id
  const selectFolder = () => {
    setSelection({ kind: 'folder', bookId: book.id, chapterId: folder.id })
    if (!expanded) toggleFolder(book.id, folder.id)
  }
  return (
    <li className="tree-folder">
      <div
        className={`tree-row child folder-row${folderSelected ? ' active' : ''}${dragOver === dropId ? ' drag-over' : ''}`}
        draggable={canWrite}
        onDragStart={(e) =>
          onDragStart(e, { type: 'folder', chapterId: folder.id, bookId: book.id })
        }
        onContextMenu={(e) =>
          openMenu(e, {
            kind: 'folder',
            bookId: book.id,
            chapterId: folder.id,
            title: folder.title,
            x: e.clientX,
            y: e.clientY,
          })
        }
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(dropId)
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => void dropOnFolder(book.id, folder.id, e)}
      >
        <button
          type="button"
          className="tree-twist"
          aria-expanded={expanded}
          onClick={() => toggleFolder(book.id, folder.id)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          className="tree-label"
          onClick={selectFolder}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              selectFolder()
            }
          }}
        >
          <span className="tree-icon">📁</span>
          <span className="tree-text">{folder.title}</span>
          <span className="muted sm">({pages.length})</span>
        </span>
      </div>
      {expanded && (
        <ul className="tree-children nested">
          {creatingIn?.bookId === book.id &&
            creatingIn.kind === 'page' &&
            creatingIn.chapterId === folder.id && (
              <li className="muted sm">Adding page… use form above</li>
            )}
          {pages.map((p) => (
            <PageRow
              key={p.id}
              bookId={book.id}
              page={p}
              active={
                params.pageId === p.id ||
                (selection.kind === 'page' && selection.pageId === p.id)
              }
              dragOver={dragOver}
              setDragOver={setDragOver}
              openMenu={openMenu}
              onDragStart={onDragStart}
              dropReorderPage={dropReorderPage}
              onSelect={() => setSelection({ kind: 'page', bookId: book.id, pageId: p.id })}
            />
          ))}
          {pages.length === 0 && (
            <li className="muted sm tree-empty">Empty folder — drop pages here</li>
          )}
        </ul>
      )}
    </li>
  )
}

function PageRow({
  bookId,
  page,
  active,
  dragOver,
  setDragOver,
  openMenu,
  onDragStart,
  dropReorderPage,
  onSelect,
}: {
  bookId: string
  page: PageSummary
  active: boolean
  dragOver: string | null
  setDragOver: (v: string | null) => void
  openMenu: (e: React.MouseEvent, next: CtxMenu) => void
  onDragStart: (e: React.DragEvent, payload: DragPayload) => void
  dropReorderPage: (
    bookId: string,
    target: PageSummary,
    place: 'before' | 'after',
    e: React.DragEvent,
  ) => Promise<void>
  onSelect: () => void
}) {
  const { canWrite } = useAuth()
  const beforeId = `page-before:${page.id}`
  const afterId = `page-after:${page.id}`
  return (
    <li>
      <div
        className={`drop-line${dragOver === beforeId ? ' active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(beforeId)
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => void dropReorderPage(bookId, page, 'before', e)}
      />
      <div
        className={`tree-row child ${active ? 'active' : ''}${dragOver === `page:${page.id}` ? ' drag-over' : ''}`}
        draggable={canWrite}
        onDragStart={(e) =>
          onDragStart(e, {
            type: 'page',
            pageId: page.id,
            bookId,
            chapterId: page.chapterId ?? null,
          })
        }
        onContextMenu={(e) =>
          openMenu(e, {
            kind: 'page',
            bookId,
            pageId: page.id,
            title: page.title,
            chapterId: page.chapterId ?? null,
            x: e.clientX,
            y: e.clientY,
          })
        }
      >
        <NavLink
          to={`/books/${bookId}/pages/${page.id}`}
          className="tree-label"
          onClick={onSelect}
        >
          <span className="tree-icon">📄</span>
          <span className="tree-text">{page.title}</span>
        </NavLink>
      </div>
      <div
        className={`drop-line${dragOver === afterId ? ' active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(afterId)
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => void dropReorderPage(bookId, page, 'after', e)}
      />
    </li>
  )
}

function DiagramRow({
  bookId,
  diagram,
  active,
  openMenu,
  onSelect,
}: {
  bookId: string
  diagram: DiagramSummary
  active: boolean
  openMenu: (e: React.MouseEvent, next: CtxMenu) => void
  onSelect: () => void
}) {
  return (
    <li>
      <div
        className={`tree-row child ${active ? 'active' : ''}`}
        onContextMenu={(e) =>
          openMenu(e, {
            kind: 'diagram',
            bookId,
            diagramId: diagram.id,
            title: diagram.title,
            x: e.clientX,
            y: e.clientY,
          })
        }
      >
        <NavLink
          to={`/books/${bookId}/diagrams/${diagram.id}`}
          className="tree-label"
          onClick={onSelect}
        >
          <span className="tree-icon">⬡</span>
          <span className="tree-text">{diagram.title}</span>
        </NavLink>
      </div>
    </li>
  )
}
