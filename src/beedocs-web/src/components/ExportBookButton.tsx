import { useState } from 'react'
import { exportBookToPdf } from '../export/pdf'
import { useI18n } from '../i18n'
import { showToast } from '../toast'

type Props = {
  bookId: string
  bookTitle?: string
  className?: string
  /** compact icon-style button */
  variant?: 'button' | 'icon'
}

export function ExportBookButton({ bookId, bookTitle, className = '', variant = 'button' }: Props) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setStatus(t('dialogs.preparing'))
    try {
      await exportBookToPdf(bookId, (msg) => setStatus(msg))
      setStatus(t('dialogs.printOpened'))
      showToast(t('dialogs.printOpened'), 'ok')
      setTimeout(() => setStatus(null), 5000)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      setStatus(null)
      showToast(message, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'icon') {
    return (
      <span className={`export-book-wrap ${className}`}>
        <button
          type="button"
          className="icon-btn sm"
          title={
            busy
              ? status || t('dialogs.exporting')
              : t('dialogs.exportAsPdf', { title: bookTitle ?? t('dialogs.bookFallback') })
          }
          aria-label={
            busy
              ? status || t('dialogs.exporting')
              : t('dialogs.exportAsPdf', { title: bookTitle ?? t('dialogs.bookFallback') })
          }
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? '…' : 'PDF'}
        </button>
        {error && <span className="export-book-error" title={error}>!</span>}
      </span>
    )
  }

  return (
    <div className={`export-book ${className}`}>
      <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>
        {busy ? t('dialogs.exporting') : t('dialogs.exportPdf')}
      </button>
      {status && <p className="muted sm export-book-status">{status}</p>}
      {error && <div className="banner error compact">{error}</div>}
    </div>
  )
}
