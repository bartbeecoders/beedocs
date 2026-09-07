/**
 * OneNote-style note documents stored as book items (`note.source`) and as
 * ```note fenced blocks on a page. A note is a free-form canvas: blocks sit at
 * absolute positions (click anywhere to type), ink is drawn over everything.
 * The server stores this JSON verbatim and reads only the block texts (search)
 * and the block count (tree badge).
 *
 * Coordinates are CSS pixels on the note page, origin top-left. Ink strokes
 * carry page coordinates too (not block-relative), so drawing never has to
 * re-base points when a stroke grows the block's bounding box; moving an ink
 * block translates its points.
 */

export const NOTE_BACKGROUNDS = ['plain', 'ruled', 'grid', 'dots'] as const
export type NoteBackground = (typeof NOTE_BACKGROUNDS)[number]

/** Page colours, OneNote-style. `white` follows the theme's elevated surface. */
export const NOTE_PAPERS = ['white', 'cream', 'mint', 'sky', 'lavender', 'rose', 'graphite'] as const
export type NotePaper = (typeof NOTE_PAPERS)[number]

/** OneNote's built-in tags, minus "To Do" which is a checklist block here. */
export const NOTE_TAGS = ['important', 'question', 'idea', 'remember', 'critical', 'definition', 'contact'] as const
export type NoteTag = (typeof NOTE_TAGS)[number]

export const NOTE_TAG_GLYPH: Record<NoteTag, string> = {
  important: '★',
  question: '?',
  idea: '💡',
  remember: '📌',
  critical: '!',
  definition: '§',
  contact: '☎',
}

/** Pen colours offered in the toolbar. Any CSS colour is accepted in a document. */
export const NOTE_PEN_COLORS = ['#1f2933', '#d64545', '#2f6fdb', '#1c8f4a', '#e08a00', '#8a3ffc', '#e91e63'] as const
export const NOTE_HIGHLIGHT_COLORS = ['#ffe733', '#7cf59a', '#7fd4ff', '#ffa4d0'] as const

export type NoteBlockBase = {
  id: string
  x: number
  y: number
  w: number
  /** Null = auto height (text, checklist). Images and ink always carry one. */
  h: number | null
}

export type NoteTextBlock = NoteBlockBase & {
  kind: 'text'
  /** Markdown (GFM). */
  text: string
  tag: NoteTag | null
}

export type NoteChecklistItem = {
  id: string
  text: string
  done: boolean
}

export type NoteChecklistBlock = NoteBlockBase & {
  kind: 'checklist'
  title: string
  items: NoteChecklistItem[]
}

export type NoteImageBlock = NoteBlockBase & {
  kind: 'image'
  /** `/uploads/…` from `/api/uploads`, or any URL. */
  src: string
  alt: string
}

export type NoteStroke = {
  id: string
  color: string
  width: number
  /** 1 for a pen, ~0.4 for a highlighter. */
  opacity: number
  /** Flat page-coordinate pairs: x0, y0, x1, y1, … */
  points: number[]
}

export type NoteInkBlock = NoteBlockBase & {
  kind: 'ink'
  strokes: NoteStroke[]
}

export type NoteBlock = NoteTextBlock | NoteChecklistBlock | NoteImageBlock | NoteInkBlock
export type NoteBlockKind = NoteBlock['kind']

export type NoteDoc = {
  version: 1
  background: NoteBackground
  paper: NotePaper
  /** Array order is z-order: later blocks draw on top. */
  blocks: NoteBlock[]
}

export const NOTE_MIN_TEXT_W = 120
export const NOTE_DEFAULT_TEXT_W = 320
export const NOTE_DEFAULT_CHECKLIST_W = 280
export const NOTE_MAX_IMAGE_W = 520
/** Extra room past the furthest block so there is always empty page to click. */
export const NOTE_PAGE_PADDING = 480

export function newId(prefix: string): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `${prefix}-${raw}`
}

export function emptyNote(): NoteDoc {
  return { version: 1, background: 'plain', paper: 'white', blocks: [] }
}

export type StarterLabels = {
  heading: string
  body: string
  checklistTitle: string
  item1: string
  item2: string
}

