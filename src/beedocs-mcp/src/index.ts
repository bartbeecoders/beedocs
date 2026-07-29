#!/usr/bin/env node
/**
 * BeeDocs MCP server — stdio transport.
 *
 * Env:
 *   BEEDOCS_API_URL  Base URL of the BeeDocs API (default http://localhost:5080)
 *
 * Do not write logs to stdout (reserved for MCP JSON-RPC). Use stderr if needed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClientFromEnv } from './client.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'
import { registerPrompts } from './prompts.js'

async function main() {
  const client = createClientFromEnv()

  const server = new McpServer(
    {
      name: 'beedocs',
      version: '1.0.0',
    },
    {
      instructions: [
        'BeeDocs MCP exposes the full documentation API to AI agents.',
        'Create books, Markdown pages, chapters, and diagrams (BeeDiagram JSON or Mermaid/C4).',
        `API: ${client.baseUrl}`,
        'Start with beedocs_health and beedocs_get_api_info if unsure.',
        'For architecture diagrams prefer beedocs_create_beediagram_with_nodes then beedocs_embed_diagram_in_page.',
      ].join(' '),
    },
  )

  registerTools(server, client)
  registerResources(server, client)
  registerPrompts(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // stderr only — stdout is MCP protocol
  console.error(`[beedocs-mcp] connected (API ${client.baseUrl})`)
}

main().catch((err) => {
  console.error('[beedocs-mcp] fatal:', err)
  process.exit(1)
})
