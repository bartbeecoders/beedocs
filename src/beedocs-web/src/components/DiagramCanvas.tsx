import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Diagram } from '../types'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { MarkdownView } from './MarkdownView'

export type DiagramEditorState = {
  diagram: Diagram | null
  title: string
  kind: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  setTitle: (v: string) => void
  setKind: (v: string) => void
  setSource: (v: string) => void
  save: () => Promise<void>
  deleteDiagram: () => Promise<void>
  embedSnippet: string
}

type Props = {
  onStateChange?: (state: DiagramEditorState | null) => void
}

export function DiagramCanvas({ onStateChange }: Props) {
  const { bookId = '', diagramId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteDiagram: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [kind, setKind] = useState('beediagram')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const kindRef = useRef(kind)
  const dirtyRef = useRef(dirty)
  const diagramIdRef = useRef(diagramId)
  const savingRef = useRef(false)
  /** Title the library tree is currently showing, so a save only refreshes it when it moved. */
  const treeTitleRef = useRef('')

  titleRef.current = title
  sourceRef.current = source
  kindRef.current = kind
  dirtyRef.current = dirty
  diagramIdRef.current = diagramId

  // Flush unsaved edits when navigating to another diagram.
  useEffect(() => {
    const id = diagramId
    return () => {
      if (!dirtyRef.current) return
      const payload = {
        title: titleRef.current,
        kind: kindRef.current,
        source: sourceRef.current,
      }
      void api.updateDiagram(id, payload).catch(() => {
        /* best-effort flush */
      })
    }
  }, [diagramId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setDiagram(null)
      setDirty(false)
      setSavedAt(null)
      try {
        const d = await api.getDiagram(diagramId)
        if (cancelled) return
        setDiagram(d)
        setTitle(d.title)
        setSource(d.source)
        setKind(d.kind)
        treeTitleRef.current = d.title
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [diagramId])

  const save = useCallback(async () => {
    const id = diagramIdRef.current
    if (!id || savingRef.current) return

    const payload = {
      title: titleRef.current,
      kind: kindRef.current,
      source: sourceRef.current,
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateDiagram(id, payload)
      if (diagramIdRef.current !== id) return
      setDiagram(updated)
      setSavedAt(new Date().toLocaleTimeString())
      if (
        titleRef.current === payload.title &&
        kindRef.current === payload.kind &&
        sourceRef.current === payload.source
      ) {
        setDirty(false)
      }
      // Same reason as PageCanvas: the tree only shows the title, so refetching the
      // whole library on every autosave was pure re-render churn.
      if (updated.title !== treeTitleRef.current) {
        treeTitleRef.current = updated.title
        await renameInTree()
      }
    } catch (err) {
      if (diagramIdRef.current === id) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      savingRef.current = false
      if (diagramIdRef.current === id) setSaving(false)
    }
  }, [renameInTree])

  useAutoSave({ enabled: autoSaveEnabled, dirty, save })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const remove = async () => {
    if (!confirm('Delete this diagram?')) return
    await deleteFromTree(diagramId, bookId)
    void navigate(`/books/${bookId}`)
  }

  const embedSnippet =
    kind === 'beediagram'
      ? `\`\`\`beediagram-ref\n${diagramId}\n\`\`\``
      : `\`\`\`${kind === 'c4' ? 'mermaid' : kind}\n${source}\n\`\`\``

  useEffect(() => {
    onStateChange?.({
      diagram,
      title,
      kind,
      source,
      dirty,
      saving,
      error,
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      setKind: (v) => {
        setKind(v)
        setDirty(true)
      },
      setSource: (v) => {
        setSource(v)
        setDirty(true)
      },
      save,
      deleteDiagram: remove,
      embedSnippet,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, title, kind, source, dirty, saving, error, embedSnippet, save])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !diagram) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!diagram) {
    return <div className="canvas-message muted">Loading diagram…</div>
  }

  const statusLabel = saving
    ? 'Saving…'
    : dirty
      ? autoSaveEnabled
        ? 'Unsaved · auto-save pending'
        : 'Unsaved'
      : savedAt
        ? `Saved · ${savedAt}`
        : null

  return (
    <div className="diagram-canvas">
      <div className="canvas-toolbar">
        <input
          className="canvas-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setDirty(true)
          }}
          placeholder="Diagram title"
        />
        <div className="toolbar-group">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setDirty(true)
            }}
            aria-label="Diagram kind"
          >
            <option value="beediagram">BeeDiagram</option>
            <option value="mermaid">Mermaid</option>
            <option value="c4">C4 (Mermaid)</option>
          </select>
          <button type="button" className="btn primary sm" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>
      <div className="canvas-meta">
        <span>{kind}</span>
        {statusLabel && (
          <span className={dirty && !saving ? 'dirty-dot' : undefined}>· {statusLabel}</span>
        )}
        {autoSaveEnabled && (
          <span className="muted save-hint" title="Ctrl/Cmd+S to save immediately">
            · auto-save on
          </span>
        )}
      </div>
      {error && <div className="banner error compact">{error}</div>}
      {kind === 'beediagram' ? (
        <BeeDiagramWorkbench
          bookId={bookId}
          source={source}
          onChange={(s) => {
            setSource(s)
            setDirty(true)
          }}
        />
      ) : (
        <div className="editor-panes mode-split">
          <textarea
            className="editor-textarea"
            value={source}
            onChange={(e) => {
              setSource(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
          />
          <div className="editor-preview">
            <MarkdownView content={'```mermaid\n' + source + '\n```'} />
          </div>
        </div>
      )}
    </div>
  )
}
