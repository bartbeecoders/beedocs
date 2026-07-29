import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BeeDocsClient } from './client.js'

export function registerResources(server: McpServer, client: BeeDocsClient) {
  server.registerResource(
    'beedocs-library',
    'beedocs://library',
    {
      title: 'BeeDocs library index',
      description: 'JSON list of all books (id, title, slug, description).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const books = await client.listBooks()
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(books, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-book',
    new ResourceTemplate('beedocs://books/{bookId}', {
      list: undefined,
    }),
    {
      title: 'Book',
      description: 'Single book metadata by id.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const bookId = String(vars.bookId)
      const book = await client.getBook(bookId)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(book, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-book-pages',
    new ResourceTemplate('beedocs://books/{bookId}/pages', {
      list: undefined,
    }),
    {
      title: 'Book pages',
      description: 'Page summaries for a book.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const bookId = String(vars.bookId)
      const pages = await client.listPages(bookId)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(pages, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-book-chapters',
    new ResourceTemplate('beedocs://books/{bookId}/chapters', {
      list: undefined,
    }),
    {
      title: 'Book chapters (folders)',
      description: 'Folder/chapter list for a book.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const bookId = String(vars.bookId)
      const chapters = await client.listChapters(bookId)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(chapters, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-book-tree',
    new ResourceTemplate('beedocs://books/{bookId}/tree', {
      list: undefined,
    }),
    {
      title: 'Book tree',
      description: 'Folders with nested pages, root pages, and diagrams.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const bookId = String(vars.bookId)
      const [book, chapters, pages, diagrams] = await Promise.all([
        client.getBook(bookId),
        client.listChapters(bookId) as Promise<
          Array<{ id: string; title: string; sortOrder: number }>
        >,
        client.listPages(bookId) as Promise<
          Array<{ id: string; title: string; chapterId?: string | null; sortOrder: number }>
        >,
        client.listDiagrams(bookId),
      ])
      const ch = [...chapters].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
      )
      const sortedPages = [...pages].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
      )
      const tree = {
        book,
        folders: ch.map((c) => ({
          ...c,
          pages: sortedPages.filter((p) => p.chapterId === c.id),
        })),
        rootPages: sortedPages.filter((p) => !p.chapterId),
        diagrams,
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(tree, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-page',
    new ResourceTemplate('beedocs://pages/{pageId}', {
      list: undefined,
    }),
    {
      title: 'Page',
      description: 'Full page including Markdown content.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const pageId = String(vars.pageId)
      const page = await client.getPage(pageId)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'beedocs-diagram',
    new ResourceTemplate('beedocs://diagrams/{diagramId}', {
      list: undefined,
    }),
    {
      title: 'Diagram',
      description: 'Full diagram including source payload.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const diagramId = String(vars.diagramId)
      const diagram = await client.getDiagram(diagramId)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(diagram, null, 2),
          },
        ],
      }
    },
  )
}
