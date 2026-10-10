import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import {
  EASINGS,
  ELEMENT_TYPES,
  EMPHASIS_PRESETS,
  ENTER_PRESETS,
  EXIT_PRESETS,
  FONTS,
  TRANSITIONS,
  elementState,
  newId,
  parseAnimation,
  sceneAt,
  sceneContentEnd,
  scenePosterTime,
  sceneStart,
  serializeAnimation,
  type AnimDoc,
  type AnimElement,
  type Cue,
  type Easing,
  type ElementType,
  type EmphasisPreset,
  type EnterPreset,
  type ExitPreset,
  type Keyframe,
  type Scene,
} from './animModel'
import { AnimationFrame, AnimationPlayer, AnimationScrubber } from './AnimationPlayer'
import { formatTime, usePlayhead } from './playhead'
import { AnimationExportMenu } from './AnimationExportMenu'
import '../styles/animation.css'

type Props = {
  source: string
  onChange: (next: string) => void
  /** Inline page-embed shape: a player with an Edit button until expanded. */
  compact?: boolean
  /** Title used for video / fframes export file names. */
  title?: string
}

const SNAP_T = 0.05
const snapT = (v: number) => Math.max(0, Math.round(v / SNAP_T) * SNAP_T)
const round = (v: number) => Math.round(v)
const HISTORY_LIMIT = 100

const TYPE_ICONS: Record<ElementType, string> = {
  text: 'T',
  box: '▭',
  circle: '◯',
  line: '╱',
  arrow: '→',
  icon: '☺',
  image: '🖼',
  path: '〰',
}

const SIZE_PRESETS = [
  { key: '16:9', width: 1280, height: 720 },
  { key: '9:16', width: 720, height: 1280 },
  { key: '1:1', width: 1080, height: 1080 },
  { key: '4:3', width: 1024, height: 768 },
] as const

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

/** Shift an element's whole motion path: base pose, line end and keyframe positions. */
function translateElement(el: AnimElement, dx: number, dy: number): AnimElement {
  return {
    ...el,
    x: round(el.x + dx),
    y: round(el.y + dy),
    x2: el.x2 !== undefined ? round(el.x2 + dx) : undefined,
    y2: el.y2 !== undefined ? round(el.y2 + dy) : undefined,
    keyframes: el.keyframes?.map((k) => ({
      ...k,
      x: k.x !== undefined ? round(k.x + dx) : undefined,
      y: k.y !== undefined ? round(k.y + dy) : undefined,
    })),
  }
}

/** Shift every cue and keyframe of an element in time. */
function retimeElement(el: AnimElement, dt: number): AnimElement {
  const shift = <P extends string>(c?: Cue<P>) => (c ? { ...c, at: snapT(c.at + dt) } : c)
  return {
    ...el,
    enter: shift(el.enter),
    emphasis: shift(el.emphasis),
    exit: shift(el.exit),
    keyframes: el.keyframes?.map((k) => ({ ...k, t: snapT(k.t + dt) })),
  }
}

function elementSpan(el: AnimElement, duration: number) {
  const start = el.enter && el.enter.preset !== 'none' ? el.enter.at : 0
  const end = el.exit && el.exit.preset !== 'none' ? Math.min(duration, el.exit.at + el.exit.duration) : duration
  return { start: Math.min(start, duration), end: Math.max(Math.min(start, duration), end) }
}

function elementLabel(el: AnimElement): string {
  const text = (el.text ?? '').replace(/\s+/g, ' ').trim()
  return text ? (text.length > 22 ? `${text.slice(0, 21)}…` : text) : el.type
}

function newElement(type: ElementType, doc: AnimDoc, at: number, accent: string): AnimElement {
  const cx = doc.width / 2
  const cy = doc.height / 2
  const id = newId('el')
  switch (type) {
    case 'text':
      return { id, type, x: round(cx - 300), y: round(cy - 40), w: 600, h: 80, text: 'Text', fontSize: 44, align: 'middle', color: '#f8fafc', enter: { preset: 'rise', at, duration: 0.6 } }
    case 'box':
      return { id, type, x: round(cx - 130), y: round(cy - 65), w: 260, h: 130, text: 'Box', fontSize: 32, bold: true, color: '#0f172a', fill: accent, radius: 16, enter: { preset: 'pop', at, duration: 0.6 } }
    case 'circle':
      return { id, type, x: round(cx - 80), y: round(cy - 80), w: 160, h: 160, fill: '#38bdf8', enter: { preset: 'pop', at, duration: 0.6 } }
    case 'line':
    case 'arrow':
      return { id, type, x: round(cx - 120), y: round(cy), w: 240, h: 1, x2: round(cx + 120), y2: round(cy), stroke: '#e2e8f0', strokeWidth: 6, enter: { preset: 'draw', at, duration: 0.6, easing: 'easeInOut' } }
    case 'icon':
      return { id, type, x: round(cx - 60), y: round(cy - 60), w: 120, h: 120, text: '💡', enter: { preset: 'pop', at, duration: 0.6 } }
    case 'image':
      return { id, type, x: round(cx - 200), y: round(cy - 125), w: 400, h: 250, enter: { preset: 'fade', at, duration: 0.6 } }
    case 'path':
      return { id, type, x: round(cx - 150), y: round(cy - 60), w: 300, h: 120, d: 'M0 60 C 75 -20, 150 140, 300 60', stroke: accent, strokeWidth: 6, enter: { preset: 'draw', at, duration: 1, easing: 'easeInOut' } }
  }
}

// ---------------------------------------------------------------------------

export function AnimationEditor({ source, onChange, compact = false, title }: Props) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  if (compact && !expanded) {
    return (
      <div className="anim-embed">
        <AnimationPlayer source={source} title={title} compact />
        <button type="button" className="btn ghost sm anim-embed-edit" onClick={() => setExpanded(true)}>
          ✎ {t('animation.edit')}
        </button>
      </div>
    )
  }
  return (
    <FullEditor
      source={source}
      onChange={onChange}
      title={title}
      onCollapse={compact ? () => setExpanded(false) : undefined}
    />
  )
}

