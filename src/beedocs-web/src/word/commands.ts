/**
 * Formatting commands over the live selection.
 *
 * Inline formatting (bold, colour, font) goes through `execCommand`, which
 * the browser implements well and which handles partially formatted
 * selections; paragraph-level commands (style, alignment, spacing, indent)
 * are implemented here on the block elements the selection touches, because
 * `formatBlock` cannot carry a style id and `indent` wraps text in
 * blockquotes. Every command leaves the selection where it was.
 */

const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,div:not(.docx-raw),blockquote,pre'

export type BlockElement = HTMLElement

export function exec(command: string, value?: string): boolean {
  try {
    return document.execCommand(command, false, value)
  } catch {
    return false
  }
}

export function queryState(command: string): boolean {
  try {
    return document.queryCommandState(command)
  } catch {
    return false
  }
}

export function currentRange(body: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!body.contains(range.commonAncestorContainer)) return null
  return range
}

export function setRange(range: Range) {
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

/** The nearest block ancestor of a node, staying inside the body. */
export function blockOf(body: HTMLElement, node: Node | null): BlockElement | null {
  let cur: Node | null = node
  while (cur && cur !== body) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement
      if (el.closest('.docx-raw')) return null
      if (el.matches(BLOCK_SELECTOR)) return el
    }
    cur = cur.parentNode
  }
  return null
}