/** A title, a hint and a small to-do list so a new note is not a blank sheet. */
export function starterNote(labels?: Partial<StarterLabels>): NoteDoc {
  const heading = labels?.heading?.trim() || 'Meeting notes'
  const body =
    labels?.body?.trim() ||
    'Click anywhere on the page to start typing. Drag a block by its top bar, draw with the pen.'
  return {
    version: 1,
    background: 'plain',
    paper: 'white',
    blocks: [
      {
        id: newId('blk'),
        kind: 'text',
        x: 48,
        y: 40,
        w: 460,
        h: null,
        text: `# ${heading}\n\n${body}`,
        tag: null,
      },
      {
        id: newId('blk'),
        kind: 'checklist',
        x: 48,
        y: 190,
        w: NOTE_DEFAULT_CHECKLIST_W,
        h: null,
        title: labels?.checklistTitle?.trim() || 'To do',
        items: [
          { id: newId('chk'), text: labels?.item1?.trim() || 'Agree next steps', done: false },
          { id: newId('chk'), text: labels?.item2?.trim() || 'Share the summary', done: false },
        ],
      },
    ],
  }
}

export function starterNoteSource(labels?: Partial<StarterLabels>): string {
  return serializeNote(starterNote(labels))
}

export function serializeNote(doc: NoteDoc): string {
  return JSON.stringify(doc, null, 2)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function isBackground(v: unknown): v is NoteBackground {
  return typeof v === 'string' && (NOTE_BACKGROUNDS as readonly string[]).includes(v)
}

function isPaper(v: unknown): v is NotePaper {
  return typeof v === 'string' && (NOTE_PAPERS as readonly string[]).includes(v)
}

function isTag(v: unknown): v is NoteTag {
  return typeof v === 'string' && (NOTE_TAGS as readonly string[]).includes(v)
}

function parseStroke(raw: unknown): NoteStroke | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pts = Array.isArray(r.points) ? r.points.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)) : []
  if (pts.length < 2) return null
  if (pts.length % 2 === 1) pts.pop()
  return {
    id: str(r.id) || newId('stk'),
    color: str(r.color) || NOTE_PEN_COLORS[0],
    width: Math.max(1, num(r.width, 3)),
    opacity: Math.min(1, Math.max(0.05, num(r.opacity, 1))),
    points: pts,
  }
}

function parseBlock(raw: unknown): NoteBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const base: NoteBlockBase = {
    id: str(r.id) || newId('blk'),
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(24, num(r.w, NOTE_DEFAULT_TEXT_W)),
    h: typeof r.h === 'number' && Number.isFinite(r.h) && r.h > 0 ? r.h : null,
  }
  switch (r.kind) {
    case 'text':
      return { ...base, kind: 'text', text: str(r.text), tag: isTag(r.tag) ? r.tag : null }
    case 'checklist': {
      const items = Array.isArray(r.items)
        ? r.items
            .map((it): NoteChecklistItem | null => {
              if (!it || typeof it !== 'object') return null
              const i = it as Record<string, unknown>
              return { id: str(i.id) || newId('chk'), text: str(i.text), done: i.done === true }
            })
            .filter((it): it is NoteChecklistItem => it !== null)
        : []
      return { ...base, kind: 'checklist', title: str(r.title), items }
    }
    case 'image': {
      const src = str(r.src)
      if (!src) return null
      return { ...base, kind: 'image', src, alt: str(r.alt), h: base.h ?? 200 }
    }
    case 'ink': {
      const strokes = Array.isArray(r.strokes)
        ? r.strokes.map(parseStroke).filter((s): s is NoteStroke => s !== null)
        : []
      if (strokes.length === 0) return null
      return withInkBounds({ ...base, kind: 'ink', strokes, h: base.h ?? 0 })
    }
    default:
      return null
  }
}

/**
 * Tolerant parse: missing fields take defaults, unknown blocks are dropped, a
 * broken document opens as an empty page rather than an error.
 */
