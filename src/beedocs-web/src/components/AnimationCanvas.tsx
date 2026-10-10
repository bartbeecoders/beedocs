import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { Animation } from '../types'
import { countScenes, parseAnimation } from '../animation/animModel'
import { AnimationEditor } from '../animation/AnimationEditor'
import { AnimationView } from '../animation/AnimationView'
import '../styles/animation.css'

export type AnimationEditorState = {
  animation: Animation | null
  title: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  sceneCount: number
  setTitle: (v: string) => void
  save: () => Promise<void>
  deleteAnimation: () => Promise<void>
}

type Props = {
  onStateChange?: (state: AnimationEditorState | null) => void
}

/**
 * Center-canvas host for an animation route: loads the animation, owns save/dirty
 * state, and renders the editor for writers or the read-only player for viewers.
 */
export function AnimationCanvas({ onStateChange }: Props) {
  const { bookId = '', animationId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteAnimation: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [animation, setAnimation] = useState<Animation | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const dirtyRef = useRef(dirty)
  const animationIdRef = useRef(animationId)
  const savingRef = useRef(false)
  const treeTitleRef = useRef('')
  const treeCountRef = useRef(0)

  titleRef.current = title
  sourceRef.current = source
  dirtyRef.current = dirty
  animationIdRef.current = animationId

  useEffect(() => {
    const id = animationId
    return () => {
      if (!dirtyRef.current) return
      void api
        .updateAnimation(id, { title: titleRef.current, source: sourceRef.current })
        .catch(() => {})
    }
  }, [animationId])

  const save = useCallback(async () => {
    const id = animationIdRef.current
    if (!id || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateAnimation(id, {
        title: titleRef.current,
        source: sourceRef.current,
      })
      setAnimation(updated)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      const scenes = countScenes(parseAnimation(updated.source))
      if (treeTitleRef.current !== updated.title || treeCountRef.current !== scenes) {
        treeTitleRef.current = updated.title
        treeCountRef.current = scenes
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
    if (!confirm(t('canvas.deleteAnimationConfirm'))) return
    await deleteFromTree(animationId, bookId)
    void navigate(`/books/${bookId}`)
  }, [animationId, bookId, deleteFromTree, navigate, t])

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
    setAnimation(null)
    setDirty(false)
    void api
      .getAnimation(animationId)
      .then((a) => {
        if (cancelled) return
        setAnimation(a)
        setTitle(a.title)
        setSource(a.source)
        treeTitleRef.current = a.title
        treeCountRef.current = countScenes(parseAnimation(a.source))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [animationId])

  const parsed = parseAnimation(source)

  useEffect(() => {
    onStateChange?.({
      animation,
      title,
      source,
      dirty,
      saving,
      error,
      sceneCount: countScenes(parsed),
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      save,
      deleteAnimation: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animation, title, source, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !animation) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!animation) {
    return <div className="canvas-message muted">{t('canvas.loadingAnimation')}</div>
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
    <div className="animation-canvas">
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
              placeholder={t('canvas.animationTitlePlaceholder')}
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>
              {t('common.animation')} · {countScenes(parsed)}
            </span>
            {statusLabel && <span className="muted sm">{statusLabel}</span>}
            {!canWrite && <span className="muted sm">{t('canvas.readOnly')}</span>}
          </div>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="animation-canvas-body">
        {canWrite ? (
          <AnimationEditor
            source={source}
            title={title}
            onChange={(next) => {
              setSource(next)
              setDirty(true)
            }}
          />
        ) : (
          <AnimationView source={source} title={title} />
        )}
      </div>
    </div>
  )
}
