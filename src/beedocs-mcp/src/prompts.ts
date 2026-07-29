import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    'beedocs_document_system',
    {
      title: 'Document a software system',
      description:
        'Guide for creating a book, architecture pages, and C4/BeeDiagrams for a named system.',
      argsSchema: {
        systemName: z.string().describe('Name of the system to document'),
        context: z
          .string()
          .optional()
          .describe('Optional domain/context notes for the agent'),
      },
    },
    ({ systemName, context }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Document the software system "${systemName}" in BeeDocs using MCP tools.`,
              '',
              'Steps:',
              '1. Call beedocs_health to verify the API.',
              '2. beedocs_list_books — reuse a matching book or beedocs_create_book.',
              '3. Create pages with beedocs_create_page:',
              '   - System Context (C4 L1)',
              '   - Containers (C4 L2)',
              '   - Deployment / network notes',
              '4. Create diagrams with beedocs_create_beediagram_with_nodes or beedocs_create_diagram (kind mermaid/c4).',
              '5. Embed diagrams into pages with beedocs_embed_diagram_in_page.',
              '6. Prefer clear Markdown headings, bullet lists, and Mermaid where helpful.',
              context ? `\nAdditional context:\n${context}` : '',
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'beedocs_add_architecture_diagram',
    {
      title: 'Add architecture diagram',
      description: 'Create a BeeDiagram and embed it into an existing page.',
      argsSchema: {
        bookId: z.string(),
        pageId: z.string(),
        diagramTitle: z.string(),
        description: z
          .string()
          .describe('What the diagram should show (components, people, data flows)'),
      },
    },
    ({ bookId, pageId, diagramTitle, description }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Add architecture diagram "${diagramTitle}" to BeeDocs.`,
              `bookId=${bookId}`,
              `pageId=${pageId}`,
              '',
              'Use beedocs_create_beediagram_with_nodes with person/system/box/database nodes and labeled edges.',
              'Then beedocs_embed_diagram_in_page with a suitable heading.',
              '',
              'Diagram intent:',
              description,
            ].join('\n'),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'beedocs_write_runbook_page',
    {
      title: 'Write an ops runbook page',
      description: 'Create or update a runbook-style Markdown page in a book.',
      argsSchema: {
        bookId: z.string(),
        topic: z.string(),
      },
    },
    ({ bookId, topic }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Create a runbook page for "${topic}" in book ${bookId}.`,
              'Use beedocs_create_page with sections: Overview, Prerequisites, Procedure, Verification, Rollback, Related systems.',
              'Use Markdown checklists for steps. Optionally add a simple mermaid sequence diagram.',
            ].join('\n'),
          },
        },
      ],
    }),
  )
}
