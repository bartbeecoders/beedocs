import {
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import mermaid from 'mermaid'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { useI18n } from '../i18n'
import { replaceFenceBody, splitMarkdownSegments } from '../markdownFences'
import { parsePageLayout, serializePageLayout } from '../pageLayout'
import { isInternalDocHref } from '../markdownLinks'
import { useMarkdownSite } from '../site/markdownSite'
import { remarkHtmlBreaks, remarkTableThemes } from '../markdownTable'
import { outlineId } from '../pageOutline'
import { highlightCode, resolveLanguage } from '../syntaxHighlight'
import { DataTree } from './DataTree'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { BeeDiagramView } from './BeeDiagramView'
import { ExcelGridCanvas } from './ExcelGridCanvas'
import { ExcelGridView } from './ExcelGridView'
import { FreeDrawCanvas } from './FreeDrawCanvas'
import { FreeDrawView } from './FreeDrawView'
import { MediaEmbed } from './media/MediaEmbed'
import { KanbanBoard } from '../kanban/KanbanBoard'
import { KanbanView } from '../kanban/KanbanView'
import { ProjectEditor } from '../project/ProjectEditor'
import { ProjectView } from '../project/ProjectView'
import { NoteEditor } from '../notes/NoteEditor'
import { NoteView } from '../notes/NoteView'

// Lazy so only pages that actually embed an isometric diagram load its module.
const IsometricView = lazy(() => import('../isometric/IsometricView'))

mermaid.initialize({
  startOnLoad: false,
  theme: document.documentElement.dataset.theme === 'light' ? 'default' : 'dark',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
})

/** Module scope: a fresh array each render would defeat react-markdown's own memoization. */
const REMARK_PLUGINS = [remarkGfm, remarkTableThemes, remarkHtmlBreaks]

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
  const { t } = useI18n()
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
              {editing ? t('common.done') : t('common.edit')}
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
  const { t } = useI18n()
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
            {t('common.apply')}
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
          aria-label={t('editor.fence.sourceAria', { lang: fenceLang })}
        />
      ) : fenceLang === 'plantuml' ? (
        <pre className="inline-diagram-readonly-source">{chart}</pre>
      ) : (
        <MermaidBlock chart={chart} />
      )}
    </InlineShell>
  )
}

/** Always-on free-draw editor for inline ```freedraw fences. */
function InlineFreeDrawEditor({
  source,
  fenceLang,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceLang: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const { t } = useI18n()
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
        onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, next))
      }, 450)
    },
    [contentRef, fenceIndex, fenceLang, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing inline-diagram--freedraw">
      <div className="inline-diagram-chrome">
        <div className="inline-diagram-labels">
          <span className="inline-diagram-badge">{t('editor.insert.freedraw')}</span>
          <figcaption className="inline-diagram-title">{t('editor.freedraw.title')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.freedraw.hint')}</span>
      </div>
      <div className="inline-diagram-body inline-diagram-body--freedraw">
        <FreeDrawCanvas source={live} onChange={commitSource} compact />
      </div>
    </figure>
  )
}

/** Always-on Excel-style grid editor for inline ```excelgrid fences. */
function InlineExcelGridEditor({
  source,
  fenceLang,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceLang: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const { t } = useI18n()
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
        onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, next))
      }, 450)
    },
    [contentRef, fenceIndex, fenceLang, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing inline-diagram--excelgrid">
      <div className="inline-diagram-chrome">
        <div className="inline-diagram-labels">
          <span className="inline-diagram-badge">{t('editor.insert.spreadsheet')}</span>
          <figcaption className="inline-diagram-title">{t('editor.excelgrid.title')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.excelgrid.hint')}</span>
      </div>
      <div className="inline-diagram-body inline-diagram-body--excelgrid">
        <ExcelGridCanvas source={live} onChange={commitSource} compact />
      </div>
    </figure>
  )
}

function InlineKanbanEditor({
  source,
  fenceLang,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceLang: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const { t } = useI18n()
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
        onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, next))
      }, 400)
    },
    [contentRef, fenceIndex, fenceLang, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing kanban-embed">
      <div className="inline-diagram-head">
        <div>
          <span className="inline-diagram-badge">{t('editor.insert.kanban')}</span>
          <figcaption className="inline-diagram-title">{t('editor.kanban.title')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.kanban.hint')}</span>
      </div>
      <div className="inline-diagram-body">
        <KanbanBoard source={live} onChange={commitSource} compact />
      </div>
    </figure>
  )
}

