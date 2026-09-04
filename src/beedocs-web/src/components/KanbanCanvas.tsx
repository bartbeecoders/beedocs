import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { KanbanBoard as KanbanBoardDto } from '../types'
import { countCards, parseBoard } from '../kanban/kanbanModel'
import { KanbanBoard } from '../kanban/KanbanBoard'
import { KanbanView } from '../kanban/KanbanView'
import '../styles/kanban.css'

export type KanbanEditorState = {
  board: KanbanBoardDto | null
  title: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  cardCount: number
  setTitle: (v: string) => void
  save: () => Promise<void>
  deleteBoard: () => Promise<void>
}

type Props = {
  onStateChange?: (state: KanbanEditorState | null) => void
}

/**
 * Center-canvas host for a kanban board route: loads the board, owns save/dirty
 * state, and renders the editor for writers or a read-only view for viewers.
 */
export function KanbanCanvas({ onStateChange }: Props) {
  const { bookId = '', boardId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteKanbanBoard: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [board, setBoard] = useState<KanbanBoardDto | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const dirtyRef = useRef(dirty)
  const boardIdRef = useRef(boardId)
  const savingRef = useRef(false)
  const treeTitleRef = useRef('')
  const treeCountRef = useRef(0)

  titleRef.current = title
  sourceRef.current = source
  dirtyRef.current = dirty
  boardIdRef.current = boardId

  useEffect(() => {
    const id = boardId
    return () => {
      if (!dirtyRef.current) return
      void api
        .updateKanbanBoard(id, { title: titleRef.current, source: sourceRef.current })
        .catch(() => {})
    }
  }, [boardId])

  const save = useCallback(async () => {
    const id = boardIdRef.current
    if (!id || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateKanbanBoard(id, {
        title: titleRef.current,
        source: sourceRef.current,
      })
      setBoard(updated)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      const cards = countCards(parseBoard(updated.source))
      if (treeTitleRef.current !== updated.title || treeCountRef.current !== cards) {
        treeTitleRef.current = updated.title
        treeCountRef.current = cards
        await renameInTree()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [renameInTree])

  const remove = useCallback(async () => {
    if (!confirm(t('canvas.deleteKanbanConfirm'))) return
    await deleteFromTree(boardId, bookId)
    void navigate(`/books/${bookId}`)
  }, [boardId, bookId, deleteFromTree, navigate, t])

  useAutoSave({ enabled: autoSaveEnabled && canWrite, dirty, save })

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
    let cancelled = false
    setError(null)
    setBoard(null)
    setDirty(false)
    void api
      .getKanbanBoard(boardId)
      .then((b) => {
        if (cancelled) return
        setBoard(b)
        setTitle(b.title)
        setSource(b.source)
        treeTitleRef.current = b.title
        treeCountRef.current = countCards(parseBoard(b.source))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [boardId])

  const parsed = parseBoard(source)

  useEffect(() => {
    onStateChange?.({
      board,
      title,
      source,
      dirty,
      saving,
      error,
      cardCount: countCards(parsed),
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      save,
      deleteBoard: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, title, source, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !board) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!board) {
    return <div className="canvas-message muted">{t('canvas.loadingKanban')}</div>
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

  return (
    <div className="kanban-canvas">
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
              placeholder={t('canvas.kanbanTitlePlaceholder')}
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>
              {t('common.kanban')} · {countCards(parsed)}
            </span>
            {statusLabel && <span className="muted sm">{statusLabel}</span>}
            {!canWrite && <span className="muted sm">{t('canvas.readOnly')}</span>}
          </div>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="kanban-canvas-body">
        {canWrite ? (
          <KanbanBoard
            source={source}
            onChange={(next) => {
              setSource(next)
              setDirty(true)
            }}
          />
        ) : (
          <KanbanView source={source} />
        )}
      </div>
    </div>
  )
}
