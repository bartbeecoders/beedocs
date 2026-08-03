import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { replaceFenceBody } from '../markdownFences'
import { highlightCode, resolveLanguage } from '../syntaxHighlight'
import { DataTree } from './DataTree'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { BeeDiagramView } from './BeeDiagramView'
import { MediaEmbed } from './media/MediaEmbed'

mermaid.initialize({
  startOnLoad: false,
  theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
})

/** Module scope: a fresh array each render would defeat react-markdown's own memoization. */
const REMARK_PLUGINS = [remarkGfm]

/** Fence labels that get the collapsible tree instead of a flat code block. */
function dataTreeLang(lang: string | undefined): 'json' | 'xml' | null {
  const resolved = resolveLanguage(lang)
  if (resolved === 'json') return 'json'
  // `resolveLanguage` folds html/svg/xsd/… onto the xml grammar; only offer the
  // tree for labels that really mean a structured document.
  if (resolved === 'xml' && lang && /^(xml|xsd|xsl|xslt|rss|atom|plist|wsdl)$/i.test(lang.trim())) {
    return 'xml'
  }
  return null
}

/**
 * Whether the `code` renderer is inside a fence.
 *
 * react-markdown no longer passes an `inline` flag, and the text alone cannot
 * settle it — a single-line fence and inline code look identical by the time
 * they arrive. The `pre` renderer marks its subtree instead.
 */
const InsideFence = createContext(false)

function MermaidBlock({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/:/g, '')

  useEffect(() => {
    let cancelled = false
    const el = ref.current
    if (!el) return

    const render = async () => {
      try {
        const { svg } = await mermaid.render(`mmd-${reactId}-${Math.random().toString(36).slice(2)}`, chart)
        if (!cancelled && el) el.innerHTML = svg
      } catch (err) {
        if (!cancelled && el) {
          el.innerHTML = `<pre class="mermaid-error">${String(err)}</pre>`
        }
      }
    }
    void render()
    return () => {
      cancelled = true
    }
  }, [chart, reactId])

  return <div className="mermaid-block" ref={ref} />
}

function InlineShell({
  label,
  badge,
  editing,
  onToggle,
  actions,
  children,
}: {
  label?: string | null
  badge: string
  editing: boolean
  onToggle?: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <figure className={`inline-diagram${editing ? ' is-editing' : ''}`}>
      <div className="inline-diagram-chrome">
        <div className="inline-diagram-labels">
          <span className="inline-diagram-badge">{badge}</span>
          {label && <figcaption className="inline-diagram-title">{label}</figcaption>}
        </div>
        <div className="inline-diagram-actions">
          {actions}
          {onToggle && (
            <button type="button" className="btn sm" onClick={onToggle}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>
      </div>
      <div className="inline-diagram-body">{children}</div>
    </figure>
  )
}

function EditableMermaidFence({
  chart,
  fenceLang,
  fenceIndex,
  editing,
  onToggleEdit,
  contentRef,
  onContentChange,
}: {
  chart: string
  fenceLang: string
  fenceIndex: number
  editing: boolean
  onToggleEdit: () => void
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
}) {
  const [draft, setDraft] = useState(chart)

  useEffect(() => {
    if (!editing) setDraft(chart)
  }, [chart, editing])

  const apply = () => {
    onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, draft))
    onToggleEdit()
  }

  const badge =
    fenceLang === 'plantuml' ? 'PlantUML' : fenceLang === 'c4' ? 'C4' : 'Mermaid'

  return (
    <InlineShell
      badge={badge}
      editing={editing}
      onToggle={() => {
        if (editing) apply()
        else onToggleEdit()
      }}
      actions={
        editing ? (
          <button type="button" className="btn primary sm" onClick={apply}>
            Apply
          </button>
        ) : null
      }
    >
      {editing ? (
        <textarea
          className="inline-diagram-source"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={Math.min(24, Math.max(8, draft.split('\n').length + 1))}
          aria-label={`${fenceLang} source`}
        />
      ) : fenceLang === 'plantuml' ? (
        <pre className="inline-diagram-readonly-source">{chart}</pre>
      ) : (
        <MermaidBlock chart={chart} />
      )}
    </InlineShell>
  )
}

/** Always-on visual BeeDiagram editor for inline ```beediagram fences. */
function InlineBeeDiagramEditor({
  source,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const live = draft ?? source
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const commitSource = useCallback(
    (next: string) => {
      onDraftChange(next)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onContentChange(replaceFenceBody(contentRef.current, 'beediagram', fenceIndex, next))
      }, 450)
    },
    [contentRef, fenceIndex, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing inline-diagram--visual">
      <div className="inline-diagram-chrome">
        <div className="inline-diagram-labels">
          <span className="inline-diagram-badge">BeeDiagram</span>
          <figcaption className="inline-diagram-title">Studio editor</figcaption>
        </div>
        <span className="muted sm">Studio or Classic · palette · connections · format</span>
      </div>
      <div className="inline-diagram-body inline-diagram-body--visual">
        <BeeDiagramWorkbench source={live} onChange={commitSource} />
      </div>
    </figure>
  )
}