function FullEditor({
  source,
  onChange,
  title,
  onCollapse,
}: {
  source: string
  onChange: (next: string) => void
  title?: string
  onCollapse?: () => void
}) {
  const { t } = useI18n()
  const doc = useMemo(() => parseAnimation(source), [source])
  const docRef = useRef(doc)
  docRef.current = doc
  const sourceRef = useRef(source)
  sourceRef.current = source

  const { time, playing, seek, toggle, setPlaying } = usePlayhead(doc)
  // Open on the first scene's settled frame: at t = 0 nothing has entered yet.
  const openedRef = useRef(false)
  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    seek(scenePosterTime(docRef.current, 0))
  }, [seek])
  const { index: sceneIndex, local } = sceneAt(doc, time)
  const scene = doc.scenes[sceneIndex]
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = scene?.elements.find((e) => e.id === selectedId) ?? null
  const [jsonMode, setJsonMode] = useState(false)

  // --- history (serialized snapshots, like the notes editor) ---------------
  const past = useRef<string[]>([])
  const future = useRef<string[]>([])
  const [, bump] = useState(0)

  const checkpoint = useCallback(() => {
    past.current.push(sourceRef.current)
    if (past.current.length > HISTORY_LIMIT) past.current.shift()
    future.current = []
  }, [])

  const emit = useCallback(
    (next: AnimDoc) => {
      const s = serializeAnimation(next)
      sourceRef.current = s
      docRef.current = next
      onChange(s)
    },
    [onChange],
  )

  // Typing into a field commits per keystroke; consecutive edits of the same
  // field within a second share one undo step.
  const lastEdit = useRef<{ key: string; at: number } | null>(null)
  const commit = useCallback(
    (next: AnimDoc, coalesceKey?: string) => {
      const now = Date.now()
      const prev = lastEdit.current
      if (!coalesceKey || !prev || prev.key !== coalesceKey || now - prev.at > 1000) checkpoint()
      lastEdit.current = coalesceKey ? { key: coalesceKey, at: now } : null
      emit(next)
      bump((n) => n + 1)
    },
    [checkpoint, emit],
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (prev === undefined) return
    future.current.push(sourceRef.current)
    sourceRef.current = prev
    onChange(prev)
    bump((n) => n + 1)
  }, [onChange])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (next === undefined) return
    past.current.push(sourceRef.current)
    sourceRef.current = next
    onChange(next)
    bump((n) => n + 1)
  }, [onChange])

  // --- doc helpers ------------------------------------------------------------
  const mapScene = useCallback(
    (d: AnimDoc, idx: number, fn: (s: Scene) => Scene): AnimDoc => ({
      ...d,
      scenes: d.scenes.map((s, i) => (i === idx ? fn(s) : s)),
    }),
    [],
  )

  const patchScene = (patch: Partial<Scene>) => {
    const next = mapScene(docRef.current, sceneIndex, (s) => ({ ...s, ...patch }))
    commit(next, `scene:${scene?.id}:${Object.keys(patch).join(',')}`)
  }

  const patchElement = (id: string, fn: (el: AnimElement) => AnimElement, history = true) => {
    const next = mapScene(docRef.current, sceneIndex, (s) => ({
      ...s,
      elements: s.elements.map((e) => (e.id === id ? fn(e) : e)),
    }))
    if (history) commit(next)
    else emit(next)
  }

  const setEl = (patch: Partial<AnimElement>) => {
    if (!selected) return
    const next = mapScene(docRef.current, sceneIndex, (s) => ({
      ...s,
      elements: s.elements.map((e) => (e.id === selected.id ? { ...e, ...patch } : e)),
    }))
    commit(next, `el:${selected.id}:${Object.keys(patch).join(',')}`)
  }

  const patchDoc = (patch: Partial<AnimDoc>) => commit({ ...docRef.current, ...patch })

  const goToScene = (i: number) => {
    setPlaying(false)
    setSelectedId(null)
    seek(scenePosterTime(docRef.current, i))
  }

  const addElement = async (type: ElementType) => {
    let el = newElement(type, docRef.current, snapT(local), docRef.current.accent)
    if (type === 'image') {
      const file = await pickImage()
      if (!file) return
      try {
        const uploaded = await api.uploadImage(file)
        el = { ...el, src: uploaded.url }
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
        return
      }
    }
    commit(mapScene(docRef.current, sceneIndex, (s) => ({ ...s, elements: [...s.elements, el] })))
    setSelectedId(el.id)
  }

  const removeSelected = () => {
    if (!selected) return
    commit(mapScene(docRef.current, sceneIndex, (s) => ({ ...s, elements: s.elements.filter((e) => e.id !== selected.id) })))
    setSelectedId(null)
  }

  const duplicateSelected = () => {
    if (!selected) return
    const copy = { ...translateElement(selected, 24, 24), id: newId('el') }
    commit(
      mapScene(docRef.current, sceneIndex, (s) => {
        const at = s.elements.findIndex((e) => e.id === selected.id)
        const elements = [...s.elements]
        elements.splice(at + 1, 0, copy)
        return { ...s, elements }
      }),
    )
    setSelectedId(copy.id)
  }

  const reorderSelected = (dir: 'front' | 'back' | 'up' | 'down') => {
    if (!selected) return
    commit(
      mapScene(docRef.current, sceneIndex, (s) => {
        const els = s.elements.filter((e) => e.id !== selected.id)
        const at = s.elements.findIndex((e) => e.id === selected.id)
        const to =
          dir === 'front' ? els.length : dir === 'back' ? 0 : dir === 'up' ? Math.min(els.length, at + 1) : Math.max(0, at - 1)
        els.splice(to, 0, selected)
        return { ...s, elements: els }
      }),
    )
  }

  const addScene = (duplicate: boolean) => {
    const d = docRef.current
    const base = d.scenes[sceneIndex]
    const fresh: Scene = duplicate
      ? {
          ...base,
          id: newId('scene'),
          title: `${base.title} (2)`,
          elements: base.elements.map((e) => ({ ...e, id: newId('el') })),
        }
      : { id: newId('scene'), title: t('animation.sceneN', { n: d.scenes.length + 1 }), duration: 4, transition: 'fade', elements: [] }
    const scenes = [...d.scenes]
    scenes.splice(sceneIndex + 1, 0, fresh)
    const next = { ...d, scenes }
    commit(next)
    setSelectedId(null)
    seek(sceneStart(next, sceneIndex + 1))
  }

  const removeScene = (i: number) => {
    const d = docRef.current
    if (d.scenes.length <= 1) return
    if (!confirm(t('animation.confirmDeleteScene', { title: d.scenes[i].title }))) return
    const next = { ...d, scenes: d.scenes.filter((_, j) => j !== i) }
    commit(next)
    setSelectedId(null)
    seek(sceneStart(next, Math.min(i, next.scenes.length - 1)))
  }

  const moveScene = (i: number, dir: -1 | 1) => {
    const d = docRef.current
    const j = i + dir
    if (j < 0 || j >= d.scenes.length) return
    const scenes = [...d.scenes]
    ;[scenes[i], scenes[j]] = [scenes[j], scenes[i]]
    const next = { ...d, scenes }
    commit(next)
    seek(scenePosterTime(next, j))
  }

  // --- keyboard ---------------------------------------------------------------
  const clipboard = useRef<AnimElement | null>(null)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (isTextInput(e.target)) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicateSelected()
    } else if (mod && e.key.toLowerCase() === 'c' && selected) {
      clipboard.current = selected
    } else if (mod && e.key.toLowerCase() === 'v' && clipboard.current) {
      e.preventDefault()
      const copy = { ...translateElement(clipboard.current, 24, 24), id: newId('el') }
      commit(mapScene(docRef.current, sceneIndex, (s) => ({ ...s, elements: [...s.elements, copy] })))
      setSelectedId(copy.id)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      removeSelected()
    } else if (e.key === ' ') {
      e.preventDefault()
      toggle()
    } else if (e.key === 'Escape') {
      setSelectedId(null)
    } else if (selected && e.key.startsWith('Arrow')) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      patchElement(selected.id, (el) => translateElement(el, dx, dy))
    } else if (e.key === ',' || e.key === '.') {
      seek(time + (e.key === ',' ? -1 : 1) / doc.fps)
    }
  }

  // Selection belongs to a scene: playing into the next one drops it.
  useEffect(() => {
    if (selectedId && !scene?.elements.some((e) => e.id === selectedId)) setSelectedId(null)
  }, [scene, selectedId])

  const exportTitle = title || 'animation'

  return (
    <div className="anim-editor" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="anim-toolbar" role="toolbar">
        <div className="anim-toolbar-group">
          {ELEMENT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="anim-tool"
              onClick={() => void addElement(type)}
              title={t('animation.addAt', { what: t(`animation.type.${type}` as MessageKey), time: formatTime(local) })}
            >
              <span aria-hidden>{TYPE_ICONS[type]}</span>
              <span className="anim-tool-label">{t(`animation.type.${type}` as MessageKey)}</span>
            </button>
          ))}
        </div>
        <div className="anim-toolbar-group">
          <button type="button" className="anim-tool" onClick={undo} disabled={past.current.length === 0} title={t('animation.undo')}>
            ↶
          </button>
          <button type="button" className="anim-tool" onClick={redo} disabled={future.current.length === 0} title={t('animation.redo')}>
            ↷
          </button>
          <button
            type="button"
            className={`anim-tool${jsonMode ? ' is-on' : ''}`}
            onClick={() => setJsonMode((v) => !v)}
            title={t('animation.jsonHint')}
          >
            {'{ }'}
          </button>
          <AnimationExportMenu source={source} title={exportTitle} time={time} />
          {onCollapse ? (
            <button type="button" className="anim-tool" onClick={onCollapse} title={t('animation.doneEditing')}>
              ✓ <span className="anim-tool-label">{t('animation.doneEditing')}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="anim-body">
        <aside className="anim-scenes" aria-label={t('animation.scenes')}>
          <ol>
            {doc.scenes.map((s, i) => (
              <li key={s.id} className={i === sceneIndex ? 'is-active' : undefined}>
                <button type="button" className="anim-scene-thumb" onClick={() => goToScene(i)}>
                  <SceneThumb doc={doc} index={i} />
                  <span className="anim-scene-meta">
                    <span className="anim-scene-num">{i + 1}</span>
                    <span className="anim-scene-title">{s.title}</span>
                    <span className="muted sm">{s.duration.toFixed(1)}s</span>
                  </span>
                </button>
                <span className="anim-scene-actions">
                  <button type="button" onClick={() => moveScene(i, -1)} disabled={i === 0} title={t('animation.moveUp')}>
                    ↑
                  </button>
                  <button type="button" onClick={() => moveScene(i, 1)} disabled={i === doc.scenes.length - 1} title={t('animation.moveDown')}>
                    ↓
                  </button>
                  <button type="button" onClick={() => removeScene(i)} disabled={doc.scenes.length <= 1} title={t('animation.deleteScene')}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="anim-scenes-add">
            <button type="button" className="btn ghost sm" onClick={() => addScene(false)}>
              + {t('animation.addScene')}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => addScene(true)}>
              ⧉ {t('animation.duplicateScene')}
            </button>
          </div>
        </aside>

        <div className="anim-center">
          {jsonMode ? (
            <JsonPane source={source} onApply={(next) => commit(parseAnimation(next))} />
          ) : (
            <Stage
              doc={doc}
              scene={scene}
              sceneIndex={sceneIndex}
              time={time}
              local={local}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id)
                setPlaying(false)
              }}
              onGestureStart={checkpoint}
              onLive={(id, fn) => patchElement(id, fn, false)}
            />
          )}
          <div className="anim-transport">
            <button type="button" className="anim-ctl" onClick={toggle} title={playing ? t('animation.pause') : t('animation.play')}>
              {playing ? '❚❚' : '▶'}
            </button>
            <AnimationScrubber doc={doc} time={time} onSeek={seek} onScrubStart={() => setPlaying(false)} />
            <span className="anim-time mono">{formatTime(time)}</span>
          </div>
          {scene ? (
            <Timeline
              scene={scene}
              local={local}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onSeekLocal={(lt) => {
                setPlaying(false)
                seek(sceneStart(docRef.current, sceneIndex) + Math.min(lt, scene.duration - 0.001))
              }}
              onGestureStart={checkpoint}
              onLive={(id, fn) => patchElement(id, fn, false)}
            />
          ) : null}
        </div>

        <aside className="anim-format" aria-label={t('animation.format')}>
          {selected ? (
            <ElementPanel
              el={selected}
              local={local}
              set={setEl}
              replace={(next) => patchElement(selected.id, () => next)}
              onDelete={removeSelected}
              onDuplicate={duplicateSelected}
              onReorder={reorderSelected}
            />
          ) : scene ? (
            <ScenePanel doc={doc} scene={scene} patchScene={patchScene} patchDoc={patchDoc} />
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

function SceneThumb({ doc, index }: { doc: AnimDoc; index: number }) {
  const at = scenePosterTime(doc, index)
  return <AnimationFrame doc={doc} time={at} captions={false} className="anim-thumb-frame" />
}

// ---------------------------------------------------------------------------
// Stage: the rendered frame plus a selection layer in document coordinates.
// ---------------------------------------------------------------------------

type Live = (id: string, fn: (el: AnimElement) => AnimElement) => void

function Stage({
  doc,
  scene,
  time,
  local,
  selectedId,
  onSelect,
  onGestureStart,
  onLive,
}: {
  doc: AnimDoc
  scene: Scene | undefined
  sceneIndex: number
  time: number
  local: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onGestureStart: () => void
  onLive: Live
}) {
  const { t } = useI18n()
  const layerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    id: string
    mode: 'move' | 'resize' | 'p1' | 'p2'
    startX: number
    startY: number
    origin: AnimElement
    scale: number
  } | null>(null)

  const pct = (v: number, of: number) => `${(v / of) * 100}%`

  const startDrag = (e: ReactPointerEvent, el: AnimElement, mode: 'move' | 'resize' | 'p1' | 'p2') => {
    e.stopPropagation()
    e.preventDefault()
    onSelect(el.id)
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    onGestureStart()
    drag.current = { id: el.id, mode, startX: e.clientX, startY: e.clientY, origin: el, scale: doc.width / rect.width }
  }

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.startX) * d.scale
    const dy = (e.clientY - d.startY) * d.scale
    const o = d.origin
    onLive(d.id, () => {
      switch (d.mode) {
        case 'move':
          return translateElement(o, dx, dy)
        case 'resize':
          return { ...o, w: Math.max(10, round(o.w + dx)), h: Math.max(10, round(o.h + dy)) }
        case 'p1':
          return { ...o, x: round(o.x + dx), y: round(o.y + dy) }
        case 'p2':
          return { ...o, x2: round((o.x2 ?? o.x) + dx), y2: round((o.y2 ?? o.y) + dy) }
      }
    })
  }

  const endDrag = () => {
    drag.current = null
  }

  return (
    <div className="anim-stage-wrap" style={{ '--anim-ratio': doc.width / doc.height } as CSSProperties}>
      <div className="anim-stage" style={{ aspectRatio: `${doc.width} / ${doc.height}` }}>
        <AnimationFrame doc={doc} time={time} />
        <div
          ref={layerRef}
          className="anim-select-layer"
          onPointerDown={() => onSelect(null)}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {scene?.elements.map((el) => {
            const s = elementState(el, local)
            const offX = s.x - el.x
            const offY = s.y - el.y
            const isLine = el.type === 'line' || el.type === 'arrow'
            const isSel = el.id === selectedId
            let bx: number, by: number, bw: number, bh: number
            if (isLine) {
              const x2 = el.x2 ?? el.x + el.w
              const y2 = el.y2 ?? el.y
              bx = Math.min(el.x, x2) + offX - 8
              by = Math.min(el.y, y2) + offY - 8
              bw = Math.abs(x2 - el.x) + 16
              bh = Math.abs(y2 - el.y) + 16
            } else {
              bx = el.x + offX
              by = el.y + offY
              bw = el.w
              bh = el.h
            }
            return (
              <div
                key={el.id}
                className={`anim-hit${isSel ? ' is-selected' : ''}${s.visible ? '' : ' is-hidden'}`}
                style={{ left: pct(bx, doc.width), top: pct(by, doc.height), width: pct(bw, doc.width), height: pct(bh, doc.height) }}
                onPointerDown={(e) => startDrag(e, el, 'move')}
                title={s.visible ? elementLabel(el) : t('animation.hiddenNow', { label: elementLabel(el) })}
              >
                {isSel && !isLine ? (
                  <span className="anim-handle is-resize" onPointerDown={(e) => startDrag(e, el, 'resize')} />
                ) : null}
              </div>
            )
          })}
          {(() => {
            const el = scene?.elements.find((e) => e.id === selectedId)
            if (!el || (el.type !== 'line' && el.type !== 'arrow')) return null
            const s = elementState(el, local)
            const offX = s.x - el.x
            const offY = s.y - el.y
            const pts: Array<['p1' | 'p2', number, number]> = [
              ['p1', el.x + offX, el.y + offY],
              ['p2', (el.x2 ?? el.x) + offX, (el.y2 ?? el.y) + offY],
            ]
            return pts.map(([mode, x, y]) => (
              <span
                key={mode}
                className="anim-handle is-point"
                style={{ left: pct(x, doc.width), top: pct(y, doc.height) }}
                onPointerDown={(e) => startDrag(e, el, mode)}
              />
            ))
          })()}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline: one row per element, bars from enter to exit, keyframe diamonds.
// ---------------------------------------------------------------------------

function Timeline({
  scene,
  local,
  selectedId,
  onSelect,
  onSeekLocal,
  onGestureStart,
  onLive,
}: {
  scene: Scene
  local: number
  selectedId: string | null
  onSelect: (id: string) => void
  onSeekLocal: (t: number) => void
  onGestureStart: () => void
  onLive: Live
}) {
  const { t } = useI18n()
  const trackRef = useRef<HTMLDivElement>(null)
  const dur = scene.duration
  const drag = useRef<{ id: string; mode: 'move' | 'start' | 'end'; startX: number; origin: AnimElement; perPx: number } | null>(null)
  const pct = (v: number) => `${(Math.min(Math.max(v, 0), dur) / dur) * 100}%`

  const perPx = () => {
    const w = trackRef.current?.getBoundingClientRect().width ?? 1
    return dur / Math.max(1, w)
  }

  const begin = (e: ReactPointerEvent, el: AnimElement, mode: 'move' | 'start' | 'end') => {
    e.stopPropagation()
    e.preventDefault()
    onSelect(el.id)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    onGestureStart()
    drag.current = { id: el.id, mode, startX: e.clientX, origin: el, perPx: perPx() }
  }

  const move = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const dt = (e.clientX - d.startX) * d.perPx
    const o = d.origin
    onLive(d.id, () => {
      if (d.mode === 'move') return retimeElement(o, dt)
      if (d.mode === 'start') {
        const enter: Cue<EnterPreset> =
          o.enter && o.enter.preset !== 'none' ? { ...o.enter } : { preset: 'fade', at: 0, duration: 0.5 }
        const end = elementSpan(o, dur).end
        enter.at = Math.min(snapT(enter.at + dt), Math.max(0, end - 0.1))
        return { ...o, enter }
      }
      const span = elementSpan(o, dur)
      const exit: Cue<ExitPreset> =
        o.exit && o.exit.preset !== 'none' ? { ...o.exit } : { preset: 'fade', at: dur - 0.4, duration: 0.4 }
      const newEnd = Math.min(dur, Math.max(span.start + 0.1, span.end + dt))
      exit.at = snapT(Math.max(span.start, newEnd - exit.duration))
      return { ...o, exit }
    })
  }

  const end = () => {
    drag.current = null
  }

  const ticks = []
  const step = dur > 20 ? 5 : dur > 8 ? 2 : 1
  for (let s = 0; s <= dur + 0.001; s += step) ticks.push(s)

  return (
    <div className="anim-timeline" onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <div className="anim-tl-row anim-tl-ruler-row">
        <span className="anim-tl-label muted sm">{t('animation.timeline')}</span>
        <div
          className="anim-tl-ruler"
          ref={trackRef}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            e.currentTarget.setPointerCapture(e.pointerId)
            onSeekLocal(((e.clientX - r.left) / r.width) * dur)
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
            const r = e.currentTarget.getBoundingClientRect()
            onSeekLocal(((e.clientX - r.left) / r.width) * dur)
          }}
        >
          {ticks.map((s) => (
            <span key={s} className="anim-tl-tick" style={{ left: pct(s) }}>
              {s}s
            </span>
          ))}
        </div>
      </div>
      <div className="anim-tl-rows">
        {scene.elements.length === 0 ? (
          <div className="anim-tl-empty muted sm">{t('animation.timelineEmpty')}</div>
        ) : null}
        {[...scene.elements].reverse().map((el) => {
          const span = elementSpan(el, dur)
          const isSel = el.id === selectedId
          return (
            <div key={el.id} className={`anim-tl-row${isSel ? ' is-selected' : ''}`} onPointerDown={() => onSelect(el.id)}>
              <span className="anim-tl-label" title={elementLabel(el)}>
                <span className="anim-tl-icon" aria-hidden>
                  {TYPE_ICONS[el.type]}
                </span>
                {elementLabel(el)}
              </span>
              <div className="anim-tl-track">
                <div
                  className="anim-tl-bar"
                  style={{ left: pct(span.start), width: `calc(${pct(span.end)} - ${pct(span.start)})` }}
                  onPointerDown={(e) => begin(e, el, 'move')}
                  title={`${span.start.toFixed(2)}s → ${span.end.toFixed(2)}s`}
                >
                  {el.enter && el.enter.preset !== 'none' ? (
                    <span className="anim-tl-cue is-enter" style={{ width: `${(Math.min(el.enter.duration, span.end - span.start) / Math.max(0.001, span.end - span.start)) * 100}%` }} title={el.enter.preset} />
                  ) : null}
                  {el.exit && el.exit.preset !== 'none' ? (
                    <span className="anim-tl-cue is-exit" style={{ width: `${(Math.min(el.exit.duration, span.end - span.start) / Math.max(0.001, span.end - span.start)) * 100}%` }} title={el.exit.preset} />
                  ) : null}
                  <span className="anim-tl-grip is-start" onPointerDown={(e) => begin(e, el, 'start')} />
                  <span className="anim-tl-grip is-end" onPointerDown={(e) => begin(e, el, 'end')} />
                </div>
                {el.emphasis ? (
                  <span
                    className="anim-tl-emphasis"
                    style={{ left: pct(el.emphasis.at), width: `calc(${pct(el.emphasis.at + el.emphasis.duration)} - ${pct(el.emphasis.at)})` }}
                    title={el.emphasis.preset}
                  />
                ) : null}
                {el.keyframes?.map((k, i) => (
                  <span key={i} className="anim-tl-key" style={{ left: pct(k.t) }} title={`${k.t.toFixed(2)}s`} />
                ))}
              </div>
            </div>
          )
        })}
        <span className="anim-tl-playhead" style={{ left: `calc(var(--tl-label) + (100% - var(--tl-label) - 0.6rem) * ${local / dur})` }} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Format panels
// ---------------------------------------------------------------------------

function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  placeholder,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  step?: number
  min?: number
  max?: number
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value])
  return (
    <label className="anim-field">
      <span>{label}</span>
      <input
        type="number"
        value={draft}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = draft.trim() === '' ? undefined : Number(draft)
          if (v === undefined || Number.isFinite(v)) onChange(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </label>
  )
}

