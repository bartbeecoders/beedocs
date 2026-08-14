import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAutoSave } from '../hooks/useAutoSave'
import { useTheme } from '../theme'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { SlideDeck } from '../types'
import { parseDeck } from '../slides/slideModel'
import { SlideEditor } from '../slides/SlideEditor'
import { SlidePresenter } from '../slides/SlidePresenter'
import { SlideScaled } from '../slides/SlideView'
import { NamePromptDialog } from './NamePromptDialog'
import '../styles/slides.css'

export type SlideEditorState = {
  deck: SlideDeck | null
  title: string
  source: string
  dirty: boolean
  saving: boolean
  error: string | null
  slideCount: number
  setTitle: (v: string) => void
  save: () => Promise<void>
  deleteDeck: () => Promise<void>
  /** Open presentation mode on the first slide. */
  present: () => void
}

type Props = {
  onStateChange?: (state: SlideEditorState | null) => void
}

/**
 * Center-canvas host for a slide deck route: loads the deck, owns save/dirty
 * state, and renders the designer for editors or a scrollable preview for
 * read-only accounts. Presenting works for both — a viewer role is exactly who
 * a finished deck is presented to.
 */
export function SlideCanvas({ onStateChange }: Props) {
  const { bookId = '', deckId = '' } = useParams()
  const navigate = useNavigate()
  const { renameInTree, deleteSlideDeck: deleteFromTree } = useWorkspace()
  const { autoSaveEnabled } = useTheme()
  const { canWrite } = useAuth()
  const [deck, setDeck] = useState<SlideDeck | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [presentFrom, setPresentFrom] = useState<number | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [templatePromptOpen, setTemplatePromptOpen] = useState(false)

  const titleRef = useRef(title)
  const sourceRef = useRef(source)
  const dirtyRef = useRef(dirty)
  const deckIdRef = useRef(deckId)
  const savingRef = useRef(false)
  /** Title the library tree is currently showing, so a save only refreshes it when it moved. */
  const treeTitleRef = useRef('')
  /** Same idea for the tree's slide-count badge — changes on add/remove, not per keystroke. */
  const treeCountRef = useRef(0)

  titleRef.current = title
  sourceRef.current = source
  dirtyRef.current = dirty
  deckIdRef.current = deckId

  // Flush unsaved edits when navigating to another deck.
  useEffect(() => {
    const id = deckId
    return () => {
      if (!dirtyRef.current) return
      void api
        .updateSlideDeck(id, { title: titleRef.current, source: sourceRef.current })
        .catch(() => {
          /* best-effort flush */
        })
    }
  }, [deckId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setError(null)
      setDeck(null)
      setDirty(false)
      setSavedAt(null)
      setPresentFrom(null)
      try {
        const d = await api.getSlideDeck(deckId)
        if (cancelled) return
        setDeck(d)
        setTitle(d.title)
        setSource(d.source)
        treeTitleRef.current = d.title
        treeCountRef.current = parseDeck(d.source).slides.length
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [deckId])

  const save = useCallback(async () => {
    const id = deckIdRef.current
    if (!id || savingRef.current) return

    const payload = { title: titleRef.current, source: sourceRef.current }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateSlideDeck(id, payload)
      if (deckIdRef.current !== id) return
      setDeck(updated)
      setSavedAt(new Date().toLocaleTimeString())
      if (titleRef.current === payload.title && sourceRef.current === payload.source) {
        setDirty(false)
      }
      // The tree shows the title and the slide-count badge, so a full refresh is
      // worth it only when one of those actually moved — same reasoning as
      // PageCanvas. Counts change on add/remove slide, never per keystroke.
      const savedCount = parseDeck(updated.source).slides.length
      if (updated.title !== treeTitleRef.current || savedCount !== treeCountRef.current) {
        treeTitleRef.current = updated.title
        treeCountRef.current = savedCount
        await renameInTree()
      }
    } catch (err) {
      if (deckIdRef.current === id) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      savingRef.current = false
      if (deckIdRef.current === id) setSaving(false)
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

  const remove = useCallback(async () => {
    if (!confirm('Delete this slide deck?')) return
    await deleteFromTree(deckIdRef.current, bookId)
    void navigate(`/books/${bookId}`)
  }, [deleteFromTree, bookId, navigate])

  /**
   * Both menu items download the same server-rendered .pptx — Google Slides
   * imports it natively — so "Google Slides" also opens the import surface.
   * Unsaved edits are flushed first: the server renders the stored document.
   */
  const exportPptx = useCallback(
    async (target: 'powerpoint' | 'google') => {
      setExportOpen(false)
      if (dirtyRef.current && canWrite) await save()
      const a = document.createElement('a')
      a.href = api.slideDeckPptxUrl(deckIdRef.current)
      a.download = ''
      a.click()
      if (target === 'google') {
        window.open('https://docs.google.com/presentation/u/0/', '_blank', 'noopener')
      }
    },
    [canWrite, save],
  )

  const parsed = parseDeck(source)

  useEffect(() => {
    onStateChange?.({
      deck,
      title,
      source,
      dirty,
      saving,
      error,
      slideCount: parsed.slides.length,
      setTitle: (v) => {
        setTitle(v)
        setDirty(true)
      },
      save,
      deleteDeck: remove,
      present: () => setPresentFrom(0),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, title, source, dirty, saving, error, save, remove])

  useEffect(() => {
    return () => onStateChange?.(null)
  }, [onStateChange])

  if (error && !deck) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!deck) {
    return <div className="canvas-message muted">Loading slides…</div>
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
    <div className="slide-canvas">
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
              placeholder="Presentation title"
            />
          ) : (
            <span className="canvas-title">{title}</span>
          )}
          <div className="canvas-meta">
            <span>
              {parsed.slides.length} slide{parsed.slides.length === 1 ? '' : 's'}
            </span>
            {statusLabel && (
              <span className={dirty && !saving ? 'dirty-dot' : undefined}>· {statusLabel}</span>
            )}
            {autoSaveEnabled && canWrite && (
              <span className="muted save-hint" title="Ctrl/Cmd+S to save immediately">
                · auto-save on
              </span>
            )}
          </div>
        </div>
        <div className="toolbar-group">
          {canWrite && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setTemplatePromptOpen(true)}
              title="Save this deck's slides as a reusable layout for new decks"
            >
              Save as template
            </button>
          )}
          <div className="slide-shape-menu">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setExportOpen((v) => !v)}
              aria-expanded={exportOpen}
            >
              Export ▾
            </button>
            {exportOpen && (
              <div
                className="slide-shape-popover slide-export-popover"
                onMouseLeave={() => setExportOpen(false)}
              >
                <button
                  type="button"
                  className="slide-shape-item"
                  onClick={() => void exportPptx('powerpoint')}
                  title="Download as a PowerPoint file"
                >
                  PowerPoint (.pptx)
                </button>
                <button
                  type="button"
                  className="slide-shape-item"
                  onClick={() => void exportPptx('google')}
                  title="Downloads the .pptx and opens Google Slides — import it there via File → Open → Upload"
                >
                  Google Slides
                </button>
              </div>
            )}
          </div>
          {!canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                onClick={() => setPresentFrom(0)}
              >
                ▶ Present
              </button>
              <span className="ws-theme-pill" title="Your account has read-only access">
                Read-only
              </span>
            </>
          )}
          {canWrite && (
            <button
              type="button"
              className="btn primary sm"
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}

      {canWrite ? (
        // Keyed by deck id: the editor owns the document after mount, so moving
        // to another deck must remount it rather than leak the previous slides.
        <SlideEditor
          key={deck.id}
          initialSource={deck.source}
          onChange={(s) => {
            setSource(s)
            setDirty(true)
          }}
          onPresent={(index) => setPresentFrom(index)}
        />
      ) : (
        <div className="slide-readonly">
          {parsed.slides.map((s, i) => (
            <div key={s.id} className="slide-readonly-item">
              <span className="muted sm">{i + 1}</span>
              <SlideScaled deck={parsed} slide={s} width={760} className="slide-readonly-frame" />
            </div>
          ))}
        </div>
      )}

      {presentFrom != null && (
        <SlidePresenter
          deck={parsed}
          initialIndex={presentFrom}
          onClose={() => setPresentFrom(null)}
        />
      )}

      <NamePromptDialog
        open={templatePromptOpen}
        title="Save as template"
        label="Template name"
        placeholder="e.g. Company pitch layout"
        defaultValue={title}
        confirmLabel="Save template"
        onSubmit={async (name) => {
          await api.createSlideTemplate({ name, source: sourceRef.current })
        }}
        onClose={() => setTemplatePromptOpen(false)}
      />
    </div>
  )
}
