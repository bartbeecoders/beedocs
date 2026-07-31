import { useEffect, useRef } from 'react'
import type { FocusEvent, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

/**
 * Text fields whose value round-trips through page state before it comes back.
 *
 * A plain controlled field drops keystrokes here: every character travels up
 * through the page editor, PageCanvas and the workspace shell before React
 * re-renders with it, and any commit that lands with the not-yet-updated value
 * rewrites the DOM node — throwing away whatever was typed in between. The page
 * title is the worst case, since it is mirrored in two panes and so is always a
 * render behind in one of them.
 *
 * These mount uncontrolled instead. While the field has focus the DOM owns the
 * text and nothing is written back over it; an incoming `value` is only pushed
 * in when the change came from somewhere else — another pane, loading a
 * different page, or an edit made in the raw source view.
 */

function useSyncedValue<T extends HTMLInputElement | HTMLTextAreaElement>(value: string) {
  const ref = useRef<T>(null)
  // Last value this field emitted, so echoes of our own typing are ignored.
  const local = useRef(value)
  // Newest prop seen, including ones the effect skipped while focused.
  const latest = useRef(value)
  latest.current = value

  const pull = (next: string) => {
    const el = ref.current
    if (!el || next === local.current) return
    local.current = next
    if (el.value !== next) el.value = next
  }

  useEffect(() => {
    // Never overwrite a field the user is typing into — the value arriving here
    // may still be catching up with what they have already entered.
    if (ref.current && document.activeElement === ref.current) return
    pull(value)
  }, [value])

  // Whatever was skipped while focused settles once the field is left.
  const onBlur = () => pull(latest.current)

  return { ref, local, onBlur }
}

type SyncedTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'defaultValue' | 'onChange'
> & {
  value: string
  onValueChange: (next: string) => void
}

export function SyncedTextarea({ value, onValueChange, onBlur, ...rest }: SyncedTextareaProps) {
  const synced = useSyncedValue<HTMLTextAreaElement>(value)
  return (
    <textarea
      {...rest}
      ref={synced.ref}
      defaultValue={value}
      onChange={(e) => {
        synced.local.current = e.target.value
        onValueChange(e.target.value)
      }}
      onBlur={(e: FocusEvent<HTMLTextAreaElement>) => {
        synced.onBlur()
        onBlur?.(e)
      }}
    />
  )
}

type SyncedInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange'
> & {
  value: string
  onValueChange: (next: string) => void
}

export function SyncedInput({ value, onValueChange, onBlur, ...rest }: SyncedInputProps) {
  const synced = useSyncedValue<HTMLInputElement>(value)
  return (
    <input
      {...rest}
      ref={synced.ref}
      defaultValue={value}
      onChange={(e) => {
        synced.local.current = e.target.value
        onValueChange(e.target.value)
      }}
      onBlur={(e: FocusEvent<HTMLInputElement>) => {
        synced.onBlur()
        onBlur?.(e)
      }}
    />
  )
}
