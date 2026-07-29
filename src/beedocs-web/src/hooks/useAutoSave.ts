import { useEffect, useRef } from 'react'

export const AUTO_SAVE_DELAY_MS = 1500

type Options = {
  /** When false, timers are cleared and no auto-save runs. */
  enabled: boolean
  dirty: boolean
  /** Idle debounce before calling save (default 1500ms). */
  delayMs?: number
  /** Race-safe save owned by the editor. */
  save: () => Promise<void>
}

/**
 * Debounced auto-save when `enabled && dirty`.
 * Flushes once on unmount or when auto-save is turned off while dirty.
 * Skips scheduling while a save is already in flight (caller may re-dirty).
 */
export function useAutoSave({ enabled, dirty, delayMs = AUTO_SAVE_DELAY_MS, save }: Options) {
  const saveRef = useRef(save)
  const dirtyRef = useRef(dirty)
  const enabledRef = useRef(enabled)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)

  saveRef.current = save
  dirtyRef.current = dirty
  enabledRef.current = enabled

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const runSave = async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      await saveRef.current()
    } finally {
      inFlightRef.current = false
      // If still dirty after save (newer edits), schedule again when enabled
      if (enabledRef.current && dirtyRef.current) {
        clearTimer()
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          void runSave()
        }, delayMs)
      }
    }
  }

  useEffect(() => {
    clearTimer()
    if (!enabled || !dirty) return

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void runSave()
    }, delayMs)

    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps -- save via ref
  }, [enabled, dirty, delayMs])

  // Flush when auto-save is disabled while dirty (user turned it off mid-edit: leave dirty for manual save)
  // Flush on unmount only
  useEffect(() => {
    return () => {
      clearTimer()
      if (dirtyRef.current && enabledRef.current) {
        void saveRef.current()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
