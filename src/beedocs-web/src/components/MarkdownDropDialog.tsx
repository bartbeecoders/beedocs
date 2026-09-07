import { useEffect, useId, useState, type FormEvent } from 'react'
import { useI18n } from '../i18n'

export type MarkdownDropAction = 'page' | 'file'

type BookOption = { id: string; title: string }

type Props = {
  files: File[]
  books: BookOption[]
  defaultBookId: string
  onConfirm: (action: MarkdownDropAction, bookId: string) => void | Promise<void>
  onClose: () => void
}

/**
 * Choice shown when Markdown is dropped on the library: attach it as a file,
 * or turn it into an editable page. The book is always asked for, even when
 * the drop already named one — the user may want it elsewhere.
 */
export function MarkdownDropDialog({ files, books, defaultBookId, onConfirm, onClose }: Props) {
  const { t } = useI18n()
  const titleId = useId()
  const [action, setAction] = useState<MarkdownDropAction>('page')
  const [bookId, setBookId] = useState(defaultBookId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setAction('page')
    setBookId(defaultBookId)
    setBusy(false)
    setError(null)
  }, [files, defaultBookId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const names = files.map((f) => f.name)
  const lead =
    files.length === 1
      ? t('dialogs.mdDropLead', { name: names[0] ?? '' })
      : t('dialogs.mdDropLeadMany', { count: files.length })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !bookId) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(action, bookId)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <form
        className="modal modal--compact"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id={titleId}>{t('dialogs.mdDropTitle')}</h2>
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
        <div className="modal-body">
          <p>{lead}</p>
          <fieldset className="field md-drop-actions">
            <legend className="field-label">{t('dialogs.mdDropChoice')}</legend>
            <label className="radio md-drop-option">
              <input
                type="radio"
                name="md-drop-action"
                checked={action === 'page'}
                onChange={() => setAction('page')}
                disabled={busy}
              />
              <span>
                <strong>{t('dialogs.mdDropAsPage')}</strong>
                <span className="muted sm">{t('dialogs.mdDropAsPageHint')}</span>
              </span>
            </label>
            <label className="radio md-drop-option">
              <input
                type="radio"
                name="md-drop-action"
                checked={action === 'file'}
                onChange={() => setAction('file')}
                disabled={busy}
              />
              <span>
                <strong>{t('dialogs.mdDropAsFile')}</strong>
                <span className="muted sm">{t('dialogs.mdDropAsFileHint')}</span>
              </span>
            </label>
          </fieldset>
          <label className="field">
            <span className="field-label">{t('dialogs.mdDropBook')}</span>
            <select
              value={bookId}
              onChange={(e) => setBookId(e.target.value)}
              disabled={busy || books.length === 0}
              required
            >
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="banner error compact">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !bookId}>
            {busy ? t('dialogs.working') : t('dialogs.mdDropConfirm')}
          </button>
        </footer>
      </form>
    </div>
  )
}
