/**
 * Animations ("moving explanations") stored as book items (`animation.source`)
 * and as ```animation fenced blocks on a page. The server stores this JSON
 * verbatim and reads only scene titles, narration and element text (search)
 * and the scene count (tree badge), so new fields need no server change.
 *
 * The engine follows fframes (github.com/dmtrKovalenko/fframes): a video is a
 * pure function from time to an SVG frame. Nothing here keeps playback state —
 * `renderFrameSvg(doc, t)` is the whole renderer, shared by the editor stage,
 * the player, page embeds, PDF export (poster frame) and video export, so an
 * animation looks the same everywhere and any instant can be rendered alone.
 *
 * Timing is per scene: every cue (`enter`, `emphasis`, `exit`) and keyframe
 * `t` is in seconds from the start of its scene. Scenes play back to back.
 */

export const EASINGS = [
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'easeOutBack',
  'easeOutElastic',
  'easeOutBounce',
] as const
export type Easing = (typeof EASINGS)[number]

export const ENTER_PRESETS = [
  'none',
  'fade',
  'rise',
  'drop',
  'slide-left',
  'slide-right',
  'pop',
  'zoom',
  'draw',
  'type',
  'wipe',
] as const
export type EnterPreset = (typeof ENTER_PRESETS)[number]

export const EXIT_PRESETS = ['none', 'fade', 'sink', 'shrink', 'slide-left', 'slide-right'] as const
export type ExitPreset = (typeof EXIT_PRESETS)[number]

export const EMPHASIS_PRESETS = ['pulse', 'shake', 'glow', 'spin'] as const
export type EmphasisPreset = (typeof EMPHASIS_PRESETS)[number]

export const ELEMENT_TYPES = ['text', 'box', 'circle', 'line', 'arrow', 'icon', 'image', 'path'] as const
export type ElementType = (typeof ELEMENT_TYPES)[number]

export const TRANSITIONS = ['none', 'fade', 'slide', 'zoom'] as const
export type Transition = (typeof TRANSITIONS)[number]

export const FONTS = ['sans', 'serif', 'mono'] as const
export type FontKind = (typeof FONTS)[number]

export type Cue<P extends string> = {
  preset: P
  /** Seconds from the start of the scene. */
  at: number
  /** Seconds. */
  duration: number
  easing?: Easing
}

/** A pose at scene time `t`. Omitted properties hold their previous value. */
export type Keyframe = {
  t: number
  x?: number
  y?: number
  opacity?: number
  scale?: number
  rotate?: number
  /** Easing used to arrive at this keyframe from the previous one. */
  easing?: Easing
}

export type AnimElement = {
  id: string
  type: ElementType
  /** Top-left of the element box on the stage (lines: start point). */
  x: number
  y: number
  w: number
  h: number
  /** End point for `line` / `arrow`. */
  x2?: number
  y2?: number
  /** Label (box/circle), body (text, may contain \n), glyph or emoji (icon). */
  text?: string
  fontSize?: number
  font?: FontKind
  bold?: boolean
  align?: 'start' | 'middle' | 'end'
  /** Text colour. */
  color?: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  /** Corner radius for `box`. */
  radius?: number
  /** Resting opacity, 0..1 (default 1). */
  opacity?: number
  /** Image URL for `image`. */
  src?: string
  /** SVG path data for `path`, relative to the element's top-left (x, y). */
  d?: string
  /** Dashed stroke (lines, arrows, outlines). */
  dashed?: boolean
  enter?: Cue<EnterPreset>
  emphasis?: Cue<EmphasisPreset>
  exit?: Cue<ExitPreset>
  keyframes?: Keyframe[]
}

export type Scene = {
  id: string
  title: string
  /** Seconds. */
  duration: number
  background?: string
  /** Spoken/caption text for the scene; shown as a caption bar when captions are on. */
  narration?: string
  /** How this scene arrives from the previous one. */
  transition?: Transition
  transitionDuration?: number
  elements: AnimElement[]
}

export type AnimDoc = {
  version: 1
  width: number
  height: number
  fps: number
  background: string
  /** Accent colour the starter content and AI generation lean on. */
  accent: string
  captions: boolean
  scenes: Scene[]
}

export const DEFAULT_WIDTH = 1280
export const DEFAULT_HEIGHT = 720
export const DEFAULT_FPS = 30
export const DEFAULT_BACKGROUND = '#0f172a'
export const DEFAULT_ACCENT = '#f59e0b'

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return `${prefix}-${raw}`
}

// ---------------------------------------------------------------------------
// Easing — the same curve names fframes and CSS use.
// ---------------------------------------------------------------------------