export function parseNote(source: string | null | undefined): NoteDoc {
  if (!source || !source.trim()) return emptyNote()
  try {
    const raw = JSON.parse(source) as unknown
    if (!raw || typeof raw !== 'object') return emptyNote()
    const r = raw as Record<string, unknown>
    const blocks = Array.isArray(r.blocks)
      ? r.blocks.map(parseBlock).filter((b): b is NoteBlock => b !== null)
      : []
    return {
      version: 1,
      background: isBackground(r.background) ? r.background : 'plain',
      paper: isPaper(r.paper) ? r.paper : 'white',
      blocks,
    }
  } catch {
    return emptyNote()
  }
}

export function countBlocks(doc: NoteDoc): number {
  return doc.blocks.length
}

/** Page extent (px) so the canvas always has empty room past the last block. */
export function noteExtent(doc: NoteDoc): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const b of doc.blocks) {
    width = Math.max(width, b.x + b.w)
    height = Math.max(height, b.y + (b.h ?? estimateHeight(b)))
  }
  return { width: width + NOTE_PAGE_PADDING, height: height + NOTE_PAGE_PADDING }
}

/** Rough rendered height for auto-sized blocks (export layout, extent). */
export function estimateHeight(b: NoteBlock): number {
  if (b.h != null) return b.h
  if (b.kind === 'text') {
    const lines = b.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((line.length * 7.2) / Math.max(80, b.w - 24))), 0)
    return 24 + Math.max(1, lines) * 22
  }
  if (b.kind === 'checklist') return 40 + b.items.length * 26
  return 120
}

// ---- editing helpers (pure) ----

export function findBlock(doc: NoteDoc, id: string): NoteBlock | undefined {
  return doc.blocks.find((b) => b.id === id)
}

export function addBlock(doc: NoteDoc, block: NoteBlock): NoteDoc {
  return { ...doc, blocks: [...doc.blocks, block] }
}

export function newTextBlock(x: number, y: number, text = ''): NoteTextBlock {
  return { id: newId('blk'), kind: 'text', x: Math.max(0, x), y: Math.max(0, y), w: NOTE_DEFAULT_TEXT_W, h: null, text, tag: null }
}

export function newChecklistBlock(x: number, y: number, title = ''): NoteChecklistBlock {
  return {
    id: newId('blk'),
    kind: 'checklist',
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: NOTE_DEFAULT_CHECKLIST_W,
    h: null,
    title,
    items: [{ id: newId('chk'), text: '', done: false }],
  }
}

export function newImageBlock(x: number, y: number, src: string, alt: string, w: number, h: number): NoteImageBlock {
  return { id: newId('blk'), kind: 'image', x: Math.max(0, x), y: Math.max(0, y), w, h, src, alt }
}

export function updateBlock<K extends NoteBlock>(doc: NoteDoc, id: string, patch: Partial<K>): NoteDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as NoteBlock) : b)),
  }
}

export function removeBlock(doc: NoteDoc, id: string): NoteDoc {
  return { ...doc, blocks: doc.blocks.filter((b) => b.id !== id) }
}

/** Move a block; ink blocks carry their strokes along. */
export function moveBlock(doc: NoteDoc, id: string, dx: number, dy: number): NoteDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      if (b.id !== id) return b
      const nx = Math.max(0, b.x + dx)
      const ny = Math.max(0, b.y + dy)
      const ddx = nx - b.x
      const ddy = ny - b.y
      if (b.kind === 'ink') {
        return {
          ...b,
          x: nx,
          y: ny,
          strokes: b.strokes.map((s) => ({
            ...s,
            points: s.points.map((v, i) => (i % 2 === 0 ? v + ddx : v + ddy)),
          })),
        }
      }
      return { ...b, x: nx, y: ny }
    }),
  }
}

export function bringToFront(doc: NoteDoc, id: string): NoteDoc {
  const b = findBlock(doc, id)
  if (!b) return doc
  return { ...doc, blocks: [...doc.blocks.filter((x) => x.id !== id), b] }
}

export function sendToBack(doc: NoteDoc, id: string): NoteDoc {
  const b = findBlock(doc, id)
  if (!b) return doc
  return { ...doc, blocks: [b, ...doc.blocks.filter((x) => x.id !== id)] }
}

