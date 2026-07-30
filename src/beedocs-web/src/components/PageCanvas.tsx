import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Page } from '../types'
import { HybridPageEditor } from './HybridPageEditor'
import { MarkdownView } from './MarkdownView'
import { ExportMenu } from './ExportMenu'

export type PageEditorState = {
  page: Page | null
  title: string
  content: string
  dirty: boolean
  saving: boolean
  error: string | null
  mode: 'edit' | 'source' | 'preview' | 'split'
  setTitle: (v: string) => void
  setContent: (v: string) => void
  setMode: (m: 'edit' | 'source' | 'preview' | 'split') => void
  save: () => Promise<void>
  deletePage: () => Promise<void>
}

type Props = {
  onStateChange?: (state: PageEditorState | null) => void
}

export function PageCanvas({ onStateChange }: Props) {
  const { bookId = '', pageId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deletePage: deleteFromTree } = useWorkspace()
  const { showPreviewDefault, autoSaveEnabled } = useTheme()
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<'edit' | 'source' | 'preview' | 'split'>('edit')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const contentRef = useRef(content)
  const dirtyRef = useRef(dirty)
  const pageIdRef = useRef(pageId)
  const savingRef = useRef(false)

  titleRef.current = title
  contentRef.current = content
  dirtyRef.current = dirty
  pageIdRef.current = pageId

  useEffect(() => {
    // Always open in visual edit (hybrid) so diagrams are editable on the page.
    // showPreviewDefault still used as a soft preference for split vs edit.
    setMode(showPreviewDefault ? 'split' : 'edit')
  }, [pageId, showPreviewDefault])

  // Flush unsaved edits when navigating to another page (cleanups run before the next load).
  useEffect(() => {
    const id = pageId
    return () => {
      if (!dirtyRef.current) return
      const payload = { title: titleRef.current, content: contentRef.current }
      void api.updatePage(id, payload).catch(() => {
        /* best-effort flush */
      })
    }
  }, [pageId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setPage(null)
      setDirty(false)
      setSavedAt(null)
      try {
        const p = await api.getPage(pageId)
        if (cancelled) return
        setPage(p)
        setTitle(p.title)
        setContent(p.content)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pageId])

  const save = useCallback(async () => {
    const id = pageIdRef.current
    if (!id || savingRef.current) return

    const payload = { title: titleRef.current, content: contentRef.current }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updatePage(id, payload)
      if (pageIdRef.current !== id) return
      setPage(updated)
      setSavedAt(new Date().toLocaleTimeString())
      // Only clear dirty if local state still matches what we saved
      if (titleRef.current === payload.title && contentRef.current === payload.content) {
        setDirty(false)
      }
      await renameInTree()
    } catch (err) {
      if (pageIdRef.current === id) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      savingRef.current = false
      if (pageIdRef.current === id) setSaving(false)
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
    if (!confirm('Delete this page?')) return
    await deleteFromTree(pageId, bookId)
    void navigate(`/books/${bookId}`)
  }

  useEffect(() => {
    onStateChange?.({
      page,
      title,
      content,
      dirty,
      saving,
      error,
      mode,
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      setContent: (v) => {
        setContent(v)
        setDirty(true)
      },
      setMode,
      save,
      deletePage: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, title, content, dirty, saving, error, mode, save])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !page) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!page) {
    return <div className="canvas-message muted">Loading page…</div>
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
    <div className="page-canvas">
      <div className="canvas-toolbar">
        <input
          className="canvas-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setDirty(true)
          }}
          placeholder="Page title"
        />
        <div className="toolbar-group">
          <div className="segmented">
            {(
              [
                { id: 'edit' as const, label: 'edit' },
                { id: 'source' as const, label: 'source' },
                { id: 'split' as const, label: 'split' },
                { id: 'preview' as const, label: 'preview' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                className={mode === m.id ? 'active' : ''}
                onClick={() => setMode(m.id)}
                title={
                  m.id === 'edit'
                    ? 'Visual page edit — diagrams are canvases on the page'
                    : m.id === 'source'
                      ? 'Raw Markdown only'
                      : m.id === 'split'
                        ? 'Visual edit + live preview'
                        : 'Rendered preview'
                }
              >
                {m.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn primary sm" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <ExportMenu scope="page" id={page.id} title={page.title} variant="icon" />
        </div>
      </div>
      <div className="canvas-meta">
        <span>v{page.version}</span>
        {statusLabel && (
          <span className={dirty && !saving ? 'dirty-dot' : undefined}>· {statusLabel}</span>
        )}
        {autoSaveEnabled && (
          <span className="muted save-hint" title="Ctrl/Cmd+S to save immediately">
            · auto-save on
          </span>
        )}
        <span className="muted">
          {mode === 'edit' || mode === 'split'
            ? 'Visual edit · BeeDiagram canvases on the page'
            : 'Markdown · Mermaid · BeeDiagram'}
        </span>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className={`editor-panes mode-${mode === 'source' ? 'edit' : mode}`}>
        {(mode === 'edit' || mode === 'split') && (
          <div className="editor-hybrid">
            <HybridPageEditor
              content={content}
              bookId={bookId}
              pageId={pageId}
              placeholder="Write Markdown… or use Add to insert sections and diagrams."
              onChange={(next) => {
                setContent(next)
                setDirty(true)
              }}
            />
          </div>
        )}
        {mode === 'source' && (
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            placeholder="Raw Markdown source…"
          />
        )}
        {(mode === 'preview' || mode === 'split') && (
          <div className="editor-preview">
            <MarkdownView content={content} bookId={bookId} />
          </div>
        )}
      </div>
    </div>
  )
}
