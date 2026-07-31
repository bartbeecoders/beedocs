import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { replaceFenceBody } from '../markdownFences'
import { BeeDiagramEditor } from './BeeDiagramEditor'
import { BeeDiagramView } from './BeeDiagramView'

mermaid.initialize({
  startOnLoad: false,
  theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
})

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
          <figcaption className="inline-diagram-title">Visual editor</figcaption>
        </div>
        <span className="muted sm">Drag nodes · toolbar tools · properties panel</span>
      </div>
      <div className="inline-diagram-body inline-diagram-body--visual">
        <BeeDiagramEditor source={live} onChange={commitSource} />
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
        <BeeDiagramEditor source={live} onChange={onEditorChange} />
      </div>
    </figure>
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

export function MarkdownView({ content, editable = false, onContentChange, bookId }: MarkdownViewProps) {
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

  // Occurrence counters reset every render so fence indices stay stable vs content string.
  const counters: Record<string, number> = {}

  const nextIndex = (lang: string) => {
    const i = counters[lang] ?? 0
    counters[lang] = i + 1
    return i
  }

  return (
    <div className={`markdown-body${editable ? ' markdown-body--editable' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img({ src, alt, ...props }) {
            return <img src={src ? withApiBase(src) : src} alt={alt ?? ''} {...props} />
          },
          code({ className, children, ...props }) {
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

            const isBlock = Boolean(match) || code.includes('\n')
            if (isBlock) {
              return (
                <pre className={className}>
                  <code {...props}>{code}</code>
                </pre>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
