/**
 * BeeDocs MCP server — Streamable HTTP transport.
 *
 * Runs the same tools/resources/prompts as the stdio entrypoint, but over HTTP
 * so agents can connect to a hosted instance instead of spawning a local
 * subprocess:
 *
 *   claude mcp add --transport http beedocs https://mcp.example.com/mcp
 *
 * Stateless by design: every request builds its own McpServer + transport and
 * throws it away afterwards. Nothing is kept between calls (each tool is just
 * an HTTP call to the BeeDocs API), so there are no sessions to pin to a pod
 * and no session state to lose when a connection through the tunnel drops.
 *
 * Env:
 *   MCP_HTTP_PORT    Port to listen on (default 5090)
 *   MCP_HTTP_HOST    Bind address (default 0.0.0.0)
 *   MCP_AUTH_TOKEN   If set, require `Authorization: Bearer <token>` on /mcp.
 *                    Defence in depth behind Cloudflare Access — see
 *                    Docs/MCP-HOSTING.md.
 *   BEEDOCS_API_URL  Base URL of the BeeDocs API
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BeeDocsClient } from './client.js'

export interface HttpServerOptions {
  client: BeeDocsClient
  port: number
  host: string
  authToken?: string
  /** Factory for the configured McpServer — shared with the stdio entrypoint. */
  createServer: (client: BeeDocsClient) => McpServer
}

/** Compare two secrets without leaking their length difference via timing. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** JSON-RPC shaped error, so MCP clients surface something useful. */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  })
}

function isAuthorized(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true

  const header = req.headers.authorization
  if (!header) return false

  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return false

  return tokensMatch(rest.join(' ').trim(), authToken)
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
): Promise<void> {
  const server = options.createServer(options.client)

  // sessionIdGenerator: undefined -> stateless. No session header is issued and
  // none is validated, so a client can reconnect to any pod at any time.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // The per-request server and transport must be torn down once the response
  // finishes, or every call leaks a listener.
  res.on('close', () => {
    void transport.close().catch(() => {})
    void server.close().catch(() => {})
  })

  await server.connect(transport)
  await transport.handleRequest(req, res)
}

export function startHttpServer(options: HttpServerOptions): void {
  const { port, host, authToken, client } = options

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    // Unauthenticated: kubelet probes hit this, and it must not depend on the
    // BeeDocs API being reachable — this reports the MCP process only.
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', service: 'beedocs-mcp', api: client.baseUrl })
      return
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. MCP endpoint is /mcp.' })
      return
    }

    if (!isAuthorized(req, authToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="beedocs-mcp"')
      sendRpcError(res, 401, 'Unauthorized: missing or invalid bearer token.')
      return
    }

    handleMcpRequest(req, res, options).catch((err) => {
      console.error('[beedocs-mcp] request failed:', err)
      if (!res.headersSent) {
        sendRpcError(res, 500, 'Internal server error.')
      } else {
        res.end()
      }
    })
  })

  httpServer.listen(port, host, () => {
    console.error(
      `[beedocs-mcp] http transport listening on http://${host}:${port}/mcp ` +
        `(API ${client.baseUrl}, auth ${authToken ? 'enabled' : 'DISABLED'})`,
    )
    if (!authToken) {
      console.error(
        '[beedocs-mcp] WARNING: MCP_AUTH_TOKEN is not set — every caller that ' +
          'can reach this port has full read/write access to BeeDocs.',
      )
    }
  })

  const shutdown = (signal: string) => {
    console.error(`[beedocs-mcp] ${signal} received, shutting down`)
    httpServer.close(() => process.exit(0))
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