export function ease(name: Easing | undefined, p: number): number {
  const x = clamp01(p)
  switch (name ?? 'easeOut') {
    case 'linear':
      return x
    case 'easeIn':
      return x * x * x
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3)
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
    case 'easeOutBack': {
      const c1 = 1.70158
      const c3 = c1 + 1
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
    }
    case 'easeOutElastic': {
      if (x === 0 || x === 1) return x
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
    }
    case 'easeOutBounce': {
      const n1 = 7.5625
      const d1 = 2.75
      let v = x
      if (v < 1 / d1) return n1 * v * v
      if (v < 2 / d1) return n1 * (v -= 1.5 / d1) * v + 0.75
      if (v < 2.5 / d1) return n1 * (v -= 2.25 / d1) * v + 0.9375
      return n1 * (v -= 2.625 / d1) * v + 0.984375
    }
  }
  return x
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ---------------------------------------------------------------------------
// Parsing — tolerant, so a hand- or AI-written document never breaks a page.
// ---------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined
}

function asCue<P extends string>(list: readonly P[], raw: unknown): Cue<P> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const preset = oneOf(list, o.preset)
  if (!preset) return undefined
  return {
    preset,
    at: Math.max(0, num(o.at, 0)),
    duration: Math.max(0.05, num(o.duration, 0.6)),
    easing: oneOf(EASINGS, o.easing),
  }
}

function asKeyframe(raw: unknown): Keyframe | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.t !== 'number' || !Number.isFinite(o.t)) return null
  return {
    t: Math.max(0, o.t),
    x: optNum(o.x),
    y: optNum(o.y),
    opacity: optNum(o.opacity),
    scale: optNum(o.scale),
    rotate: optNum(o.rotate),
    easing: oneOf(EASINGS, o.easing),
  }
}

function asElement(raw: unknown): AnimElement | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = oneOf(ELEMENT_TYPES, o.type)
  if (!type) return null
  const keyframes = Array.isArray(o.keyframes)
    ? o.keyframes
        .map(asKeyframe)
        .filter((k): k is Keyframe => k !== null)
        .sort((a, b) => a.t - b.t)
    : undefined
  const el: AnimElement = {
    id: typeof o.id === 'string' && o.id.trim() ? o.id : newId('el'),
    type,
    x: num(o.x, 100),
    y: num(o.y, 100),
    w: Math.max(1, num(o.w, type === 'text' ? 600 : 200)),
    h: Math.max(1, num(o.h, type === 'text' ? 80 : 120)),
    x2: optNum(o.x2),
    y2: optNum(o.y2),
    text: typeof o.text === 'string' ? o.text : undefined,
    fontSize: optNum(o.fontSize),
    font: oneOf(FONTS, o.font),
    bold: typeof o.bold === 'boolean' ? o.bold : undefined,
    align: oneOf(['start', 'middle', 'end'] as const, o.align),
    color: optStr(o.color),
    fill: optStr(o.fill),
    stroke: optStr(o.stroke),
    strokeWidth: optNum(o.strokeWidth),
    radius: optNum(o.radius),
    opacity: optNum(o.opacity),
    src: optStr(o.src),
    d: optStr(o.d),
    dashed: typeof o.dashed === 'boolean' ? o.dashed : undefined,
    enter: asCue(ENTER_PRESETS, o.enter),
    emphasis: asCue(EMPHASIS_PRESETS, o.emphasis),
    exit: asCue(EXIT_PRESETS, o.exit),
    keyframes: keyframes && keyframes.length ? keyframes : undefined,
  }
  if ((type === 'line' || type === 'arrow') && (el.x2 === undefined || el.y2 === undefined)) {
    el.x2 = el.x + el.w
    el.y2 = el.y
  }
  return el
}

function asScene(raw: unknown, index: number): Scene | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id : newId('scene'),
    title: typeof o.title === 'string' ? o.title : `Scene ${index + 1}`,
    duration: Math.min(600, Math.max(0.5, num(o.duration, 4))),
    background: optStr(o.background),
    narration: typeof o.narration === 'string' && o.narration.trim() ? o.narration : undefined,
    transition: oneOf(TRANSITIONS, o.transition),
    transitionDuration: optNum(o.transitionDuration),
    elements: Array.isArray(o.elements)
      ? o.elements.map(asElement).filter((e): e is AnimElement => e !== null)
      : [],
  }
}

export function emptyAnimation(): AnimDoc {
  return {
    version: 1,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    fps: DEFAULT_FPS,
    background: DEFAULT_BACKGROUND,
    accent: DEFAULT_ACCENT,
    captions: true,
    scenes: [{ id: newId('scene'), title: 'Scene 1', duration: 4, elements: [] }],
  }
}

