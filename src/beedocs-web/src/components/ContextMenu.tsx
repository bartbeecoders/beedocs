import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

/**
 * One row of a context menu. Menus are data rather than JSX so the caller can
 * decide what applies to the spot that was clicked, and this component owns
 * everything else: placement, submenus, keyboard and dismissal.
 */
export type MenuEntry =
  | {
      kind: 'item'
      label: string
      onSelect: () => void
      /** Shortcut or hint shown right-aligned. */
      hint?: string
      checked?: boolean
      disabled?: boolean
      danger?: boolean
    }
  | { kind: 'sub'; label: string; entries: MenuEntry[]; disabled?: boolean }
  | { kind: 'heading'; label: string }
  | { kind: 'sep' }

type Props = {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  /** Escape pressed — e.g. hand focus back to the field the menu was opened on. */
  onDismiss?: () => void
  /** Footer line under the entries (e.g. how to reach the browser's own menu). */
  footer?: string
  ariaLabel?: string
}

const ITEM_SELECTOR = ':scope > [role^="menuitem"]:not(:disabled), :scope > .ctx-sub > [role="menuitem"]:not(:disabled)'

function menuItems(menu: Element | null): HTMLElement[] {
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) : []
}

/**
 * Right-click menu at a viewport point, portaled to <body> so no transformed
 * or clipped ancestor can cut it off (the page editor also runs inside the
 * full-page overlay). ↑/↓ walk the items, → opens a submenu, ← or Esc backs
 * out, and a click anywhere else dismisses it.
 */
export function ContextMenu({ x, y, entries, onClose, onDismiss, footer, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the whole menu on screen: flip left/up when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = x
    let top = y
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width)
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - r.height)
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    menuItems(ref.current)[0]?.focus()
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [onClose])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null
    const menu = active?.closest('[role="menu"]') ?? ref.current
    const items = menuItems(menu)
    const at = active ? items.indexOf(active) : -1
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      onDismiss?.()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (e.key === 'ArrowRight' && active?.getAttribute('aria-haspopup') === 'menu') {
      e.preventDefault()
      active.click()
    } else if (e.key === 'ArrowLeft' && menu !== ref.current) {
      e.preventDefault()
      const trigger = menu?.parentElement?.querySelector<HTMLElement>(':scope > [aria-haspopup="menu"]')
      trigger?.dispatchEvent(new CustomEvent('ctx-close-sub'))
      trigger?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="tree-context-menu ctx-menu"
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 1200 }}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Entries entries={entries} onClose={onClose} />
      {footer && <div className="ctx-footer muted">{footer}</div>}
    </div>,
    document.body,
  )
}

function Entries({ entries, onClose }: { entries: MenuEntry[]; onClose: () => void }) {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === 'sep') return <div key={`sep-${i}`} className="tree-context-sep" role="separator" />
        if (entry.kind === 'heading')
          return (
            <div key={`h-${i}`} className="tree-context-heading" title={entry.label}>
              {entry.label}
            </div>
          )
        if (entry.kind === 'sub') return <SubMenu key={`sub-${entry.label}`} entry={entry} onClose={onClose} />
        return (
          <button
            key={`item-${entry.label}`}
            type="button"
            role={entry.checked != null ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={entry.checked}
            className={`tree-context-item ctx-item${entry.danger ? ' danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            <span className="ctx-check" aria-hidden="true">
              {entry.checked ? '✓' : ''}
            </span>
            <span className="ctx-label">{entry.label}</span>
            {entry.hint && <span className="ctx-hint muted">{entry.hint}</span>}
          </button>
        )
      })}
    </>
  )
}

function SubMenu({ entry, onClose }: { entry: Extract<MenuEntry, { kind: 'sub' }>; onClose: () => void }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const openedByKey = useRef(false)

  useEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const close = () => setOpen(false)
    trigger.addEventListener('ctx-close-sub', close)
    return () => trigger.removeEventListener('ctx-close-sub', close)
  }, [])

  // Open to the left when there is no room on the right.
  useLayoutEffect(() => {
    if (!open) return
    const r = wrapRef.current?.getBoundingClientRect()
    const w = listRef.current?.offsetWidth ?? 220
    setFlip(!!r && r.right + w > window.innerWidth - 8)
    if (openedByKey.current) menuItems(listRef.current)[0]?.focus()
    openedByKey.current = false
  }, [open])

  return (
    <div
      ref={wrapRef}
      className="ctx-sub"
      onMouseEnter={() => !entry.disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="tree-context-item ctx-item"
        disabled={entry.disabled}
        onClick={(e) => {
          // A click from the keyboard (Enter/→) focuses the first child.
          if (open) {
            if (e.detail === 0) menuItems(listRef.current)[0]?.focus()
            return
          }
          openedByKey.current = e.detail === 0
          setOpen(true)
        }}
      >
        <span className="ctx-check" aria-hidden="true" />
        <span className="ctx-label">{entry.label}</span>
        <span className="ctx-hint muted" aria-hidden="true">
          ▸
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          className={`tree-context-menu ctx-menu ctx-submenu${flip ? ' is-flipped' : ''}`}
          role="menu"
          aria-label={entry.label}
        >
          <Entries entries={entry.entries} onClose={onClose} />
        </div>
      )}
    </div>
  )
}
