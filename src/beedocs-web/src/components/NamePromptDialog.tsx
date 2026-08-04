import { useEffect, useId, useRef, useState, type FormEvent } from 'react'

export type NamePromptDialogProps = {
  open: boolean
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  onSubmit: (value: string) => void | Promise<void>
  onClose: () => void
}

/**
 * In-app name prompt — replaces `window.prompt` for create/rename flows.
 */
export function NamePromptDialog({
  open,
  title,
  label = 'Name',
  placeholder,
  defaultValue = '',
  confirmLabel = 'Create',
  onSubmit,
  onClose,
}: NamePromptDialogProps) {
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setBusy(false)
    setError(null)
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open, defaultValue])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  if (!open) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
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
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              maxLength={200}
              required
              disabled={busy}
              autoComplete="off"
            />
          </label>
          {error && <div className="banner error compact">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  )
}
