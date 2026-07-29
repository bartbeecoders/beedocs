import { useState } from 'react'
import { exportBookToPdf } from '../export/pdf'

type Props = {
  bookId: string
  bookTitle?: string
  className?: string
  /** compact icon-style button */
  variant?: 'button' | 'icon'
}

export function ExportBookButton({ bookId, bookTitle, className = '', variant = 'button' }: Props) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setStatus('Preparing…')
    try {
      await exportBookToPdf(bookId, (msg) => setStatus(msg))
      setStatus('Print dialog opened — choose “Save as PDF”.')
      setTimeout(() => setStatus(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
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
          title={busy ? status || 'Exporting…' : `Export “${bookTitle ?? 'book'}” as PDF`}
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
        {busy ? 'Exporting…' : 'Export PDF'}
      </button>
      {status && <p className="muted sm export-book-status">{status}</p>}
      {error && <div className="banner error compact">{error}</div>}
    </div>
  )
}
