/**
 * Replace the body of the n-th fenced code block with the given language (0-based).
 * Language match is case-insensitive. Returns original markdown if occurrence not found.
 */
export function replaceFenceBody(
  markdown: string,
  lang: string,
  occurrenceIndex: number,
  newBody: string,
): string {
  const escaped = lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('```' + escaped + '\\s*\\r?\\n([\\s\\S]*?)```', 'gi')
  let i = 0
  let found = false
  const next = markdown.replace(re, (full) => {
    if (i++ !== occurrenceIndex) return full
    found = true
    const body = newBody.replace(/\r\n/g, '\n').replace(/\n$/, '')
    return '```' + lang + '\n' + body + '\n```'
  })
  return found ? next : markdown
}

export type TextSegment = {
  type: 'text'
  text: string
}

export type FenceSegment = {
  type: 'fence'
  /** Normalized language id (lowercase) */
  lang: string
  body: string
}

export type ContentSegment = TextSegment | FenceSegment

/** Languages rendered as interactive diagram blocks in the hybrid page editor */
export const VISUAL_FENCE_LANGS = new Set(['beediagram', 'beediagram-ref'])

/** Isometric isometric diagram embeds — the body is a diagram id, not JSON */
export const ISOMETRIC_FENCE_LANGS = new Set(['isometric-ref'])

/** Free-draw sketch pad (JSON stroke document) */
export const FREEDRAW_FENCE_LANGS = new Set(['freedraw', 'sketch'])

/** Excel-style grid (JSON cell document) */
export const EXCELGRID_FENCE_LANGS = new Set(['excelgrid', 'spreadsheet', 'grid'])

/** PDF / 3D model fence languages — hybrid editor shows MediaEmbed, not source-only */
export const MEDIA_FENCE_LANGS = new Set(['pdf', 'glb', 'gltf', 'obj', 'model'])

/** ATX heading at the start of a line: `# Title` … `###### Title`. */
const HEADING_LINE = /^(#{1,6})\s+\S/

/** True when a text segment opens with a heading, so it must start its own line. */
export function startsWithHeading(text: string): boolean {
  return HEADING_LINE.test(text.replace(/^\n+/, ''))
}

/**
 * Break a run of Markdown into one piece per heading, so each section is its own
 * editable, reorderable block. Any prose before the first heading stays as the
 * leading piece. Pieces concatenate back to the input exactly.
 */
export function splitTextAtHeadings(text: string): string[] {
  if (!text) return [text]

  const lines = text.split('\n')
  const pieces: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (HEADING_LINE.test(line) && current.some((l) => l.trim().length > 0)) {
      pieces.push(current.join('\n'))
      current = [line]
      continue
    }
    current.push(line)
  }
  pieces.push(current.join('\n'))

  // Re-attach the newline each split consumed, so joining is lossless.
  return pieces.map((piece, i) => (i < pieces.length - 1 ? piece + '\n' : piece)).filter((p) => p !== '')
}

/**
 * Split Markdown into text + fenced code segments (any fence language).
 * Closing fence is ``` alone on a line (optional trailing spaces).
 *
 * Text runs are further split at headings — the editor renders one block per
 * segment, and a section is what a reader thinks of as a movable unit.
 */
export function splitMarkdownSegments(markdown: string): ContentSegment[] {
  const src = markdown.replace(/\r\n/g, '\n')
  const segments: ContentSegment[] = []
  // ```lang optional-info\n body \n```
  const re = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (text: string) => {
    for (const piece of splitTextAtHeadings(text)) segments.push({ type: 'text', text: piece })
  }

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      pushText(src.slice(last, m.index))
    }
    const info = (m[1] ?? '').trim()
    const lang = (info.split(/\s+/)[0] || 'text').toLowerCase()
    const body = (m[2] ?? '').replace(/\n$/, '')
    segments.push({ type: 'fence', lang, body })
    last = m.index + m[0].length
  }
  if (last < src.length) {
    pushText(src.slice(last))
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', text: src })
  }
  return segments
}

/**
 * Rejoin segments into Markdown.
 *
 * Both fence markers have to own their line, so a text segment whose trailing
 * (or leading) newline was edited away can't be allowed to run into the fence
 * next to it — that turns ```` ```mermaid ```` into ordinary prose and silently
 * destroys the block on the next save.
 */
export function joinMarkdownSegments(segments: ContentSegment[]): string {
  let out = ''
  let afterFence = false
  for (const s of segments) {
    if (s.type === 'text') {
      // Keep the previous fence's closing ``` alone on its line, and — now that
      // blocks can be reordered — make sure a section heading landing after some
      // other block still begins on a line of its own. Text that already opens
      // with a newline carries its own break, so adding one would rewrite the
      // document on load.
      const needsBreak =
        s.text !== '' &&
        !s.text.startsWith('\n') &&
        (afterFence || (out !== '' && !out.endsWith('\n') && startsWithHeading(s.text)))
      if (needsBreak) out += '\n\n'
      out += s.text
      afterFence = false
      continue
    }
    // Start the opening ``` on a line of its own.
    if (out && !out.endsWith('\n')) out += '\n\n'
    const body = s.body.replace(/\n$/, '')
    out += '```' + s.lang + '\n' + body + (body ? '\n' : '') + '```'
    afterFence = true
  }
  return out
}

export function isVisualFenceLang(lang: string): boolean {
  return VISUAL_FENCE_LANGS.has(lang.toLowerCase())
}

export function isIsometricFenceLang(lang: string): boolean {
  return ISOMETRIC_FENCE_LANGS.has(lang.toLowerCase())
}

export function isFreedrawFenceLang(lang: string): boolean {
  return FREEDRAW_FENCE_LANGS.has(lang.toLowerCase())
}

export function isExcelGridFenceLang(lang: string): boolean {
  return EXCELGRID_FENCE_LANGS.has(lang.toLowerCase())
}

export function isMediaFenceLang(lang: string): boolean {
  return MEDIA_FENCE_LANGS.has(lang.toLowerCase())
}
