import { splitMarkdownSegments, type ContentSegment } from './markdownFences'

export type PageOutlineKind = 'heading' | 'diagram' | 'freedraw' | 'excelgrid' | 'media' | 'code' | 'block'

export type PageOutlineItem = {
  /** Stable DOM id used for scroll targets (`page-ol-N`). */
  id: string
  /** Segment index in the hybrid page editor. */
  blockIndex: number
  /** Heading depth 1–6, or 7 for non-heading embeds. */
  level: number
  label: string
  kind: PageOutlineKind
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/m

/**
 * Build a navigation outline for a page from its Markdown source.
 * One entry per hybrid editor block that is a heading section or a major embed.
 */
export function buildPageOutline(content: string): PageOutlineItem[] {
  const segments = splitMarkdownSegments(content ?? '')
  const items: PageOutlineItem[] = []

  segments.forEach((seg, blockIndex) => {
    const item = outlineItemForSegment(seg, blockIndex)
    if (item) items.push(item)
  })

  return items
}

function outlineItemForSegment(seg: ContentSegment, blockIndex: number): PageOutlineItem | null {
  const id = outlineId(blockIndex)

  if (seg.type === 'text') {
    const m = HEADING_RE.exec(seg.text.trimStart())
    if (!m) return null
    const level = m[1].length
    const label = cleanLabel(m[2])
    if (!label) return null
    return { id, blockIndex, level, label, kind: 'heading' }
  }

  const lang = seg.lang.toLowerCase()
  if (lang === 'beediagram' || lang === 'beediagram-ref') {
    return {
      id,
      blockIndex,
      level: 7,
      label: lang === 'beediagram-ref' ? 'Linked diagram' : 'BeeDiagram',
      kind: 'diagram',
    }
  }
  if (lang === 'freedraw' || lang === 'sketch') {
    return { id, blockIndex, level: 7, label: 'Sketch', kind: 'freedraw' }
  }
  if (lang === 'excelgrid' || lang === 'spreadsheet' || lang === 'grid') {
    return { id, blockIndex, level: 7, label: 'Spreadsheet', kind: 'excelgrid' }
  }
  if (lang === 'pdf' || lang === 'glb' || lang === 'gltf' || lang === 'obj' || lang === 'model') {
    return {
      id,
      blockIndex,
      level: 7,
      label: lang === 'pdf' ? 'PDF' : '3D model',
      kind: 'media',
    }
  }
  if (lang === 'mermaid' || lang === 'c4' || lang === 'plantuml') {
    return {
      id,
      blockIndex,
      level: 7,
      label: lang === 'c4' ? 'C4 diagram' : lang === 'plantuml' ? 'PlantUML' : 'Mermaid',
      kind: 'code',
    }
  }
  // Other fences (json, code) — only list if non-empty and somewhat substantial
  if (seg.body.trim().length > 40) {
    return {
      id,
      blockIndex,
      level: 7,
      label: lang && lang !== 'text' ? lang : 'Code',
      kind: 'code',
    }
  }
  return null
}

export function outlineId(blockIndex: number): string {
  return `page-ol-${blockIndex}`
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → text
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Find the nearest scrollable ancestor of an element. */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el
  while (cur) {
    const { overflowY } = getComputedStyle(cur)
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      cur.scrollHeight > cur.clientHeight + 1
    ) {
      return cur
    }
    cur = cur.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/**
 * Scroll so the outline target is visible, preferably near the top of the
 * workspace centre pane (not only the nested editor scroller).
 */
export function scrollToOutlineTarget(id: string, root?: HTMLElement | null): boolean {
  const scope = root ?? document
  const target =
    (scope instanceof Document ? scope.getElementById(id) : scope.querySelector(`#${CSS.escape(id)}`)) ??
    scope.querySelector?.(`[data-outline-id="${CSS.escape(id)}"]`)
  if (!(target instanceof HTMLElement)) return false

  // Prefer scrolling the main workspace centre so the sticky header stays usable.
  const wsCenter = document.querySelector('.ws-center')
  const scroller =
    (wsCenter instanceof HTMLElement && wsCenter.contains(target)
      ? findScrollParent(target) ?? wsCenter
      : findScrollParent(target)) ?? null

  if (scroller && scroller !== document.documentElement && scroller !== document.body) {
    const scRect = scroller.getBoundingClientRect()
    const tRect = target.getBoundingClientRect()
    const offset = tRect.top - scRect.top + scroller.scrollTop - 12
    scroller.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' })
  } else {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Brief highlight so the jump is obvious.
  target.classList.add('outline-target-flash')
  window.setTimeout(() => target.classList.remove('outline-target-flash'), 1200)
  return true
}
