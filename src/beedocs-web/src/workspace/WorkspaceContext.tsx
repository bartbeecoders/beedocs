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
import { api } from '../api'
import type { Book, Chapter, DiagramSummary, PageSummary, Shelf, SlideDeckSummary } from '../types'
import { starterDeckSource } from '../slides/slideModel'
import {
  selectionEquals,
  selectionFromRoute,
  type RouteSelectionParams,
  type TreeSelection,
} from './selection'

export type { TreeSelection } from './selection'

export type TreeBook = Book & {
  pages: PageSummary[]
  diagrams: DiagramSummary[]
  slideDecks: SlideDeckSummary[]
  chapters: Chapter[]
  expanded: boolean
  /** Expanded folder (chapter) ids within this book */
  expandedFolders: Set<string>
  loading?: boolean
}

export type TreeShelf = Shelf & {
  expanded: boolean
}

type WorkspaceCtx = {
  /**
   * Every book, shelved or not — the tree groups them by {@link TreeBook.shelfId}
   * rather than nesting them, so a book keeps one identity and one loaded set of
   * children wherever it is shown.
   */
  books: TreeBook[]
  shelves: TreeShelf[]
  loading: boolean
  error: string | null
  /** Current library selection (route-synced + folder tree clicks) */
  selection: TreeSelection
  setSelection: (next: TreeSelection) => void
  /** Keep selection in sync with route params / view */
  syncSelectionFromRoute: (params: RouteSelectionParams) => void
  refreshTree: () => Promise<void>
  toggleBook: (bookId: string) => Promise<void>
  expandBook: (bookId: string) => Promise<void>
  toggleFolder: (bookId: string, chapterId: string) => void
  toggleShelf: (shelfId: string) => void
  /** Omit `shelfId` to create the book at the library root. */
  createBook: (title: string, description?: string, shelfId?: string | null) => Promise<Book>
  createShelf: (title: string, description?: string) => Promise<Shelf>
  createPage: (bookId: string, title: string, chapterId?: string | null) => Promise<PageSummary>
  createFolder: (bookId: string, title: string) => Promise<Chapter>
  createDiagram: (bookId: string, title: string) => Promise<DiagramSummary>
  /** Starts from a title slide carrying the deck's name. */
  createSlideDeck: (bookId: string, title: string) => Promise<SlideDeckSummary>
  deleteBook: (bookId: string) => Promise<void>
  /** The shelf goes; its books return to the library root. */
  deleteShelf: (shelfId: string) => Promise<void>
  renameShelf: (shelfId: string, title: string) => Promise<void>
  /** Move a book onto a shelf, or to the library root when `shelfId` is null. */
  moveBookToShelf: (bookId: string, shelfId: string | null) => Promise<void>
  deletePage: (pageId: string, bookId: string) => Promise<void>
  deleteFolder: (chapterId: string, bookId: string) => Promise<void>
  deleteDiagram: (diagramId: string, bookId: string) => Promise<void>
  deleteSlideDeck: (deckId: string, bookId: string) => Promise<void>
  renameFolder: (chapterId: string, bookId: string, title: string) => Promise<void>
  /** Move page into folder (or root) and/or reorder among siblings */
  movePage: (args: {
    pageId: string
    bookId: string
    chapterId: string | null
    /** Target sort order among siblings in the destination */
    sortOrder?: number
  }) => Promise<void>
  reorderFolder: (chapterId: string, bookId: string, sortOrder: number) => Promise<void>
  renameInTree: () => Promise<void>
}

