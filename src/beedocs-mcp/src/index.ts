#!/usr/bin/env node
/**
 * BeeDocs MCP server.
 *
 * Two transports, same tools:
 *   stdio (default)  local subprocess spawned by the agent — dev machines
 *   http             hosted instance, Streamable HTTP on /mcp — K3S
 *
 * Env:
 *   MCP_TRANSPORT    'stdio' (default) or 'http'
 *   BEEDOCS_API_URL  Base URL of the BeeDocs API (default http://localhost:5080)
 *
 * HTTP mode reads MCP_HTTP_PORT / MCP_HTTP_HOST / MCP_AUTH_TOKEN — see http.ts.
 *
 * In stdio mode, do not write logs to stdout (reserved for MCP JSON-RPC).
 * Use stderr if needed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClientFromEnv, type BeeDocsClient } from './client.js'
import { startHttpServer } from './http.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'
import { registerPrompts } from './prompts.js'

/**
 * Build a fully configured MCP server. Called once for stdio, and once per
 * request in stateless HTTP mode.
 */
export function createBeeDocsServer(client: BeeDocsClient): McpServer {
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

  return server
}

async function main() {
  const client = createClientFromEnv()
  const transport = (process.env.MCP_TRANSPORT ?? 'stdio').trim().toLowerCase()

  if (transport === 'http') {
    startHttpServer({
      client,
      port: Number(process.env.MCP_HTTP_PORT ?? 5090),
      host: process.env.MCP_HTTP_HOST ?? '0.0.0.0',
      authToken: process.env.MCP_AUTH_TOKEN?.trim() || undefined,
      createServer: createBeeDocsServer,
    })
    return
  }

  if (transport !== 'stdio') {
    console.error(`[beedocs-mcp] unknown MCP_TRANSPORT '${transport}' (expected 'stdio' or 'http')`)
    process.exit(1)
  }

  const server = createBeeDocsServer(client)
  await server.connect(new StdioServerTransport())

  // stderr only — stdout is MCP protocol
  console.error(`[beedocs-mcp] connected (API ${client.baseUrl})`)
}

main().catch((err) => {
  console.error('[beedocs-mcp] fatal:', err)
  process.exit(1)
})
