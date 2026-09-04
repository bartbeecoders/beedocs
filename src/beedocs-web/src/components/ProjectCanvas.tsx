import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { ProjectPlan as ProjectPlanDto } from '../types'
import { countTasks, parsePlan } from '../project/projectModel'
import { ProjectEditor } from '../project/ProjectEditor'
import { ProjectView } from '../project/ProjectView'
import '../styles/project.css'

export type ProjectEditorState = {
  plan: ProjectPlanDto | null
  title: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  taskCount: number
  setTitle: (v: string) => void
  save: () => Promise<void>
  deletePlan: () => Promise<void>
}

type Props = {
  onStateChange?: (state: ProjectEditorState | null) => void
}

/**
 * Center-canvas host for a project-plan route: loads the plan, owns save/dirty
 * state, and renders the editor for writers or a read-only view for viewers.
 */
export function ProjectCanvas({ onStateChange }: Props) {
  const { bookId = '', planId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteProjectPlan: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const [plan, setPlan] = useState<ProjectPlanDto | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const dirtyRef = useRef(dirty)
  const planIdRef = useRef(planId)
  const savingRef = useRef(false)
  const treeTitleRef = useRef('')
  const treeCountRef = useRef(0)

  titleRef.current = title
  sourceRef.current = source
  dirtyRef.current = dirty
  planIdRef.current = planId

  useEffect(() => {
    const id = planId
    return () => {
      if (!dirtyRef.current) return
      void api
        .updateProjectPlan(id, { title: titleRef.current, source: sourceRef.current })
        .catch(() => {})
    }
  }, [planId])

  const save = useCallback(async () => {
    const id = planIdRef.current
    if (!id || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateProjectPlan(id, {
        title: titleRef.current,
        source: sourceRef.current,
      })
      setPlan(updated)
      setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      const tasks = countTasks(parsePlan(updated.source))
      if (treeTitleRef.current !== updated.title || treeCountRef.current !== tasks) {
        treeTitleRef.current = updated.title
        treeCountRef.current = tasks
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
    if (!confirm(t('canvas.deleteProjectConfirm'))) return
    await deleteFromTree(planId, bookId)
    void navigate(`/books/${bookId}`)
  }, [planId, bookId, deleteFromTree, navigate, t])

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
    setPlan(null)
    setDirty(false)
    void api
      .getProjectPlan(planId)
      .then((p) => {
        if (cancelled) return
        setPlan(p)
        setTitle(p.title)
        setSource(p.source)
        treeTitleRef.current = p.title
        treeCountRef.current = countTasks(parsePlan(p.source))
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [planId])

  const parsed = parsePlan(source)

  useEffect(() => {
    onStateChange?.({
      plan,
      title,
      source,
      dirty,
      saving,
      error,
      taskCount: countTasks(parsed),
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      save,
      deletePlan: remove,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, title, source, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !plan) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!plan) {
    return <div className="canvas-message muted">{t('canvas.loadingProject')}</div>
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
    <div className="project-canvas">
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
              placeholder={t('canvas.projectTitlePlaceholder')}
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>
              {t('common.project')} · {countTasks(parsed)}
            </span>
            {statusLabel && <span className="muted sm">{statusLabel}</span>}
            {!canWrite && <span className="muted sm">{t('canvas.readOnly')}</span>}
          </div>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="project-canvas-body">
        {canWrite ? (
          <ProjectEditor
            source={source}
            onChange={(next) => {
              setSource(next)
              setDirty(true)
            }}
          />
        ) : (
          <ProjectView source={source} />
        )}
      </div>
    </div>
  )
}
