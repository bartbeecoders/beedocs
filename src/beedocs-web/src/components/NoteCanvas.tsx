import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Note as NoteDto } from '../types'
import { countBlocks, parseNote } from '../notes/noteModel'
import { NoteEditor } from '../notes/NoteEditor'
import { NoteView } from '../notes/NoteView'
import '../styles/notes.css'

export type NoteEditorState = {
  note: NoteDto | null
  title: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  blockCount: number
  setTitle: (v: string) => void
  save: () => Promise<void>
  deleteNote: () => Promise<void>
}

type Props = {
  onStateChange?: (state: NoteEditorState | null) => void
}

/**
 * Center-canvas host for a note route: loads the note, owns save/dirty state,
 * and renders the editor for writers or a read-only view for viewers.
 */
export function NoteCanvas({ onStateChange }: Props) {
  const { bookId = '', noteId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteNote: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [note, setNote] = useState<NoteDto | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const dirtyRef = useRef(dirty)
  const noteIdRef = useRef(noteId)
  const savingRef = useRef(false)
  const treeTitleRef = useRef('')
  const treeCountRef = useRef(0)

  titleRef.current = title
  sourceRef.current = source
  dirtyRef.current = dirty
  noteIdRef.current = noteId

  // Flush unsaved work when navigating away from the note.
  useEffect(() => {
    const id = noteId
    return () => {
      if (!dirtyRef.current) return
      void api.updateNote(id, { title: titleRef.current, source: sourceRef.current }).catch(() => {})
    }
  }, [noteId])

  const save = useCallback(async () => {
    const id = noteIdRef.current
    if (!id || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateNote(id, {
        title: titleRef.current,
        source: sourceRef.current,
      })
      setNote(updated)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      const blocks = countBlocks(parseNote(updated.source))
      if (treeTitleRef.current !== updated.title || treeCountRef.current !== blocks) {
        treeTitleRef.current = updated.title
        treeCountRef.current = blocks
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
    if (!confirm(t('canvas.deleteNoteConfirm'))) return
    await deleteFromTree(noteId, bookId)
    void navigate(`/books/${bookId}`)
  }, [noteId, bookId, deleteFromTree, navigate, t])

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
    setNote(null)
    setDirty(false)
    void api
      .getNote(noteId)
      .then((n) => {
        if (cancelled) return
        setNote(n)
        setTitle(n.title)
        setSource(n.source)
        treeTitleRef.current = n.title
        treeCountRef.current = countBlocks(parseNote(n.source))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [noteId])

  const blockCount = countBlocks(parseNote(source))

  useEffect(() => {
    onStateChange?.({
      note,
      title,
      source,
      dirty,
      saving,
      error,
      blockCount,
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      save,
      deleteNote: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, title, source, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !note) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!note) {
    return <div className="canvas-message muted">{t('canvas.loadingNote')}</div>
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
    <div className="note-canvas">
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
              placeholder={t('canvas.noteTitlePlaceholder')}
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>
              {t('common.note')} · {t(blockCount === 1 ? 'notes.blockCount.one' : 'notes.blockCount.other', { count: blockCount })}
            </span>
            {statusLabel && <span className="muted sm">{statusLabel}</span>}
            {!canWrite && <span className="muted sm">{t('canvas.readOnly')}</span>}
          </div>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="note-canvas-body">
        {canWrite ? (
          <NoteEditor
            source={source}
            onChange={(next) => {
              setSource(next)
              setDirty(true)
            }}
          />
        ) : (
          <NoteView source={source} />
        )}
      </div>
    </div>
  )
}
