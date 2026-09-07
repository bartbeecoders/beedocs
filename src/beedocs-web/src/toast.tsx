import { useEffect, useState } from 'react'

export type ToastTone = 'ok' | 'error' | 'info'

type Toast = {
  id: number
  message: string
  tone: ToastTone
}

type Listener = (toasts: Toast[]) => void

let seq = 0
let toasts: Toast[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener(toasts)
}

/**
 * Lightweight app-wide toasts. There is no provider: call {@link showToast}
 * from anywhere and mount {@link ToastHost} once near the router.
 */
export function showToast(message: string, tone: ToastTone = 'info', ms = 5000) {
  const id = ++seq
  toasts = [...toasts, { id, message, tone }]
  emit()
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  }, ms)
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>(toasts)

  useEffect(() => {
    listeners.add(setItems)
    return () => {
      listeners.delete(setItems)
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div className="toast-host" aria-live="polite" aria-relevant="additions">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
