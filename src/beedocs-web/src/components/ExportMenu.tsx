import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

type MenuPos = { top: number; left: number }

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
 *
 * The menu is portaled to document.body with fixed positioning so it is not
 * clipped by the workspace toolbar (`overflow-y: hidden` + fixed height).
 */
export function ExportMenu({ scope, id, title, className = '', variant = 'button' }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const updateMenuPos = () => {
    const btn = triggerRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const menuWidth = 260
    // Prefer right-aligning to the trigger; clamp so the menu stays on-screen.
    const left = Math.min(
      Math.max(8, rect.right - menuWidth),
      window.innerWidth - menuWidth - 8,
    )
    const top = Math.min(rect.bottom + 6, window.innerHeight - 8)
    setMenuPos({ top, left })
  }

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    updateMenuPos()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onReposition = () => updateMenuPos()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    // Capture scroll from any scrollable ancestor (toolbar overflow-x, panes, …)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
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

  const menu =
    open && menuPos
      ? createPortal(
          <div
            ref={popRef}
            className="export-menu-pop export-menu-pop--portal"
            role="menu"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
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
          </div>,
          document.body,
        )
      : null

  return (
    <div className={`export-menu ${className}`} ref={wrapRef}>
      {variant === 'icon' ? (
        <button
          ref={triggerRef}
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
          ref={triggerRef}
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

      {menu}

      {status && <span className="export-menu-status muted sm">{status}</span>}
      {error && (
        <span className="export-menu-error" title={error}>
          {error}
        </span>
      )}
    </div>
  )
}