export function parseAnimation(source: string | null | undefined): AnimDoc {
  if (!source?.trim()) return emptyAnimation()
  try {
    const raw = JSON.parse(source) as unknown
    if (!raw || typeof raw !== 'object') return emptyAnimation()
    const o = raw as Record<string, unknown>
    const scenes = Array.isArray(o.scenes)
      ? o.scenes.map(asScene).filter((s): s is Scene => s !== null)
      : []
    if (scenes.length === 0) return emptyAnimation()
    return {
      version: 1,
      width: Math.min(3840, Math.max(160, Math.round(num(o.width, DEFAULT_WIDTH)))),
      height: Math.min(2160, Math.max(90, Math.round(num(o.height, DEFAULT_HEIGHT)))),
      fps: Math.min(60, Math.max(1, Math.round(num(o.fps, DEFAULT_FPS)))),
      background: optStr(o.background) ?? DEFAULT_BACKGROUND,
      accent: optStr(o.accent) ?? DEFAULT_ACCENT,
      captions: typeof o.captions === 'boolean' ? o.captions : true,
      scenes,
    }
  } catch {
    return emptyAnimation()
  }
}

/** Compact JSON: undefined fields drop out, so the stored document stays small. */
export function serializeAnimation(doc: AnimDoc): string {
  return JSON.stringify(doc)
}

export function countScenes(doc: AnimDoc): number {
  return doc.scenes.length
}

export function totalDuration(doc: AnimDoc): number {
  return doc.scenes.reduce((sum, s) => sum + s.duration, 0)
}

export function sceneStart(doc: AnimDoc, index: number): number {
  let t = 0
  for (let i = 0; i < index && i < doc.scenes.length; i++) t += doc.scenes[i].duration
  return t
}

/** Which scene plays at global time `t`, and how far into it. */
export function sceneAt(doc: AnimDoc, t: number): { index: number; local: number } {
  let start = 0
  for (let i = 0; i < doc.scenes.length; i++) {
    const d = doc.scenes[i].duration
    if (t < start + d || i === doc.scenes.length - 1) {
      return { index: i, local: Math.min(Math.max(0, t - start), d) }
    }
    start += d
  }
  return { index: 0, local: 0 }
}

/** Last moment anything in a scene still moves — useful for "fit duration". */
export function sceneContentEnd(scene: Scene): number {
  let end = 0
  for (const el of scene.elements) {
    for (const cue of [el.enter, el.emphasis, el.exit]) {
      if (cue && cue.preset !== 'none') end = Math.max(end, cue.at + cue.duration)
    }
    for (const k of el.keyframes ?? []) end = Math.max(end, k.t)
  }
  return end
}

// ---------------------------------------------------------------------------
// Starter document
// ---------------------------------------------------------------------------

export type StarterLabels = {
  title: string
  subtitle: string
  step1: string
  step2: string
  step3: string
  narration1: string
  narration2: string
}

const STARTER_EN: StarterLabels = {
  title: 'How it works',
  subtitle: 'A moving explanation in three steps',
  step1: 'Input',
  step2: 'Process',
  step3: 'Result',
  narration1: 'Every explanation starts with a question.',
  narration2: 'Data flows from the input, through the process, into a result.',
}

export function starterAnimation(labels?: Partial<StarterLabels>): AnimDoc {
  const l = { ...STARTER_EN, ...labels }
  const accent = DEFAULT_ACCENT
  const box = (id: string, x: number, text: string, at: number): AnimElement => ({
    id,
    type: 'box',
    x,
    y: 300,
    w: 260,
    h: 130,
    text,
    fontSize: 34,
    bold: true,
    color: '#0f172a',
    fill: accent,
    radius: 18,
    enter: { preset: 'pop', at, duration: 0.6, easing: 'easeOutBack' },
  })
  const arrow = (id: string, x: number, at: number): AnimElement => ({
    id,
    type: 'arrow',
    x,
    y: 365,
    w: 110,
    h: 1,
    x2: x + 110,
    y2: 365,
    stroke: '#e2e8f0',
    strokeWidth: 6,
    enter: { preset: 'draw', at, duration: 0.5, easing: 'easeInOut' },
  })
  return {
    version: 1,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    fps: DEFAULT_FPS,
    background: DEFAULT_BACKGROUND,
    accent,
    captions: true,
    scenes: [
      {
        id: newId('scene'),
        title: l.title,
        duration: 3.5,
        narration: l.narration1,
        elements: [
          {
            id: newId('el'),
            type: 'icon',
            x: 580,
            y: 140,
            w: 120,
            h: 120,
            text: '🐝',
            enter: { preset: 'drop', at: 0, duration: 0.8, easing: 'easeOutBounce' },
            emphasis: { preset: 'pulse', at: 2.2, duration: 0.6 },
          },
          {
            id: newId('el'),
            type: 'text',
            x: 140,
            y: 300,
            w: 1000,
            h: 90,
            text: l.title,
            fontSize: 72,
            bold: true,
            align: 'middle',
            color: '#f8fafc',
            enter: { preset: 'rise', at: 0.4, duration: 0.7 },
          },
          {
            id: newId('el'),
            type: 'text',
            x: 140,
            y: 400,
            w: 1000,
            h: 50,
            text: l.subtitle,
            fontSize: 32,
            align: 'middle',
            color: '#94a3b8',
            enter: { preset: 'type', at: 1.1, duration: 1.2, easing: 'linear' },
          },
        ],
      },
      {
        id: newId('scene'),
        title: `${l.step1} → ${l.step3}`,
        duration: 5,
        narration: l.narration2,
        transition: 'fade',
        elements: [
          box(newId('el'), 150, l.step1, 0.3),
          arrow(newId('el'), 425, 1.0),
          box(newId('el'), 550, l.step2, 1.4),
          arrow(newId('el'), 825, 2.1),
          {
            ...box(newId('el'), 950, l.step3, 2.5),
            emphasis: { preset: 'pulse', at: 3.6, duration: 0.7 },
          },
        ],
      },
    ],
  }
}