export function strokeBounds(strokes: NoteStroke[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let pad = 0
  for (const s of strokes) {
    pad = Math.max(pad, s.width / 2 + 2)
    for (let i = 0; i + 1 < s.points.length; i += 2) {
      const x = s.points[i]!
      const y = s.points[i + 1]!
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

export function withInkBounds(b: NoteInkBlock): NoteInkBlock {
  const r = strokeBounds(b.strokes)
  return { ...b, x: r.x, y: r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) }
}

/** Append a stroke to an ink block (or start a new block when `inkId` is null). Returns the block id. */
export function addStroke(doc: NoteDoc, inkId: string | null, stroke: NoteStroke): { doc: NoteDoc; inkId: string } {
  const existing = inkId ? findBlock(doc, inkId) : undefined
  if (existing && existing.kind === 'ink') {
    const next = withInkBounds({ ...existing, strokes: [...existing.strokes, stroke] })
    return { doc: { ...doc, blocks: doc.blocks.map((b) => (b.id === existing.id ? next : b)) }, inkId: existing.id }
  }
  const block = withInkBounds({ id: newId('blk'), kind: 'ink', x: 0, y: 0, w: 0, h: 0, strokes: [stroke] })
  return { doc: addBlock(doc, block), inkId: block.id }
}

/** Remove one stroke; an ink block with no strokes left disappears. */
export function removeStroke(doc: NoteDoc, inkId: string, strokeId: string): NoteDoc {
  return {
    ...doc,
    blocks: doc.blocks.flatMap((b) => {
      if (b.id !== inkId || b.kind !== 'ink') return [b]
      const strokes = b.strokes.filter((s) => s.id !== strokeId)
      return strokes.length === 0 ? [] : [withInkBounds({ ...b, strokes })]
    }),
  }
}

/** Squared distance from a point to a segment. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * vx
  const cy = ay + t * vy
  return (px - cx) * (px - cx) + (py - cy) * (py - cy)
}

/** The stroke under a point (eraser hit-test), searched top-most first. */
export function strokeAt(doc: NoteDoc, x: number, y: number, radius = 6): { inkId: string; strokeId: string } | null {
  for (let bi = doc.blocks.length - 1; bi >= 0; bi -= 1) {
    const b = doc.blocks[bi]!
    if (b.kind !== 'ink') continue
    if (x < b.x - radius || y < b.y - radius || x > b.x + b.w + radius || y > b.y + (b.h ?? 0) + radius) continue
    for (let si = b.strokes.length - 1; si >= 0; si -= 1) {
      const s = b.strokes[si]!
      const r = radius + s.width / 2
      const r2 = r * r
      const p = s.points
      if (p.length === 2) {
        if ((p[0]! - x) ** 2 + (p[1]! - y) ** 2 <= r2) return { inkId: b.id, strokeId: s.id }
        continue
      }
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (segDist2(x, y, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!) <= r2) return { inkId: b.id, strokeId: s.id }
      }
    }
  }
  return null
}

/** SVG path data for a stroke (straight segments; a dot for a single point). */
export function strokePath(s: NoteStroke): string {
  const p = s.points
  if (p.length < 2) return ''
  if (p.length === 2) return `M ${p[0]} ${p[1]} l 0.01 0`
  let d = `M ${p[0]} ${p[1]}`
  for (let i = 2; i + 1 < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`
  return d
}

/** Next free spot below everything, for toolbar-inserted blocks. */
export function nextFreeSpot(doc: NoteDoc): { x: number; y: number } {
  if (doc.blocks.length === 0) return { x: 48, y: 40 }
  let bottom = 0
  for (const b of doc.blocks) bottom = Math.max(bottom, b.y + (b.h ?? estimateHeight(b)))
  return { x: 48, y: bottom + 24 }
}

/** Plain text of a note, block by block — what search and previews see. */
export function noteText(doc: NoteDoc): string {
  const out: string[] = []
  for (const b of doc.blocks) {
    if (b.kind === 'text' && b.text.trim()) out.push(b.text.trim())
    else if (b.kind === 'checklist') {
      if (b.title.trim()) out.push(b.title.trim())
      for (const it of b.items) if (it.text.trim()) out.push(`${it.done ? '☑' : '☐'} ${it.text.trim()}`)
    } else if (b.kind === 'image' && b.alt.trim()) out.push(b.alt.trim())
  }
  return out.join('\n')
}

// ---- export (PDF / HTML) ----

const PAPER_HEX: Record<NotePaper, string> = {
  white: '#ffffff',
  cream: '#fdf6e3',
  mint: '#edf8f0',
  sky: '#eaf3fc',
  lavender: '#f1ecfa',
  rose: '#fbeef1',
  graphite: '#e9ebee',
}

function backgroundCss(bg: NoteBackground): string {
  switch (bg) {
    case 'ruled':
      return 'background-image: linear-gradient(transparent 23px, rgba(80,120,200,0.25) 23px, rgba(80,120,200,0.25) 24px); background-size: 100% 24px;'
    case 'grid':
      return 'background-image: linear-gradient(rgba(120,130,150,0.22) 1px, transparent 1px), linear-gradient(90deg, rgba(120,130,150,0.22) 1px, transparent 1px); background-size: 24px 24px;'
    case 'dots':
      return 'background-image: radial-gradient(rgba(120,130,150,0.45) 1px, transparent 1.5px); background-size: 24px 24px;'
    default:
      return ''
  }
}

/** Minimal Markdown → HTML for export text blocks (headings, lists, emphasis, code). */
export function noteMarkdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`)
      continue
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      const body = (ul ?? ol)![1]!
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(body)
      out.push(task ? `<li>${task[1] === ' ' ? '☐' : '☑'} ${inline(task[2]!)}</li>` : `<li>${inline(body)}</li>`)
      continue
    }
    closeList()
    if (!line.trim()) continue
    if (line.startsWith('> ')) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`)
    else out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('')
}

export function noteToHtml(source: string, title?: string): string {
  const doc = parseNote(source)
  const extent = noteExtent(doc)
  const width = Math.max(640, extent.width - NOTE_PAGE_PADDING + 48)
  const height = Math.max(240, extent.height - NOTE_PAGE_PADDING + 48)
  const blocks = doc.blocks
    .map((b) => {
      const style = `left:${b.x}px;top:${b.y}px;width:${b.w}px;${b.h != null ? `height:${b.h}px;` : ''}`
      switch (b.kind) {
        case 'text': {
          const tag = b.tag ? `<span class="export-note-tag" title="${esc(b.tag)}">${esc(NOTE_TAG_GLYPH[b.tag])}</span>` : ''
          return `<div class="export-note-block export-note-text" style="${style}">${tag}${noteMarkdownToHtml(b.text)}</div>`
        }
        case 'checklist': {
          const items = b.items
            .map((it) => `<li${it.done ? ' class="is-done"' : ''}>${it.done ? '☑' : '☐'} ${esc(it.text)}</li>`)
            .join('')
          const head = b.title.trim() ? `<strong>${esc(b.title)}</strong>` : ''
          return `<div class="export-note-block export-note-checklist" style="${style}">${head}<ul>${items}</ul></div>`
        }
        case 'image':
          return `<div class="export-note-block export-note-image" style="${style}"><img src="${esc(b.src)}" alt="${esc(b.alt)}" style="width:100%;height:100%;object-fit:contain" /></div>`
        case 'ink': {
          const paths = b.strokes
            .map(
              (s) =>
                `<path d="${strokePath(s)}" fill="none" stroke="${esc(s.color)}" stroke-width="${s.width}" stroke-opacity="${s.opacity}" stroke-linecap="round" stroke-linejoin="round" />`,
            )
            .join('')
          return `<svg class="export-note-ink" style="position:absolute;left:0;top:0;overflow:visible" width="${width}" height="${height}">${paths}</svg>`
        }
      }
    })
    .join('')
  const caption = title ? `<figcaption>${esc(title)}</figcaption>` : ''
  return `<figure class="export-diagram export-note">${caption}<div class="export-note-page" style="position:relative;width:${width}px;height:${height}px;background:${PAPER_HEX[doc.paper]};${backgroundCss(doc.background)}">${blocks}</div></figure>`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
