import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { BeeDocsClient } from './client.js'
import { BeeDocsApiError } from './client.js'

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  }
}

function errorResult(err: unknown) {
  const message =
    err instanceof BeeDocsApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err)
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  }
}

const emptyBeeDiagram = JSON.stringify({
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
})

/**
 * Register every BeeDocs capability as an MCP tool.
 */
export function registerTools(server: McpServer, client: BeeDocsClient) {
  // ---- System ----
  server.registerTool(
    'beedocs_health',
    {
      title: 'Health check',
      description: 'Check whether the BeeDocs API is reachable and healthy.',
    },
    async () => {
      try {
        const h = await client.health()
        return jsonResult({ ok: true, api: client.baseUrl, ...h })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_get_api_info',
    {
      title: 'API info',
      description:
        'Return the configured BeeDocs API base URL and a summary of available entity types and workflows for agents.',
    },
    async () =>
      jsonResult({
        apiBaseUrl: client.baseUrl,
        entities: ['book', 'chapter (folder)', 'page', 'diagram', 'upload'],
        diagramKinds: ['beediagram', 'mermaid', 'c4', 'plantuml'],
        beediagramNodeTypes: ['box', 'person', 'system', 'database', 'note', 'image'],
        beediagramEdgeRoutes: ['straight', 'curved', 'orthogonal'],
        beediagramSourceShape: {
          version: 1,
          nodes: [
            {
              id: 'n1',
              type: 'box|person|system|database|note|image',
              label: 'string',
              x: 0,
              y: 0,
              w: 140,
              h: 72,
              color: '#hex optional',
              imageUrl: 'optional for type=image',
            },
          ],
          edges: [
            {
              id: 'e1',
              from: 'n1',
              to: 'n2',
              label: 'optional',
              fromAnchor: 'n|e|s|w',
              toAnchor: 'n|e|s|w',
              route: 'straight|curved|orthogonal',
              waypoints: 'optional [{x,y}] for orthogonal bends',
            },
          ],
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        markdownEmbeds: {
          mermaid: '```mermaid\\n...\\n```',
          beediagramRef: '```beediagram-ref\\nDIAGRAM_ID\\n```',
          beediagramInline: '```beediagram\\n{json}\\n```',
          image: '![alt](/uploads/...)',
        },
        capabilities: {
          folders: 'chapters group pages; beedocs_create_chapter / update / delete / move_page',
          images: 'beedocs_upload_image then embed Markdown or image nodes',
          export: 'beedocs_export_book_html (print-ready HTML for PDF) or export_library_snapshot',
        },
        suggestedWorkflow: [
          'beedocs_list_books → pick or beedocs_create_book',
          'beedocs_create_chapter for folders, beedocs_create_page with chapterId',
          'beedocs_create_diagram / beedocs_create_beediagram_with_nodes',
          'beedocs_embed_diagram_in_page or beedocs_upload_image + append',
          'beedocs_export_book_html for PDF print pipeline',
        ],
      }),
  )

  // ---- Books ----
  server.registerTool(
    'beedocs_list_books',
    {
      title: 'List books',
      description: 'List all documentation books (shelves) in BeeDocs.',
    },
    async () => {
      try {
        return jsonResult(await client.listBooks())
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_get_book',
    {
      title: 'Get book',
      description: 'Get a single book by id.',
      inputSchema: {
        bookId: z.string().describe('Book id'),
      },
    },
    async ({ bookId }) => {
      try {
        return jsonResult(await client.getBook(bookId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_create_book',
    {
      title: 'Create book',
      description: 'Create a new documentation book.',
      inputSchema: {
        title: z.string().min(1).describe('Book title'),
        description: z.string().optional().describe('Optional description'),
        slug: z.string().optional().describe('Optional URL slug (auto-generated if omitted)'),
      },
    },
    async ({ title, description, slug }) => {
      try {
        return jsonResult(await client.createBook({ title, description, slug }))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_update_book',
    {
      title: 'Update book',
      description: 'Update an existing book title, description, slug, or sort order.',
      inputSchema: {
        bookId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        slug: z.string().optional(),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ bookId, title, description, slug, sortOrder }) => {
      try {
        return jsonResult(
          await client.updateBook(bookId, { title, description, slug, sortOrder }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_delete_book',
    {
      title: 'Delete book',
      description: 'Delete a book and cascade its pages/chapters. Destructive.',
      inputSchema: {
        bookId: z.string(),
      },
    },
    async ({ bookId }) => {
      try {
        await client.deleteBook(bookId)
        return jsonResult({ deleted: true, bookId })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  // ---- Chapters ----
  server.registerTool(
    'beedocs_list_chapters',
    {
      title: 'List chapters',
      description: 'List chapters for a book.',
      inputSchema: {
        bookId: z.string(),
      },
    },
    async ({ bookId }) => {
      try {
        return jsonResult(await client.listChapters(bookId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_create_chapter',
    {
      title: 'Create chapter (folder)',
      description:
        'Create a chapter/folder inside a book for grouping pages. Same as UI “New folder”.',
      inputSchema: {
        bookId: z.string(),
        title: z.string().min(1),
        slug: z.string().optional(),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ bookId, title, slug, sortOrder }) => {
      try {
        return jsonResult(await client.createChapter(bookId, { title, slug, sortOrder }))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_update_chapter',
    {
      title: 'Update chapter (folder)',
      description: 'Rename a folder/chapter or change its sort order.',
      inputSchema: {
        chapterId: z.string(),
        title: z.string().min(1),
        slug: z.string().optional(),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ chapterId, title, slug, sortOrder }) => {
      try {
        return jsonResult(await client.updateChapter(chapterId, { title, slug, sortOrder }))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_delete_chapter',
    {
      title: 'Delete chapter (folder)',
      description:
        'Delete a folder/chapter. Pages inside are unlinked (moved to book root), not deleted.',
      inputSchema: {
        chapterId: z.string(),
      },
    },
    async ({ chapterId }) => {
      try {
        await client.deleteChapter(chapterId)
        return jsonResult({ deleted: true, chapterId })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  // ---- Pages ----
  server.registerTool(
    'beedocs_list_pages',
    {
      title: 'List pages',
      description: 'List page summaries for a book (no full content).',
      inputSchema: {
        bookId: z.string(),
      },
    },
    async ({ bookId }) => {
      try {
        return jsonResult(await client.listPages(bookId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_get_page',
    {
      title: 'Get page',
      description: 'Get a page including full Markdown content.',
      inputSchema: {
        pageId: z.string(),
      },
    },
    async ({ pageId }) => {
      try {
        return jsonResult(await client.getPage(pageId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_create_page',
    {
      title: 'Create page',
      description:
        'Create a Markdown documentation page in a book. Content supports Mermaid fences and beediagram-ref embeds.',
      inputSchema: {
        bookId: z.string(),
        title: z.string().min(1),
        content: z
          .string()
          .optional()
          .describe('Markdown body (optional; empty page if omitted)'),
        slug: z.string().optional(),
        chapterId: z.string().optional(),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ bookId, title, content, slug, chapterId, sortOrder }) => {
      try {
        return jsonResult(
          await client.createPage(bookId, { title, content, slug, chapterId, sortOrder }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_update_page',
    {
      title: 'Update page',
      description:
        'Update page title and/or Markdown content. Creates a revision snapshot on the server.',
      inputSchema: {
        pageId: z.string(),
        title: z.string().min(1),
        content: z.string().optional().describe('Full Markdown body when updating content'),
        slug: z.string().optional(),
        chapterId: z
          .string()
          .nullable()
          .optional()
          .describe('Chapter id, or null to clear'),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ pageId, title, content, slug, chapterId, sortOrder }) => {
      try {
        return jsonResult(
          await client.updatePage(pageId, { title, content, slug, chapterId, sortOrder }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_delete_page',
    {
      title: 'Delete page',
      description: 'Permanently delete a page by id.',
      inputSchema: {
        pageId: z.string(),
      },
    },
    async ({ pageId }) => {
      try {
        await client.deletePage(pageId)
        return jsonResult({ deleted: true, pageId })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_append_page_content',
    {
      title: 'Append to page',
      description:
        'Convenience: load a page, append Markdown to its content, and save (bumps version).',
      inputSchema: {
        pageId: z.string(),
        markdown: z.string().describe('Markdown fragment to append'),
        separator: z
          .string()
          .optional()
          .describe('Inserted between existing content and append (default two newlines)'),
      },
    },
    async ({ pageId, markdown, separator }) => {
      try {
        const page = (await client.getPage(pageId)) as {
          title: string
          content: string
          chapterId?: string | null
          slug?: string
        }
        const sep = separator ?? '\n\n'
        const content = page.content
          ? `${page.content}${sep}${markdown}`
          : markdown
        return jsonResult(
          await client.updatePage(pageId, {
            title: page.title,
            content,
            chapterId: page.chapterId,
            slug: page.slug,
          }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_move_page',
    {
      title: 'Move page',
      description:
        'Move a page into a folder (chapterId) or to book root (chapterId null), and/or set sortOrder among siblings.',
      inputSchema: {
        pageId: z.string(),
        chapterId: z
          .string()
          .nullable()
          .optional()
          .describe('Target folder id, or null/omit to leave unchanged; use empty string or null with clearFolder'),
        clearFolder: z
          .boolean()
          .optional()
          .describe('If true, move page to book root (clears chapterId)'),
        sortOrder: z.number().int().optional(),
      },
    },
    async ({ pageId, chapterId, clearFolder, sortOrder }) => {
      try {
        const page = (await client.getPage(pageId)) as {
          title: string
          content: string
          chapterId?: string | null
          slug?: string
          sortOrder?: number
        }
        let nextChapter: string | null | undefined = chapterId
        if (clearFolder) nextChapter = null
        return jsonResult(
          await client.updatePage(pageId, {
            title: page.title,
            content: page.content,
            slug: page.slug,
            chapterId: nextChapter === undefined ? page.chapterId : nextChapter,
            sortOrder: sortOrder ?? page.sortOrder,
          }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  // ---- Uploads / images ----
  server.registerTool(
    'beedocs_upload_image',
    {
      title: 'Upload image',
      description:
        'Upload an image to BeeDocs (/uploads/…). Pass base64 file bytes. Returns { url, fileName } for Markdown ![alt](url) or diagram image nodes.',
      inputSchema: {
        base64: z.string().describe('Base64-encoded image bytes (no data: URL prefix)'),
        fileName: z.string().describe('e.g. diagram.png'),
        contentType: z
          .string()
          .optional()
          .describe('MIME type, e.g. image/png (guessed from fileName if omitted)'),
      },
    },
    async ({ base64, fileName, contentType }) => {
      try {
        const cleaned = base64.replace(/^data:[^;]+;base64,/, '')
        return jsonResult(
          await client.uploadImage({ base64: cleaned, fileName, contentType }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_embed_image_in_page',
    {
      title: 'Embed image in page',
      description:
        'Append a Markdown image to a page. Provide either a public/uploads URL or base64 to upload first.',
      inputSchema: {
        pageId: z.string(),
        url: z.string().optional().describe('Existing image URL (e.g. /uploads/abc.png)'),
        base64: z.string().optional().describe('If set, upload first then embed'),
        fileName: z.string().optional().describe('Required with base64'),
        alt: z.string().optional().describe('Alt text (default file name or image)'),
        heading: z.string().optional(),
      },
    },
    async ({ pageId, url, base64, fileName, alt, heading }) => {
      try {
        let imageUrl = url
        let name = fileName || 'image'
        if (!imageUrl) {
          if (!base64 || !fileName) {
            return errorResult(new Error('Provide url, or base64 + fileName'))
          }
          const cleaned = base64.replace(/^data:[^;]+;base64,/, '')
          const up = await client.uploadImage({ base64: cleaned, fileName })
          imageUrl = up.url
          name = up.fileName || fileName
        }
        const page = (await client.getPage(pageId)) as {
          title: string
          content: string
          chapterId?: string | null
          slug?: string
        }
        const safeAlt = (alt || name).replace(/[[\]]/g, '')
        const block = `![${safeAlt}](${imageUrl})`
        const content = [
          page.content?.trim() ? page.content.trimEnd() : '',
          heading ? `\n\n${heading}\n\n` : '\n\n',
          block,
          '\n',
        ].join('')
        return jsonResult({
          page: await client.updatePage(pageId, {
            title: page.title,
            content,
            chapterId: page.chapterId,
            slug: page.slug,
          }),
          imageUrl,
          markdown: block,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  // ---- Diagrams ----
  server.registerTool(
    'beedocs_list_diagrams',
    {
      title: 'List diagrams in book',
      description: 'List diagram summaries for a book.',
      inputSchema: {
        bookId: z.string(),
      },
    },
    async ({ bookId }) => {
      try {
        return jsonResult(await client.listDiagrams(bookId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_list_page_diagrams',
    {
      title: 'List diagrams linked to page',
      description: 'List diagrams that have pageId set to the given page.',
      inputSchema: {
        pageId: z.string(),
      },
    },
    async ({ pageId }) => {
      try {
        return jsonResult(await client.listPageDiagrams(pageId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_get_diagram',
    {
      title: 'Get diagram',
      description: 'Get a diagram including full source (JSON for beediagram, text for mermaid/c4).',
      inputSchema: {
        diagramId: z.string(),
      },
    },
    async ({ diagramId }) => {
      try {
        return jsonResult(await client.getDiagram(diagramId))
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_create_diagram',
    {
      title: 'Create diagram',
      description:
        'Create a diagram in a book. kind: beediagram (JSON canvas), mermaid, c4, or plantuml. For beediagram, source is JSON with nodes/edges.',
      inputSchema: {
        bookId: z.string(),
        title: z.string().min(1),
        kind: z
          .enum(['beediagram', 'mermaid', 'c4', 'plantuml'])
          .optional()
          .describe('Default beediagram'),
        source: z
          .string()
          .optional()
          .describe('Diagram payload (JSON string for beediagram, text for mermaid/c4)'),
        pageId: z.string().optional().describe('Optional page to attach the diagram to'),
      },
    },
    async ({ bookId, title, kind, source, pageId }) => {
      try {
        const k = kind ?? 'beediagram'
        const src =
          source ??
          (k === 'beediagram'
            ? emptyBeeDiagram
            : k === 'mermaid' || k === 'c4'
              ? 'graph TD\n  A[Start] --> B[End]'
              : '')
        return jsonResult(
          await client.createDiagram(bookId, {
            title,
            kind: k,
            source: src,
            pageId,
          }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_update_diagram',
    {
      title: 'Update diagram',
      description: 'Update diagram title, kind, source, or linked pageId.',
      inputSchema: {
        diagramId: z.string(),
        title: z.string().min(1),
        kind: z.enum(['beediagram', 'mermaid', 'c4', 'plantuml']).optional(),
        source: z.string().optional(),
        pageId: z.string().nullable().optional(),
      },
    },
    async ({ diagramId, title, kind, source, pageId }) => {
      try {
        return jsonResult(
          await client.updateDiagram(diagramId, { title, kind, source, pageId }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_delete_diagram',
    {
      title: 'Delete diagram',
      description: 'Permanently delete a diagram by id.',
      inputSchema: {
        diagramId: z.string(),
      },
    },
    async ({ diagramId }) => {
      try {
        await client.deleteDiagram(diagramId)
        return jsonResult({ deleted: true, diagramId })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_create_beediagram_with_nodes',
    {
      title: 'Create BeeDiagram from nodes/edges',
      description:
        'Create a beediagram with structured nodes and edges (agent-friendly). Returns the created diagram including id for embeds.',
      inputSchema: {
        bookId: z.string(),
        title: z.string().min(1),
        pageId: z.string().optional(),
        nodes: z
          .array(
            z.object({
              id: z.string().optional(),
              type: z
                .enum(['box', 'person', 'system', 'database', 'note', 'image'])
                .optional()
                .default('box'),
              label: z.string(),
              x: z.number().optional(),
              y: z.number().optional(),
              w: z.number().optional(),
              h: z.number().optional(),
              color: z.string().optional(),
              imageUrl: z.string().optional().describe('For type=image'),
            }),
          )
          .describe('Nodes to place on the canvas'),
        edges: z
          .array(
            z.object({
              id: z.string().optional(),
              from: z.string().describe('Source node id'),
              to: z.string().describe('Target node id'),
              label: z.string().optional(),
              fromAnchor: z.enum(['n', 'e', 's', 'w']).optional(),
              toAnchor: z.enum(['n', 'e', 's', 'w']).optional(),
              route: z.enum(['straight', 'curved', 'orthogonal']).optional(),
              waypoints: z
                .array(z.object({ x: z.number(), y: z.number() }))
                .optional()
                .describe('Orthogonal bend points'),
            }),
          )
          .optional()
          .describe('Connections between nodes (use node ids)'),
      },
    },
    async ({ bookId, title, pageId, nodes, edges }) => {
      try {
        const mappedNodes = nodes.map((n, i) => {
          const id = n.id ?? `n${i + 1}`
          const type = n.type ?? 'box'
          const defaults =
            type === 'person'
              ? { w: 120, h: 100 }
              : type === 'database'
                ? { w: 120, h: 90 }
                : type === 'note'
                  ? { w: 160, h: 100 }
                  : type === 'system'
                    ? { w: 160, h: 80 }
                    : type === 'image'
                      ? { w: 220, h: 160 }
                      : { w: 140, h: 72 }
          return {
            id,
            type,
            label: n.label,
            x: n.x ?? 40 + (i % 4) * 200,
            y: n.y ?? 40 + Math.floor(i / 4) * 140,
            w: n.w ?? defaults.w,
            h: n.h ?? defaults.h,
            color: n.color,
            imageUrl: n.imageUrl,
          }
        })
        const idSet = new Set(mappedNodes.map((n) => n.id))
        const mappedEdges = (edges ?? []).map((e, i) => ({
          id: e.id ?? `e${i + 1}`,
          from: e.from,
          to: e.to,
          label: e.label,
          fromAnchor: e.fromAnchor,
          toAnchor: e.toAnchor,
          route: e.route,
          waypoints: e.waypoints,
        }))
        for (const e of mappedEdges) {
          if (!idSet.has(e.from) || !idSet.has(e.to)) {
            return errorResult(
              new Error(
                `Edge ${e.id} references unknown node (from=${e.from}, to=${e.to}). Known: ${[...idSet].join(', ')}`,
              ),
            )
          }
        }
        const source = JSON.stringify({
          version: 1,
          nodes: mappedNodes,
          edges: mappedEdges,
          viewport: { x: 0, y: 0, zoom: 1 },
        })
        const created = await client.createDiagram(bookId, {
          title,
          kind: 'beediagram',
          source,
          pageId,
        })
        const id = (created as { id?: string }).id
        return jsonResult({
          diagram: created,
          embedMarkdown: id
            ? `\`\`\`beediagram-ref\n${id}\n\`\`\``
            : null,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_embed_diagram_in_page',
    {
      title: 'Embed diagram in page',
      description:
        'Append a beediagram-ref (or mermaid fence for mermaid/c4 diagrams) to a page so it renders in the UI.',
      inputSchema: {
        pageId: z.string(),
        diagramId: z.string(),
        heading: z
          .string()
          .optional()
          .describe('Optional Markdown heading before the embed (e.g. "## Architecture")'),
      },
    },
    async ({ pageId, diagramId, heading }) => {
      try {
        const diagram = (await client.getDiagram(diagramId)) as {
          kind: string
          source: string
          title: string
        }
        const page = (await client.getPage(pageId)) as {
          title: string
          content: string
          chapterId?: string | null
          slug?: string
        }
        let block: string
        if (diagram.kind === 'beediagram') {
          block = `\`\`\`beediagram-ref\n${diagramId}\n\`\`\``
        } else if (diagram.kind === 'mermaid' || diagram.kind === 'c4') {
          block = `\`\`\`mermaid\n${diagram.source}\n\`\`\``
        } else {
          block = `\`\`\`${diagram.kind}\n${diagram.source}\n\`\`\``
        }
        const parts = [
          page.content?.trim() ? page.content.trimEnd() : '',
          heading ? `\n\n${heading}\n\n` : '\n\n',
          block,
          '\n',
        ]
        const content = parts.join('')
        return jsonResult(
          await client.updatePage(pageId, {
            title: page.title,
            content,
            chapterId: page.chapterId,
            slug: page.slug,
          }),
        )
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_export_library_snapshot',
    {
      title: 'Export library snapshot',
      description:
        'Export a nested snapshot of all books with their pages (full content) and diagrams. Useful for agents to reason about the whole library.',
      inputSchema: {
        includePageContent: z
          .boolean()
          .optional()
          .describe('Include full page Markdown (default true)'),
        includeDiagramSource: z
          .boolean()
          .optional()
          .describe('Include diagram source (default true)'),
      },
    },
    async ({ includePageContent = true, includeDiagramSource = true }) => {
      try {
        const books = (await client.listBooks()) as Array<{ id: string; title: string }>
        const out = []
        for (const b of books) {
          const pagesSummary = (await client.listPages(b.id)) as Array<{ id: string }>
          const diagramsSummary = (await client.listDiagrams(b.id)) as Array<{ id: string }>
          const chapters = await client.listChapters(b.id)
          const pages = []
          for (const p of pagesSummary) {
            if (includePageContent) {
              pages.push(await client.getPage(p.id))
            } else {
              pages.push(p)
            }
          }
          const diagrams = []
          for (const d of diagramsSummary) {
            if (includeDiagramSource) {
              diagrams.push(await client.getDiagram(d.id))
            } else {
              diagrams.push(d)
            }
          }
          out.push({
            book: b,
            chapters,
            pages,
            diagrams,
          })
        }
        return jsonResult({ exportedAt: new Date().toISOString(), books: out })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_export_book',
    {
      title: 'Export book (structured)',
      description:
        'Export one book with chapters, full pages, and diagrams as JSON. Prefer this before generating PDF/HTML offline.',
      inputSchema: {
        bookId: z.string(),
        includePageContent: z.boolean().optional().describe('Default true'),
        includeDiagramSource: z.boolean().optional().describe('Default true'),
      },
    },
    async ({ bookId, includePageContent = true, includeDiagramSource = true }) => {
      try {
        const book = await client.getBook(bookId)
        const chapters = await client.listChapters(bookId)
        const pagesSummary = (await client.listPages(bookId)) as Array<{
          id: string
          title: string
          sortOrder: number
          chapterId?: string | null
        }>
        const sorted = [...pagesSummary].sort(
          (a, b) =>
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
            String(a.title).localeCompare(String(b.title)),
        )
        const pages = []
        for (const p of sorted) {
          pages.push(includePageContent ? await client.getPage(p.id) : p)
        }
        const diagramsSummary = (await client.listDiagrams(bookId)) as Array<{ id: string }>
        const diagrams = []
        for (const d of diagramsSummary) {
          diagrams.push(includeDiagramSource ? await client.getDiagram(d.id) : d)
        }
        return jsonResult({
          exportedAt: new Date().toISOString(),
          book,
          chapters,
          pages,
          diagrams,
          note: 'Open the book in the BeeDocs UI and use Export PDF for a browser print-to-PDF. This tool returns structured content for agents.',
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'beedocs_get_book_tree',
    {
      title: 'Get book tree',
      description:
        'Return folders (chapters) and pages grouped for tree navigation (root pages + per-folder pages + diagrams).',
      inputSchema: {
        bookId: z.string(),
      },
    },
    async ({ bookId }) => {
      try {
        const [book, chapters, pages, diagrams] = await Promise.all([
          client.getBook(bookId),
          client.listChapters(bookId) as Promise<
            Array<{ id: string; title: string; sortOrder: number }>
          >,
          client.listPages(bookId) as Promise<
            Array<{
              id: string
              title: string
              chapterId?: string | null
              sortOrder: number
            }>
          >,
          client.listDiagrams(bookId),
        ])
        const ch = [...chapters].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
        )
        const sortedPages = [...pages].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
        )
        const rootPages = sortedPages.filter((p) => !p.chapterId)
        const folders = ch.map((c) => ({
          ...c,
          pages: sortedPages.filter((p) => p.chapterId === c.id),
        }))
        return jsonResult({
          book,
          folders,
          rootPages,
          diagrams,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}