export function starterAnimationSource(labels?: Partial<StarterLabels>): string {
  return serializeAnimation(starterAnimation(labels))
}

// ---------------------------------------------------------------------------
// Evaluation: element state at a scene-local time.
// ---------------------------------------------------------------------------

export type ElementState = {
  visible: boolean
  x: number
  y: number
  opacity: number
  scale: number
  rotate: number
  /** Offset added after keyframes — enter/exit/emphasis presets. */
  dx: number
  dy: number
  /** 0..1 progressive reveal for draw / type / wipe. */
  reveal: number
  revealMode: 'none' | 'draw' | 'type' | 'wipe'
  glow: number
}

function keyframed(el: AnimElement, t: number) {
  const base = { x: el.x, y: el.y, opacity: el.opacity ?? 1, scale: 1, rotate: 0 }
  const kfs = el.keyframes
  if (!kfs || kfs.length === 0) return base
  // Pose before the first keyframe is the element's own; each keyframe then
  // holds until the next one, which is approached with that keyframe's easing.
  let prev = { ...base, t: 0 }
  for (const k of kfs) {
    const next = {
      x: k.x ?? prev.x,
      y: k.y ?? prev.y,
      opacity: k.opacity ?? prev.opacity,
      scale: k.scale ?? prev.scale,
      rotate: k.rotate ?? prev.rotate,
      t: k.t,
    }
    if (t < k.t) {
      const span = k.t - prev.t
      const p = span <= 0 ? 1 : ease(k.easing ?? 'easeInOut', (t - prev.t) / span)
      return {
        x: lerp(prev.x, next.x, p),
        y: lerp(prev.y, next.y, p),
        opacity: lerp(prev.opacity, next.opacity, p),
        scale: lerp(prev.scale, next.scale, p),
        rotate: lerp(prev.rotate, next.rotate, p),
      }
    }
    prev = next
  }
  return { x: prev.x, y: prev.y, opacity: prev.opacity, scale: prev.scale, rotate: prev.rotate }
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p
}

export function elementState(el: AnimElement, t: number): ElementState {
  const k = keyframed(el, t)
  const s: ElementState = {
    visible: true,
    x: k.x,
    y: k.y,
    opacity: k.opacity,
    scale: k.scale,
    rotate: k.rotate,
    dx: 0,
    dy: 0,
    reveal: 1,
    revealMode: 'none',
    glow: 0,
  }

  const enter = el.enter
  if (enter && enter.preset !== 'none') {
    if (t < enter.at) {
      s.visible = false
      return s
    }
    const raw = (t - enter.at) / enter.duration
    if (raw < 1) {
      const defaultEasing: Easing =
        enter.preset === 'pop' ? 'easeOutBack' : enter.preset === 'type' ? 'linear' : 'easeOut'
      const p = ease(enter.easing ?? defaultEasing, raw)
      switch (enter.preset) {
        case 'fade':
          s.opacity *= p
          break
        case 'rise':
          s.dy += (1 - p) * 60
          s.opacity *= clamp01(raw * 1.6)
          break
        case 'drop':
          s.dy -= (1 - p) * 160
          s.opacity *= clamp01(raw * 3)
          break
        case 'slide-left':
          s.dx -= (1 - p) * 220
          s.opacity *= clamp01(raw * 2)
          break
        case 'slide-right':
          s.dx += (1 - p) * 220
          s.opacity *= clamp01(raw * 2)
          break
        case 'pop':
          s.scale *= Math.max(0, p)
          break
        case 'zoom':
          s.scale *= 0.4 + 0.6 * p
          s.opacity *= clamp01(raw * 1.5)
          break
        case 'draw':
          s.reveal = p
          s.revealMode = 'draw'
          break
        case 'type':
          s.reveal = p
          s.revealMode = 'type'
          break
        case 'wipe':
          s.reveal = p
          s.revealMode = 'wipe'
          break
      }
    }
  }

  const em = el.emphasis
  if (em && t >= em.at && t < em.at + em.duration) {
    const q = (t - em.at) / em.duration
    const bell = Math.sin(Math.PI * q)
    switch (em.preset) {
      case 'pulse':
        s.scale *= 1 + 0.14 * bell
        break
      case 'shake':
        s.dx += Math.sin(q * Math.PI * 8) * 12 * (1 - q)
        break
      case 'glow':
        s.glow = bell
        break
      case 'spin':
        s.rotate += 360 * ease(em.easing ?? 'easeInOut', q)
        break
    }
  }

  const exit = el.exit
  if (exit && exit.preset !== 'none' && t >= exit.at) {
    const raw = (t - exit.at) / exit.duration
    if (raw >= 1) {
      s.visible = false
      return s
    }
    const p = ease(exit.easing ?? 'easeIn', raw)
    switch (exit.preset) {
      case 'fade':
        s.opacity *= 1 - p
        break
      case 'sink':
        s.dy += p * 60
        s.opacity *= 1 - p
        break
      case 'shrink':
        s.scale *= 1 - p
        break
      case 'slide-left':
        s.dx -= p * 220
        s.opacity *= 1 - p
        break
      case 'slide-right':
        s.dx += p * 220
        s.opacity *= 1 - p
        break
    }
  }
  if (s.opacity <= 0.001) s.visible = false
  return s
}