/** Always-on visual editor for ```beediagram-ref entity embeds. */
function InlineBeeDiagramRefEditor({
  diagramId,
  bookId,
  allowEdit,
  draft,
  onDraftChange,
}: {
  diagramId: string
  bookId?: string
  allowEdit: boolean
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const [title, setTitle] = useState<string | null>(null)
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSource = useRef<string>('')
  const titleRef = useRef<string | null>(null)
  const id = diagramId.trim().split(/\s+/)[0] ?? ''

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = await api.getDiagram(id)
        if (cancelled) return
        setTitle(d.title)
        titleRef.current = d.title
        setLoadedSource(d.source)
        latestSource.current = d.source
        onDraftChange(d.source)
        setDirty(false)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per id
  }, [id])

  const persist = useCallback(async (nextSource: string) => {
    const t = titleRef.current
    if (!t) return
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateDiagram(id, { title: t, source: nextSource })
      setLoadedSource(updated.source)
      latestSource.current = updated.source
      setSavedAt(new Date().toLocaleTimeString())
      if (latestSource.current === nextSource) setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [id])

  const onEditorChange = (next: string) => {
    latestSource.current = next
    onDraftChange(next)
    setDirty(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void persist(next)
    }, 1200)
  }

  const saveNow = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    void persist(latestSource.current)
  }

  if (error && !loadedSource && !draft) {
    return <div className="banner error">Diagram {id}: {error}</div>
  }
  if (!loadedSource && !draft) return <p className="muted">Loading diagram…</p>

  const live = draft ?? loadedSource ?? ''
  const openHref = bookId ? `/books/${bookId}/diagrams/${id}` : undefined

  if (!allowEdit) {
    return (
      <figure className="bee-embed">
        {title && <figcaption className="meta">{title}</figcaption>}
        <BeeDiagramView source={live} />
      </figure>
    )
  }

  return (
    <figure className="inline-diagram is-editing inline-diagram--visual">
      <div className="inline-diagram-chrome">
        <div className="inline-diagram-labels">
          <span className="inline-diagram-badge">BeeDiagram</span>
          <figcaption className="inline-diagram-title">{title ?? 'Diagram'}</figcaption>
        </div>
        <div className="inline-diagram-actions">
          <span className="inline-diagram-status-inline">
            {saving && 'Saving…'}
            {!saving && dirty && <span className="dirty-dot">Unsaved</span>}
            {!saving && !dirty && savedAt && <span className="muted">Saved · {savedAt}</span>}
          </span>
          <button type="button" className="btn primary sm" disabled={saving || !dirty} onClick={saveNow}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          {openHref && (
            <Link className="btn ghost sm" to={openHref}>
              Full page
            </Link>
          )}
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="inline-diagram-body inline-diagram-body--visual">
        <BeeDiagramWorkbench source={live} onChange={onEditorChange} bookId={bookId} />
      </div>
    </figure>
  )
}

/**
 * A fenced code block, coloured when its language is one we have a grammar for.
 *
 * The highlighted markup comes from highlight.js, which escapes every character
 * of the document and emits only its own class-bearing spans — so this stays the
 * one place raw HTML is injected, and none of it originates from the page.
 * Unlabelled or unsupported fences render as plain text rather than being
 * guessed at.
 */
function CodeBlock({
  code,
  lang,
  className,
  ...props
}: {
  code: string
  lang: string | undefined
  className?: string
} & ComponentProps<'code'>) {
  const highlighted = useMemo(() => highlightCode(code, lang), [code, lang])
  const language = resolveLanguage(lang)

  return (
    <pre className={className} data-language={language ?? undefined}>
      {highlighted ? (
        <code
          {...props}
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <code {...props}>{code}</code>
      )}
    </pre>
  )
}

export type MarkdownViewProps = {
  content: string
  /** Enable Edit controls on embedded diagrams / fences */
  editable?: boolean
  /** Called when an inline fence body changes (mermaid / beediagram / plantuml) */
  onContentChange?: (next: string) => void
  /** Used to deep-link beediagram-ref “Open editor” */
  bookId?: string
}

