import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { downloadFframesProject, downloadFramePng, downloadVideo, pickVideoFormat } from './animExport'

type Props = {
  source: string
  title: string
  /** Playhead, for "Save this frame". */
  time: number
}

/** Video / frame / fframes-project downloads. Exporting is not a write, so viewers get it too. */
export function AnimationExportMenu({ source, title, time }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const format = pickVideoFormat()

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [open])

  useEffect(() => () => abortRef.current?.abort(), [])

  const exportVideo = async () => {
    setOpen(false)
    setError(null)
    const ac = new AbortController()
    abortRef.current = ac
    setProgress(0)
    try {
      await downloadVideo(source, title, { signal: ac.signal, onProgress: setProgress })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : String(e))
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  const run = async (fn: () => Promise<void>) => {
    setOpen(false)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (progress !== null) {
    return (
      <span className="anim-export-progress" onClick={(e) => e.stopPropagation()}>
        <span className="anim-export-bar">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
        <span className="sm muted">{t('animation.recording', { pct: Math.round(progress * 100) })}</span>
        <button type="button" className="anim-ctl" onClick={() => abortRef.current?.abort()}>
          {t('animation.cancel')}
        </button>
      </span>
    )
  }

  return (
    <div className="anim-export" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="anim-ctl"
        onClick={() => setOpen((v) => !v)}
        title={t('animation.export')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⤓
      </button>
      {open ? (
        <div className="anim-menu" role="menu">
          <button type="button" role="menuitem" disabled={!format} onClick={() => void exportVideo()}>
            <strong>{t('animation.exportVideo', { ext: format?.ext.toUpperCase() ?? 'WebM' })}</strong>
            <span className="muted sm">{format ? t('animation.exportVideoHint') : t('animation.exportVideoUnsupported')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void run(() => downloadFramePng(source, time, title))}>
            <strong>{t('animation.exportFrame')}</strong>
            <span className="muted sm">{t('animation.exportFrameHint')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => void run(() => downloadFframesProject(source, title))}>
            <strong>{t('animation.exportFframes')}</strong>
            <span className="muted sm">{t('animation.exportFframesHint')}</span>
          </button>
        </div>
      ) : null}
      {error ? (
        <span className="anim-export-error sm" role="alert" onClick={() => setError(null)}>
          {error}
        </span>
      ) : null}
    </div>
  )
}
