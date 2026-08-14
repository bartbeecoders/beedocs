/**
 * The slide deck document: what `slide_deck.source` holds, in one place.
 *
 * A deck is a fixed-size canvas (16:9 by default), a theme, and an ordered list
 * of slides; each slide is an ordered list of absolutely-positioned elements.
 * Element order is z-order — later elements draw on top — so "bring to front"
 * is an array move, not a property.
 *
 * The API stores the document verbatim and only ever reads `slides[].elements[]
 * .text` and `slides[].notes` (search indexing) plus `slides.length` (tree
 * badge), so fields can be added here without a server change.
 */

export type SlideElementKind = 'text' | 'shape' | 'image'

export type SlideShapeKind =
  | 'rect'
  | 'rounded'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'arrow'
  | 'line'

export type SlideTextAlign = 'left' | 'center' | 'right'
export type SlideTextVAlign = 'top' | 'middle' | 'bottom'

export type SlideElement = {
  id: string
  kind: SlideElementKind
  /** Position and size in slide coordinates (the deck's `size` space). */
  x: number
  y: number
  w: number
  h: number
  /** Degrees clockwise around the element centre. */
  rotation?: number

  /** Text content (also the label inside a shape). Plain text, newlines kept. */
  text?: string
  fontSize?: number
  /** Overrides the theme font. */
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: SlideTextAlign
  valign?: SlideTextVAlign
  /** Text colour; falls back to the theme's `color`. */
  color?: string

  /** kind=shape: which geometry to draw. */
  shape?: SlideShapeKind
  /** Shape fill. "none" for outline-only. */
  fill?: string
  stroke?: string
  strokeWidth?: number
  /** 0–100; omitted means opaque. */
  opacity?: number

  /** kind=image: uploaded (/uploads/…) or remote URL. */
  imageUrl?: string
}

export type Slide = {
  id: string
  /** Overrides the theme background for this slide only. */
  background?: string
  elements: SlideElement[]
  /** Speaker notes; shown in the editor, never on the slide. */
  notes?: string
}

export type SlideTheme = {
  background: string
  color: string
  accent: string
  fontFamily: string
}

export type SlideDeckDoc = {
  version: 1
  size: { w: number; h: number }
  theme: SlideTheme
  slides: Slide[]
}

export const SLIDE_WIDTH = 1280
export const SLIDE_HEIGHT = 720

export const DEFAULT_THEME: SlideTheme = {
  background: '#ffffff',
  color: '#1f2430',
  accent: '#f59e0b',
  fontFamily: "'Segoe UI', system-ui, sans-serif",
}