// ---------------------------------------------------------------------------
// Rendering: frame(t) -> SVG markup. Pure, string-based, no DOM.
// ---------------------------------------------------------------------------

export type RenderOptions = {
  /** Prefix for clip/filter ids so several frames can share one document. */
  idPrefix?: string
  /** Map an image URL to what should be drawn (data: URLs for video export). */
  resolveSrc?: (src: string) => string
  /** Draw the caption bar (defaults to the document's `captions`). */
  captions?: boolean
  /** Rendered size of the root <svg> (defaults to the document's pixels). */
  width?: number | string
  height?: number | string
}

const FONT_STACKS: Record<FontKind, string> = {
  sans: "Inter, 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'JetBrains Mono', 'Cascadia Code', Consolas, Menlo, monospace",
}

export function renderFrameSvg(doc: AnimDoc, time: number, opts: RenderOptions = {}): string {
  const { index, local } = sceneAt(doc, time)
  const scene = doc.scenes[index]
  const prefix = opts.idPrefix ?? 'bee-anim'
  const W = doc.width
  const H = doc.height
  let body = ''

  const transition = index > 0 ? (scene.transition ?? 'none') : 'none'
  const tDur = Math.min(scene.duration, Math.max(0.05, scene.transitionDuration ?? 0.6))
  if (transition !== 'none' && local < tDur) {
    const prevScene = doc.scenes[index - 1]
    const p = ease('easeInOut', local / tDur)
    const prevLayer = sceneLayer(doc, prevScene, prevScene.duration, `${prefix}-p`, opts)
    const curLayer = sceneLayer(doc, scene, local, `${prefix}-c`, opts)
    if (transition === 'fade') {
      body = `<g>${prevLayer}</g><g opacity="${fmt(p)}">${curLayer}</g>`
    } else if (transition === 'slide') {
      body = `<g transform="translate(${fmt(-W * p)} 0)">${prevLayer}</g><g transform="translate(${fmt(W * (1 - p))} 0)">${curLayer}</g>`
    } else {
      const s = 0.8 + 0.2 * p
      body = `<g opacity="${fmt(1 - p)}">${prevLayer}</g><g opacity="${fmt(p)}" transform="translate(${fmt((W * (1 - s)) / 2)} ${fmt((H * (1 - s)) / 2)}) scale(${fmt(s)})">${curLayer}</g>`
    }
  } else {
    body = sceneLayer(doc, scene, local, `${prefix}-c`, opts)
  }

  const showCaptions = opts.captions ?? doc.captions
  if (showCaptions && scene.narration) body += captionBar(doc, scene.narration, local, scene.duration)

  const w = opts.width ?? W
  const h = opts.height ?? H
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet">${body}</svg>`
}

function sceneLayer(doc: AnimDoc, scene: Scene, t: number, prefix: string, opts: RenderOptions): string {
  let out = `<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${attr(scene.background ?? doc.background)}"/>`
  for (const el of scene.elements) out += renderElement(el, elementState(el, t), prefix, opts)
  return out
}

