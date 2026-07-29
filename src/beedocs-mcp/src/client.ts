/**
 * Thin HTTP client for the BeeDocs REST API.
 * Base URL: BEEDOCS_API_URL (default http://localhost:5080)
 */

export class BeeDocsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'BeeDocsApiError'
  }
}

export class BeeDocsClient {
  constructor(public readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BeeDocsApiError(
        `BeeDocs API ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 500)}` : ''}`,
        res.status,
        text,
      )
    }

    if (res.status === 204) return undefined as T
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) {
      return undefined as T
    }
    return (await res.json()) as T
  }

  health() {
    return this.request<{ status: string; service: string }>('/api/health')
  }

  // --- Books ---
  listBooks() {
    return this.request<unknown[]>('/api/books')
  }

  getBook(id: string) {
    return this.request<unknown>(`/api/books/${encodeURIComponent(id)}`)
  }

  createBook(body: { title: string; description?: string; slug?: string }) {
    return this.request<unknown>('/api/books', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  updateBook(
    id: string,
    body: { title: string; description?: string; slug?: string; sortOrder?: number },
  ) {
    return this.request<unknown>(`/api/books/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  deleteBook(id: string) {
    return this.request<void>(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // --- Chapters ---
  listChapters(bookId: string) {
    return this.request<unknown[]>(`/api/books/${encodeURIComponent(bookId)}/chapters`)
  }

  createChapter(bookId: string, body: { title: string; slug?: string; sortOrder?: number }) {
    return this.request<unknown>(`/api/books/${encodeURIComponent(bookId)}/chapters`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  updateChapter(id: string, body: { title: string; slug?: string; sortOrder?: number }) {
    return this.request<unknown>(`/api/chapters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  deleteChapter(id: string) {
    return this.request<void>(`/api/chapters/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // --- Pages ---
  listPages(bookId: string) {
    return this.request<unknown[]>(`/api/books/${encodeURIComponent(bookId)}/pages`)
  }

  getPage(id: string) {
    return this.request<unknown>(`/api/pages/${encodeURIComponent(id)}`)
  }

  createPage(
    bookId: string,
    body: {
      title: string
      content?: string
      slug?: string
      chapterId?: string
      sortOrder?: number
    },
  ) {
    return this.request<unknown>(`/api/books/${encodeURIComponent(bookId)}/pages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  updatePage(
    id: string,
    body: {
      title: string
      content?: string
      slug?: string
      /** null/empty string clears folder assignment */
      chapterId?: string | null
      sortOrder?: number
    },
  ) {
    const payload = {
      ...body,
      // API: non-null ChapterId updates; whitespace clears. JSON null is ignored by API.
      chapterId:
        body.chapterId === null || body.chapterId === undefined
          ? body.chapterId === null
            ? ''
            : undefined
          : body.chapterId,
    }
    // Only include chapterId when defined (including '')
    const clean: Record<string, unknown> = {
      title: payload.title,
    }
    if (payload.content !== undefined) clean.content = payload.content
    if (payload.slug !== undefined) clean.slug = payload.slug
    if (payload.sortOrder !== undefined) clean.sortOrder = payload.sortOrder
    if (body.chapterId !== undefined) clean.chapterId = body.chapterId === null ? '' : body.chapterId

    return this.request<unknown>(`/api/pages/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(clean),
    })
  }

  deletePage(id: string) {
    return this.request<void>(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  // --- Diagrams ---
  listDiagrams(bookId: string) {
    return this.request<unknown[]>(`/api/books/${encodeURIComponent(bookId)}/diagrams`)
  }

  listPageDiagrams(pageId: string) {
    return this.request<unknown[]>(`/api/pages/${encodeURIComponent(pageId)}/diagrams`)
  }

  getDiagram(id: string) {
    return this.request<unknown>(`/api/diagrams/${encodeURIComponent(id)}`)
  }

  createDiagram(
    bookId: string,
    body: { title: string; kind?: string; source?: string; pageId?: string },
  ) {
    return this.request<unknown>(`/api/books/${encodeURIComponent(bookId)}/diagrams`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  updateDiagram(
    id: string,
    body: { title: string; kind?: string; source?: string; pageId?: string | null },
  ) {
    return this.request<unknown>(`/api/diagrams/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  deleteDiagram(id: string) {
    return this.request<void>(`/api/diagrams/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /**
   * Upload an image (multipart). Accepts base64 payload from MCP tools.
   */
  async uploadImage(args: {
    base64: string
    fileName: string
    contentType?: string
  }): Promise<{ id: string; fileName: string; url: string; contentType: string; size: number }> {
    const buf = Buffer.from(args.base64, 'base64')
    const type = args.contentType || guessContentType(args.fileName)
    const form = new FormData()
    const blob = new Blob([buf], { type })
    form.append('file', blob, args.fileName)

    const url = `${this.baseUrl}/api/uploads`
    const res = await fetch(url, { method: 'POST', body: form })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new BeeDocsApiError(
        `BeeDocs API POST /api/uploads failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 500)}` : ''}`,
        res.status,
        text,
      )
    }
    return (await res.json()) as {
      id: string
      fileName: string
      url: string
      contentType: string
      size: number
    }
  }
}

function guessContentType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

export function createClientFromEnv(): BeeDocsClient {
  const base =
    process.env.BEEDOCS_API_URL?.trim() ||
    process.env.BEEDOCS_URL?.trim() ||
    'http://localhost:5080'
  return new BeeDocsClient(base)
}
