import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api } from '../api'
import type { Book, Chapter, DiagramSummary, PageSummary } from '../types'

export type TreeBook = Book & {
  pages: PageSummary[]
  diagrams: DiagramSummary[]
  chapters: Chapter[]
  expanded: boolean
  /** Expanded folder (chapter) ids within this book */
  expandedFolders: Set<string>
  loading?: boolean
}

type WorkspaceCtx = {
  books: TreeBook[]
  loading: boolean
  error: string | null
  refreshTree: () => Promise<void>
  toggleBook: (bookId: string) => Promise<void>
  expandBook: (bookId: string) => Promise<void>
  toggleFolder: (bookId: string, chapterId: string) => void
  createBook: (title: string, description?: string) => Promise<Book>
  createPage: (bookId: string, title: string, chapterId?: string | null) => Promise<PageSummary>
  createFolder: (bookId: string, title: string) => Promise<Chapter>
  createDiagram: (bookId: string, title: string) => Promise<DiagramSummary>
  deleteBook: (bookId: string) => Promise<void>
  deletePage: (pageId: string, bookId: string) => Promise<void>
  deleteFolder: (chapterId: string, bookId: string) => Promise<void>
  deleteDiagram: (diagramId: string, bookId: string) => Promise<void>
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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

  useEffect(() => {
    localStorage.setItem('beedocs-expanded-books', JSON.stringify([...expandedIds]))
  }, [expandedIds])

  useEffect(() => {
    localStorage.setItem('beedocs-expanded-folders', JSON.stringify([...expandedFolders]))
  }, [expandedFolders])

  const loadChildren = async (bookId: string) => {
    const [pages, diagrams, chapters] = await Promise.all([
      api.listPages(bookId),
      api.listDiagrams(bookId),
      api.listChapters(bookId),
    ])
    return { pages, diagrams, chapters }
  }

  const refreshTree = useCallback(async () => {
    setError(null)
    try {
      const list = await api.listBooks()
      const next: TreeBook[] = await Promise.all(
        list.map(async (b) => {
          const expanded = expandedIds.has(b.id)
          if (!expanded) {
            return {
              ...b,
              pages: [],
              diagrams: [],
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
  }, [expandedIds, expandedFolders])

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

  const createBook = useCallback(async (title: string, description?: string) => {
    const book = await api.createBook({ title, description })
    setBooks((prev) => [
      ...prev,
      {
        ...book,
        pages: [],
        diagrams: [],
        chapters: [],
        expanded: false,
        expandedFolders: new Set(),
      },
    ])
    return book
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

  const deleteBook = useCallback(async (bookId: string) => {
    await api.deleteBook(bookId)
    setBooks((prev) => prev.filter((b) => b.id !== bookId))
  }, [])

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
      loading,
      error,
      refreshTree,
      toggleBook,
      expandBook,
      toggleFolder,
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
      reorderFolder,
      renameInTree,
    }),
    [
      books,
      loading,
      error,
      refreshTree,
      toggleBook,
      expandBook,
      toggleFolder,
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
