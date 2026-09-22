/**
 * Text edits behind the page editor's section context menu.
 *
 * Every operation is a pure function of (text, selection) returning one
 * replacement — `{ start, end, text }` over the *old* value plus where the
 * selection should land in the new one — so the menu can apply it through
 * `applyTextareaEdit`, which goes via the browser's own editing path and keeps
 * Ctrl+Z working. Offsets are relative to the textarea's value; on a section
 * showing images or tables that is one text piece, not the whole block.
 */

export type TextEdit = {
  start: number
  end: number
  text: string
  /** Selection in the *new* value, absolute. Defaults to a caret after the inserted text. */
  select?: [number, number]
}

/** What a line is, as far as the "Turn into" menu is concerned. */
export type LineKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'bullet' | 'numbered' | 'check' | 'quote'

const LINE_PREFIX = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/

/** Kind of one line, judged by its Markdown prefix. */
export function kindOfLine(line: string): LineKind {
  const m = /^\s*(#{1,6})\s+/.exec(line)
  if (m) {
    const level = Math.min(m[1].length, 4)
    return `h${level}` as LineKind
  }
  if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) return 'check'
  if (/^\s*[-*+]\s+/.test(line)) return 'bullet'
  if (/^\s*\d+[.)]\s+/.test(line)) return 'numbered'
  if (/^\s*>/.test(line)) return 'quote'
  return 'paragraph'
}

/** Start/end offsets of the whole lines a selection touches. */
export function lineBounds(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  // A selection ending right after a newline does not reach into the next line.
  const tail = end > start && value[end - 1] === '\n' ? end - 1 : end
  const nl = value.indexOf('\n', tail)
  return [start === 0 ? 0 : from, nl === -1 ? value.length : nl]
}

/** Kind of the line the caret (or the start of the selection) sits on. */
export function kindAtCaret(value: string, start: number): LineKind {
  const [from, to] = lineBounds(value, start, start)
  return kindOfLine(value.slice(from, to))
}

/**
 * Re-prefix every non-blank line the selection touches. Choosing the kind the
 * lines already are turns them back into plain paragraphs, so each item in the
 * menu is also its own undo.
 */
export function turnLinesInto(value: string, start: number, end: number, kind: LineKind): TextEdit {
  const [from, to] = lineBounds(value, start, end)
  const lines = value.slice(from, to).split('\n')
  const nonBlank = lines.filter((l) => l.trim() !== '')
  const already = nonBlank.length > 0 && nonBlank.every((l) => kindOfLine(l) === kind)
  const target: LineKind = already ? 'paragraph' : kind
  let n = 0
  const next = lines
    .map((line) => {
      if (line.trim() === '') return line
      const m = LINE_PREFIX.exec(line)
      const indent = m?.[1] ?? ''
      const body = line.slice(m?.[0].length ?? 0)
      n += 1
      return indent + prefixFor(target, n) + body
    })
    .join('\n')
  return { start: from, end: to, text: next, select: [from, from + next.length] }
}

function prefixFor(kind: LineKind, n: number): string {
  switch (kind) {
    case 'h1':
      return '# '
    case 'h2':
      return '## '
    case 'h3':
      return '### '
    case 'h4':
      return '#### '
    case 'bullet':
      return '- '
    case 'numbered':
      return `${n}. `
    case 'check':
      return '- [ ] '
    case 'quote':
      return '> '
    default:
      return ''
  }
}

/**
 * Wrap the selection in an inline marker (`**`, `_`, `` ` ``, `~~`), or unwrap
 * it when it is already wrapped. With nothing selected a placeholder is
 * inserted and selected, ready to be typed over.
 */
export function toggleInline(value: string, start: number, end: number, marker: string, placeholder: string): TextEdit {
  const m = marker.length
  if (start >= m && value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
    const inner = value.slice(start, end)
    return { start: start - m, end: end + m, text: inner, select: [start - m, start - m + inner.length] }
  }
  const inner = start === end ? placeholder : value.slice(start, end)
  return {
    start,
    end,
    text: marker + inner + marker,
    select: [start + m, start + m + inner.length],
  }
}

/**
 * A Markdown link at the selection. The selected text, when there is any,
 * becomes the label — select a word, pick a page, and the word is now a link.
 */
export function insertLink(value: string, start: number, end: number, label: string, href: string): TextEdit {
  const selected = value.slice(start, end).trim()
  const text = `[${(selected || label).replace(/[[\]]/g, '')}](${href})`
  if (start !== end) return { start, end, text }
  // A link is inline: pad with a space rather than blank lines.
  const before = value.slice(0, start)
  const after = value.slice(end)
  const padBefore = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const padAfter = after !== '' && !/^\s/.test(after) ? ' ' : ''
  return { start, end, text: padBefore + text + padAfter }
}

/**
 * A block-level snippet (list, table, code…) at the caret, padded so it stands
 * on its own lines — after the caret's line when nothing is selected. `select`
 * is relative to the snippet: typically the first placeholder, so typing
 * replaces it.
 */
export function insertBlock(
  value: string,
  start: number,
  end: number,
  snippet: string,
  select?: [number, number],
  /** Insert exactly at the caret, even mid-line (splitting a section does want the cut). */
  exact = false,
): TextEdit {
  // A caret mid-line would cut the sentence in two — land after the line instead.
  if (start === end && !exact) {
    const nl = value.indexOf('\n', start)
    start = end = nl === -1 ? value.length : nl
  }
  const before = value.slice(0, start)
  const after = value.slice(end)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const at = start + lead.length
  return {
    start,
    end,
    text: lead + snippet + trail,
    select: select ? [at + select[0], at + select[1]] : [at + snippet.length, at + snippet.length],
  }
}

/** Fence the selected lines as a code block, or insert an empty one. */
export function codeBlock(value: string, start: number, end: number, placeholder: string): TextEdit {
  if (start === end) {
    const snippet = '```\n' + placeholder + '\n```'
    return insertBlock(value, start, end, snippet, [4, 4 + placeholder.length])
  }
  const [from, to] = lineBounds(value, start, end)
  const body = value.slice(from, to)
  return insertBlock(value, from, to, '```\n' + body + '\n```', [4, 4 + body.length])
}

/**
 * Apply an edit to a textarea through the browser's editing pipeline, so the
 * change lands in the field's own undo stack and fires the `input` event React
 * listens for. `setRangeText` is the fallback where `insertText` is refused.
 */
export function applyTextareaEdit(ta: HTMLTextAreaElement, edit: TextEdit): void {
  ta.focus()
  ta.setSelectionRange(edit.start, edit.end)
  let done = false
  try {
    // Deprecated, but still the only way to keep native undo for scripted edits.
    done = document.execCommand('insertText', false, edit.text)
  } catch {
    done = false
  }
  if (!done) {
    ta.setRangeText(edit.text, edit.start, edit.end, 'end')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const caret = edit.start + edit.text.length
  const [s, e] = edit.select ?? [caret, caret]
  ta.setSelectionRange(s, e)
}
