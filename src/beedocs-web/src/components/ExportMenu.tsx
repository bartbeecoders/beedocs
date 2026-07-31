import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { exportBookToPdf, exportPageToPdf } from '../export/pdf'
import type { ExportFormat } from '../types'

type Scope = 'book' | 'page'

type Props = {
  scope: Scope
  /** Book id or page id, matching `scope`. */
  id: string
  title?: string
  className?: string
  /** `icon` renders a compact square trigger for toolbars. */
  variant?: 'button' | 'icon'
}

type Choice = {
  /** 'pdf' is rendered in the browser; the rest are fetched from the API. */
  format: ExportFormat | 'pdf'
  label: string
  hint: string
}

const CHOICES: Choice[] = [
  { format: 'pdf', label: 'PDF', hint: 'Opens a print view — choose “Save as PDF”' },
  { format: 'markdown', label: 'Markdown', hint: 'Portable text, diagrams as fenced blocks' },
  { format: 'docx', label: 'Word (.docx)', hint: 'Formatted document with images and tables' },
  {
    format: 'archive',
    label: 'BeeDocs archive',
    hint: 'Lossless — re-importable, keeps diagrams and images',
  },
]

/**
 * Export a book or a single document. PDF goes through the browser print
 * pipeline (it is the only path that can rasterise Mermaid/BeeDiagram content);
 * every other format is built by the API and downloaded.
 */
export function ExportMenu({ scope, id, title, className = '', variant = 'button' }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = async (choice: Choice) => {
    setOpen(false)
    setBusy(choice.format)
    setError(null)
    setStatus('Preparing…')
    try {
      if (choice.format === 'pdf') {
        if (scope === 'book') await exportBookToPdf(id, setStatus)
        else await exportPageToPdf(id, setStatus)
        setStatus('Print dialog opened — choose “Save as PDF”.')
      } else {
        const fileName = await api.downloadExport(
          scope === 'book' ? 'books' : 'pages',
          id,
          choice.format,
        )
        setStatus(`Downloaded ${fileName}`)
      }
      setTimeout(() => setStatus(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(null)
    }
  }

  const label = scope === 'book' ? `Export “${title ?? 'book'}”` : `Export “${title ?? 'document'}”`

  return (
    <div className={`export-menu ${className}`} ref={wrapRef}>
      {variant === 'icon' ? (
        <button
          type="button"
          className="icon-btn sm"
          title={busy ? (status ?? 'Exporting…') : label}
          disabled={busy !== null}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {busy ? '…' : '⭳'}
        </button>
      ) : (
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy !== null}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {busy ? 'Exporting…' : 'Export ▾'}
        </button>
      )}

      {open && (
        <div className="export-menu-pop" role="menu">
          <div className="export-menu-heading">
            {scope === 'book' ? 'Export book' : 'Export document'}
          </div>
          {CHOICES.map((choice) => (
            <button
              key={choice.format}
              type="button"
              role="menuitem"
              className="export-menu-item"
              onClick={() => void run(choice)}
            >
              <span className="export-menu-label">{choice.label}</span>
              <span className="export-menu-hint">{choice.hint}</span>
            </button>
          ))}
        </div>
      )}

      {status && <span className="export-menu-status muted sm">{status}</span>}
      {error && (
        <span className="export-menu-error" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
