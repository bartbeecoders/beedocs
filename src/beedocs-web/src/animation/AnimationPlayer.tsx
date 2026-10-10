import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import {
  parseAnimation,
  renderFrameSvg,
  sceneAt,
  scenePosterTime,
  sceneStart,
  totalDuration,
  type AnimDoc,
} from './animModel'
import { AnimationExportMenu } from './AnimationExportMenu'
import { formatTime, usePlayhead } from './playhead'
import '../styles/animation.css'

type Props = {
  source: string
  title?: string
  compact?: boolean
  /** Start playing when first scrolled into view (page embeds). */
  autoPlay?: boolean
}

/** The SVG frame for one instant — the fframes model: frame = f(t). */
export function AnimationFrame({
  doc,
  time,
  captions,
  className,
}: {
  doc: AnimDoc
  time: number
  captions?: boolean
  className?: string
}) {
  const prefix = `a${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const svg = useMemo(
    () => renderFrameSvg(doc, time, { idPrefix: prefix, captions, width: '100%', height: '100%' }),
    [doc, time, prefix, captions],
  )
  return (
    <div
      className={className ?? 'anim-frame'}
      style={{ aspectRatio: `${doc.width} / ${doc.height}` }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** Scrubber with scene boundaries; shared by the player and the editor. */
export function AnimationScrubber({
  doc,
  time,
  onSeek,
  onScrubStart,
}: {
  doc: AnimDoc
  time: number
  onSeek: (t: number) => void
  onScrubStart?: () => void
}) {
  const total = totalDuration(doc)
  const ref = useRef<HTMLDivElement>(null)
  const seekFromEvent = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    onSeek(((clientX - rect.left) / rect.width) * total)
  }
  return (
    <div
      ref={ref}
      className="anim-scrubber"
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={Math.round(total * 10) / 10}
      aria-valuenow={Math.round(time * 10) / 10}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        onScrubStart?.()
        seekFromEvent(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromEvent(e.clientX)
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onSeek(time - 1 / doc.fps)
        else if (e.key === 'ArrowRight') onSeek(time + 1 / doc.fps)
        else return
        e.preventDefault()
      }}
    >
      <div className="anim-scrubber-track">
        {doc.scenes.map((s, i) => (
          <span
            key={s.id}
            className="anim-scrubber-scene"
            style={{
              left: `${(sceneStart(doc, i) / total) * 100}%`,
              width: `${(s.duration / total) * 100}%`,
            }}
            title={s.title}
          />
        ))}
        <span className="anim-scrubber-fill" style={{ width: `${(time / Math.max(total, 0.001)) * 100}%` }} />
      </div>
      <span className="anim-scrubber-thumb" style={{ left: `${(time / Math.max(total, 0.001)) * 100}%` }} />
    </div>
  )
}

/**
 * Read-only player: what viewers, page previews and the reader site get.
 * Presenting is deliberately not a write affordance, so everyone can play and
 * export.
 */
export function AnimationPlayer({ source, title, compact = false, autoPlay = false }: Props) {
  const { t } = useI18n()
  const doc = useMemo(() => parseAnimation(source), [source])
  const [loop, setLoop] = useState(false)
  const [captions, setCaptions] = useState(doc.captions)
  const playhead = usePlayhead(doc, { loop })
  const { time, playing, total } = playhead
  // Until the first play or seek, show the opening scene settled rather than
  // the empty frame at t = 0 — a poster, like a video's thumbnail.
  const [started, setStarted] = useState(false)
  const toggle = () => {
    setStarted(true)
    playhead.toggle()
  }
  const seek = (t: number) => {
    setStarted(true)
    playhead.seek(t)
  }
  const { setPlaying } = playhead
  const rootRef = useRef<HTMLDivElement>(null)
  const { index } = sceneAt(doc, time)
  const scene = doc.scenes[index]

  useEffect(() => setCaptions(doc.captions), [doc.captions])

  useEffect(() => {
    if (!autoPlay || !rootRef.current || typeof IntersectionObserver === 'undefined') return
    let started = false
    const io = new IntersectionObserver((entries) => {
      if (!started && entries.some((e) => e.isIntersecting)) {
        started = true
        setStarted(true)
        setPlaying(true)
      }
    })
    io.observe(rootRef.current)
    return () => io.disconnect()
  }, [autoPlay, setPlaying])

  const fullscreen = () => {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  return (
    <div
      ref={rootRef}
      className={`anim-player${compact ? ' is-compact' : ''}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === ' ' || e.key === 'k') {
          e.preventDefault()
          toggle()
        } else if (e.key === 'ArrowRight' || e.key === 'l') {
          seek(time + (e.shiftKey ? 1 / doc.fps : 2))
        } else if (e.key === 'ArrowLeft' || e.key === 'j') {
          seek(time - (e.shiftKey ? 1 / doc.fps : 2))
        } else if (e.key === 'f') {
          fullscreen()
        }
      }}
    >
      {title && !compact ? <div className="anim-player-title muted sm">{title}</div> : null}
      <div className="anim-player-stage" onClick={toggle}>
        <AnimationFrame doc={doc} time={started ? time : scenePosterTime(doc, 0)} captions={captions && started} />
        {!started ? (
          <button
            type="button"
            className="anim-bigplay"
            aria-label={t('animation.play')}
            onClick={(e) => {
              e.stopPropagation()
              toggle()
            }}
          >
            ▶
          </button>
        ) : null}
      </div>
      <div className="anim-controls">
        <button
          type="button"
          className="anim-ctl"
          onClick={toggle}
          aria-label={playing ? t('animation.pause') : t('animation.play')}
          title={playing ? t('animation.pause') : t('animation.play')}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <AnimationScrubber doc={doc} time={time} onSeek={seek} />
        <span className="anim-time mono">
          {formatTime(time)} / {formatTime(total)}
        </span>
        {!compact && doc.scenes.length > 1 ? (
          <span className="anim-scene-label muted sm" title={scene?.title}>
            {index + 1}/{doc.scenes.length} · {scene?.title}
          </span>
        ) : null}
        <button
          type="button"
          className={`anim-ctl${loop ? ' is-on' : ''}`}
          onClick={() => setLoop((v) => !v)}
          title={t('animation.loop')}
          aria-pressed={loop}
        >
          ⟳
        </button>
        <button
          type="button"
          className={`anim-ctl${captions ? ' is-on' : ''}`}
          onClick={() => setCaptions((v) => !v)}
          title={t('animation.captions')}
          aria-pressed={captions}
        >
          CC
        </button>
        <AnimationExportMenu source={source} title={title ?? 'animation'} time={time} />
        <button type="button" className="anim-ctl" onClick={fullscreen} title={t('animation.fullscreen')}>
          ⤢
        </button>
      </div>
    </div>
  )
}