const Ctx = createContext<WorkspaceCtx | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [books, setBooks] = useState<TreeBook[]>([])
  const [shelves, setShelves] = useState<TreeShelf[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelectionState] = useState<TreeSelection>({ kind: 'none' })
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('beedocs-expanded-books')
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('beedocs-expanded-folders')
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  // Shelves start open. A collapsed shelf hides whole books, and someone who has
  // never used the feature should not find their library apparently empty.
  const [collapsedShelves, setCollapsedShelves] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('beedocs-collapsed-shelves')
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    localStorage.setItem('beedocs-expanded-books', JSON.stringify([...expandedIds]))
  }, [expandedIds])

  useEffect(() => {
    localStorage.setItem('beedocs-expanded-folders', JSON.stringify([...expandedFolders]))
  }, [expandedFolders])

  useEffect(() => {
    localStorage.setItem('beedocs-collapsed-shelves', JSON.stringify([...collapsedShelves]))
  }, [collapsedShelves])

  /** Last route key applied by sync — folder clicks only stick until the route changes. */
  const lastRouteKeyRef = useRef<string | null>(null)

  const setSelection = useCallback((next: TreeSelection) => {
    setSelectionState((prev) => (selectionEquals(prev, next) ? prev : next))
  }, [])

  const syncSelectionFromRoute = useCallback((params: RouteSelectionParams) => {
    const key = `${params.view ?? ''}|${params.bookId ?? ''}|${params.pageId ?? ''}|${params.diagramId ?? ''}|${params.deckId ?? ''}`
    // Same route: keep tree-only selections (folders) that have no route of their own.
    if (lastRouteKeyRef.current === key) return
    lastRouteKeyRef.current = key
    const next = selectionFromRoute(params)
    setSelectionState((prev) => (selectionEquals(prev, next) ? prev : next))
  }, [])

  const loadChildren = async (bookId: string) => {
    const [pages, diagrams, slideDecks, chapters] = await Promise.all([
      api.listPages(bookId),
      api.listDiagrams(bookId),
      api.listSlideDecks(bookId),
      api.listChapters(bookId),
    ])
    return { pages, diagrams, slideDecks, chapters }
  }

  const refreshTree = useCallback(async () => {
    setError(null)
    try {
      const [shelfList, list] = await Promise.all([api.listShelves(), api.listBooks()])
      setShelves(
        shelfList.map((s) => ({ ...s, expanded: !collapsedShelves.has(s.id) })),
      )
      const next: TreeBook[] = await Promise.all(
        list.map(async (b) => {
          const expanded = expandedIds.has(b.id)
          if (!expanded) {
            return {
              ...b,
              pages: [],
              diagrams: [],
              slideDecks: [],
              chapters: [],
              expanded: false,
              expandedFolders: new Set<string>(),
            }
          }
          try {
            const kids = await loadChildren(b.id)
            return {
              ...b,
              ...kids,
              expanded: true,
              expandedFolders: new Set(
                [...expandedFolders].filter((id) => kids.chapters.some((c) => c.id === id)),
              ),
            }
          } catch {
            return {
              ...b,
              pages: [],
              diagrams: [],
              slideDecks: [],
              chapters: [],
              expanded: true,
              expandedFolders: new Set<string>(),
            }
          }
        }),
      )
      setBooks(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [expandedIds, expandedFolders, collapsedShelves])

  useEffect(() => {
    void refreshTree()
  }, [refreshTree])

  const expandBook = useCallback(async (bookId: string) => {
    setExpandedIds((s) => new Set(s).add(bookId))
    setBooks((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, loading: true, expanded: true } : b)),
    )
    try {
      const kids = await loadChildren(bookId)
      setBooks((prev) =>
        prev.map((b) =>
          b.id === bookId
            ? {
                ...b,
                ...kids,
                loading: false,
                expanded: true,
                expandedFolders: new Set(
                  [...(b.expandedFolders ?? new Set())].filter((id) =>
                    kids.chapters.some((c) => c.id === id),
                  ),
                ),
              }
            : b,
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBooks((prev) =>
        prev.map((b) => (b.id === bookId ? { ...b, loading: false } : b)),
      )
    }
  }, [])

  const toggleBook = useCallback(
    async (bookId: string) => {
      if (expandedIds.has(bookId)) {
        setExpandedIds((s) => {
          const n = new Set(s)
          n.delete(bookId)
          return n
        })
        setBooks((prev) =>
          prev.map((b) => (b.id === bookId ? { ...b, expanded: false } : b)),
        )
        return
      }
      await expandBook(bookId)
    },
    [expandedIds, expandBook],
  )

  const toggleFolder = useCallback((bookId: string, chapterId: string) => {
    setExpandedFolders((s) => {
      const n = new Set(s)
      if (n.has(chapterId)) n.delete(chapterId)
      else n.add(chapterId)
      return n
    })
    setBooks((prev) =>
      prev.map((b) => {
        if (b.id !== bookId) return b
        const next = new Set(b.expandedFolders)
        if (next.has(chapterId)) next.delete(chapterId)
        else next.add(chapterId)
        return { ...b, expandedFolders: next }
      }),
    )
  }, [])

  const toggleShelf = useCallback((shelfId: string) => {
    setCollapsedShelves((s) => {
      const n = new Set(s)
      if (n.has(shelfId)) n.delete(shelfId)
      else n.add(shelfId)
      return n
    })
    setShelves((prev) =>
      prev.map((s) => (s.id === shelfId ? { ...s, expanded: !s.expanded } : s)),
    )
  }, [])

  const createBook = useCallback(
    async (title: string, description?: string, shelfId?: string | null) => {
      const book = await api.createBook({ title, description, shelfId: shelfId ?? undefined })
      setBooks((prev) => [
        ...prev,
        {
          ...book,
          pages: [],
          diagrams: [],
          slideDecks: [],
          chapters: [],
          expanded: false,
          expandedFolders: new Set(),
        },
      ])
      if (book.shelfId) {
        setShelves((prev) =>
          prev.map((s) =>
            s.id === book.shelfId ? { ...s, bookCount: s.bookCount + 1, expanded: true } : s,
          ),
        )
        setCollapsedShelves((s) => {
          const n = new Set(s)
          n.delete(book.shelfId!)
          return n
        })
      }
      return book
    },
    [],
  )

  const createShelf = useCallback(async (title: string, description?: string) => {
    const shelf = await api.createShelf({ title, description })
    setShelves((prev) => [...prev, { ...shelf, expanded: true }])
    return shelf
  }, [])

  const renameShelf = useCallback(async (shelfId: string, title: string) => {
    const updated = await api.updateShelf(shelfId, { title })
    setShelves((prev) =>
      prev.map((s) => (s.id === shelfId ? { ...updated, expanded: s.expanded } : s)),
    )
    // The book rows carry the shelf title for the properties pane, so they have
    // to hear about the rename too.
    setBooks((prev) =>
      prev.map((b) => (b.shelfId === shelfId ? { ...b, shelfTitle: updated.title } : b)),
    )
  }, [])

  const deleteShelf = useCallback(async (shelfId: string) => {
    await api.deleteShelf(shelfId)
    setShelves((prev) => prev.filter((s) => s.id !== shelfId))
    // Server-side the books are unshelved, not deleted — mirror that rather than
    // dropping them out of the tree until the next refresh.
    setBooks((prev) =>
      prev.map((b) =>
        b.shelfId === shelfId ? { ...b, shelfId: null, shelfTitle: null } : b,
      ),
    )
  }, [])

  const moveBookToShelf = useCallback(async (bookId: string, shelfId: string | null) => {
    const book = await api.getBook(bookId)
    if ((book.shelfId ?? null) === shelfId) return
    const updated = await api.updateBook(bookId, {
      title: book.title,
      // "" is the API's "move to the library root"; omitting it would mean
      // "leave the shelf alone", which is the opposite of what unshelving needs.
      shelfId: shelfId ?? '',
    })
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, shelfId: updated.shelfId ?? null, shelfTitle: updated.shelfTitle ?? null }
          : b,
      ),
    )
    const from = book.shelfId ?? null
    setShelves((prev) =>
      prev.map((s) => {
        if (s.id === from) return { ...s, bookCount: Math.max(0, s.bookCount - 1) }
        if (s.id === shelfId) return { ...s, bookCount: s.bookCount + 1, expanded: true }
        return s
      }),
    )
    if (shelfId) {
      setCollapsedShelves((s) => {
        const n = new Set(s)
        n.delete(shelfId)
        return n
      })
    }
  }, [])

  const createPage = useCallback(async (bookId: string, title: string, chapterId?: string | null) => {
    const sample = `# ${title}

Write architecture notes in **Markdown**.

\`\`\`mermaid
graph LR
  A[Author] --> B[BeeDocs]
\`\`\`
`
    const siblings = (await api.listPages(bookId)).filter(
      (p) => (p.chapterId ?? null) === (chapterId ?? null),
    )
    const sortOrder = siblings.length
    const page = await api.createPage(bookId, {
      title,
      content: sample,
      chapterId: chapterId || undefined,
      sortOrder,
    })
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              expanded: true,
              pages: [...b.pages, page].sort(
                (a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title),
              ),
              expandedFolders:
                chapterId != null
                  ? new Set(b.expandedFolders).add(chapterId)
                  : b.expandedFolders,
            }
          : b,
      ),
    )
    setExpandedIds((s) => new Set(s).add(bookId))
    if (chapterId) setExpandedFolders((s) => new Set(s).add(chapterId))
    return page
  }, [])

  const createFolder = useCallback(async (bookId: string, title: string) => {
    const chapters = await api.listChapters(bookId)
    const chapter = await api.createChapter(bookId, {
      title,
      sortOrder: chapters.length,
    })
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              expanded: true,
              chapters: [...b.chapters, chapter].sort(
                (a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title),
              ),
              expandedFolders: new Set(b.expandedFolders).add(chapter.id),
            }
          : b,
      ),
    )
    setExpandedIds((s) => new Set(s).add(bookId))
    setExpandedFolders((s) => new Set(s).add(chapter.id))
    return chapter
  }, [])

  const createDiagram = useCallback(async (bookId: string, title: string) => {
    const diagram = await api.createDiagram(bookId, { title, kind: 'beediagram' })
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              expanded: true,
              diagrams: [diagram, ...b.diagrams],
            }
          : b,
      ),
    )
    setExpandedIds((s) => new Set(s).add(bookId))
    return diagram
  }, [])

  const createSlideDeck = useCallback(async (bookId: string, title: string) => {
    const deck = await api.createSlideDeck(bookId, {
      title,
      source: starterDeckSource(title),
    })
    const summary: SlideDeckSummary = {
      id: deck.id,
      bookId: deck.bookId,
      title: deck.title,
      slideCount: 1,
      updatedAt: deck.updatedAt,
    }
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              expanded: true,
              slideDecks: [summary, ...b.slideDecks],
            }
          : b,
      ),
    )
    setExpandedIds((s) => new Set(s).add(bookId))
    return summary
  }, [])

  const deleteBook = useCallback(
    async (bookId: string) => {
      const shelfId = books.find((b) => b.id === bookId)?.shelfId ?? null
      await api.deleteBook(bookId)
      setBooks((prev) => prev.filter((b) => b.id !== bookId))
      if (shelfId) {
        setShelves((prev) =>
          prev.map((s) =>
            s.id === shelfId ? { ...s, bookCount: Math.max(0, s.bookCount - 1) } : s,
          ),
        )
      }
    },
    [books],
  )

  const deletePage = useCallback(async (pageId: string, bookId: string) => {
    await api.deletePage(pageId)
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, pages: b.pages.filter((p) => p.id !== pageId) } : b,
      ),
    )
  }, [])

  const deleteFolder = useCallback(async (chapterId: string, bookId: string) => {
    await api.deleteChapter(chapterId)
    setBooks((prev) =>
      prev.map((b) => {
        if (b.id !== bookId) return b
        return {
          ...b,
          chapters: b.chapters.filter((c) => c.id !== chapterId),
          pages: b.pages.map((p) =>
            p.chapterId === chapterId ? { ...p, chapterId: null } : p,
          ),
        }
      }),
    )
    setExpandedFolders((s) => {
      const n = new Set(s)
      n.delete(chapterId)
      return n
    })
  }, [])

  const deleteDiagram = useCallback(async (diagramId: string, bookId: string) => {
    await api.deleteDiagram(diagramId)
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, diagrams: b.diagrams.filter((d) => d.id !== diagramId) }
          : b,
      ),
    )
  }, [])

  const deleteSlideDeck = useCallback(async (deckId: string, bookId: string) => {
    await api.deleteSlideDeck(deckId)
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, slideDecks: b.slideDecks.filter((d) => d.id !== deckId) }
          : b,
      ),
    )
  }, [])

  const renameFolder = useCallback(async (chapterId: string, bookId: string, title: string) => {
    const updated = await api.updateChapter(chapterId, { title })
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              chapters: b.chapters.map((c) => (c.id === chapterId ? updated : c)),
            }
          : b,
      ),
    )
  }, [])

  const movePage = useCallback(
    async (args: {
      pageId: string
      bookId: string
      chapterId: string | null
      sortOrder?: number
    }) => {
      const full = await api.getPage(args.pageId)
      const chapterIdPayload = args.chapterId == null ? '' : args.chapterId
      const updated = await api.updatePage(args.pageId, {
        title: full.title,
        content: full.content,
        chapterId: chapterIdPayload,
        sortOrder: args.sortOrder ?? full.sortOrder,
      })
      setBooks((prev) =>
        prev.map((b) => {
          if (b.id !== args.bookId) return b
          const pages = b.pages.map((p) =>
            p.id === args.pageId
              ? {
                  ...p,
                  chapterId: updated.chapterId ?? null,
                  sortOrder: updated.sortOrder,
                  title: updated.title,
                }
              : p,
          )
          return {
            ...b,
            pages: pages.sort(
              (a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title),
            ),
            expandedFolders:
              args.chapterId != null
                ? new Set(b.expandedFolders).add(args.chapterId)
                : b.expandedFolders,
          }
        }),
      )
      if (args.chapterId) setExpandedFolders((s) => new Set(s).add(args.chapterId!))
    },
    [],
  )

  const reorderFolder = useCallback(
    async (chapterId: string, bookId: string, sortOrder: number) => {
      const book = books.find((b) => b.id === bookId)
      const chapter = book?.chapters.find((c) => c.id === chapterId)
      if (!chapter) return
      const updated = await api.updateChapter(chapterId, {
        title: chapter.title,
        sortOrder,
      })
      setBooks((prev) =>
        prev.map((b) =>
          b.id === bookId
            ? {
                ...b,
                chapters: b.chapters
                  .map((c) => (c.id === chapterId ? updated : c))
                  .sort((a, c) => a.sortOrder - c.sortOrder || a.title.localeCompare(c.title)),
              }
            : b,
        ),
      )
    },
    [books],
  )

  const renameInTree = useCallback(async () => {
    await refreshTree()
  }, [refreshTree])

  const value = useMemo(
    () => ({
      books,
      shelves,
      loading,
      error,
      selection,
      setSelection,
      syncSelectionFromRoute,
      refreshTree,
      toggleBook,
      expandBook,
      toggleFolder,
      toggleShelf,
      createBook,
      createShelf,
      createPage,
      createFolder,
      createDiagram,
      createSlideDeck,
      deleteBook,
      deleteShelf,
      renameShelf,
      moveBookToShelf,
      deletePage,
      deleteFolder,
      deleteDiagram,
      deleteSlideDeck,
      renameFolder,
      movePage,
      reorderFolder,
      renameInTree,
    }),
    [
      books,
      shelves,
      loading,
      error,
      selection,
      setSelection,
      syncSelectionFromRoute,
      refreshTree,
      toggleBook,
      expandBook,
      toggleFolder,
      toggleShelf,
      createBook,
      createShelf,
      createPage,
      createFolder,
      createDiagram,
      createSlideDeck,
      deleteBook,
      deleteShelf,
      renameShelf,
      moveBookToShelf,
      deletePage,
      deleteFolder,
      deleteDiagram,
      deleteSlideDeck,
      renameFolder,
      movePage,
      reorderFolder,
      renameInTree,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useWorkspace() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWorkspace outside provider')
  return ctx
}