function captionBar(doc: AnimDoc, text: string, t: number, duration: number): string {
  const fontSize = Math.round(doc.height * 0.034)
  const maxW = doc.width * 0.8
  const lines = wrapText(text, fontSize, maxW, 'sans').slice(0, 3)
  const lineH = fontSize * 1.3
  const boxH = lines.length * lineH + fontSize * 0.9
  const y = doc.height - boxH - doc.height * 0.04
  // Fade in over the first 0.3 s and out over the last 0.3 s of the scene.
  const o = Math.min(clamp01(t / 0.3), clamp01((duration - t) / 0.3))
  const longest = Math.min(maxW, Math.max(...lines.map((l) => estimateWidth(l, fontSize, 'sans'))))
  const boxW = longest + fontSize * 1.6
  const x = (doc.width - boxW) / 2
  let tspans = ''
  lines.forEach((line, i) => {
    tspans += `<tspan x="${fmt(doc.width / 2)}" y="${fmt(y + fontSize * 0.45 + lineH * i + fontSize)}">${esc(line)}</tspan>`
  })
  return `<g opacity="${fmt(o)}"><rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(boxW)}" height="${fmt(boxH)}" rx="${fmt(fontSize * 0.5)}" fill="#000" fill-opacity="0.62"/><text font-family="${attr(FONT_STACKS.sans)}" font-size="${fontSize}" fill="#fff" text-anchor="middle">${tspans}</text></g>`
}

function renderElement(el: AnimElement, s: ElementState, prefix: string, opts: RenderOptions): string {
  if (!s.visible) return ''
  const isLine = el.type === 'line' || el.type === 'arrow'
  // Keyframes move the element's anchor; line end points travel with it.
  const offX = s.x - el.x + s.dx
  const offY = s.y - el.y + s.dy
  const x2 = el.x2 ?? el.x + el.w
  const y2 = el.y2 ?? el.y
  const cx = isLine ? (el.x + x2) / 2 : el.x + el.w / 2
  const cy = isLine ? (el.y + y2) / 2 : el.y + el.h / 2
  const transforms: string[] = []
  if (offX !== 0 || offY !== 0) transforms.push(`translate(${fmt(offX)} ${fmt(offY)})`)
  if (s.rotate !== 0 || s.scale !== 1) {
    transforms.push(`translate(${fmt(cx)} ${fmt(cy)})`)
    if (s.rotate !== 0) transforms.push(`rotate(${fmt(s.rotate)})`)
    if (s.scale !== 1) transforms.push(`scale(${fmt(Math.max(0, s.scale))})`)
    transforms.push(`translate(${fmt(-cx)} ${fmt(-cy)})`)
  }
  const id = `${prefix}-${safeId(el.id)}`
  let defs = ''
  let wrapAttrs = ''
  if (transforms.length) wrapAttrs += ` transform="${transforms.join(' ')}"`
  if (s.opacity < 1) wrapAttrs += ` opacity="${fmt(clamp01(s.opacity))}"`
  if (s.glow > 0.01) {
    const glowColor = el.stroke ?? el.fill ?? el.color ?? '#ffffff'
    defs += `<filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="0" stdDeviation="${fmt(4 + 14 * s.glow)}" flood-color="${attr(glowColor)}" flood-opacity="${fmt(0.9 * s.glow)}"/></filter>`
    wrapAttrs += ` filter="url(#${id}-glow)"`
  }
  if (s.revealMode === 'wipe' && s.reveal < 1) {
    const bx = isLine ? Math.min(el.x, x2) - 20 : el.x - 4
    const by = isLine ? Math.min(el.y, y2) - 20 : el.y - 4
    const bw = (isLine ? Math.abs(x2 - el.x) + 40 : el.w + 8) * s.reveal
    const bh = isLine ? Math.abs(y2 - el.y) + 40 : el.h + 8
    defs += `<clipPath id="${id}-wipe"><rect x="${fmt(bx)}" y="${fmt(by)}" width="${fmt(bw)}" height="${fmt(bh)}"/></clipPath>`
  }
  const clip = s.revealMode === 'wipe' && s.reveal < 1 ? ` clip-path="url(#${id}-wipe)"` : ''
  const inner = elementShape(el, s, opts)
  if (!inner) return ''
  return `${defs ? `<defs>${defs}</defs>` : ''}<g${wrapAttrs}><g${clip}>${inner}</g></g>`
}