/** A handful of ready-made looks; the theme stays fully editable afterwards. */
export const SLIDE_THEMES: { id: string; label: string; theme: SlideTheme }[] = [
  { id: 'light', label: 'Light', theme: DEFAULT_THEME },
  {
    id: 'dark',
    label: 'Dark',
    theme: {
      background: '#171b26',
      color: '#e8eaf2',
      accent: '#fbbf24',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    },
  },
  {
    id: 'honey',
    label: 'Honey',
    theme: {
      background: '#fff8e7',
      color: '#3b2f13',
      accent: '#d97706',
      fontFamily: "Georgia, 'Times New Roman', serif",
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    theme: {
      background: '#0f2a43',
      color: '#eaf4ff',
      accent: '#38bdf8',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
    },
  },
]

let counter = 0

/** Unique enough within one document; readable in the JSON. */
export function newSlideId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`
}

export function newTextElement(partial?: Partial<SlideElement>): SlideElement {
  return {
    id: newSlideId('el'),
    kind: 'text',
    x: 160,
    y: 280,
    w: 960,
    h: 120,
    text: 'Text',
    fontSize: 32,
    align: 'left',
    valign: 'top',
    ...partial,
  }
}

export function newShapeElement(shape: SlideShapeKind, partial?: Partial<SlideElement>): SlideElement {
  const line = shape === 'line' || shape === 'arrow'
  return {
    id: newSlideId('el'),
    kind: 'shape',
    shape,
    x: 440,
    y: 240,
    w: 400,
    h: line ? 4 : 240,
    text: '',
    fontSize: 24,
    align: 'center',
    valign: 'middle',
    fill: line ? 'none' : '#f59e0b',
    stroke: line ? '#1f2430' : 'none',
    strokeWidth: line ? 3 : 0,
    ...partial,
  }
}

export function newImageElement(imageUrl: string, partial?: Partial<SlideElement>): SlideElement {
  return {
    id: newSlideId('el'),
    kind: 'image',
    imageUrl,
    x: 390,
    y: 160,
    w: 500,
    h: 400,
    ...partial,
  }
}

export type SlideLayoutId = 'blank' | 'title' | 'title-content' | 'section' | 'two-content'

export const SLIDE_LAYOUTS: { id: SlideLayoutId; label: string }[] = [
  { id: 'title', label: 'Title slide' },
  { id: 'title-content', label: 'Title + content' },
  { id: 'two-content', label: 'Two content' },
  { id: 'section', label: 'Section header' },
  { id: 'blank', label: 'Blank' },
]

/** A fresh slide from one of the PowerPoint-style layouts. */
export function newSlide(layout: SlideLayoutId = 'title-content'): Slide {
  const slide: Slide = { id: newSlideId('slide'), elements: [] }
  switch (layout) {
    case 'title':
      slide.elements = [
        newTextElement({
          x: 120, y: 240, w: 1040, h: 140,
          text: 'Presentation title',
          fontSize: 60, bold: true, align: 'center', valign: 'middle',
        }),
        newTextElement({
          x: 240, y: 400, w: 800, h: 70,
          text: 'Subtitle',
          fontSize: 28, align: 'center', valign: 'top',
        }),
      ]
      break
    case 'title-content':
      slide.elements = [
        newTextElement({
          x: 80, y: 50, w: 1120, h: 90,
          text: 'Slide title',
          fontSize: 44, bold: true, valign: 'middle',
        }),
        newTextElement({
          x: 80, y: 170, w: 1120, h: 480,
          text: '• First point\n• Second point\n• Third point',
          fontSize: 28,
        }),
      ]
      break
    case 'two-content':
      slide.elements = [
        newTextElement({
          x: 80, y: 50, w: 1120, h: 90,
          text: 'Slide title',
          fontSize: 44, bold: true, valign: 'middle',
        }),
        newTextElement({
          x: 80, y: 170, w: 545, h: 480,
          text: '• Left content',
          fontSize: 26,
        }),
        newTextElement({
          x: 655, y: 170, w: 545, h: 480,
          text: '• Right content',
          fontSize: 26,
        }),
      ]
      break
    case 'section':
      slide.elements = [
        newTextElement({
          x: 120, y: 280, w: 1040, h: 120,
          text: 'Section',
          fontSize: 54, bold: true, align: 'center', valign: 'middle',
        }),
      ]
      break
    case 'blank':
      break
  }
  return slide
}

/** Deep copy with fresh ids, for "duplicate slide". */
export function cloneSlide(slide: Slide): Slide {
  return {
    ...slide,
    id: newSlideId('slide'),
    elements: slide.elements.map((el) => ({ ...el, id: newSlideId('el') })),
  }
}

export function emptyDeck(): SlideDeckDoc {
  return {
    version: 1,
    size: { w: SLIDE_WIDTH, h: SLIDE_HEIGHT },
    theme: { ...DEFAULT_THEME },
    slides: [newSlide('title')],
  }
}

/** The document a brand-new deck starts from: a title slide carrying the deck's name. */
export function starterDeckSource(title: string): string {
  const deck = emptyDeck()
  const titleEl = deck.slides[0].elements[0]
  if (titleEl) titleEl.text = title
  return serializeDeck(deck)
}

/**
 * Parse a stored document, tolerantly: a missing or broken source becomes a
 * one-slide empty deck rather than a crash, and absent fields take defaults so
 * documents written by older builds keep opening.
 */
export function parseDeck(source: string | null | undefined): SlideDeckDoc {
  if (!source || !source.trim()) return emptyDeck()
  try {
    const raw = JSON.parse(source) as Partial<SlideDeckDoc>
    if (typeof raw !== 'object' || raw === null) return emptyDeck()
    const slides = Array.isArray(raw.slides) ? raw.slides : []
    return {
      version: 1,
      size: {
        w: raw.size?.w && raw.size.w > 0 ? raw.size.w : SLIDE_WIDTH,
        h: raw.size?.h && raw.size.h > 0 ? raw.size.h : SLIDE_HEIGHT,
      },
      theme: { ...DEFAULT_THEME, ...(raw.theme ?? {}) },
      slides: slides.length
        ? slides.map((s) => ({
            id: s?.id || newSlideId('slide'),
            background: s?.background,
            notes: s?.notes,
            elements: Array.isArray(s?.elements) ? s.elements.filter(Boolean) : [],
          }))
        : [newSlide('blank')],
    }
  } catch {
    return emptyDeck()
  }
}

export function serializeDeck(deck: SlideDeckDoc): string {
  return JSON.stringify(deck)
}
