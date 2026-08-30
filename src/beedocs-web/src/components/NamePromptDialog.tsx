import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useI18n } from '../i18n'

export type NamePromptSelect = {
  label: string
  options: Array<{ value: string; label: string }>
  defaultValue?: string
}

export type NamePromptDialogProps = {
  open: boolean
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  /** Optional secondary choice (e.g. a template) rendered under the name field. */
  select?: NamePromptSelect
  onSubmit: (value: string, selected?: string) => void | Promise<void>
  onClose: () => void
}

/**
 * In-app name prompt — replaces `window.prompt` for create/rename flows.
 */
export function NamePromptDialog({
  open,
  title,
  label,
  placeholder,
  defaultValue = '',
  confirmLabel,
  select,
  onSubmit,
  onClose,
}: NamePromptDialogProps) {
  const { t } = useI18n()
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)
  const [selected, setSelected] = useState(select?.defaultValue ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setSelected(select?.defaultValue ?? '')
    setBusy(false)
    setError(null)
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, defaultValue, select?.defaultValue])

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
      await onSubmit(trimmed, selected || undefined)
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
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label={t('common.close')}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{label ?? t('common.name')}</span>
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
          {select && (
            <label className="field">
              <span className="field-label">{select.label}</span>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                disabled={busy}
              >
                {select.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && <div className="banner error compact">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !value.trim()}>
            {busy ? t('dialogs.working') : (confirmLabel ?? t('common.create'))}
          </button>
        </footer>
      </form>
    </div>
  )
}