export const MarkdownView = memo(function MarkdownView({
  content,
  editable = false,
  onContentChange,
  bookId,
}: MarkdownViewProps) {
  const contentRef = useRef(content)
  contentRef.current = content

  // Survives remounts of react-markdown code nodes when content updates.
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({})
  const [beeDrafts, setBeeDrafts] = useState<Record<string, string>>({})

  const toggleKey = useCallback((key: string) => {
    setOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const setBeeDraft = useCallback((key: string, next: string) => {
    setBeeDrafts((d) => (d[key] === next ? d : { ...d, [key]: next }))
  }, [])

  const handleContentChange = useCallback(
    (next: string) => {
      contentRef.current = next
      onContentChange?.(next)
    },
    [onContentChange],
  )

  // Occurrence counters reset every render so fence indices stay stable vs content
  // string. Held in a ref because the renderers below are memoized and so cannot
  // close over a value recreated per render.
  const countersRef = useRef<Record<string, number>>({})
  countersRef.current = {}

  const nextIndex = useCallback((lang: string) => {
    const i = countersRef.current[lang] ?? 0
    countersRef.current[lang] = i + 1
    return i
  }, [])

  /**
   * Memoized so the renderer functions keep their identity between renders.
   *
   * Passing a fresh object here makes every entry a brand new component *type*,
   * which React can only reconcile by unmounting and remounting the whole subtree
   * — so each save used to rebuild every diagram, PDF and 3D embed on the page.
   * Mermaid renders asynchronously into an empty div, which is what the resulting
   * flicker actually was.
   *
   * The state in the deps (open editors, diagram drafts) only changes on a
   * deliberate click, not while typing, so those remounts stay rare.
   */
  const components = useMemo(
    () => ({
      img({ src, alt, ...props }: ComponentProps<'img'>) {
        return <img src={src ? withApiBase(src) : src} alt={alt ?? ''} {...props} />
      },
      // The `code` renderer below emits its own <pre> (or a diagram, or an
      // embed), so react-markdown's wrapper would double the box, the padding
      // and the border around every fence. Pass its children straight through.
      pre({ children }: ComponentProps<'pre'>) {
        return <InsideFence.Provider value={true}>{children}</InsideFence.Provider>
      },
      code({ className, children, ...props }: ComponentProps<'code'>) {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- rendered as a component by react-markdown
        const insideFence = useContext(InsideFence)
        const match = /language-(\w[\w-]*)/.exec(className || '')
        const lang = match?.[1]
        const code = String(children).replace(/\n$/, '')

        if (lang === 'mermaid' || lang === 'c4' || lang === 'plantuml') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `${lang}:${idx}`
            return (
              <EditableMermaidFence
                chart={code}
                fenceLang={lang}
                fenceIndex={idx}
                editing={Boolean(openKeys[key])}
                onToggleEdit={() => toggleKey(key)}
                contentRef={contentRef}
                onContentChange={handleContentChange}
              />
            )
          }
          if (lang === 'plantuml') {
            return <pre className="inline-diagram-readonly-source">{code}</pre>
          }
          return <MermaidBlock chart={code} />
        }

        if (lang === 'beediagram') {
          const idx = nextIndex('beediagram')
          if (editable && onContentChange) {
            const key = `beediagram:${idx}`
            return (
              <InlineBeeDiagramEditor
                source={code}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />
            )
          }
          return (
            <figure className="bee-embed">
              <BeeDiagramView source={code} />
            </figure>
          )
        }

        if (lang === 'beediagram-ref') {
          const id = code.trim().split(/\s+/)[0] ?? ''
          const key = `beediagram-ref:${id}`
          return (
            <InlineBeeDiagramRefEditor
              diagramId={code}
              allowEdit={editable}
              bookId={bookId}
              draft={beeDrafts[key]}
              onDraftChange={(next) => setBeeDraft(key, next)}
            />
          )
        }

        if (
          lang === 'pdf' ||
          lang === 'glb' ||
          lang === 'gltf' ||
          lang === 'obj' ||
          lang === 'model'
        ) {
          return <MediaEmbed lang={lang} body={code} />
        }

        const isBlock = insideFence || Boolean(match) || code.includes('\n')
        if (isBlock) {
          const block = <CodeBlock code={code} lang={lang} className={className} {...props} />
          const dataLang = dataTreeLang(lang)
          // Structured formats get a collapsible tree, falling back to the plain
          // block when the document does not parse or is too big to be useful.
          return dataLang ? (
            <DataTree code={code} lang={dataLang} fallback={block} />
          ) : (
            block
          )
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },
    }),
    [
      beeDrafts,
      bookId,
      editable,
      handleContentChange,
      nextIndex,
      onContentChange,
      openKeys,
      setBeeDraft,
      toggleKey,
    ],
  )

  return (
    <div className={`markdown-body${editable ? ' markdown-body--editable' : ''}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