function elementShape(el: AnimElement, s: ElementState, opts: RenderOptions): string {
  const draw = s.revealMode === 'draw' ? s.reveal : 1
  const dash = el.dashed ? ` stroke-dasharray="${fmt((el.strokeWidth ?? 3) * 3)} ${fmt((el.strokeWidth ?? 3) * 2)}"` : ''
  const drawAttrs = (len: number) =>
    draw < 1 ? ` stroke-dasharray="${fmt(len)}" stroke-dashoffset="${fmt(len * (1 - draw))}"` : dash
  switch (el.type) {
    case 'text':
      return textBlock(el, s, el.x, el.y, el.w, el.h, el.color ?? '#f8fafc', 'top')
    case 'box':
    case 'circle': {
      const fill = el.fill ?? (el.type === 'box' ? '#1e293b' : '#334155')
      const stroke = el.stroke ?? 'none'
      const sw = el.strokeWidth ?? (el.stroke ? 3 : 0)
      // "Draw" traces the outline first, then floods the fill and label in.
      const fillOpacity = draw < 1 ? clamp01((draw - 0.55) / 0.45) : 1
      const outlineStroke = draw < 1 ? (el.stroke ?? el.fill ?? '#e2e8f0') : stroke
      const outlineWidth = draw < 1 ? Math.max(sw, 3) : sw
      let shape: string
      if (el.type === 'box') {
        const r = Math.min(el.radius ?? 12, el.w / 2, el.h / 2)
        const perimeter = 2 * (el.w + el.h)
        shape = `<rect x="${fmt(el.x)}" y="${fmt(el.y)}" width="${fmt(el.w)}" height="${fmt(el.h)}" rx="${fmt(r)}" fill="${attr(fill)}" fill-opacity="${fmt(fillOpacity)}" stroke="${attr(outlineStroke)}" stroke-width="${fmt(outlineWidth)}"${outlineWidth ? drawAttrs(perimeter) : ''}/>`
      } else {
        const rx = el.w / 2
        const ry = el.h / 2
        const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
        shape = `<ellipse cx="${fmt(el.x + rx)}" cy="${fmt(el.y + ry)}" rx="${fmt(rx)}" ry="${fmt(ry)}" fill="${attr(fill)}" fill-opacity="${fmt(fillOpacity)}" stroke="${attr(outlineStroke)}" stroke-width="${fmt(outlineWidth)}"${outlineWidth ? drawAttrs(perimeter) : ''}/>`
      }
      const label = el.text
        ? textBlock({ ...el, align: el.align ?? 'middle' }, s, el.x + 12, el.y, el.w - 24, el.h, el.color ?? '#f8fafc', 'middle', fillOpacity)
        : ''
      return shape + label
    }
    case 'line':
    case 'arrow': {
      const x2 = el.x2 ?? el.x + el.w
      const y2 = el.y2 ?? el.y
      const stroke = el.stroke ?? '#e2e8f0'
      const sw = el.strokeWidth ?? 4
      const len = Math.hypot(x2 - el.x, y2 - el.y)
      let out = `<line x1="${fmt(el.x)}" y1="${fmt(el.y)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${attr(stroke)}" stroke-width="${fmt(sw)}" stroke-linecap="round"${drawAttrs(len)}/>`
      if (el.type === 'arrow' && len > 0) {
        // The head rides the tip of the line while it is being drawn.
        const tipX = el.x + (x2 - el.x) * draw
        const tipY = el.y + (y2 - el.y) * draw
        const ang = Math.atan2(y2 - el.y, x2 - el.x)
        const size = Math.max(12, sw * 3.2)
        const p1x = tipX - size * Math.cos(ang - 0.45)
        const p1y = tipY - size * Math.sin(ang - 0.45)
        const p2x = tipX - size * Math.cos(ang + 0.45)
        const p2y = tipY - size * Math.sin(ang + 0.45)
        if (draw > 0.02)
          out += `<polygon points="${fmt(tipX)},${fmt(tipY)} ${fmt(p1x)},${fmt(p1y)} ${fmt(p2x)},${fmt(p2y)}" fill="${attr(stroke)}"/>`
      }
      if (el.text) {
        const fs = el.fontSize ?? 22
        out += `<text x="${fmt((el.x + x2) / 2)}" y="${fmt((el.y + y2) / 2 - sw - 8)}" font-family="${attr(FONT_STACKS[el.font ?? 'sans'])}" font-size="${fmt(fs)}" fill="${attr(el.color ?? stroke)}" text-anchor="middle" opacity="${fmt(draw)}">${esc(el.text)}</text>`
      }
      return out
    }
    case 'icon': {
      const size = el.fontSize ?? Math.min(el.w, el.h) * 0.82
      return `<text x="${fmt(el.x + el.w / 2)}" y="${fmt(el.y + el.h / 2)}" font-size="${fmt(size)}" text-anchor="middle" dominant-baseline="central" fill="${attr(el.color ?? '#f8fafc')}" font-family="'Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', ${attr(FONT_STACKS.sans)}">${esc(el.text ?? '★')}</text>`
    }
    case 'image': {
      if (!el.src) return ''
      const href = opts.resolveSrc ? opts.resolveSrc(el.src) : el.src
      const r = el.radius ?? 0
      return `<image href="${attr(href)}" xlink:href="${attr(href)}" x="${fmt(el.x)}" y="${fmt(el.y)}" width="${fmt(el.w)}" height="${fmt(el.h)}" preserveAspectRatio="xMidYMid meet"${r ? ` style="clip-path: inset(0 round ${fmt(r)}px)"` : ''}/>`
    }
    case 'path': {
      if (!el.d) return ''
      const stroke = el.stroke ?? '#e2e8f0'
      const sw = el.strokeWidth ?? 4
      const fill = el.fill ?? 'none'
      const drawPart =
        draw < 1 ? ` pathLength="1" stroke-dasharray="1" stroke-dashoffset="${fmt(1 - draw)}"` : dash
      return `<path transform="translate(${fmt(el.x)} ${fmt(el.y)})" d="${attr(el.d)}" fill="${attr(fill)}" fill-opacity="${fmt(draw < 1 ? clamp01((draw - 0.6) / 0.4) : 1)}" stroke="${attr(stroke)}" stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"${drawPart}/>`
    }
  }
  return ''
}