function ColorField({ label, value, onChange, fallback }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; fallback: string }) {
  const { t } = useI18n()
  return (
    <label className="anim-field anim-color">
      <span>{label}</span>
      <span className="anim-color-row">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : fallback} onChange={(e) => onChange(e.target.value)} />
        <input type="text" value={value ?? ''} placeholder={fallback} onChange={(e) => onChange(e.target.value || undefined)} />
        {value ? (
          <button type="button" className="anim-mini" onClick={() => onChange(undefined)} title={t('animation.reset')}>
            ✕
          </button>
        ) : null}
      </span>
    </label>
  )
}

function Select<T extends string>({ label, value, options, onChange, labelFor }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; labelFor?: (v: T) => string }) {
  return (
    <label className="anim-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor ? labelFor(o) : o}
          </option>
        ))}
      </select>
    </label>
  )
}

function CueEditor<P extends string>({
  title,
  cue,
  presets,
  allowNone,
  defaultAt,
  onChange,
}: {
  title: string
  cue: Cue<P> | undefined
  presets: readonly P[]
  allowNone: boolean
  defaultAt: number
  onChange: (c: Cue<P> | undefined) => void
}) {
  const { t } = useI18n()
  const NONE = '__none' as P
  const options = (allowNone ? [NONE, ...presets.filter((p) => p !== 'none')] : presets) as readonly P[]
  const value = cue && cue.preset !== 'none' ? cue.preset : NONE
  return (
    <fieldset className="anim-group">
      <legend>{title}</legend>
      <Select
        label={t('animation.effect')}
        value={value}
        options={options}
        labelFor={(p) => (p === NONE ? t('animation.none') : t(`animation.preset.${p}` as MessageKey))}
        onChange={(p) =>
          onChange(p === NONE ? undefined : { preset: p, at: cue?.at ?? snapT(defaultAt), duration: cue?.duration ?? 0.6, easing: cue?.easing })
        }
      />
      {cue && cue.preset !== 'none' ? (
        <>
          <div className="anim-row">
            <NumField label={t('animation.at')} value={cue.at} step={0.05} min={0} onChange={(v) => onChange({ ...cue, at: snapT(v ?? 0) })} />
            <NumField label={t('animation.duration')} value={cue.duration} step={0.05} min={0.05} onChange={(v) => onChange({ ...cue, duration: Math.max(0.05, v ?? 0.6) })} />
          </div>
          <Select<Easing | ''>
            label={t('animation.easing')}
            value={cue.easing ?? ''}
            options={['', ...EASINGS]}
            labelFor={(e) => (e === '' ? t('animation.easingAuto') : e)}
            onChange={(e) => onChange({ ...cue, easing: e === '' ? undefined : e })}
          />
          <button type="button" className="anim-mini-link" onClick={() => onChange({ ...cue, at: snapT(defaultAt) })}>
            ⇤ {t('animation.startAtPlayhead')}
          </button>
        </>
      ) : null}
    </fieldset>
  )
}