function KanbanRefPreview({
  boardId,
  bookId,
  editable,
}: {
  boardId: string
  bookId?: string
  editable?: boolean
}) {
  const { t } = useI18n()
  const id = boardId.trim().split(/\s+/)[0] ?? ''
  const [source, setSource] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .getKanbanBoard(id)
      .then((b) => {
        if (cancelled) return
        setSource(b.source)
        setTitle(b.title)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return <div className="banner error compact">{t('editor.kanbanError', { id, error })}</div>
  }
  if (source == null) {
    return <p className="muted sm">{t('editor.loadingKanban')}</p>
  }
  return (
    <figure className="kanban-embed">
      <div className="inline-diagram-head">
        <span className="inline-diagram-badge">{t('editor.kanban.linkedBadge')}</span>
        <figcaption className="inline-diagram-title">{title}</figcaption>
        {editable && bookId && (
          <Link className="btn ghost sm" to={`/books/${bookId}/kanban/${id}`}>
            {t('kanban.openBoard')}
          </Link>
        )}
      </div>
      <KanbanView source={source} title={title} compact />
    </figure>
  )
}

function InlineNoteEditor({
  source,
  fenceLang,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceLang: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const { t } = useI18n()
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
        onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, next))
      }, 400)
    },
    [contentRef, fenceIndex, fenceLang, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing note-embed">
      <div className="inline-diagram-head">
        <div>
          <span className="inline-diagram-badge">{t('editor.insert.note')}</span>
          <figcaption className="inline-diagram-title">{t('editor.note.title')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.note.hint')}</span>
      </div>
      <div className="inline-diagram-body">
        <NoteEditor source={live} onChange={commitSource} compact />
      </div>
    </figure>
  )
}

function NoteRefPreview({
  noteId,
  bookId,
  editable,
}: {
  noteId: string
  bookId?: string
  editable?: boolean
}) {
  const { t } = useI18n()
  const id = noteId.trim().split(/\s+/)[0] ?? ''
  const [source, setSource] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .getNote(id)
      .then((n) => {
        if (cancelled) return
        setSource(n.source)
        setTitle(n.title)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return <div className="banner error compact">{t('editor.noteError', { id, error })}</div>
  }
  if (source == null) {
    return <p className="muted sm">{t('editor.loadingNote')}</p>
  }
  return (
    <figure className="note-embed">
      <div className="inline-diagram-head">
        <span className="inline-diagram-badge">{t('editor.note.linkedBadge')}</span>
        <figcaption className="inline-diagram-title">{title}</figcaption>
        {editable && bookId && (
          <Link className="btn ghost sm" to={`/books/${bookId}/notes/${id}`}>
            {t('notes.openNote')}
          </Link>
        )}
      </div>
      {editable ? (
        <NoteEditor
          source={source}
          compact
          onChange={(next) => {
            setSource(next)
            void api.updateNote(id, { title, source: next }).catch(() => {})
          }}
        />
      ) : (
        <NoteView source={source} compact />
      )}
    </figure>
  )
}

function InlineProjectEditor({
  source,
  fenceLang,
  fenceIndex,
  contentRef,
  onContentChange,
  draft,
  onDraftChange,
}: {
  source: string
  fenceLang: string
  fenceIndex: number
  contentRef: React.MutableRefObject<string>
  onContentChange: (next: string) => void
  draft: string | undefined
  onDraftChange: (next: string) => void
}) {
  const { t } = useI18n()
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
        onContentChange(replaceFenceBody(contentRef.current, fenceLang, fenceIndex, next))
      }, 400)
    },
    [contentRef, fenceIndex, fenceLang, onContentChange, onDraftChange],
  )

  return (
    <figure className="inline-diagram is-editing project-embed">
      <div className="inline-diagram-head">
        <div>
          <span className="inline-diagram-badge">{t('editor.insert.project')}</span>
          <figcaption className="inline-diagram-title">{t('editor.project.title')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.project.hint')}</span>
      </div>
      <div className="inline-diagram-body">
        <ProjectEditor source={live} onChange={commitSource} compact />
      </div>
    </figure>
  )
}

