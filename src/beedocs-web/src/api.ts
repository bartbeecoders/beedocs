import type {
  Book,
  Chapter,
  Diagram,
  DiagramSummary,
  ExportFormat,
  ImportNameMode,
  ImportPreview,
  ImportResult,
  Page,
  PageSummary,
  SearchKind,
  SearchResponse,
  SearchStatus,
  ShapeCollection,
} from './types'
import { withApiBase } from './basePath'

/** Pull the API's `{ error }` message out of a failed response when there is one. */
async function errorText(res: Response): Promise<string> {
  const text = await res.text()
  if (!text) return `${res.status} ${res.statusText}`
  try {
    const parsed = JSON.parse(text) as { error?: string; title?: string }
    return parsed.error ?? parsed.title ?? text
  } catch {
    return text
  }
}

/** Multipart upload → { id, fileName, url, contentType, size } */
async function uploadFile(file: File | Blob, fileName?: string) {
  const form = new FormData()
  const name =
    fileName ||
    (file instanceof File && file.name ? file.name : `paste-${Date.now()}.png`)
  form.append('file', file, name)
  const res = await fetch(withApiBase('/api/uploads'), { method: 'POST', body: form })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<{
    id: string
    fileName: string
    url: string
    contentType: string
    size: number
  }>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withApiBase(path), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  getVersion: () => request<{ version: string }>('/api/version'),
  getHealth: () => request<{ status: string; service?: string; version?: string }>('/api/health'),

  /**
   * Full-text search over books, folders, pages and diagrams. `signal` lets the
   * caller drop the response for a query the user has already typed past.
   */
  search: (
    query: string,
    options: {
      limit?: number
      offset?: number
      bookId?: string
      kinds?: SearchKind[]
      /** Match the final term as a prefix. On for as-you-type, off for a submitted query. */
      prefix?: boolean
      signal?: AbortSignal
    } = {},
  ) => {
    const params = new URLSearchParams({ q: query })
    if (options.limit != null) params.set('limit', String(options.limit))
    if (options.offset != null) params.set('offset', String(options.offset))
    if (options.bookId) params.set('bookId', options.bookId)
    if (options.kinds?.length) params.set('kinds', options.kinds.join(','))
    if (options.prefix === false) params.set('prefix', 'false')
    return request<SearchResponse>(`/api/search?${params}`, { signal: options.signal })
  },
  getSearchStatus: () => request<SearchStatus>('/api/search/status'),
  reindexSearch: () => request<SearchStatus>('/api/search/reindex', { method: 'POST' }),

  listBooks: () => request<Book[]>('/api/books'),
  getBook: (id: string) => request<Book>(`/api/books/${id}`),
  createBook: (body: { title: string; description?: string; slug?: string }) =>
    request<Book>('/api/books', { method: 'POST', body: JSON.stringify(body) }),
  updateBook: (id: string, body: { title: string; description?: string; slug?: string }) =>
    request<Book>(`/api/books/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteBook: (id: string) => request<void>(`/api/books/${id}`, { method: 'DELETE' }),

  listChapters: (bookId: string) => request<Chapter[]>(`/api/books/${bookId}/chapters`),
  createChapter: (bookId: string, body: { title: string; slug?: string; sortOrder?: number }) =>
    request<Chapter>(`/api/books/${bookId}/chapters`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateChapter: (id: string, body: { title: string; slug?: string; sortOrder?: number }) =>
    request<Chapter>(`/api/chapters/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteChapter: (id: string) => request<void>(`/api/chapters/${id}`, { method: 'DELETE' }),

  listPages: (bookId: string) => request<PageSummary[]>(`/api/books/${bookId}/pages`),
  getPage: (id: string) => request<Page>(`/api/pages/${id}`),
  createPage: (
    bookId: string,
    body: {
      title: string
      content?: string
      slug?: string
      chapterId?: string
      sortOrder?: number
    },
  ) =>
    request<Page>(`/api/books/${bookId}/pages`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePage: (
    id: string,
    body: {
      title: string
      content?: string
      slug?: string
      /** Pass "" to clear folder assignment */
      chapterId?: string | null
      sortOrder?: number
    },
  ) => request<Page>(`/api/pages/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePage: (id: string) => request<void>(`/api/pages/${id}`, { method: 'DELETE' }),

  listDiagrams: (bookId: string) => request<DiagramSummary[]>(`/api/books/${bookId}/diagrams`),
  listPageDiagrams: (pageId: string) => request<DiagramSummary[]>(`/api/pages/${pageId}/diagrams`),
  getDiagram: (id: string) => request<Diagram>(`/api/diagrams/${id}`),
  createDiagram: (
    bookId: string,
    body: { title: string; kind?: string; source?: string; pageId?: string },
  ) =>
    request<Diagram>(`/api/books/${bookId}/diagrams`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateDiagram: (
    id: string,
    body: { title: string; kind?: string; source?: string; pageId?: string | null },
  ) => request<Diagram>(`/api/diagrams/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteDiagram: (id: string) => request<void>(`/api/diagrams/${id}`, { method: 'DELETE' }),

  /** Book-scoped collections only. */
  listShapeCollections: (bookId: string) =>
    request<ShapeCollection[]>(`/api/books/${bookId}/collections`),
  /** App-wide library (available in every book). */
  listAppShapeCollections: () => request<ShapeCollection[]>('/api/collections'),
  getShapeCollection: (id: string) => request<ShapeCollection>(`/api/collections/${id}`),
  /**
   * Save a collection. Pass `bookId` for book scope; omit for the app-wide library.
   */
  createShapeCollection: (body: {
    name: string
    description?: string
    source: string
    bookId?: string
  }) => {
    const { bookId, ...payload } = body
    if (bookId) {
      return request<ShapeCollection>(`/api/books/${bookId}/collections`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    }
    return request<ShapeCollection>('/api/collections', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
  updateShapeCollection: (
    id: string,
    body: { name: string; description?: string | null; source?: string },
  ) => request<ShapeCollection>(`/api/collections/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteShapeCollection: (id: string) =>
    request<void>(`/api/collections/${id}`, { method: 'DELETE' }),

  /**
   * Download a book or page in one of the server-rendered formats and save it
   * through the browser. PDF is not handled here — it is produced client-side
   * by src/export/pdf.ts, which needs a DOM to render diagrams.
   */
  downloadExport: async (kind: 'books' | 'pages', id: string, format: ExportFormat) => {
    const res = await fetch(withApiBase(`/api/${kind}/${id}/export?format=${format}`))
    if (!res.ok) {
      const text = await res.text()
      throw new Error(text || `${res.status} ${res.statusText}`)
    }

    // Prefer the server's filename; fall back to something sensible.
    const disposition = res.headers.get('content-disposition') ?? ''
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
    const fileName = match ? decodeURIComponent(match[1]) : `${kind}-${id}.${format}`

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return fileName
  },

  /** Describe an import file without writing anything. */
  inspectImport: async (file: File): Promise<ImportPreview> => {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch(withApiBase('/api/import/inspect'), { method: 'POST', body: form })
    if (!res.ok) throw new Error(await errorText(res))
    return res.json() as Promise<ImportPreview>
  },

  importFile: async (
    file: File,
    options: { mode: ImportNameMode; targetBookId?: string; title?: string },
  ): Promise<ImportResult> => {
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('mode', options.mode)
    if (options.targetBookId) form.append('targetBookId', options.targetBookId)
    if (options.title) form.append('title', options.title)
    const res = await fetch(withApiBase('/api/import'), { method: 'POST', body: form })
    if (!res.ok) throw new Error(await errorText(res))
    return res.json() as Promise<ImportResult>
  },

  /**
   * Multipart file upload (images, PDF, 3D models) →
   * { id, fileName, url: "/uploads/…", contentType, size }
   */
  uploadFile: uploadFile,

  /** Alias of uploadFile — kept for existing image paste/drop call sites. */
  uploadImage: uploadFile,
}