function ElementPanel({
  el,
  local,
  set,
  replace,
  onDelete,
  onDuplicate,
  onReorder,
}: {
  el: AnimElement
  local: number
  set: (patch: Partial<AnimElement>) => void
  replace: (next: AnimElement) => void
  onDelete: () => void
  onDuplicate: () => void
  onReorder: (dir: 'front' | 'back' | 'up' | 'down') => void
}) {
  const { t } = useI18n()
  const isLine = el.type === 'line' || el.type === 'arrow'
  const hasText = el.type === 'text' || el.type === 'box' || el.type === 'circle' || el.type === 'icon' || isLine
  const hasFill = el.type === 'box' || el.type === 'circle' || el.type === 'path'
  const hasStroke = el.type !== 'text' && el.type !== 'icon' && el.type !== 'image'
  const hasFont = el.type !== 'icon' && hasText

  const addKeyframe = () => {
    const s = elementState(el, local)
    const k: Keyframe = { t: snapT(local), x: round(s.x), y: round(s.y), opacity: Math.round(s.opacity * 100) / 100, scale: s.scale, rotate: s.rotate }
    const keyframes = [...(el.keyframes ?? []).filter((x) => Math.abs(x.t - k.t) > 0.001), k].sort((a, b) => a.t - b.t)
    replace({ ...el, keyframes })
  }

  const setKey = (i: number, patch: Partial<Keyframe>) => {
    const keyframes = (el.keyframes ?? []).map((k, j) => (j === i ? { ...k, ...patch } : k)).sort((a, b) => a.t - b.t)
    replace({ ...el, keyframes })
  }

  return (
    <div className="anim-panel">
      <header className="anim-panel-head">
        <strong>
          {TYPE_ICONS[el.type]} {t(`animation.type.${el.type}` as MessageKey)}
        </strong>
        <span className="anim-panel-actions">
          <button type="button" className="anim-mini" onClick={() => onReorder('down')} title={t('animation.sendBackward')}>
            ▼
          </button>
          <button type="button" className="anim-mini" onClick={() => onReorder('up')} title={t('animation.bringForward')}>
            ▲
          </button>
          <button type="button" className="anim-mini" onClick={onDuplicate} title={t('animation.duplicate')}>
            ⧉
          </button>
          <button type="button" className="anim-mini is-danger" onClick={onDelete} title={t('animation.delete')}>
            🗑
          </button>
        </span>
      </header>

      {hasText ? (
        <label className="anim-field">
          <span>{el.type === 'icon' ? t('animation.glyph') : t('animation.text')}</span>
          {el.type === 'icon' ? (
            <input type="text" value={el.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
          ) : (
            <textarea rows={el.type === 'text' ? 3 : 2} value={el.text ?? ''} onChange={(e) => set({ text: e.target.value || undefined })} />
          )}
        </label>
      ) : null}
      {el.type === 'image' ? (
        <label className="anim-field">
          <span>{t('animation.imageUrl')}</span>
          <input type="text" value={el.src ?? ''} onChange={(e) => set({ src: e.target.value || undefined })} />
        </label>
      ) : null}
      {el.type === 'path' ? (
        <label className="anim-field">
          <span>{t('animation.pathData')}</span>
          <textarea rows={2} className="mono" value={el.d ?? ''} onChange={(e) => set({ d: e.target.value || undefined })} />
        </label>
      ) : null}

      {hasFont ? (
        <div className="anim-row">
          <NumField label={t('animation.fontSize')} value={el.fontSize} min={6} onChange={(v) => set({ fontSize: v })} placeholder="auto" />
          <Select label={t('animation.font')} value={el.font ?? 'sans'} options={FONTS} onChange={(v) => set({ font: v === 'sans' ? undefined : v })} />
        </div>
      ) : null}
      {hasFont ? (
        <div className="anim-row anim-row-tight">
          <label className="anim-check">
            <input type="checkbox" checked={!!el.bold} onChange={(e) => set({ bold: e.target.checked || undefined })} /> {t('animation.bold')}
          </label>
          <span className="anim-seg" role="group" aria-label={t('animation.align')}>
            {(['start', 'middle', 'end'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={(el.align ?? (el.type === 'text' ? 'start' : 'middle')) === a ? 'is-on' : undefined}
                onClick={() => set({ align: a })}
                title={t(`animation.align.${a}` as MessageKey)}
              >
                {a === 'start' ? '⇤' : a === 'middle' ? '↔' : '⇥'}
              </button>
            ))}
          </span>
        </div>
      ) : null}

      {hasText ? <ColorField label={t('animation.textColor')} value={el.color} onChange={(v) => set({ color: v })} fallback="#f8fafc" /> : null}
      {hasFill ? <ColorField label={t('animation.fill')} value={el.fill} onChange={(v) => set({ fill: v })} fallback={el.type === 'path' ? '#000000' : '#1e293b'} /> : null}
      {hasStroke ? <ColorField label={t('animation.stroke')} value={el.stroke} onChange={(v) => set({ stroke: v })} fallback="#e2e8f0" /> : null}
      {hasStroke ? (
        <div className="anim-row">
          <NumField label={t('animation.strokeWidth')} value={el.strokeWidth} min={0} onChange={(v) => set({ strokeWidth: v })} placeholder="auto" />
          <label className="anim-check">
            <input type="checkbox" checked={!!el.dashed} onChange={(e) => set({ dashed: e.target.checked || undefined })} /> {t('animation.dashed')}
          </label>
        </div>
      ) : null}
      {el.type === 'box' || el.type === 'image' ? (
        <NumField label={t('animation.radius')} value={el.radius} min={0} onChange={(v) => set({ radius: v })} placeholder="auto" />
      ) : null}

      <fieldset className="anim-group">
        <legend>{t('animation.position')}</legend>
        <div className="anim-row">
          <NumField label="X" value={el.x} onChange={(v) => replace(translateElement(el, (v ?? el.x) - el.x, 0))} />
          <NumField label="Y" value={el.y} onChange={(v) => replace(translateElement(el, 0, (v ?? el.y) - el.y))} />
        </div>
        {isLine ? (
          <div className="anim-row">
            <NumField label="X2" value={el.x2} onChange={(v) => set({ x2: v })} />
            <NumField label="Y2" value={el.y2} onChange={(v) => set({ y2: v })} />
          </div>
        ) : (
          <div className="anim-row">
            <NumField label={t('animation.width')} value={el.w} min={1} onChange={(v) => set({ w: Math.max(1, v ?? el.w) })} />
            <NumField label={t('animation.height')} value={el.h} min={1} onChange={(v) => set({ h: Math.max(1, v ?? el.h) })} />
          </div>
        )}
        <NumField label={t('animation.opacity')} value={el.opacity} step={0.05} min={0} max={1} onChange={(v) => set({ opacity: v })} placeholder="1" />
      </fieldset>

      <CueEditor<EnterPreset>
        title={t('animation.enter')}
        cue={el.enter}
        presets={ENTER_PRESETS}
        allowNone
        defaultAt={local}
        onChange={(c) => set({ enter: c })}
      />
      <CueEditor<EmphasisPreset>
        title={t('animation.emphasis')}
        cue={el.emphasis}
        presets={EMPHASIS_PRESETS}
        allowNone
        defaultAt={local}
        onChange={(c) => set({ emphasis: c })}
      />
      <CueEditor<ExitPreset>
        title={t('animation.exit')}
        cue={el.exit}
        presets={EXIT_PRESETS}
        allowNone
        defaultAt={local}
        onChange={(c) => set({ exit: c })}
      />

      <fieldset className="anim-group">
        <legend>{t('animation.keyframes')}</legend>
        <p className="muted sm anim-hint">{t('animation.keyframesHint')}</p>
        {(el.keyframes ?? []).map((k, i) => (
          <div key={i} className="anim-key">
            <div className="anim-row">
              <NumField label="t" value={k.t} step={0.05} min={0} onChange={(v) => setKey(i, { t: snapT(v ?? k.t) })} />
              <NumField label="X" value={k.x} onChange={(v) => setKey(i, { x: v })} />
              <NumField label="Y" value={k.y} onChange={(v) => setKey(i, { y: v })} />
            </div>
            <div className="anim-row">
              <NumField label={t('animation.scale')} value={k.scale} step={0.05} onChange={(v) => setKey(i, { scale: v })} />
              <NumField label={t('animation.rotate')} value={k.rotate} step={5} onChange={(v) => setKey(i, { rotate: v })} />
              <NumField label={t('animation.opacity')} value={k.opacity} step={0.05} min={0} max={1} onChange={(v) => setKey(i, { opacity: v })} />
            </div>
            <div className="anim-row anim-row-tight">
              <Select<Easing | ''>
                label={t('animation.easing')}
                value={k.easing ?? ''}
                options={['', ...EASINGS]}
                labelFor={(e) => (e === '' ? 'easeInOut' : e)}
                onChange={(e) => setKey(i, { easing: e === '' ? undefined : e })}
              />
              <button
                type="button"
                className="anim-mini is-danger"
                onClick={() => {
                  const keyframes = (el.keyframes ?? []).filter((_, j) => j !== i)
                  replace({ ...el, keyframes: keyframes.length ? keyframes : undefined })
                }}
                title={t('animation.delete')}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="btn ghost sm" onClick={addKeyframe}>
          ◆ {t('animation.addKeyframe', { time: local.toFixed(2) })}
        </button>
      </fieldset>
    </div>
  )
}

function ScenePanel({
  doc,
  scene,
  patchScene,
  patchDoc,
}: {
  doc: AnimDoc
  scene: Scene
  patchScene: (patch: Partial<Scene>) => void
  patchDoc: (patch: Partial<AnimDoc>) => void
}) {
  const { t } = useI18n()
  const contentEnd = sceneContentEnd(scene)
  const sizeKey = SIZE_PRESETS.find((p) => p.width === doc.width && p.height === doc.height)?.key ?? 'custom'
  return (
    <div className="anim-panel">
      <header className="anim-panel-head">
        <strong>{t('animation.scene')}</strong>
      </header>
      <label className="anim-field">
        <span>{t('animation.sceneTitle')}</span>
        <input type="text" value={scene.title} onChange={(e) => patchScene({ title: e.target.value })} />
      </label>
      <div className="anim-row">
        <NumField label={t('animation.durationS')} value={scene.duration} step={0.5} min={0.5} onChange={(v) => patchScene({ duration: Math.max(0.5, v ?? scene.duration) })} />
        <button
          type="button"
          className="anim-mini-link"
          disabled={contentEnd <= 0}
          onClick={() => patchScene({ duration: Math.max(0.5, Math.round((contentEnd + 1) * 2) / 2) })}
          title={t('animation.fitDurationHint')}
        >
          ⇥ {t('animation.fitDuration')}
        </button>
      </div>
      <label className="anim-field">
        <span>{t('animation.narration')}</span>
        <textarea rows={4} value={scene.narration ?? ''} placeholder={t('animation.narrationHint')} onChange={(e) => patchScene({ narration: e.target.value || undefined })} />
      </label>
      <ColorField label={t('animation.background')} value={scene.background} onChange={(v) => patchScene({ background: v })} fallback={doc.background} />
      <div className="anim-row">
        <Select
          label={t('animation.transition')}
          value={scene.transition ?? 'none'}
          options={TRANSITIONS}
          labelFor={(v) => t(`animation.transition.${v}` as MessageKey)}
          onChange={(v) => patchScene({ transition: v === 'none' ? undefined : v })}
        />
        <NumField label={t('animation.duration')} value={scene.transitionDuration} step={0.1} min={0.1} placeholder="0.6" onChange={(v) => patchScene({ transitionDuration: v })} />
      </div>

      <fieldset className="anim-group">
        <legend>{t('animation.document')}</legend>
        <Select
          label={t('animation.size')}
          value={sizeKey}
          options={[...SIZE_PRESETS.map((p) => p.key), 'custom'] as string[]}
          labelFor={(k) => {
            const p = SIZE_PRESETS.find((x) => x.key === k)
            return p ? `${k} · ${p.width}×${p.height}` : `${t('animation.custom')} · ${doc.width}×${doc.height}`
          }}
          onChange={(k) => {
            const p = SIZE_PRESETS.find((x) => x.key === k)
            if (p) patchDoc({ width: p.width, height: p.height })
          }}
        />
        <div className="anim-row">
          <NumField label={t('animation.width')} value={doc.width} min={160} max={3840} onChange={(v) => patchDoc({ width: Math.round(Math.min(3840, Math.max(160, v ?? doc.width))) })} />
          <NumField label={t('animation.height')} value={doc.height} min={90} max={2160} onChange={(v) => patchDoc({ height: Math.round(Math.min(2160, Math.max(90, v ?? doc.height))) })} />
          <NumField label="FPS" value={doc.fps} min={1} max={60} onChange={(v) => patchDoc({ fps: Math.round(Math.min(60, Math.max(1, v ?? doc.fps))) })} />
        </div>
        <ColorField label={t('animation.defaultBackground')} value={doc.background} onChange={(v) => patchDoc({ background: v ?? '#0f172a' })} fallback="#0f172a" />
        <ColorField label={t('animation.accent')} value={doc.accent} onChange={(v) => patchDoc({ accent: v ?? '#f59e0b' })} fallback="#f59e0b" />
        <label className="anim-check">
          <input type="checkbox" checked={doc.captions} onChange={(e) => patchDoc({ captions: e.target.checked })} /> {t('animation.showCaptions')}
        </label>
      </fieldset>
      <p className="muted sm anim-hint">{t('animation.editorHint')}</p>
    </div>
  )
}

function JsonPane({ source, onApply }: { source: string; onApply: (next: string) => void }) {
  const { t } = useI18n()
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(source), null, 2)
    } catch {
      return source
    }
  }, [source])
  const [draft, setDraft] = useState(pretty)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(pretty), [pretty])
  return (
    <div className="anim-json">
      <p className="muted sm">{t('animation.jsonIntro')}</p>
      <textarea className="mono" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="anim-json-actions">
        {error ? <span className="anim-export-error sm">{error}</span> : null}
        <button type="button" className="btn ghost sm" onClick={() => setDraft(pretty)} disabled={draft === pretty}>
          {t('animation.revert')}
        </button>
        <button
          type="button"
          className="btn primary sm"
          disabled={draft === pretty}
          onClick={() => {
            try {
              const raw = JSON.parse(draft) as { scenes?: unknown }
              if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) throw new Error(t('animation.jsonNoScenes'))
              setError(null)
              onApply(draft)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          {t('animation.apply')}
        </button>
      </div>
    </div>
  )
}
