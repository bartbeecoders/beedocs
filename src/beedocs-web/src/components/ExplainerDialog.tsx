import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { countScenes, parseAnimation } from '../animation/animModel'
import type { PageEditorState } from './PageCanvas'
import '../styles/explainer.css'

type Props = {
  bookId: string
  pageId: string
  pageTitle: string
  /**
   * The page's live editor when it is the open canvas. Embedding then goes
   * through the editor, so an unsaved draft is extended rather than
   * overwritten by a server-side write it would later clobber on auto-save.
   */
  pageState?: PageEditorState | null
  /**
   * False when the page is open in an editor this dialog cannot reach (the
   * tree's menu): a server-side append would be overwritten by its next save.
   */
  embedAvailable?: boolean
  onClose: () => void
}

/** Scene-count choices; 0 lets the model decide from the page's length. */
const SCENE_CHOICES = [0, 3, 4, 5, 6, 7, 8]

/**
 * "Explain as animation…": the default LLM provider storyboards a page into an
 * animation (scenes, narration, animated shapes) filed in the same book. The
 * page itself is never changed unless "Embed in the page" is ticked, which
 * appends an ```animation-ref fence at the end.
 */
export function ExplainerDialog({
  bookId,
  pageId,
  pageTitle,
  pageState,
  embedAvailable = true,
  onClose,
}: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { addAnimationToTree } = useWorkspace()
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(() => t('explainer.defaultTitle', { title: pageTitle }))
  const [sceneCount, setSceneCount] = useState(0)
  const [instructions, setInstructions] = useState('')
  const [embed, setEmbed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const appendEmbed = async (animationId: string) => {
    const fence = `\n\n\`\`\`animation-ref\n${animationId}\n\`\`\`\n`
    if (pageState?.page?.id === pageId) {
      pageState.setContent(pageState.content.replace(/\s*$/, '') + fence)
      await pageState.save()
      return
    }
    const page = await api.getPage(pageId)
    await api.updatePage(pageId, { title: page.title, content: page.content.replace(/\s*$/, '') + fence })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const anim = await api.createAnimationFromPage(bookId, {
        pageId,
        title: title.trim() || undefined,
        sceneCount: sceneCount || undefined,
        instructions: instructions.trim() || undefined,
      })
      addAnimationToTree({
        id: anim.id,
        bookId: anim.bookId,
        title: anim.title,
        sceneCount: countScenes(parseAnimation(anim.source)),
        ownerId: anim.ownerId,
        isPrivate: anim.isPrivate,
        updatedAt: anim.updatedAt,
      })
      if (embed && embedAvailable) {
        try {
          await appendEmbed(anim.id)
        } catch (err) {
          // The animation exists either way; say why the page did not change.
          setError(t('explainer.embedFailed', { error: err instanceof Error ? err.message : String(err) }))
          setBusy(false)
          return
        }
      }
      onClose()
      void navigate(`/books/${anim.bookId}/animations/${anim.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="modal explainer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id={titleId}>🎬 {t('explainer.title')}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>
        <div className="modal-body explainer-body">
          <p className="muted sm explainer-intro">{t('explainer.intro', { title: pageTitle })}</p>
          <label className="field">
            <span className="field-label">{t('explainer.nameLabel')}</span>
            <input
              ref={inputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              disabled={busy}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">{t('explainer.scenesLabel')}</span>
            <select
              value={sceneCount}
              onChange={(e) => setSceneCount(Number(e.target.value))}
              disabled={busy}
            >
              {SCENE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t('explainer.scenesAuto') : t('explainer.scenesN', { count: n })}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{t('explainer.instructionsLabel')}</span>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t('explainer.instructionsPlaceholder')}
              rows={3}
              maxLength={2000}
              disabled={busy}
            />
          </label>
          {embedAvailable && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={embed}
                onChange={(e) => setEmbed(e.target.checked)}
                disabled={busy}
              />
              <span>
                {t('explainer.embedLabel')}
                <span className="muted sm explainer-check-hint">{t('explainer.embedHint')}</span>
              </span>
            </label>
          )}
          {busy && (
            <div className="explainer-progress" role="status" aria-live="polite">
              <span className="explainer-spinner" aria-hidden />
              <span>
                {t('explainer.working')}
                <span className="muted sm explainer-elapsed">{t('explainer.elapsed', { seconds: elapsed })}</span>
              </span>
            </div>
          )}
          {error && <div className="banner error compact">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? t('explainer.generating') : t('explainer.generate')}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