function ProjectRefPreview({
  planId,
  bookId,
  editable,
}: {
  planId: string
  bookId?: string
  editable?: boolean
}) {
  const { t } = useI18n()
  const id = planId.trim().split(/\s+/)[0] ?? ''
  const [source, setSource] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .getProjectPlan(id)
      .then((p) => {
        if (cancelled) return
        setSource(p.source)
        setTitle(p.title)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return <div className="banner error compact">{t('editor.projectError', { id, error })}</div>
  }
  if (source == null) {
    return <p className="muted sm">{t('editor.loadingProject')}</p>
  }
  return (
    <figure className="project-embed">
      <div className="inline-diagram-head">
        <span className="inline-diagram-badge">{t('editor.project.linkedBadge')}</span>
        <figcaption className="inline-diagram-title">{title}</figcaption>
        {editable && bookId && (
          <Link className="btn ghost sm" to={`/books/${bookId}/project/${id}`}>
            {t('project.openPlan')}
          </Link>
        )}
      </div>
      {editable ? (
        <ProjectEditor
          source={source}
          compact
          onChange={(next) => {
            setSource(next)
            void api.updateProjectPlan(id, { title, source: next }).catch(() => {})
          }}
        />
      ) : (
        <ProjectView source={source} compact />
      )}
    </figure>
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
  const { t } = useI18n()
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
          <figcaption className="inline-diagram-title">{t('editor.studioEditor')}</figcaption>
        </div>
        <span className="muted sm">{t('editor.studioHint')}</span>
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
  const { t } = useI18n()
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
  const site = useMarkdownSite()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = site.getDiagram ? await site.getDiagram(id) : await api.getDiagram(id)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per id / loader
  }, [id, site.getDiagram])

  const persist = useCallback(async (nextSource: string) => {
    const currentTitle = titleRef.current
    if (!currentTitle) return
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateDiagram(id, { title: currentTitle, source: nextSource })
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
    return <div className="banner error">{t('editor.diagramError', { id, error })}</div>
  }
  if (!loadedSource && !draft) return <p className="muted">{t('editor.loadingDiagram')}</p>

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
          <figcaption className="inline-diagram-title">{title ?? t('common.diagram')}</figcaption>
        </div>
        <div className="inline-diagram-actions">
          <span className="inline-diagram-status-inline">
            {saving && t('common.saving')}
            {!saving && dirty && <span className="dirty-dot">{t('editor.unsaved')}</span>}
            {!saving && !dirty && savedAt && (
              <span className="muted">{t('editor.savedAt', { time: savedAt })}</span>
            )}
          </span>
          <button type="button" className="btn primary sm" disabled={saving || !dirty} onClick={saveNow}>
            {saving ? t('common.saving') : dirty ? t('common.save') : t('common.saved')}
          </button>
          {openHref && (
            <Link className="btn ghost sm" to={openHref}>
              {t('editor.fullPage')}
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
 * Rendered ```isometric-ref entity embed: the referenced isometric diagram,
 * explorable (pan/zoom) but not editable inline — the isometric editor is a
 * whole workspace of its own, so editing happens on the diagram's page,
 * reachable via the link in the chrome.
 */
export function IsometricRefBlock({
  diagramId,
  bookId,
  showOpenLink,
}: {
  diagramId: string
  bookId?: string
  showOpenLink: boolean
}) {
  const { t } = useI18n()
  const [title, setTitle] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = diagramId.trim().split(/\s+/)[0] ?? ''
  const { getDiagram } = useMarkdownSite()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const d = getDiagram ? await getDiagram(id) : await api.getDiagram(id)
        if (cancelled) return
        setTitle(d.title)
        setSource(d.source)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, getDiagram])

  if (error) {
    return <div className="banner error">{t('editor.diagramError', { id, error })}</div>
  }
  if (source === null) return <p className="muted">{t('editor.loadingDiagram')}</p>

  const openHref = bookId ? `/books/${bookId}/diagrams/${id}` : undefined
  return (
    <figure className="bee-embed isometric-embed">
      {(title || (showOpenLink && openHref)) && (
        <figcaption className="meta isometric-embed-caption">
          <span>{title}</span>
          {showOpenLink && openHref && (
            <Link className="btn ghost sm" to={openHref}>
              {t('editor.openInEditor')}
            </Link>
          )}
        </figcaption>
      )}
      <Suspense fallback={<p className="muted">{t('editor.loadingIsometric')}</p>}>
        <IsometricView source={source} title={title ?? ''} />
      </Suspense>
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

type MarkdownBodyProps = MarkdownViewProps & {
  /**
   * Global block-index offset used for outline anchors when this body renders
   * one cell of a page grid — so ids line up with `buildPageOutline`, which
   * counts blocks across all cells in order.
   */
  blockIndexOffset?: number
}

/**
 * Rendered Markdown for a page — or, when the page declares a grid layout
 * (`pageLayout.ts`), a CSS grid whose cells each render their own Markdown.
 * Per-cell rendering keeps inline fence editing correct: a cell's fence
 * indices are counted within that cell, and edits are stitched back into the
 * full document here.
 */
export const MarkdownView = memo(function MarkdownView(props: MarkdownViewProps) {
  const { content, onContentChange } = props
  const parsed = useMemo(() => parsePageLayout(content), [content])
  const offsets = useMemo(() => {
    if (!parsed) return []
    const out: number[] = []
    let acc = 0
    for (const cell of parsed.cells) {
      out.push(acc)
      acc += splitMarkdownSegments(cell).length
    }
    return out
  }, [parsed])

  const handleCellChange = useCallback(
    (cellIdx: number, next: string) => {
      if (!parsed || !onContentChange) return
      const cells = [...parsed.cells]
      cells[cellIdx] = next
      onContentChange(serializePageLayout(parsed.layout, cells))
    },
    [parsed, onContentChange],
  )

  if (!parsed) return <MarkdownBody {...props} />

  return (
    <div
      className="page-grid"
      style={{ '--page-grid-cols': parsed.layout.cols } as CSSProperties}
    >
      {parsed.cells.map((cell, i) => (
        <div className="page-grid-cell" key={i}>
          <MarkdownBody
            content={cell}
            editable={props.editable}
            bookId={props.bookId}
            blockIndexOffset={offsets[i]}
            onContentChange={onContentChange ? (next) => handleCellChange(i, next) : undefined}
          />
        </div>
      ))}
    </div>
  )
})

const MarkdownBody = memo(function MarkdownBody({
  content,
  editable = false,
  onContentChange,
  bookId,
  blockIndexOffset = 0,
}: MarkdownBodyProps) {
  const { t } = useI18n()
  const site = useMarkdownSite()
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

  /** Map fence occurrence keys (`lang:n`) and ordered heading ids to outline targets. */
  const outlineTargets = useMemo(() => {
    const fenceKeyToId = new Map<string, string>()
    const headingIds: string[] = []
    const fenceCounts: Record<string, number> = {}
    splitMarkdownSegments(content).forEach((seg, blockIndex) => {
      if (seg.type === 'text') {
        if (/^(#{1,6})\s+\S/m.test(seg.text.trimStart())) {
          headingIds.push(outlineId(blockIndex + blockIndexOffset))
        }
        return
      }
      const lang = seg.lang.toLowerCase()
      const n = fenceCounts[lang] ?? 0
      fenceCounts[lang] = n + 1
      fenceKeyToId.set(`${lang}:${n}`, outlineId(blockIndex + blockIndexOffset))
    })
    return { fenceKeyToId, headingIds }
  }, [content, blockIndexOffset])

  const headingCursor = useRef(0)
  headingCursor.current = 0

  const wrapOutline = useCallback(
    (lang: string, occurrence: number, node: ReactNode) => {
      const id = outlineTargets.fenceKeyToId.get(`${lang}:${occurrence}`)
      if (!id) return node
      return (
        <div id={id} data-outline-id={id} className="outline-anchor">
          {node}
        </div>
      )
    },
    [outlineTargets],
  )

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
    () => {
      const heading =
        (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
        ({ children, ...props }: ComponentProps<'h1'>) => {
          const id = outlineTargets.headingIds[headingCursor.current++]
          return (
            <Tag id={id} data-outline-id={id} className="outline-heading" {...props}>
              {children}
            </Tag>
          )
        }

      return {
      img({ src, alt, ...props }: ComponentProps<'img'>) {
        return <img src={src ? withApiBase(src) : src} alt={alt ?? ''} {...props} />
      },
      // Links to other documents (dragged in from the library tree) go through
      // the router: a plain <a> would reload the whole app and lose the basename.
      a({ href, children, ...props }: ComponentProps<'a'>) {
        const dest = href && site.resolveHref ? site.resolveHref(href) : href
        if (isInternalDocHref(dest)) {
          return (
            <Link to={dest} className="doc-link" {...props}>
              {children}
            </Link>
          )
        }
        return (
          <a href={href} {...props}>
            {children}
          </a>
        )
      },
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      h5: heading('h5'),
      h6: heading('h6'),
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
            return wrapOutline(
              lang,
              idx,
              <EditableMermaidFence
                chart={code}
                fenceLang={lang}
                fenceIndex={idx}
                editing={Boolean(openKeys[key])}
                onToggleEdit={() => toggleKey(key)}
                contentRef={contentRef}
                onContentChange={handleContentChange}
              />,
            )
          }
          if (lang === 'plantuml') {
            return wrapOutline(
              lang,
              idx,
              <pre className="inline-diagram-readonly-source">{code}</pre>,
            )
          }
          return wrapOutline(lang, idx, <MermaidBlock chart={code} />)
        }

        if (lang === 'beediagram') {
          const idx = nextIndex('beediagram')
          if (editable && onContentChange) {
            const key = `beediagram:${idx}`
            return wrapOutline(
              'beediagram',
              idx,
              <InlineBeeDiagramEditor
                source={code}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            'beediagram',
            idx,
            <figure className="bee-embed">
              <BeeDiagramView source={code} />
            </figure>,
          )
        }

        if (lang === 'freedraw' || lang === 'sketch') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `freedraw:${idx}`
            return wrapOutline(
              lang,
              idx,
              <InlineFreeDrawEditor
                source={code}
                fenceLang={lang}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            lang,
            idx,
            <figure className="freedraw-embed">
              <FreeDrawView source={code} />
            </figure>,
          )
        }

        if (lang === 'excelgrid' || lang === 'spreadsheet' || lang === 'grid') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `excelgrid:${idx}`
            return wrapOutline(
              lang,
              idx,
              <InlineExcelGridEditor
                source={code}
                fenceLang={lang}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            lang,
            idx,
            <figure className="excelgrid-embed">
              <ExcelGridView source={code} />
            </figure>,
          )
        }

        if (lang === 'kanban') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `kanban:${idx}`
            return wrapOutline(
              lang,
              idx,
              <InlineKanbanEditor
                source={code}
                fenceLang={lang}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            lang,
            idx,
            <figure className="kanban-embed">
              <KanbanView source={code} compact />
            </figure>,
          )
        }

        if (lang === 'note') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `note:${idx}`
            return wrapOutline(
              lang,
              idx,
              <InlineNoteEditor
                source={code}
                fenceLang={lang}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            lang,
            idx,
            <figure className="note-embed">
              <NoteView source={code} compact />
            </figure>,
          )
        }

        if (lang === 'note-ref') {
          const idx = nextIndex('note-ref')
          return wrapOutline(
            'note-ref',
            idx,
            <NoteRefPreview noteId={code} bookId={bookId} editable={editable} />,
          )
        }

        if (lang === 'project') {
          const idx = nextIndex(lang)
          if (editable && onContentChange) {
            const key = `project:${idx}`
            return wrapOutline(
              lang,
              idx,
              <InlineProjectEditor
                source={code}
                fenceLang={lang}
                fenceIndex={idx}
                contentRef={contentRef}
                onContentChange={handleContentChange}
                draft={beeDrafts[key]}
                onDraftChange={(next) => setBeeDraft(key, next)}
              />,
            )
          }
          return wrapOutline(
            lang,
            idx,
            <figure className="project-embed">
              <ProjectView source={code} compact />
            </figure>,
          )
        }

        if (lang === 'project-ref') {
          const idx = nextIndex('project-ref')
          return wrapOutline(
            'project-ref',
            idx,
            <ProjectRefPreview planId={code} bookId={bookId} editable={editable} />,
          )
        }

        if (lang === 'kanban-ref') {
          const idx = nextIndex('kanban-ref')
          return wrapOutline(
            'kanban-ref',
            idx,
            <KanbanRefPreview boardId={code} bookId={bookId} editable={editable} />,
          )
        }

        if (lang === 'isometric') {
          const idx = nextIndex('isometric')
          return wrapOutline(
            'isometric',
            idx,
            <figure className="bee-embed isometric-embed">
              <Suspense fallback={<p className="muted">{t('editor.loadingIsometric')}</p>}>
                <IsometricView source={code} />
              </Suspense>
            </figure>,
          )
        }

        if (lang === 'isometric-ref') {
          const idx = nextIndex('isometric-ref')
          return wrapOutline(
            'isometric-ref',
            idx,
            <IsometricRefBlock diagramId={code} bookId={bookId} showOpenLink={editable} />,
          )
        }

        if (lang === 'beediagram-ref') {
          const id = code.trim().split(/\s+/)[0] ?? ''
          const key = `beediagram-ref:${id}`
          const idx = nextIndex('beediagram-ref')
          return wrapOutline(
            'beediagram-ref',
            idx,
            <InlineBeeDiagramRefEditor
              diagramId={code}
              allowEdit={editable}
              bookId={bookId}
              draft={beeDrafts[key]}
              onDraftChange={(next) => setBeeDraft(key, next)}
            />,
          )
        }

        if (
          lang === 'pdf' ||
          lang === 'glb' ||
          lang === 'gltf' ||
          lang === 'obj' ||
          lang === 'model'
        ) {
          const idx = nextIndex(lang)
          return wrapOutline(lang, idx, <MediaEmbed lang={lang} body={code} />)
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
    }
    },
    [
      beeDrafts,
      bookId,
      editable,
      handleContentChange,
      nextIndex,
      onContentChange,
      openKeys,
      outlineTargets,
      setBeeDraft,
      site,
      t,
      toggleKey,
      wrapOutline,
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