/** Every block the selection touches, in document order (a collapsed caret gives one). */
export function selectedBlocks(body: HTMLElement): BlockElement[] {
  const range = currentRange(body)
  if (!range) return []
  const start = blockOf(body, range.startContainer)
  const end = blockOf(body, range.endContainer)
  if (!start && !end) return []
  if (range.collapsed || start === end) return start ? [start] : end ? [end] : []
  const all = Array.from(body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter(
    (el) => !el.closest('.docx-raw') && range.intersectsNode(el),
  )
  // Keep innermost blocks only (a div wrapping paragraphs is not itself a paragraph).
  return all.filter((el) => !all.some((other) => other !== el && el.contains(other)))
}

/**
 * Run a DOM mutation and put the selection back afterwards. `remap` translates
 * a selection container the mutation replaced (an element swapped for another
 * tag) to its successor; anything else that vanished falls back to the body.
 */
export function preservingSelection(body: HTMLElement, fn: () => void, remap?: (node: Node) => Node | null) {
  const range = currentRange(body)
  const saved = range
    ? { sc: range.startContainer, so: range.startOffset, ec: range.endContainer, eo: range.endOffset }
    : null
  fn()
  if (!saved) return
  const resolve = (node: Node, offset: number): [Node, number] => {
    if (node.isConnected) return [node, Math.min(offset, node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length)]
    const mapped = remap?.(node)
    if (mapped?.isConnected) return [mapped, Math.min(offset, mapped.childNodes.length)]
    return [body, 0]
  }
  try {
    const r = document.createRange()
    const [sc, so] = resolve(saved.sc, saved.so)
    const [ec, eo] = resolve(saved.ec, saved.eo)
    r.setStart(sc, so)
    r.setEnd(ec, eo)
    setRange(r)
  } catch {
    /* the nodes moved; leave the browser's selection */
  }
}

const HEADING_TAGS: Record<string, string> = {
  Heading1: 'h1',
  Heading2: 'h2',
  Heading3: 'h3',
  Heading4: 'h4',
  Heading5: 'h5',
  Heading6: 'h6',
}

/** Replace a block's tag, keeping attributes, children and the selection inside. */
function retag(body: HTMLElement, el: HTMLElement, tag: string): HTMLElement {
  if (el.tagName.toLowerCase() === tag) return el
  const next = document.createElement(tag)
  for (const attr of Array.from(el.attributes)) next.setAttribute(attr.name, attr.value)
  while (el.firstChild) next.appendChild(el.firstChild)
  preservingSelection(body, () => el.replaceWith(next), (node) => (node === el ? next : null))
  return next
}

export function applyParagraphStyle(body: HTMLElement, styleId: string) {
  for (const block of selectedBlocks(body)) {
    const isLi = block.tagName === 'LI'
    const wanted = isLi ? 'li' : (HEADING_TAGS[styleId] ?? 'p')
    const el = retag(body, block, wanted)
    if (styleId === 'Normal' || (isLi && styleId === 'ListParagraph')) el.removeAttribute('data-style')
    else el.setAttribute('data-style', styleId)
  }
}

export function currentParagraphStyle(body: HTMLElement): string {
  const block = selectedBlocks(body)[0]
  if (!block) return 'Normal'
  const explicit = block.getAttribute('data-style')
  if (explicit) return explicit
  const tag = block.tagName.toLowerCase()
  const heading = Object.entries(HEADING_TAGS).find(([, t]) => t === tag)
  return heading ? heading[0] : 'Normal'
}

export function setAlignment(body: HTMLElement, align: 'left' | 'center' | 'right' | 'justify') {
  for (const block of selectedBlocks(body)) {
    if (align === 'left') block.style.removeProperty('text-align')
    else block.style.textAlign = align
    tidyStyle(block)
  }
}

export function currentAlignment(body: HTMLElement): 'left' | 'center' | 'right' | 'justify' {
  const block = selectedBlocks(body)[0]
  if (!block) return 'left'
  const v = getComputedStyle(block).textAlign
  if (v === 'center') return 'center'
  if (v === 'right' || v === 'end') return 'right'
  if (v === 'justify') return 'justify'
  return 'left'
}

export function setLineSpacing(body: HTMLElement, value: number | null) {
  for (const block of selectedBlocks(body)) {
    if (value == null) block.style.removeProperty('line-height')
    else block.style.lineHeight = String(value)
    tidyStyle(block)
  }
}

export function setParagraphSpacing(body: HTMLElement, which: 'before' | 'after', pt: number | null) {
  const prop = which === 'before' ? 'margin-top' : 'margin-bottom'
  for (const block of selectedBlocks(body)) {
    if (pt == null) block.style.removeProperty(prop)
    else block.style.setProperty(prop, `${pt}pt`)
    tidyStyle(block)
  }
}

/** Word's ½-inch indent step for ordinary paragraphs; list items nest instead. */
export function indent(body: HTMLElement, direction: 1 | -1) {
  const blocks = selectedBlocks(body)
  if (blocks.some((b) => b.tagName === 'LI')) {
    exec(direction > 0 ? 'indent' : 'outdent')
    return
  }
  for (const block of blocks) {
    const current = parseFloat(block.style.marginLeft || '0') || 0
    const unit = block.style.marginLeft?.endsWith('px') ? 48 : 36
    const next = Math.max(0, current + direction * unit)
    if (next === 0) block.style.removeProperty('margin-left')
    else block.style.marginLeft = `${next}${block.style.marginLeft?.endsWith('px') ? 'px' : 'pt'}`
    tidyStyle(block)
  }
}

function tidyStyle(el: HTMLElement) {
  if (!el.getAttribute('style')) el.removeAttribute('style')
}

/**
 * Font size in points. `execCommand('fontSize')` only knows the seven legacy
 * sizes, so size 7 is applied as a marker and rewritten to the real value.
 */
export function setFontSize(body: HTMLElement, pt: number) {
  exec('fontSize', '7')
  body.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((el) => {
    if (el.tagName === 'FONT') {
      const span = document.createElement('span')
      span.style.fontSize = `${pt}pt`
      while (el.firstChild) span.appendChild(el.firstChild)
      el.replaceWith(span)
    } else {
      el.style.fontSize = `${pt}pt`
    }
  })
}

/** Font size at the caret, in points, from computed style. */
export function currentFontSize(body: HTMLElement): number {
  const node = anchorElement(body)
  if (!node) return 11
  const px = parseFloat(getComputedStyle(node).fontSize)
  return Math.round(px * 0.75 * 2) / 2
}

export function currentFontFamily(body: HTMLElement): string {
  const node = anchorElement(body)
  if (!node) return ''
  const family = getComputedStyle(node).fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
  return family
}

export function anchorElement(body: HTMLElement): HTMLElement | null {
  const sel = window.getSelection()
  const node = sel?.anchorNode ?? null
  if (!node || !body.contains(node)) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
}

export function setFontFamily(body: HTMLElement, family: string) {
  void body
  exec('fontName', family)
}

export function setTextColor(body: HTMLElement, color: string | null) {
  void body
  if (color) exec('foreColor', color)
  else {
    // "Automatic": drop explicit colours in the selection.
    exec('foreColor', 'inherit')
    stripStyle(body, 'color', 'inherit')
  }
}

export function setHighlight(body: HTMLElement, color: string | null) {
  if (color) {
    if (!exec('hiliteColor', color)) exec('backColor', color)
  } else {
    if (!exec('hiliteColor', 'transparent')) exec('backColor', 'transparent')
    stripStyle(body, 'background-color', 'transparent')
  }
}

function stripStyle(body: HTMLElement, prop: string, marker: string) {
  body.querySelectorAll<HTMLElement>('span[style], font[style]').forEach((el) => {
    if (el.style.getPropertyValue(prop) === marker) {
      el.style.removeProperty(prop)
      if (!el.getAttribute('style')) {
        if (el.tagName === 'SPAN' && el.attributes.length === 0) {
          while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
          el.remove()
        } else el.removeAttribute('style')
      }
    }
  })
}

/** Word's "Clear All Formatting": inline runs back to plain, paragraphs back to Normal. */
export function clearFormatting(body: HTMLElement) {
  exec('removeFormat')
  exec('unlink')
  for (const block of selectedBlocks(body)) {
    const el = block.tagName === 'LI' ? block : retag(body, block, 'p')
    el.removeAttribute('data-style')
    el.removeAttribute('style')
  }
}

/**
 * Split the caret's block in two, Word-style (Enter mid-paragraph), returning
 * the new block that follows. Used for page breaks and block insertions.
 */
export function splitBlockAtCaret(body: HTMLElement): { before: HTMLElement; after: HTMLElement } | null {
  const range = currentRange(body)
  if (!range) return null
  const block = blockOf(body, range.startContainer)
  if (!block) return null
  const tail = document.createRange()
  tail.setStart(range.startContainer, range.startOffset)
  tail.setEndAfter(block.lastChild ?? block)
  const moved = tail.extractContents()
  const after = document.createElement(block.tagName === 'LI' ? 'p' : block.tagName.toLowerCase())
  for (const attr of Array.from(block.attributes)) if (attr.name !== 'data-bee-push' && attr.name !== 'data-bee-mt') after.setAttribute(attr.name, attr.value)
  after.appendChild(moved)
  if (!after.textContent && !after.querySelector('img,br')) after.innerHTML = '<br>'
  if (!block.textContent && !block.querySelector('img,br')) block.innerHTML = '<br>'
  const host = block.tagName === 'LI' ? block.closest('ul,ol') ?? block : block
  host.after(after)
  return { before: block, after }
}

/** Insert a block element after the caret's block (splitting it when the caret is mid-text), then place the caret in `after`. */
export function insertBlockAtCaret(body: HTMLElement, node: HTMLElement, caretInto?: HTMLElement) {
  const range = currentRange(body)
  const block = range ? blockOf(body, range.startContainer) : null
  if (!block) {
    body.appendChild(node)
  } else {
    const atEnd = range ? isAtEndOfBlock(range, block) : true
    const atStart = range ? isAtStartOfBlock(range, block) : false
    const host = block.tagName === 'LI' ? block.closest('ul,ol') ?? block : block
    if (atStart && !atEnd) host.before(node)
    else if (atEnd) host.after(node)
    else {
      const split = splitBlockAtCaret(body)
      if (split) split.after.before(node)
      else host.after(node)
    }
  }
  const target = caretInto ?? node.nextElementSibling ?? node
  placeCaret(target as HTMLElement, 'start')
}

function isAtEndOfBlock(range: Range, block: HTMLElement): boolean {
  const probe = document.createRange()
  probe.setStart(range.endContainer, range.endOffset)
  probe.setEndAfter(block.lastChild ?? block)
  const text = probe.toString()
  return text.length === 0 && !probe.cloneContents().querySelector('img')
}

function isAtStartOfBlock(range: Range, block: HTMLElement): boolean {
  const probe = document.createRange()
  probe.setStartBefore(block.firstChild ?? block)
  probe.setEnd(range.startContainer, range.startOffset)
  return probe.toString().length === 0 && !probe.cloneContents().querySelector('img')
}

export function placeCaret(el: HTMLElement, where: 'start' | 'end') {
  const range = document.createRange()
  const target = el.querySelector('p,h1,h2,h3,h4,h5,h6,li,td') && el.tagName === 'TABLE'
    ? (el.querySelector('td p, td') as HTMLElement)
    : el
  range.selectNodeContents(target)
  range.collapse(where === 'start')
  setRange(range)
}

export function insertPageBreak(body: HTMLElement) {
  const hr = document.createElement('hr')
  hr.setAttribute('data-break', 'page')
  const range = currentRange(body)
  const block = range ? blockOf(body, range.startContainer) : null
  if (block && range && isAtEndOfBlock(range, block)) {
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    const host = block.tagName === 'LI' ? block.closest('ul,ol') ?? block : block
    host.after(hr)
    hr.after(p)
    placeCaret(p, 'start')
    return
  }
  insertBlockAtCaret(body, hr)
}

export function insertHorizontalRule(body: HTMLElement) {
  const hr = document.createElement('hr')
  const p = document.createElement('p')
  p.innerHTML = '<br>'
  insertBlockAtCaret(body, hr)
  hr.after(p)
  placeCaret(p, 'start')
}

export function insertTable(body: HTMLElement, rows: number, cols: number) {
  const table = document.createElement('table')
  table.setAttribute('data-borders', '1')
  const tbody = document.createElement('tbody')
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr')
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td')
      td.innerHTML = '<p><br></p>'
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  const p = document.createElement('p')
  p.innerHTML = '<br>'
  insertBlockAtCaret(body, table)
  table.after(p)
  placeCaret(table.querySelector('td p') as HTMLElement, 'start')
}

export function insertImage(body: HTMLElement, src: string, width: number, height: number, alt: string, maxWidth: number) {
  const img = document.createElement('img')
  img.src = src
  if (alt) img.alt = alt
  let w = width
  let h = height
  if (w > maxWidth) {
    h = Math.round((h * maxWidth) / w)
    w = Math.round(maxWidth)
  }
  img.width = w
  img.height = h
  const range = currentRange(body)
  const block = range ? blockOf(body, range.startContainer) : null
  if (range && block) {
    range.deleteContents()
    range.insertNode(img)
    const after = document.createRange()
    after.setStartAfter(img)
    after.collapse(true)
    setRange(after)
  } else {
    const p = document.createElement('p')
    p.appendChild(img)
    body.appendChild(p)
    placeCaret(p, 'end')
  }
  return img
}

export function currentLink(body: HTMLElement): HTMLAnchorElement | null {
  const el = anchorElement(body)
  return (el?.closest('a') as HTMLAnchorElement | null) ?? null
}

export function insertLink(body: HTMLElement, url: string, text?: string) {
  const range = currentRange(body)
  if (!range) return
  if (range.collapsed) {
    const a = document.createElement('a')
    a.href = url
    a.textContent = text || url
    range.insertNode(a)
    const after = document.createRange()
    after.setStartAfter(a)
    after.collapse(true)
    setRange(after)
  } else {
    exec('createLink', url)
  }
}

export function currentTableCell(body: HTMLElement): HTMLTableCellElement | null {
  const el = anchorElement(body)
  const cell = el?.closest('td,th') as HTMLTableCellElement | null
  return cell && body.contains(cell) ? cell : null
}

export function tableInsertRow(cell: HTMLTableCellElement, where: 'above' | 'below') {
  const row = cell.parentElement as HTMLTableRowElement
  const clone = document.createElement('tr')
  for (const c of Array.from(row.cells)) {
    const td = document.createElement('td')
    if (c.colSpan > 1) td.colSpan = c.colSpan
    td.innerHTML = '<p><br></p>'
    clone.appendChild(td)
  }
  if (where === 'above') row.before(clone)
  else row.after(clone)
}

export function tableInsertColumn(cell: HTMLTableCellElement, where: 'left' | 'right') {
  const table = cell.closest('table')
  if (!table) return
  const index = cell.cellIndex
  for (const row of Array.from(table.rows)) {
    const ref = row.cells[Math.min(index, row.cells.length - 1)]
    const td = document.createElement('td')
    td.innerHTML = '<p><br></p>'
    if (!ref) row.appendChild(td)
    else if (where === 'left') ref.before(td)
    else ref.after(td)
  }
  // Column widths no longer describe the grid; let the browser lay it out.
  table.querySelector('colgroup')?.remove()
}

export function tableDeleteRow(cell: HTMLTableCellElement) {
  const row = cell.parentElement as HTMLTableRowElement
  const table = cell.closest('table')
  row.remove()
  if (table && table.rows.length === 0) table.remove()
}

export function tableDeleteColumn(cell: HTMLTableCellElement) {
  const table = cell.closest('table')
  if (!table) return
  const index = cell.cellIndex
  for (const row of Array.from(table.rows)) row.cells[index]?.remove()
  table.querySelector('colgroup')?.remove()
  if (Array.from(table.rows).every((r) => r.cells.length === 0)) table.remove()
}

export function tableDelete(cell: HTMLTableCellElement) {
  cell.closest('table')?.remove()
}

export function tableToggleBorders(cell: HTMLTableCellElement) {
  const table = cell.closest('table')
  if (!table) return
  table.setAttribute('data-borders', table.getAttribute('data-borders') === '0' ? '1' : '0')
}

export function tableSetCellShading(cell: HTMLTableCellElement, color: string | null) {
  if (color) cell.style.backgroundColor = color
  else cell.style.removeProperty('background-color')
  tidyStyle(cell)
}

/** Tab inside a table: next cell (a new row after the last), Shift+Tab: previous. */
export function tableMoveCell(cell: HTMLTableCellElement, backwards: boolean): boolean {
  const table = cell.closest('table')
  if (!table) return false
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th')).filter(
    (c) => c.closest('table') === table,
  )
  const i = cells.indexOf(cell)
  if (i < 0) return false
  let target: HTMLTableCellElement | undefined = cells[i + (backwards ? -1 : 1)]
  if (!target && !backwards) {
    tableInsertRow(cell, 'below')
    target = (cell.parentElement as HTMLTableRowElement).nextElementSibling?.querySelector('td') ?? undefined
  }
  if (!target) return false
  const range = document.createRange()
  range.selectNodeContents(target.querySelector('p') ?? target)
  setRange(range)
  return true
}

/** Words in the body, the way Word counts them (whitespace-separated tokens). */
export function countWords(body: HTMLElement): number {
  const text = body.innerText || ''
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0)
  return tokens.length
}