function textBlock(
  el: AnimElement,
  s: ElementState,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  valign: 'top' | 'middle',
  opacity = 1,
): string {
  const text = el.text ?? ''
  if (!text) return ''
  const font = el.font ?? 'sans'
  const fontSize = el.fontSize ?? (el.type === 'text' ? 40 : 28)
  const lineH = fontSize * 1.25
  let lines = wrapText(text, fontSize, w, font)
  if (s.revealMode === 'type' && s.reveal < 1) {
    // Typewriter: reveal characters across the wrapped lines in reading order.
    let budget = Math.round(lines.reduce((n, l) => n + l.length, 0) * s.reveal)
    lines = lines.map((l) => {
      const take = Math.max(0, Math.min(l.length, budget))
      budget -= take
      return l.slice(0, take)
    })
  }
  const align = el.align ?? 'start'
  const anchor = align === 'middle' ? 'middle' : align === 'end' ? 'end' : 'start'
  const ax = align === 'middle' ? x + w / 2 : align === 'end' ? x + w : x
  const blockH = lines.length * lineH
  const top = valign === 'middle' ? y + (h - blockH) / 2 : y
  let spans = ''
  lines.forEach((line, i) => {
    spans += `<tspan x="${fmt(ax)}" y="${fmt(top + lineH * i + fontSize * 0.95)}">${esc(line) || ' '}</tspan>`
  })
  return `<text font-family="${attr(FONT_STACKS[font])}" font-size="${fmt(fontSize)}" font-weight="${el.bold ? 700 : 400}" fill="${attr(color)}" text-anchor="${anchor}"${opacity < 1 ? ` opacity="${fmt(opacity)}"` : ''} xml:space="preserve">${spans}</text>`
}

/** Glyph-width estimate: SVG cannot wrap, and frames are rendered without a DOM. */
export function estimateWidth(text: string, fontSize: number, font: FontKind): number {
  const factor = font === 'mono' ? 0.6 : font === 'serif' ? 0.5 : 0.53
  let units = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    units += code > 0x2e80 ? 1.8 : /[A-Z]|[mwMW]/.test(ch) ? 1.2 : /[il.,'!|]/.test(ch) ? 0.55 : 1
  }
  return units * fontSize * factor
}

export function wrapText(text: string, fontSize: number, maxWidth: number, font: FontKind): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (font === 'mono') {
      out.push(para)
      continue
    }
    const words = para.split(/(\s+)/).filter((w) => w.length > 0)
    let line = ''
    for (const word of words) {
      const candidate = line + word
      if (line.trim() && estimateWidth(candidate.trimEnd(), fontSize, font) > maxWidth) {
        out.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line = candidate
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return (Math.round(n * 100) / 100).toString()
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function attr(s: string): string {
  return esc(s).replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Static export
// ---------------------------------------------------------------------------

/** The moment of a scene where everything has entered — the poster frame. */
export function scenePosterTime(doc: AnimDoc, index: number): number {
  const scene = doc.scenes[index]
  if (!scene) return 0
  const settled = Math.min(scene.duration - 0.01, Math.max(0, sceneContentEnd(scene)))
  // Prefer the moment just before any exit starts.
  const exits = scene.elements
    .map((e) => (e.exit && e.exit.preset !== 'none' ? e.exit.at : Infinity))
    .filter((v) => Number.isFinite(v))
  const beforeExit = exits.length ? Math.min(...exits) - 0.01 : settled
  return sceneStart(doc, index) + Math.max(0, Math.min(settled, beforeExit))
}

/**
 * HTML snapshot for PDF / print: one poster frame per scene plus its narration,
 * which is how a moving explanation reads on paper.
 */
export function animationToHtml(source: string, title?: string): string {
  const doc = parseAnimation(source)
  const frames = doc.scenes
    .map((scene, i) => {
      const svg = renderFrameSvg(doc, scenePosterTime(doc, i), {
        idPrefix: `exp-${i}`,
        captions: false,
        width: '100%',
        height: 'auto',
      })
      const narration = scene.narration
        ? `<p class="export-animation-narration">${esc(scene.narration)}</p>`
        : ''
      return `<li class="export-animation-scene"><div class="export-animation-frame">${svg}</div><div class="export-animation-text"><strong>${i + 1}. ${esc(scene.title)}</strong>${narration}</div></li>`
    })
    .join('')
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : ''
  return `<figure class="export-diagram export-animation">${caption}<ol class="export-animation-scenes">${frames}</ol></figure>`
}
