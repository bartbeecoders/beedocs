import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { exportBookToPdf, exportPageToPdf } from '../export/pdf'
import { useI18n, type MessageKey } from '../i18n'
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

/** 'pdf' is rendered in the browser; the rest are fetched from the API. */
type Choice = ExportFormat | 'pdf'

type MenuPos = { top: number; left: number }

/** Labels and hints come from `dialogs.exportFormat.*` / `dialogs.exportHint.*`. */
const CHOICES: Choice[] = ['pdf', 'markdown', 'docx', 'archive']

/**
 * Export a book or a single document. PDF goes through the browser print
 * pipeline (it is the only path that can rasterise Mermaid/BeeDiagram content);
 * every other format is built by the API and downloaded.
 *
 * The menu is portaled to document.body with fixed positioning so it is not
 * clipped by the workspace toolbar (`overflow-y: hidden` + fixed height).
 */
export function ExportMenu({ scope, id, title, className = '', variant = 'button' }: Props) {
  const { t } = useI18n()
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
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return
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
    setBusy(choice)
    setError(null)
    setStatus(t('dialogs.preparing'))
    try {
      if (choice === 'pdf') {
        if (scope === 'book') await exportBookToPdf(id, setStatus)
        else await exportPageToPdf(id, setStatus)
        setStatus(t('dialogs.printOpened'))
      } else {
        const fileName = await api.downloadExport(
          scope === 'book' ? 'books' : 'pages',
          id,
          choice,
        )
        setStatus(t('dialogs.downloaded', { name: fileName }))
      }
      setTimeout(() => setStatus(null), 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(null)
    }
  }

  const label = t('dialogs.exportTitle', {
    title: title ?? (scope === 'book' ? t('dialogs.bookFallback') : t('dialogs.documentFallback')),
  })

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
              {scope === 'book' ? t('dialogs.exportBook') : t('dialogs.exportDocument')}
            </div>
            {CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="menuitem"
                className="export-menu-item"
                onClick={() => void run(choice)}
              >
                <span className="export-menu-label">
                  {t(`dialogs.exportFormat.${choice}` as MessageKey)}
                </span>
                <span className="export-menu-hint">
                  {t(`dialogs.exportHint.${choice}` as MessageKey)}
                </span>
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
          title={busy ? (status ?? t('dialogs.exporting')) : label}
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
          {busy ? t('dialogs.exporting') : `${t('dialogs.export')} ▾`}
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
