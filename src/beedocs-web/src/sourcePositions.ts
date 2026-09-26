/**
 * Double-click-to-edit: map a point in rendered Markdown back to a character
 * offset in the Markdown source, and that offset forward to a block of the
 * hybrid editor.
 *
 * The preview side stamps `data-src="start:end"` (source offsets, from the
 * parser's positions) on the text-bearing elements. The rendered text of an
 * element is — almost always — a subsequence of its source slice (Markdown
 * only *adds* syntax around the words), so matching the text before the click
 * greedily through the source lands the caret on the same character.
 */
import { splitTextAtHeadings } from './markdownFences'

/** A spot in a page's source: grid cell (0 without a grid) + offset into that cell's Markdown. */
export type SourceTarget = { cell: number; offset: number }

/** Elements a reader would double-click to edit — prose, not embeds. */
const STAMPED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'dt', 'dd'])

type HastNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: HastNode[]
}

/** Rehype plugin: `data-src="start:end"` on every prose element. */
export function rehypeSourcePositions() {
  const visit = (node: HastNode) => {
    if (node.type === 'element' && node.tagName && STAMPED.has(node.tagName)) {
      const s = node.position?.start.offset
      const e = node.position?.end.offset
      if (s != null && e != null) node.properties = { ...node.properties, dataSrc: `${s}:${e}` }
    }
    node.children?.forEach(visit)
  }
  return (tree: HastNode) => visit(tree)
}

type CaretDoc = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

/** The DOM caret under a viewport point, in either engine's API. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDoc
  const pos = doc.caretPositionFromPoint?.(x, y)
  if (pos) return { node: pos.offsetNode, offset: pos.offset }
  const range = doc.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * Source offset for a double-click at (x, y) inside `el`, a `data-src` element
 * rendered from `source`. Null when the element carries no position.
 */
export function sourceOffsetAtPoint(el: HTMLElement, x: number, y: number, source: string): number | null {
  const m = /^(\d+):(\d+)$/.exec(el.dataset.src ?? '')
  if (!m) return null
  const start = Number(m[1])
  const end = Math.min(Number(m[2]), source.length)

  const caret = caretAt(x, y)
  if (!caret || !el.contains(caret.node)) return start
  const range = document.createRange()
  range.setStart(el, 0)
  range.setEnd(caret.node, caret.offset)
  const prefix = range.toString()

  // Greedy subsequence match of the visible characters through the source.
  let pos = start
  for (const ch of prefix) {
    if (/\s/.test(ch)) continue
    const at = source.indexOf(ch, pos)
    if (at === -1 || at >= end) break
    pos = at + 1
  }
  // Then land *on* the clicked character, past any syntax in between — the
  // `](url)` of a link or the space after `#` that the prefix alone stops short of.
  const after = document.createRange()
  after.setStart(caret.node, caret.offset)
  after.setEnd(el, el.childNodes.length)
  // The rest of the clicked word, not just its next letter: a single `h` would
  // happily match inside a link's `https://`. A word broken up by inline syntax
  // (`bo**ld**`) falls back to that one letter.
  const word = /\S+/.exec(after.toString())?.[0]
  if (word) {
    for (const probe of [word, word[0]]) {
      const at = source.indexOf(probe, pos)
      if (at !== -1 && at < end) {
        pos = at
        break
      }
    }
  }
  return pos
}

/**
 * Which text segment of a cell (in `splitMarkdownSegments` order) holds a
 * source offset, and where in that segment. Mirrors the splitter's own cuts,
 * so the indices line up with the hybrid editor's blocks as parsed on load.
 */
export function locateTextSegment(
  cellSource: string,
  offset: number,
): { segmentIndex: number; offsetInSegment: number } | null {
  // The splitter normalizes CRLF; the parser's offsets are on the raw text.
  const crs = (cellSource.slice(0, offset).match(/\r/g) ?? []).length
  const src = cellSource.replace(/\r\n/g, '\n')
  const target = offset - crs

  const re = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm
  let index = 0
  let last = 0
  let best: { segmentIndex: number; offsetInSegment: number } | null = null
  // A block's end is also the next block's start — prefer the start, so a
  // click on a heading lands in the heading's block. The end only counts as a
  // fallback, for a click on the very last character.
  let atEnd: { segmentIndex: number; offsetInSegment: number } | null = null
  const textRun = (from: number, to: number) => {
    let at = from
    for (const piece of splitTextAtHeadings(src.slice(from, to))) {
      if (!best && target >= at && target < at + piece.length) {
        best = { segmentIndex: index, offsetInSegment: target - at }
      } else if (target === at + piece.length) {
        atEnd = { segmentIndex: index, offsetInSegment: piece.length }
      }
      at += piece.length
      index++
    }
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) textRun(last, m.index)
    index++ // the fence
    last = m.index + m[0].length
  }
  if (last < src.length) textRun(last, src.length)
  return best ?? atEnd
}

/**
 * The cell of a pipe table (as `MarkdownTableEditor` addresses it: row `'h'`
 * for the header, else a body row index) at an offset into the table's raw
 * Markdown, plus the caret's position inside that cell's text. The separator
 * line counts as the header; a style-marker line above the table as its first
 * cell.
 */
export function locateTableCell(
  raw: string,
  offset: number,
): { row: 'h' | number; col: number; caret: number } {
  const lines = raw.split('\n')
  let lineStart = 0
  let li = 0
  while (li < lines.length - 1 && offset > lineStart + lines[li].length) {
    lineStart += lines[li].length + 1
    li++
  }
  // The header is the first line with a pipe — a marker comment has none.
  const headerLine = Math.max(0, lines.findIndex((l) => l.includes('|')))
  const bodyRow = li - headerLine - 2
  const row: 'h' | number = bodyRow < 0 ? 'h' : bodyRow
  if (li < headerLine || li === headerLine + 1) return { row, col: 0, caret: 0 }

  // Count the unescaped pipes before the caret; a leading pipe opens cell 0.
  const line = lines[li]
  const upto = Math.min(line.length, Math.max(0, offset - lineStart))
  const leading = line.trimStart().startsWith('|')
  let pipes = 0
  let cellStart = 0
  for (let i = 0; i < upto; i++) {
    if (line[i] === '\\') {
      i++
      continue
    }
    if (line[i] === '|') {
      pipes++
      cellStart = i + 1
    }
  }
  // Sitting right on a pipe (an empty cell's position starts there) is that
  // pipe's cell, not the one before it.
  if (line[upto] === '|' && upto > 0) {
    pipes++
    cellStart = upto + 1
  }
  const col = Math.max(0, leading ? pipes - 1 : pipes)
  // The editor shows cells trimmed; skip the padding after the pipe.
  const before = line.slice(cellStart, upto).replace(/^\s+/, '')
  return { row, col, caret: before.length }
}
