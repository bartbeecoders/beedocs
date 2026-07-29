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

/** Languages rendered as interactive blocks in the hybrid page editor */
export const VISUAL_FENCE_LANGS = new Set(['beediagram', 'beediagram-ref'])

/**
 * Split Markdown into text + fenced code segments (any fence language).
 * Closing fence is ``` alone on a line (optional trailing spaces).
 */
export function splitMarkdownSegments(markdown: string): ContentSegment[] {
  const src = markdown.replace(/\r\n/g, '\n')
  const segments: ContentSegment[] = []
  // ```lang optional-info\n body \n```
  const re = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', text: src.slice(last, m.index) })
    }
    const info = (m[1] ?? '').trim()
    const lang = (info.split(/\s+/)[0] || 'text').toLowerCase()
    const body = (m[2] ?? '').replace(/\n$/, '')
    segments.push({ type: 'fence', lang, body })
    last = m.index + m[0].length
  }
  if (last < src.length) {
    segments.push({ type: 'text', text: src.slice(last) })
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', text: src })
  }
  return segments
}

export function joinMarkdownSegments(segments: ContentSegment[]): string {
  return segments
    .map((s) => {
      if (s.type === 'text') return s.text
      const body = s.body.replace(/\n$/, '')
      return '```' + s.lang + '\n' + body + (body ? '\n' : '') + '```'
    })
    .join('')
}

export function isVisualFenceLang(lang: string): boolean {
  return VISUAL_FENCE_LANGS.has(lang.toLowerCase())
}
