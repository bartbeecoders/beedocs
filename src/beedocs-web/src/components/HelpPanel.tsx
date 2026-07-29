import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

/**
 * About / Help — what BeeDocs is, how to use the workspace, and how to point an
 * AI agent at the MCP server. The MCP snippets are generated from the endpoint
 * and token you type in, so they can be copied straight into a client config.
 */

type McpClient = 'claude-code' | 'cursor' | 'vscode' | 'desktop' | 'stdio'

const MCP_CLIENTS: { id: McpClient; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'desktop', label: 'Claude Desktop' },
  { id: 'stdio', label: 'stdio (local clone)' },
]

const SECTIONS = [
  { id: 'about', label: 'About BeeDocs' },
  { id: 'workspace', label: 'Workspace basics' },
  { id: 'pages', label: 'Writing pages' },
  { id: 'diagrams', label: 'Diagrams' },
  { id: 'export', label: 'Export & import' },
  { id: 'mcp', label: 'Connect an AI agent (MCP)' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
]

/** Best guess at where the MCP server lives, based on where the UI is served. */
function guessMcpUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:5090/mcp'
  const { hostname, protocol } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:5090/mcp'
  const parts = hostname.split('.')
  // docs.example.com → mcp.example.com
  const host = parts.length > 2 ? ['mcp', ...parts.slice(1)].join('.') : `mcp.${hostname}`
  return `${protocol}//${host}/mcp`
}

