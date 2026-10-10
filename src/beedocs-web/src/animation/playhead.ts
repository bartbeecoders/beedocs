import { useCallback, useEffect, useRef, useState } from 'react'
import { totalDuration, type AnimDoc } from './animModel'

export function formatTime(t: number): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}

/** Drives a global playhead over a document with requestAnimationFrame. */
export function usePlayhead(doc: AnimDoc, opts: { loop?: boolean } = {}) {
  const total = totalDuration(doc)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timeRef = useRef(0)
  const totalRef = useRef(total)
  const loopRef = useRef(opts.loop ?? false)
  timeRef.current = time
  totalRef.current = total
  loopRef.current = opts.loop ?? false

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      let next = timeRef.current + dt
      if (next >= totalRef.current) {
        if (loopRef.current) next = 0
        else {
          next = totalRef.current
          setPlaying(false)
        }
      }
      timeRef.current = next
      setTime(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const seek = useCallback((t: number) => {
    const v = Math.min(Math.max(0, t), totalRef.current)
    timeRef.current = v
    setTime(v)
  }, [])

  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && timeRef.current >= totalRef.current - 0.001) {
        timeRef.current = 0
        setTime(0)
      }
      return !p
    })
  }, [])

  // A shorter document (scene deleted) must not leave the playhead past its end.
  useEffect(() => {
    if (timeRef.current > total) seek(total)
  }, [total, seek])

  return { time, playing, total, seek, toggle, setPlaying }
}
