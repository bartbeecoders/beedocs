import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useI18n, type MessageKey, type TFunction } from '../i18n'

/**
 * About / Help — what BeeDocs is, how to use the workspace, and how to point an
 * AI agent at the MCP server. The MCP snippets are generated from the endpoint
 * and token you type in, so they can be copied straight into a client config.
 *
 * Almost all copy here is documentation prose; it is translated in sentence
 * fragments (prefix/suffix keys around <code>/<kbd>/<strong> elements) so each
 * language can phrase around the fixed technical tokens naturally.
 */

type McpClient = 'claude-code' | 'cursor' | 'vscode' | 'desktop' | 'stdio'

// Labels are product names shown untranslated; stdio's parenthetical is the
// one translatable label and is resolved at render time.
const MCP_CLIENTS: { id: McpClient; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'desktop', label: 'Claude Desktop' },
  { id: 'stdio', label: 'stdio (local clone)' },
]

const SECTION_IDS = [
  'about',
  'workspace',
  'pages',
  'diagrams',
  'export',
  'ai',
  'mcp',
  'shortcuts',
  'troubleshooting',
] as const

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
  const { t } = useI18n()
  const [version, setVersion] = useState<string | null>(null)
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [mcpUrl, setMcpUrl] = useState(guessMcpUrl)
  const [mcpToken, setMcpToken] = useState('')
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
    () => mcpSnippet(client, { mcpUrl, token: mcpToken, repoPath }, t),
    [client, mcpUrl, mcpToken, repoPath, t],
  )

  return (
    <div className="help-panel">
      <header className="settings-header">
        <h1>{t('helpdoc.title')}</h1>
        <p className="muted">
          {t('helpdoc.tagline')}
          {version && (
            <>
              {' '}
              {t('helpdoc.build')} <code>v{version}</code>
              {t('helpdoc.period')}
            </>
          )}{' '}
          {apiOk === true && <span className="help-badge ok">{t('helpdoc.apiOk')}</span>}
          {apiOk === false && <span className="help-badge bad">{t('helpdoc.apiBad')}</span>}
        </p>
      </header>

      <nav className="help-toc" aria-label={t('helpdoc.tocLabel')}>
        {SECTION_IDS.map((id) => (
          <a key={id} href={`#help-${id}`}>
            {t(`helpdoc.section.${id}` as MessageKey)}
          </a>
        ))}
      </nav>

      <section className="settings-section" id="help-about">
        <h2>{t('helpdoc.section.about')}</h2>
        <p className="muted">
          {t('helpdoc.about.body1')}
          <strong>{t('helpdoc.about.hierarchy')}</strong>
          {t('helpdoc.about.body2')}
          <strong>BeeDiagram</strong>
          {t('helpdoc.about.body3')}
        </p>
        <dl className="help-facts">
          <div>
            <dt>{t('helpdoc.about.factStack')}</dt>
            <dd>.NET 10 minimal API · SQLite · React + Vite</dd>
          </div>
          <div>
            <dt>{t('helpdoc.about.factInstance')}</dt>
            <dd>
              <code>{apiUrl}</code>
            </dd>
          </div>
          <div>
            <dt>{t('helpdoc.build')}</dt>
            <dd>{version ? `v${version}` : '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="settings-section" id="help-workspace">
        <h2>{t('helpdoc.section.workspace')}</h2>
        <ul className="help-list">
          <li>
            <strong>{t('helpdoc.ws.leftTitle')}</strong>
            {t('helpdoc.ws.left1')}
            <code>/bookshelf-serve/&lt;slug&gt;</code>
            {t('helpdoc.ws.left2')}
            <strong>{t('helpdoc.ws.leftToggle')}</strong>
            {t('helpdoc.ws.left3')}
          </li>
          <li>
            <strong>{t('common.search')}</strong>
            {t('helpdoc.dash')}
            <kbd>Ctrl</kbd>+<kbd>K</kbd>
            {t('helpdoc.ws.search2')}
            <kbd>Enter</kbd>
            {t('helpdoc.ws.search3')}
            <code>"double quotes"</code>
            {t('helpdoc.ws.search4')}
            <code>cafe</code>
            {t('helpdoc.ws.search5')}
            <code>café</code>
            {t('helpdoc.ws.search6')}
          </li>
          <li>
            <strong>{t('helpdoc.ws.centerTitle')}</strong>
            {t('helpdoc.ws.center')}
          </li>
          <li>
            <strong>{t('helpdoc.ws.rightTitle')}</strong>
            {t('helpdoc.ws.right')}
          </li>
          <li>
            {t('helpdoc.ws.panes1')}
            <strong>{t('helpdoc.ws.panesPath')}</strong>
            {t('helpdoc.period')}
          </li>
          <li>
            <strong>{t('helpdoc.ws.autosaveTitle')}</strong>
            {t('helpdoc.ws.autosave1')}
            <kbd>Ctrl</kbd>+<kbd>S</kbd>
            {t('helpdoc.ws.autosave2')}
          </li>
        </ul>
      </section>

      <section className="settings-section" id="help-pages">
        <h2>{t('helpdoc.section.pages')}</h2>
        <p className="muted">
          {t('helpdoc.pg.intro1')}
          <strong>{t('helpdoc.pg.addBtn')}</strong>
          {t('helpdoc.pg.intro2')}
        </p>
        <p className="muted">
          {t('helpdoc.pg.toc1')}
          <strong>{t('helpdoc.pg.tocName')}</strong>
          {t('helpdoc.pg.toc2')}
        </p>
        <p className="muted">
          {t('helpdoc.pg.hl1')}
          <code>bash</code>
          {', '}
          <code>csharp</code>
          {', '}
          <code>css</code>
          {', '}
          <code>diff</code>
          {', '}
          <code>dockerfile</code>
          {', '}
          <code>go</code>
          {', '}
          <code>ini</code>/<code>toml</code>
          {', '}
          <code>java</code>
          {', '}
          <code>javascript</code>
          {', '}
          <code>json</code>
          {', '}
          <code>markdown</code>
          {', '}
          <code>python</code>
          {', '}
          <code>rust</code>
          {', '}
          <code>shell</code>
          {', '}
          <code>sql</code>
          {', '}
          <code>typescript</code>
          {', '}
          <code>xml</code>/<code>html</code>
          {t('helpdoc.and')}
          <code>yaml</code>
          {t('helpdoc.pg.hl2')}
          <code>ts</code>
          {', '}
          <code>py</code>
          {', '}
          <code>yml</code>
          {', '}
          <code>sh</code>
          {t('helpdoc.pg.hl3')}
        </p>
        <p className="muted">
          <code>json</code>
          {t('helpdoc.and')}
          <code>xml</code>
          {t('helpdoc.pg.tree1')}
          <strong>{t('helpdoc.pg.collapseAll')}</strong> / <strong>{t('helpdoc.pg.expandAll')}</strong>
          {t('helpdoc.pg.tree2')}
          <strong>{t('helpdoc.pg.raw')}</strong>
          {t('helpdoc.pg.tree3')}
        </p>
        <p className="muted">
          {t('helpdoc.pg.drop1')}
          <code>.json</code>
          {t('helpdoc.or')}
          <code>.xml</code>
          {t('helpdoc.pg.drop2')}
          <code>.csv</code>
          {t('helpdoc.or')}
          <code>.tsv</code>
          {t('helpdoc.pg.drop3')}
          <strong>{t('helpdoc.pg.formatBtn')}</strong>
          {t('helpdoc.pg.drop4')}
        </p>
        <p className="muted">
          {t('helpdoc.pg.blocks1')}
          <strong>{t('helpdoc.pg.blocksEdit')}</strong>
          {t('helpdoc.pg.blocks2')}
          <code>⠿</code>
          {t('helpdoc.pg.blocks3')}
          <kbd>↑</kbd>
          {t('helpdoc.and')}
          <kbd>↓</kbd>
          {t('helpdoc.pg.blocks4')}
        </p>
        <table className="help-table">
          <thead>
            <tr>
              <th>{t('helpdoc.pg.fenceCol')}</th>
              <th>{t('helpdoc.pg.rendersCol')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>```mermaid</code>
              </td>
              <td>{t('helpdoc.pg.fenceMermaid')}</td>
            </tr>
            <tr>
              <td>
                <code>```beediagram</code>
              </td>
              <td>{t('helpdoc.pg.fenceBee')}</td>
            </tr>
            <tr>
              <td>
                <code>```beediagram-ref</code>
              </td>
              <td>{t('helpdoc.pg.fenceRef')}</td>
            </tr>
            <tr>
              <td>
                <code>```freedraw</code>
              </td>
              <td>
                {t('helpdoc.pg.fenceFree1')}
                <strong>{t('helpdoc.pg.fenceFreeMenu')}</strong>
              </td>
            </tr>
            <tr>
              <td>
                <code>```excelgrid</code>
              </td>
              <td>
                {t('helpdoc.pg.fenceExcel1')}
                <strong>{t('helpdoc.pg.fenceExcelMenu')}</strong>
                {t('helpdoc.pg.fenceExcel2')}
                <code>.csv</code>
                {t('helpdoc.pg.fenceExcel3')}
              </td>
            </tr>
            <tr>
              <td>
                <code>```kanban</code>
              </td>
              <td>
                {t('helpdoc.pg.fenceKanban1')}
                <strong>{t('helpdoc.pg.fenceKanbanMenu')}</strong>
                {t('helpdoc.pg.fenceKanban2')}
              </td>
            </tr>
            <tr>
              <td>
                <code>```kanban-ref</code>
              </td>
              <td>{t('helpdoc.pg.fenceKanbanRef')}</td>
            </tr>
            <tr>
              <td>
                <code>```project</code>
              </td>
              <td>
                {t('helpdoc.pg.fenceProject1')}
                <strong>{t('helpdoc.pg.fenceProjectMenu')}</strong>
                {t('helpdoc.pg.fenceProject2')}
              </td>
            </tr>
            <tr>
              <td>
                <code>```project-ref</code>
              </td>
              <td>{t('helpdoc.pg.fenceProjectRef')}</td>
            </tr>
            <tr>
              <td>
                <code>```note</code>
              </td>
              <td>
                {t('helpdoc.pg.fenceNotes1')}
                <strong>{t('helpdoc.pg.fenceNotesMenu')}</strong>
                {t('helpdoc.pg.fenceNotes2')}
              </td>
            </tr>
            <tr>
              <td>
                <code>```note-ref</code>
              </td>
              <td>{t('helpdoc.pg.fenceNotesRef')}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted sm">
          {t('helpdoc.pg.fenceNote1')}
          <code>beediagram-ref</code>
          {t('helpdoc.pg.fenceNote2')}
        </p>
      </section>

      <section className="settings-section" id="help-diagrams">
        <h2>{t('helpdoc.section.diagrams')}</h2>
        <p className="muted">{t('helpdoc.dg.intro')}</p>
        <ul className="help-list">
          <li>
            <strong>{t('helpdoc.dg.studioTitle')}</strong>
            {t('helpdoc.dg.studio')}
          </li>
          <li>
            <strong>{t('helpdoc.dg.connectTitle')}</strong>
            {t('helpdoc.dg.connect1')}
            <em>{t('helpdoc.dg.blueArrow')}</em>
            {t('helpdoc.dg.connect2')}
            <em>{t('helpdoc.dg.greenX')}</em>
            {t('helpdoc.dg.connect3')}
          </li>
          <li>
            <strong>{t('helpdoc.dg.containersTitle')}</strong>
            {t('helpdoc.dg.containers1')}
            <em>{t('helpdoc.dg.containerShape')}</em>
            {t('helpdoc.dg.containers2')}
          </li>
          <li>
            <strong>{t('helpdoc.dg.collectionsTitle')}</strong>
            {t('helpdoc.dg.collections1')}
            <em>{t('helpdoc.dg.saveCollection')}</em>
            {t('helpdoc.dg.collections2')}
            <em>{t('helpdoc.dg.thisBook')}</em>
            {t('helpdoc.dg.collections3')}
            <em>{t('helpdoc.dg.appLibrary')}</em>
            {t('helpdoc.dg.collections4')}
            <em>{t('helpdoc.dg.bookCollections')}</em> / <em>{t('helpdoc.dg.appCollections')}</em>
            {t('helpdoc.dg.collections5')}
          </li>
          <li>
            <strong>{t('helpdoc.dg.onPageTitle')}</strong>
            {t('helpdoc.dg.onPage1')}
            <em>BeeDiagram</em> / <em>{t('helpdoc.dg.linkedDiagram')}</em>
            {t('helpdoc.dg.onPage2')}
          </li>
          <li>
            <strong>{t('helpdoc.dg.classicTitle')}</strong>
            {t('helpdoc.dg.classic')}
          </li>
          <li>{t('helpdoc.dg.mermaid')}</li>
        </ul>
      </section>

      <section className="settings-section" id="help-export">
        <h2>{t('helpdoc.section.export')}</h2>
        <p className="muted">
          {t('helpdoc.ex.intro1')}
          <strong>{t('helpdoc.ex.exportBtn')}</strong>
          {t('helpdoc.ex.intro2')}
          <strong>⭳</strong>
          {t('helpdoc.ex.intro3')}
        </p>
        <ul className="help-list">
          <li>
            <strong>PDF</strong>
            {t('helpdoc.ex.pdf')}
          </li>
          <li>
            <strong>Markdown</strong>
            {t('helpdoc.ex.md1')}
            <code>.md</code>
            {t('helpdoc.ex.md2')}
          </li>
          <li>
            <strong>{t('helpdoc.ex.wordTitle')}</strong>
            {t('helpdoc.ex.word')}
          </li>
          <li>
            <strong>{t('helpdoc.ex.archiveTitle')}</strong>
            {t('helpdoc.ex.archive')}
          </li>
          <li>
            <strong>{t('helpdoc.ex.importTitle')}</strong>
            {t('helpdoc.ex.import')}
          </li>
        </ul>
      </section>

      <section className="settings-section" id="help-ai">
        <h2>{t('helpdoc.section.ai')}</h2>
        <p className="muted">{t('helpdoc.ai.intro')}</p>

        <h3 className="help-sub">{t('helpdoc.ai.configTitle')}</h3>
        <p className="muted">
          <strong>{t('helpdoc.ai.settingsPath')}</strong>
          {t('helpdoc.ai.config1')}
          <strong>OpenRouter</strong>
          {', '}
          <strong>xAI</strong>
          {', '}
          <strong>OpenAI</strong>
          {', '}
          <strong>Cerebras</strong>
          {t('helpdoc.or')}
          <strong>LM Studio</strong>
          {t('helpdoc.ai.config2')}
          <strong>{t('helpdoc.ai.testConn')}</strong>
          {t('helpdoc.ai.config3')}
        </p>
        <p className="muted sm">
          {t('helpdoc.ai.keys1')}
          <strong>{t('helpdoc.ai.makeDefault')}</strong>
          {t('helpdoc.ai.keys2')}
        </p>

        <h3 className="help-sub">{t('helpdoc.ai.autoTitle')}</h3>
        <p className="muted">
          {t('helpdoc.ai.auto1')}
          <kbd>Tab</kbd>
          {t('helpdoc.ai.auto2')}
          <kbd>Esc</kbd>
          {t('helpdoc.ai.auto3')}
          <em>{t('helpdoc.ai.autoEnd')}</em>
          {t('helpdoc.ai.auto4')}
          <strong>{t('helpdoc.ai.inlineSuggestions')}</strong>
          {t('helpdoc.ai.auto5')}
        </p>

        <h3 className="help-sub">{t('helpdoc.ai.selTitle')}</h3>
        <p className="muted">{t('helpdoc.ai.selIntro')}</p>
        <table className="help-table">
          <thead>
            <tr>
              <th>{t('helpdoc.ai.actionCol')}</th>
              <th>{t('helpdoc.ai.doesCol')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('helpdoc.ai.rewrite')}</td>
              <td>{t('helpdoc.ai.rewriteDesc')}</td>
            </tr>
            <tr>
              <td>{t('helpdoc.ai.grammar')}</td>
              <td>{t('helpdoc.ai.grammarDesc')}</td>
            </tr>
            <tr>
              <td>{t('helpdoc.ai.format')}</td>
              <td>{t('helpdoc.ai.formatDesc')}</td>
            </tr>
            <tr>
              <td>{t('helpdoc.ai.summarize')}</td>
              <td>{t('helpdoc.ai.summarizeDesc')}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted sm">
          {t('helpdoc.ai.result1')}
          <strong>{t('helpdoc.ai.replaceSel')}</strong>
          {t('helpdoc.ai.result2')}
          <strong>{t('helpdoc.ai.discard')}</strong>
          {t('helpdoc.ai.result3')}
        </p>
        <p className="muted sm">
          {t('helpdoc.ai.privacy1')}
          <code>/api/*</code>
          {t('helpdoc.ai.privacy2')}
          <code>Docs/LLM-PROVIDERS.md</code>
          {t('helpdoc.inRepo')}
        </p>
      </section>

      <section className="settings-section" id="help-mcp">
        <h2>{t('helpdoc.section.mcp')}</h2>
        <p className="muted">
          {t('helpdoc.mcp.intro1')}
          <strong>{t('helpdoc.mcp.serverName')}</strong>
          {t('helpdoc.mcp.intro2')}
          <strong>Streamable HTTP</strong>
          {t('helpdoc.mcp.intro3')}
          <strong>stdio</strong>
          {t('helpdoc.mcp.intro4')}
        </p>

        <div className="help-fields">
          <label className="studio-field">
            <span>{t('helpdoc.mcp.endpointLabel')}</span>
            <input
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              spellCheck={false}
              placeholder="http://localhost:5090/mcp"
            />
          </label>
          <label className="studio-field">
            <span>{t('helpdoc.mcp.tokenLabel')}</span>
            <input
              value={mcpToken}
              onChange={(e) => setMcpToken(e.target.value)}
              spellCheck={false}
              placeholder={t('helpdoc.mcp.tokenPlaceholder')}
            />
          </label>
          {client === 'stdio' && (
            <label className="studio-field">
              <span>{t('helpdoc.mcp.repoLabel')}</span>
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
          {t('helpdoc.mcp.local1')}
          <code>./scripts/start.sh</code>
          {t('helpdoc.mcp.local2')}
          <code>http://localhost:5090/mcp</code>
          {t('helpdoc.mcp.local3')}
          <code>MCP_AUTH_TOKEN</code>
          {t('helpdoc.mcp.local4')}
          <code>https://mcp.&lt;your-domain&gt;/mcp</code>
          {t('helpdoc.mcp.local5')}
          <code>./scripts/deploy-k3s.sh mcp-token</code>
          {t('helpdoc.mcp.local6')}
          <code>CF-Access-*</code>
          {t('helpdoc.mcp.local7')}
        </p>

        <div className="segmented help-clients" role="tablist" aria-label={t('helpdoc.mcp.clientLabel')}>
          {MCP_CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={client === c.id}
              className={client === c.id ? 'active' : ''}
              onClick={() => setClient(c.id)}
            >
              {c.id === 'stdio' ? t('helpdoc.client.stdio') : c.label}
            </button>
          ))}
        </div>

        <CodeBlock title={snippet.title} code={snippet.code} note={snippet.note} />

        <h3 className="help-sub">{t('helpdoc.mcp.checkTitle')}</h3>
        <p className="muted sm">
          {t('helpdoc.mcp.check1')}
          <code>beedocs_health</code>
          {t('helpdoc.mcp.check2')}
        </p>
        <CodeBlock
          title={t('helpdoc.mcp.smokeTitle')}
          code={`curl -s -X POST ${mcpUrl} \\
${mcpToken.trim() ? `  -H "Authorization: Bearer ${mcpToken.trim()}" \\\n` : ''}  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}
        />

        <h3 className="help-sub">{t('helpdoc.mcp.toolsTitle')}</h3>
        <table className="help-table">
          <thead>
            <tr>
              <th>{t('helpdoc.mcp.areaCol')}</th>
              <th>{t('helpdoc.mcp.toolsCol')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('helpdoc.mcp.areaSystem')}</td>
              <td>
                <code>beedocs_health</code>, <code>beedocs_get_api_info</code>
              </td>
            </tr>
            <tr>
              <td>{t('helpdoc.mcp.areaBooks')}</td>
              <td>{t('helpdoc.mcp.booksTools')}</td>
            </tr>
            <tr>
              <td>{t('common.pages')}</td>
              <td>{t('helpdoc.mcp.pagesTools')}</td>
            </tr>
            <tr>
              <td>{t('common.diagrams')}</td>
              <td>{t('helpdoc.mcp.diagramsTools')}</td>
            </tr>
            <tr>
              <td>{t('helpdoc.mcp.areaImages')}</td>
              <td>{t('helpdoc.mcp.imagesTools')}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted sm">
          {t('helpdoc.mcp.docs1')}
          <code>Docs/MCP-TOOLS.md</code>
          {t('helpdoc.mcp.docs2')}
          <code>Docs/MCP-SERVER.md</code>
          {t('helpdoc.mcp.docs3')}
          <code>Docs/MCP-HOSTING.md</code>
          {t('helpdoc.inRepo')}
        </p>
      </section>

      <section className="settings-section" id="help-shortcuts">
        <h2>{t('helpdoc.section.shortcuts')}</h2>
        <div className="help-shortcut-cols">
          <div>
            <h3 className="help-sub">{t('helpdoc.sc.everywhere')}</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>K</kbd>
                  </td>
                  <td>{t('helpdoc.sc.searchLibrary')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>S</kbd>
                  </td>
                  <td>{t('helpdoc.sc.savePage')}</td>
                </tr>
              </tbody>
            </table>
            <h3 className="help-sub">{t('helpdoc.sc.spreadsheet')}</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    {t('helpdoc.sc.arrows')} / <kbd>Tab</kbd> / <kbd>Enter</kbd>
                  </td>
                  <td>{t('helpdoc.sc.moveCell')}</td>
                </tr>
                <tr>
                  <td>
                    {t('helpdoc.sc.typeOr')}
                    <kbd>F2</kbd>
                  </td>
                  <td>{t('helpdoc.sc.editCell')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd>
                  </td>
                  <td>{t('helpdoc.sc.copyPaste')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>I</kbd> / <kbd>U</kbd>
                  </td>
                  <td>{t('helpdoc.sc.boldItalic')}</td>
                </tr>
              </tbody>
            </table>
            <h3 className="help-sub">{t('helpdoc.sc.studioEdit')}</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
                  </td>
                  <td>{t('helpdoc.sc.undoRedo')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> / <kbd>D</kbd>
                  </td>
                  <td>{t('helpdoc.sc.copyDup')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Del</kbd>, <kbd>Esc</kbd>
                  </td>
                  <td>{t('helpdoc.sc.selectAll')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>F2</kbd> / <kbd>Enter</kbd>
                    {t('helpdoc.sc.orType')}
                  </td>
                  <td>{t('helpdoc.sc.editLabel')}</td>
                </tr>
                <tr>
                  <td>
                    {t('helpdoc.sc.arrows')} / <kbd>Shift</kbd>+{t('helpdoc.sc.arrows')}
                  </td>
                  <td>{t('helpdoc.sc.nudge')}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3 className="help-sub">{t('helpdoc.sc.studioView')}</h3>
            <table className="help-table">
              <tbody>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> / <kbd>B</kbd>
                  </td>
                  <td>{t('helpdoc.sc.frontBack')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>
                  </td>
                  <td>{t('helpdoc.sc.fitPage')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>-</kbd> / <kbd>0</kbd>
                  </td>
                  <td>{t('helpdoc.sc.zoom')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Space</kbd>
                    {t('helpdoc.sc.spaceDrag')}
                  </td>
                  <td>{t('helpdoc.sc.pan')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Ctrl</kbd>+{t('helpdoc.sc.wheel')}
                  </td>
                  <td>{t('helpdoc.sc.zoomPointer')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Alt</kbd>
                    {t('helpdoc.sc.altDrag')}
                  </td>
                  <td>{t('helpdoc.sc.ignoreSnap')}</td>
                </tr>
                <tr>
                  <td>
                    <kbd>Shift</kbd>
                    {t('helpdoc.sc.shiftDrag')}
                  </td>
                  <td>{t('helpdoc.sc.keepRatio')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="settings-section" id="help-troubleshooting">
        <h2>{t('helpdoc.section.troubleshooting')}</h2>
        <ul className="help-list">
          <li>
            <strong>{t('helpdoc.tr.noloadTitle')}</strong>
            {t('helpdoc.tr.noload1')}
            <code>{apiUrl}/api/health</code>
            {t('helpdoc.tr.noload2')}
            <code>{'{"status":"ok"}'}</code>
            {t('helpdoc.period')}
          </li>
          <li>
            <strong>{t('helpdoc.tr.agentTitle')}</strong>
            {t('helpdoc.tr.agent1')}
            <code>/healthz</code>
            {t('helpdoc.tr.agent2')}
            <code>http://localhost:5090/healthz</code>
            {t('helpdoc.tr.agent3')}
            <code>BEEDOCS_API_URL</code>
            {t('helpdoc.tr.agent4')}
          </li>
          <li>
            <strong>{t('helpdoc.tr.401Title')}</strong>
            {t('helpdoc.tr.4011')}
            <code>MCP_AUTH_TOKEN</code>
            {t('helpdoc.tr.4012')}
            <code>CF-Access-Client-Id</code> / <code>CF-Access-Client-Secret</code>
            {t('helpdoc.tr.4013')}
          </li>
          <li>
            <strong>{t('helpdoc.tr.noAiTitle')}</strong>
            {t('helpdoc.tr.noAi1')}
            <strong>{t('helpdoc.ai.settingsPath')}</strong>
            {t('helpdoc.tr.noAi2')}
            <strong>{t('helpdoc.ai.testConn')}</strong>
            {t('helpdoc.period')}
          </li>
          <li>
            <strong>{t('helpdoc.tr.imagesTitle')}</strong>
            {t('helpdoc.tr.images1')}
            <code>/uploads</code>
            {t('helpdoc.tr.images2')}
          </li>
          <li>
            <strong>{t('helpdoc.tr.layoutTitle')}</strong>
            {t('helpdoc.tr.layout')}
          </li>
        </ul>
      </section>
    </div>
  )
}

function CodeBlock({ title, code, note }: { title: string; code: string; note?: string }) {
  const { t } = useI18n()
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
          {copied ? t('helpdoc.copied') : t('common.copy')}
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
  t: TFunction,
): { title: string; code: string; note?: string } {
  const { mcpUrl, repoPath } = opts
  const token = opts.token.trim()
  const headers = token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  switch (client) {
    case 'claude-code':
      return {
        title: t('helpdoc.mcp.snipClaudeTitle'),
        code: token
          ? `claude mcp add --transport http beedocs ${mcpUrl} \\
  -H "Authorization: Bearer ${token}"`
          : `claude mcp add --transport http beedocs ${mcpUrl}`,
        note: t('helpdoc.mcp.snipClaudeNote'),
      }
    case 'cursor':
      return {
        title: t('helpdoc.mcp.snipCursorTitle'),
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: { url: mcpUrl, ...headers },
            },
          },
          null,
          2,
        ),
        note: t('helpdoc.mcp.snipCursorNote'),
      }
    case 'vscode':
      return {
        title: t('helpdoc.mcp.snipVscodeTitle'),
        code: JSON.stringify(
          {
            servers: {
              beedocs: {
                type: 'http',
                url: mcpUrl,
                ...headers,
              },
            },
          },
          null,
          2,
        ),
      }
    case 'desktop':
      return {
        title: t('helpdoc.mcp.snipDesktopTitle'),
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: {
                command: 'npx',
                args: [
                  '-y',
                  'mcp-remote',
                  mcpUrl,
                  ...(token ? ['--header', `Authorization: Bearer ${token}`] : []),
                ],
              },
            },
          },
          null,
          2,
        ),
        note: t('helpdoc.mcp.snipDesktopNote'),
      }
    case 'stdio':
      return {
        title: t('helpdoc.mcp.snipStdioTitle'),
        code: JSON.stringify(
          {
            mcpServers: {
              beedocs: {
                command: 'dotnet',
                args: [
                  'run',
                  '--no-launch-profile',
                  '--project',
                  `${repoPath}/src/BeeDocs.Mcp/BeeDocs.Mcp.csproj`,
                ],
                env: { BEEDOCS_API_URL: 'http://localhost:5080' },
              },
            },
          },
          null,
          2,
        ),
        note: t('helpdoc.mcp.snipStdioNote'),
      }
  }
}