export function HelpPanel() {
  const [version, setVersion] = useState<string | null>(null)
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [mcpUrl, setMcpUrl] = useState(guessMcpUrl)
  const [mcpToken, setMcpToken] = useState('dev-token')
  const [client, setClient] = useState<McpClient>('claude-code')
  const [repoPath, setRepoPath] = useState('/path/to/BeeDocs')

  useEffect(() => {
    let cancelled = false
    void api
      .getHealth()
      .then((h) => {
        if (cancelled) return
        setApiOk(h.status === 'ok')
        if (h.version) setVersion(h.version)
      })
      .catch(() => !cancelled && setApiOk(false))
    void api
      .getVersion()
      .then((v) => !cancelled && setVersion(v.version))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const apiUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5080'

  const snippet = useMemo(
    () => mcpSnippet(client, { mcpUrl, token: mcpToken, repoPath }),
    [client, mcpUrl, mcpToken, repoPath],
  )

  return (
    <div className="help-panel">
      <header className="settings-header">
        <h1>About &amp; Help</h1>
        <p className="muted">
          BeeDocs — self-hosted documentation for software &amp; hardware architecture.
          {version && <> Build <code>v{version}</code>.</>}{' '}
          {apiOk === true && <span className="help-badge ok">API reachable</span>}
          {apiOk === false && <span className="help-badge bad">API unreachable</span>}
        </p>
      </header>

      <nav className="help-toc" aria-label="Sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#help-${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>

      <section className="settings-section" id="help-about">
        <h2>About BeeDocs</h2>
        <p className="muted">
          A single-page workspace for architecture documentation: a library of{' '}
          <strong>books → folders → pages</strong>, Markdown with live Mermaid and C4 diagrams, a
          built-in <strong>BeeDiagram</strong> canvas, image uploads, and PDF/HTML export. Everything
          is stored in an embedded SurrealDB next to the .NET API — no external services.
        </p>
        <dl className="help-facts">
          <div>
            <dt>Stack</dt>
            <dd>.NET 10 minimal API · SurrealDB (RocksDB) · React + Vite</dd>
          </div>
          <div>
            <dt>This instance</dt>
            <dd>
              <code>{apiUrl}</code>
            </dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{version ? `v${version}` : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-section" id="help-workspace">
        <h2>Workspace basics</h2>
        <ul className="help-list">
          <li>
            <strong>Left pane</strong> — the library tree: books, folders, pages and diagrams.
            Right-click (or use the ⋯ menu) to create, rename, move and delete. Drag pages between
            folders.
          </li>
          <li>
            <strong>Center</strong> — the editor for the selected page or diagram.
          </li>
          <li>
            <strong>Right pane</strong> — properties and actions for whatever is open.
          </li>
          <li>
            Both side panes resize by dragging their edge and collapse from their header. Widths are
            remembered per browser; reset them in <strong>Settings → Layout</strong>.
          </li>
          <li>
            <strong>Auto-save</strong> runs about 1.5s after you stop typing (toggle in Settings).{' '}
            <kbd>Ctrl</kbd>+<kbd>S</kbd> saves immediately.
          </li>
        </ul>
      </section>

      <section className="settings-section" id="help-pages">
        <h2>Writing pages</h2>
        <p className="muted">
          Pages are Markdown (GFM: tables, task lists, footnotes) with fenced blocks that render
          live. Drop or paste an image anywhere in the editor to upload it and insert the link.
        </p>
        <table className="help-table">
          <thead>
            <tr>
              <th>Fence</th>
              <th>Renders as</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>```mermaid</code>
              </td>
              <td>Mermaid diagram (flowchart, sequence, ER, gantt, C4…)</td>
            </tr>
            <tr>
              <td>
                <code>```beediagram</code>
              </td>
              <td>Inline BeeDiagram canvas, editable in place</td>
            </tr>
            <tr>
              <td>
                <code>```beediagram-ref</code>
              </td>
              <td>Embed of a stored diagram — the body is the diagram id</td>
            </tr>
          </tbody>
        </table>
        <p className="muted sm">
          A diagram's own editor shows the exact <code>beediagram-ref</code> snippet to paste, with a
          copy button. Export a whole book to PDF from the book view.
        </p>
      </section>

      <section className="settings-section" id="help-diagrams">
        <h2>Diagrams</h2>
        <p className="muted">
          BeeDiagram documents open in one of two modes — the switch sits above the canvas and is
          remembered per browser.
        </p>
        <ul className="help-list">
          <li>
            <strong>Studio</strong> — a diagrams.net-style workspace: searchable shape palette (drag
            or click to place), infinite pan/zoom canvas with grid and snapping, alignment guides,
            resize/rotate handles, undo/redo, clipboard and a Style / Text / Arrange format panel.
          </li>
          <li>
            <strong>Connecting</strong> — hover a shape: drag a <em>blue arrow</em> to another shape
            to connect it, or click the arrow to drop a connected copy in that direction. Drag from a{' '}
            <em>green ✕</em> for a fixed connection point (up to 16 per shape); drag from the shape's
            edge for a floating one that re-routes as things move. Dropping a connection on empty
            canvas offers a shape to create.
          </li>
          <li>
            <strong>Classic</strong> — the original compact editor, also used for inline{' '}
            <code>beediagram</code> fences inside pages.
          </li>
          <li>Mermaid and C4 diagrams are edited as source with a live preview beside them.</li>
        </ul>
      </section>

      <section className="settings-section" id="help-export">
        <h2>Export &amp; import</h2>
        <p className="muted">
          Whole books or single documents, from the <strong>Export ▾</strong> button on a book, the{' '}
          <strong>⭳</strong> button in the page toolbar, or by right-clicking anything in the
          library tree.
        </p>
        <ul className="help-list">
          <li>
            <strong>PDF</strong> — opens a print-ready view; choose “Save as PDF”. The only format
            that renders diagrams as pictures, so allow pop-ups for this site.
          </li>
          <li>
            <strong>Markdown</strong> — a book becomes a zip mirroring its folders, a page becomes
            one <code>.md</code> file. Front matter keeps titles and ordering, so it imports back.
          </li>
          <li>
            <strong>Word (.docx)</strong> — headings, lists, tables and images. Diagrams appear as
            their source, not as pictures.
          </li>
          <li>
            <strong>BeeDocs archive</strong> — lossless and re-importable: folders, diagrams and
            images all survive the round trip. Use this to move content between instances.
          </li>
          <li>
            <strong>Import</strong> sits in the library toolbar. It previews the file first, and
            lets you keep a clashing name or rename to a free one. Import never overwrites existing
            pages.
          </li>
        </ul>
      </section>

      <section className="settings-section" id="help-mcp">
        <h2>Connect an AI agent (MCP)</h2>
        <p className="muted">
          BeeDocs ships an <strong>MCP server</strong> that exposes the whole API to AI agents —
          books, folders, pages, images and diagrams — so an agent can write documentation directly
          into this instance. It speaks two transports:{' '}
          <strong>Streamable HTTP</strong> (point a client at a URL — recommended) and{' '}
          <strong>stdio</strong> (the client spawns a local process from a clone of the repo).
        </p>

        <div className="help-fields">
          <label className="studio-field">
            <span>MCP endpoint</span>
            <input
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              spellCheck={false}
              placeholder="http://localhost:5090/mcp"
            />
          </label>
          <label className="studio-field">
            <span>Bearer token</span>
            <input
              value={mcpToken}
              onChange={(e) => setMcpToken(e.target.value)}
              spellCheck={false}
              placeholder="dev-token"
            />
          </label>
          {client === 'stdio' && (
            <label className="studio-field">
              <span>Repo path</span>
              <input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                spellCheck={false}
                placeholder="/path/to/BeeDocs"
              />
            </label>
          )}
        </div>
        <p className="muted sm">
          Local runs (<code>./scripts/start.sh</code>) serve MCP on{' '}
          <code>http://localhost:5090/mcp</code> with the token <code>dev-token</code>. A hosted
          instance uses <code>https://mcp.&lt;your-domain&gt;/mcp</code> — get its token with{' '}
          <code>./scripts/deploy-k3s.sh mcp-token</code>, and add the two{' '}
          <code>CF-Access-*</code> headers if Cloudflare Access is in front of it.
        </p>

        <div className="segmented help-clients" role="tablist" aria-label="MCP client">
          {MCP_CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={client === c.id}
              className={client === c.id ? 'active' : ''}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <CodeBlock title={snippet.title} code={snippet.code} note={snippet.note} />

        <h3 className="help-sub">Check it works</h3>
        <p className="muted sm">
          Ask the agent to run the <code>beedocs_health</code> tool — it reports the API URL the
          server is actually using. From a terminal:
        </p>
        <CodeBlock
          title="Smoke test"
          code={`curl -s -X POST ${mcpUrl} \\
  -H "Authorization: Bearer ${mcpToken}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}
        />

        <h3 className="help-sub">What agents can do</h3>
        <table className="help-table">
          <thead>
            <tr>
              <th>Area</th>
              <th>Tools</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>System</td>
              <td>
                <code>beedocs_health</code>, <code>beedocs_get_api_info</code>
              </td>
            </tr>
            <tr>
              <td>Books &amp; folders</td>
              <td>list / get / create / update / delete, book tree, export book</td>
            </tr>
            <tr>
              <td>Pages</td>
              <td>list / get / create / update / delete, append Markdown, move between folders</td>
            </tr>
            <tr>
              <td>Diagrams</td>
              <td>list / get / create / update / delete, embed into a page</td>
            </tr>
            <tr>
              <td>Images</td>
              <td>upload, embed into a page</td>
            </tr>
          </tbody>
        </table>
        <p className="muted sm">
          Full reference: <code>Docs/MCP-TOOLS.md</code> · setup details:{' '}
          <code>Docs/MCP-SERVER.md</code> · hosting behind Cloudflare Access:{' '}
          <code>Docs/MCP-HOSTING.md</code> in the repository.
        </p>
      </section>

      <section className="settings-section" id="help-shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="help-shortcut-cols">
          <div>
            <h3 className="help-sub">Everywhere</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>S</kbd>
                  </td>
                  <td>Save the open page or diagram</td>
                </tr>
              </tbody>
            </table>
            <h3 className="help-sub">Diagram Studio — editing</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
                  </td>
                  <td>Undo / redo</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> / <kbd>D</kbd>
                  </td>
                  <td>Copy / cut / paste / duplicate</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Del</kbd>, <kbd>Esc</kbd>
                  </td>
                  <td>Select all, delete, deselect</td>
                </tr>
                <tr>
                  <td>
                    <kbd>F2</kbd> / <kbd>Enter</kbd>
                  </td>
                  <td>Edit label · double-click does the same</td>
                </tr>
                <tr>
                  <td>
                    Arrows / <kbd>Shift</kbd>+Arrows
                  </td>
                  <td>Nudge 1px / one grid step</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="help-sub">Diagram Studio — view &amp; order</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> / <kbd>B</kbd>
                  </td>
                  <td>Bring to front / send to back</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>
                  </td>
                  <td>Fit page</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd>
                  </td>
                  <td>Zoom in / out / 100%</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Space</kbd>-drag, middle-drag
                  </td>
                  <td>Pan the canvas</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+wheel
                  </td>
                  <td>Zoom at the pointer</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Alt</kbd>-drag
                  </td>
                  <td>Ignore grid snapping and guides</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Shift</kbd>-drag handle
                  </td>
                  <td>Keep ratio · snap rotation to 15°</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="settings-section" id="help-troubleshooting">
        <h2>Troubleshooting</h2>
        <ul className="help-list">
          <li>
            <strong>Nothing loads / “API unreachable”</strong> — check{' '}
            <code>{apiUrl}/api/health</code>. It should return{' '}
            <code>{'{"status":"ok"}'}</code>.
          </li>
          <li>
            <strong>Agent can't connect</strong> — check the MCP server's own health endpoint (
            <code>/healthz</code> on its port, e.g. <code>http://localhost:5090/healthz</code>). It
            reports which API URL it talks to; if that's wrong, set{' '}
            <code>BEEDOCS_API_URL</code> on the server process.
          </li>
          <li>
            <strong>401 from MCP</strong> — the bearer token doesn't match{' '}
            <code>MCP_AUTH_TOKEN</code>. Hosted instances behind Cloudflare Access also need the{' '}
            <code>CF-Access-Client-Id</code> / <code>CF-Access-Client-Secret</code> headers.
          </li>
          <li>
            <strong>Images don't appear</strong> — uploads are served from <code>/uploads</code> by
            the API; in dev the Vite proxy forwards it.
          </li>
          <li>
            <strong>Lost pane layout or theme</strong> — both live in this browser's local storage;
            reset the layout in Settings.
          </li>
        </ul>
      </section>
    </div>
  )
}

function CodeBlock({ title, code, note }: { title: string; code: string; note?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="help-code">
      <div className="help-code-head">
        <span>{title}</span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{code}</pre>
      {note && <p className="muted sm help-code-note">{note}</p>}
    </div>
  )
}

function mcpSnippet(
  client: McpClient,
  opts: { mcpUrl: string; token: string; repoPath: string },
): { title: string; code: string; note?: string } {
  const { mcpUrl, token, repoPath } = opts
  switch (client) {
    case 'claude-code':
      return {
        title: 'Terminal — registers the server for this project',
        code: `claude mcp add --transport http beedocs ${mcpUrl} \\
  -H "Authorization: Bearer ${token}"`,
        note: 'Add -s user to register it globally instead of per project.',
      }
    case 'cursor':
      return {
        title: '.cursor/mcp.json (project) or Cursor MCP settings',
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } },
            },
          },
          null,
          2,
        ),
        note: 'A "url" key instead of "command" is what selects the HTTP transport.',
      }
    case 'vscode':
      return {
        title: '.vscode/mcp.json (or user MCP settings)',
        code: JSON.stringify(
          {
            servers: {
              beedocs: {
                type: 'http',
                url: mcpUrl,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        ),
      }
    case 'desktop':
      return {
        title: 'claude_desktop_config.json — bridges stdio to the HTTP server',
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: {
                command: 'npx',
                args: ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization: Bearer ${token}`],
              },
            },
          },
          null,
          2,
        ),
        note: 'Use this pattern for any client that can only spawn a subprocess.',
      }
    case 'stdio':
      return {
        title: 'Client config — the client spawns the server itself',
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: {
                command: 'node',
                args: [`${repoPath}/src/beedocs-mcp/dist/index.js`],
                env: { BEEDOCS_API_URL: 'http://localhost:5080' },
              },
            },
          },
          null,
          2,
        ),
        note: 'Requires a clone plus pnpm install && pnpm build in src/beedocs-mcp. No token — it inherits your local API.',
      }
  }
}
