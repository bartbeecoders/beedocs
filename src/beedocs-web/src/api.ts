import type { Book, Chapter, Diagram, DiagramSummary, Page, PageSummary } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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

  /** Multipart image upload → { url: "/uploads/…", fileName, … } */
  uploadImage: async (file: File | Blob, fileName?: string) => {
    const form = new FormData()
    const name =
      fileName ||
      (file instanceof File && file.name ? file.name : `paste-${Date.now()}.png`)
    form.append('file', file, name)
    const res = await fetch('/api/uploads', { method: 'POST', body: form })
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
  },
}
