import { Suspense, lazy, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { emptySourceForKind, sourceFitsKind } from '../diagram/kindCompatibility'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useI18n, type MessageKey } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Diagram } from '../types'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { BeeDiagramView } from './BeeDiagramView'
import { MarkdownView } from './MarkdownView'

// Kept lazy so pages that never open an isometric diagram don't load its editor.
const IsometricEditor = lazy(() => import('../isometric/IsometricEditor'))
const IsometricView = lazy(() => import('../isometric/IsometricView'))

/**
 * Kinds offered by the toolbar switcher. Compatible sources (empty, mermaid↔c4)
 * switch in place. Anything else opens a confirm that replaces the document
 * with an empty starter for the new kind — there is no conversion.
 */
const KIND_OPTIONS = ['beediagram', 'isometric', 'mermaid', 'c4'] as const

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
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [kind, setKind] = useState('beediagram')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  /** Target kind waiting on the "replace with a blank document" confirm. */
  const [pendingKind, setPendingKind] = useState<string | null>(null)
  const kindDialogTitleId = useId()

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

  const applyKind = useCallback((next: string, nextSource?: string) => {
    setKind(next)
    if (nextSource !== undefined) setSource(nextSource)
    setDirty(true)
    setPendingKind(null)
  }, [])

  const requestKindChange = useCallback(
    (next: string) => {
      if (kind === next) return
      if (sourceFitsKind(source, next)) {
        applyKind(next)
        return
      }
      setPendingKind(next)
    },
    [kind, source, applyKind],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
      if (e.key === 'Escape' && pendingKind) setPendingKind(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, pendingKind])

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
    if (!confirm(t('canvas.deleteDiagramConfirm'))) return
    await deleteFromTree(diagramId, bookId)
    void navigate(`/books/${bookId}`)
  }

  const embedSnippet =
    kind === 'beediagram' || kind === 'isometric'
      ? `\`\`\`${kind === 'isometric' ? 'isometric-ref' : 'beediagram-ref'}\n${diagramId}\n\`\`\``
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
      setKind: requestKindChange,
      setSource: (v) => {
        setSource(v)
        setDirty(true)
      },
      save,
      deleteDiagram: remove,
      embedSnippet,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, title, kind, source, dirty, saving, error, embedSnippet, save, requestKindChange])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !diagram) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!diagram) {
    return <div className="canvas-message muted">{t('canvas.loadingDiagram')}</div>
  }

  const statusLabel = saving
    ? t('common.saving')
    : dirty
      ? autoSaveEnabled
        ? t('canvas.unsavedAutoSave')
        : t('canvas.unsaved')
      : savedAt
        ? t('canvas.savedAt', { time: savedAt })
        : null

  const isometricLoading = <div className="canvas-message muted">{t('canvas.loadingIsometric')}</div>

  return (
    <div className="diagram-canvas">
      <div className="canvas-toolbar">
        <div className="canvas-heading">
          {canWrite ? (
            <input
              className="canvas-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setDirty(true)
              }}
              placeholder={t('canvas.diagramTitlePlaceholder')}
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>{kind}</span>
            {statusLabel && (
              <span className={dirty && !saving ? 'dirty-dot' : undefined}>· {statusLabel}</span>
            )}
            {autoSaveEnabled && canWrite && (
              <span className="muted save-hint" title={t('canvas.saveShortcutHint')}>
                · {t('canvas.autoSaveOn')}
              </span>
            )}
          </div>
        </div>
        <div className="toolbar-group">
          {canWrite ? (
            <>
              <div className="segmented" role="tablist" aria-label={t('canvas.diagramKind')}>
                {KIND_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    role="tab"
                    aria-selected={kind === opt}
                    className={kind === opt ? 'active' : ''}
                    title={t(`canvas.kindHint.${opt}` as MessageKey)}
                    onClick={() => requestKindChange(opt)}
                  >
                    {t(`canvas.kind.${opt}` as MessageKey)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn primary sm"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? t('common.saving') : dirty ? t('common.save') : t('common.saved')}
              </button>
            </>
          ) : (
            <span className="ws-theme-pill" title={t('canvas.readOnlyHint')}>
              {t('canvas.readOnly')}
            </span>
          )}
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      {/* Read-only accounts get the rendered diagram, not the studio: the
          workbench is an editor whose every change would fail at save. */}
      {!canWrite ? (
        <div className="editor-preview diagram-readonly">
          {kind === 'beediagram' ? (
            <BeeDiagramView source={source} />
          ) : kind === 'isometric' ? (
            <Suspense fallback={isometricLoading}>
              <IsometricView source={source} title={title} />
            </Suspense>
          ) : (
            <MarkdownView content={'```mermaid\n' + source + '\n```'} />
          )}
        </div>
      ) : kind === 'beediagram' ? (
        <BeeDiagramWorkbench
          bookId={bookId}
          source={source}
          onChange={(s) => {
            setSource(s)
            setDirty(true)
          }}
        />
      ) : kind === 'isometric' ? (
        <Suspense fallback={isometricLoading}>
          <IsometricEditor
            // Remount per document so undo history never crosses diagrams.
            key={diagramId}
            source={source}
            title={title}
            onChange={(s) => {
              setSource(s)
              setDirty(true)
            }}
          />
        </Suspense>
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
            {source.trim() ? (
              <MarkdownView content={'```mermaid\n' + source + '\n```'} />
            ) : (
              <div className="canvas-message muted">{t('canvas.kindEmptyPreview')}</div>
            )}
          </div>
        </div>
      )}
      {pendingKind && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingKind(null)
          }}
        >
          <div
            className="modal modal--compact"
            role="dialog"
            aria-modal="true"
            aria-labelledby={kindDialogTitleId}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2 id={kindDialogTitleId}>{t('canvas.kindSwitchTitle')}</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPendingKind(null)}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </header>
            <div className="modal-body">
              <p>
                {t('canvas.kindSwitchBody', {
                  from: t(`canvas.kind.${kind}` as MessageKey),
                  to: t(`canvas.kind.${pendingKind}` as MessageKey),
                })}
              </p>
            </div>
            <footer className="modal-footer">
              <button type="button" className="btn ghost" onClick={() => setPendingKind(null)}>
                {t('canvas.kindSwitchKeep')}
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => applyKind(pendingKind, emptySourceForKind(pendingKind))}
              >
                {t('canvas.kindSwitchReplace')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
