/**
 * JSON / XML files dropped onto a page.
 *
 * Unlike images, PDFs and 3D models these are not uploaded and linked — the text
 * goes straight into a fenced block, so a config or schema is versioned with the
 * page, searchable, and exportable rather than living behind a download link.
 *
 * The dropped text is inserted **verbatim**. Re-serializing looks harmless but
 * is not: `JSON.parse`/`stringify` reorders integer-like keys and rounds numbers
 * past 2^53, and re-indenting XML rewrites whitespace that is significant inside
 * mixed content. Formatting is therefore something the author asks for on the
 * block, never something a drop does to their data behind their back.
 */

/** Fence language for a dropped data file. */
export type DataFenceLang = 'json' | 'xml'

const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'geojson', 'ndjson'])
const XML_EXTENSIONS = new Set(['xml', 'xsd', 'xsl', 'xslt', 'rss', 'atom', 'plist', 'wsdl'])

/**
 * Inline content cap. Past this a page becomes unreadable and every keystroke
 * pays to re-render it, so it is better to say no than to wedge the editor.
 */
export const MAX_DATA_FILE_BYTES = 512 * 1024

export function dataFenceLangForFile(file: File): DataFenceLang | null {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase().split(';')[0]?.trim() ?? ''
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''

  if (JSON_EXTENSIONS.has(ext)) return 'json'
  if (XML_EXTENSIONS.has(ext)) return 'xml'

  if (type === 'application/json' || type === 'text/json' || type.endsWith('+json')) return 'json'
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) {
    // SVG is an image everywhere else in the editor; keep it that way.
    return ext === 'svg' || type === 'image/svg+xml' ? null : 'xml'
  }
  return null
}

export function isDataFile(file: File): boolean {
  return dataFenceLangForFile(file) != null
}

export function collectDataFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt?.files?.length) return []
  return Array.from(dt.files).filter(isDataFile)
}

export type FormatResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: string }

/** Pretty-print JSON with two-space indentation. */
export function formatJson(text: string): FormatResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'Nothing to format.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Invalid JSON.' }
  }

  // Numbers wider than JavaScript can hold, and integer-like keys, do not
  // survive a parse/stringify round trip — leave those documents alone.
  if (hasUnsafeNumber(trimmed)) {
    return { ok: false, reason: 'Contains a number too large for JavaScript to reformat exactly.' }
  }
  if (hasIntegerLikeKey(parsed)) {
    return { ok: false, reason: 'Contains numeric object keys, which reformatting would reorder.' }
  }

  const formatted = JSON.stringify(parsed, null, 2)
  return { ok: true, text: formatted, changed: formatted !== text }
}

/** A literal that JSON.parse would round. */
function hasUnsafeNumber(json: string): boolean {
  // Number literals outside strings; the crude scan errs toward refusing.
  const withoutStrings = json.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  for (const match of withoutStrings.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const raw = match[0]
    if (!Number.isSafeInteger(Number(raw)) && String(Number(raw)) !== raw) return true
  }
  return false
}

/** `{"2": …}` — JSON.stringify emits integer-like keys first, in numeric order. */
function hasIntegerLikeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIntegerLikeKey)
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(0|[1-9]\d*)$/.test(key)) return true
      if (hasIntegerLikeKey(child)) return true
    }
  }
  return false
}

/**
 * Re-indent XML.
 *
 * Refused when any element holds both child elements and text, because there the
 * whitespace an indent adds is part of the content.
 */
export function formatXml(text: string): FormatResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'Nothing to format.' }

  const doc = new DOMParser().parseFromString(trimmed, 'application/xml')
  if (doc.querySelector('parsererror')) {
    return { ok: false, reason: 'Invalid XML.' }
  }
  if (hasMixedContent(doc.documentElement)) {
    return {
      ok: false,
      reason: 'Contains elements mixing text and child elements, where indentation would change the content.',
    }
  }

  const formatted = indentXml(trimmed)
  return { ok: true, text: formatted, changed: formatted !== text }
}

function hasMixedContent(el: Element | null): boolean {
  if (!el) return false
  let hasElementChild = false
  let hasTextChild = false
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) hasElementChild = true
    else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) hasTextChild = true
  }
  if (hasElementChild && hasTextChild) return true
  return Array.from(el.children).some(hasMixedContent)
}

function indentXml(xml: string): string {
  // Only whitespace-only gaps between tags are rewritten; text content is untouched.
  const withBreaks = xml.replace(/>\s*</g, '>\n<')
  const pad = '  '
  let depth = 0
  const lines: string[] = []

  for (const raw of withBreaks.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const isClosing = /^<\//.test(line)
    const isSelfContained = /^<[^!?][^>]*\/>$/.test(line) || /^<([\w:.-]+)[^>]*>.*<\/\1>$/.test(line)
    const isDeclaration = /^<[?!]/.test(line)

    if (isClosing) depth = Math.max(0, depth - 1)
    lines.push(pad.repeat(depth) + line)
    if (!isClosing && !isSelfContained && !isDeclaration && /^<[\w:.-]/.test(line)) depth += 1
  }

  return lines.join('\n')
}

/** Read a dropped file, refusing anything too big to live inside a page. */
export async function readDataFile(file: File): Promise<{ text: string } | { error: string }> {
  if (file.size > MAX_DATA_FILE_BYTES) {
    const mb = (MAX_DATA_FILE_BYTES / 1024 / 1024).toFixed(1)
    return { error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit for inlined data is ${mb} MB.` }
  }
  try {
    return { text: await file.text() }
  } catch (e) {
    return { error: e instanceof Error ? e.message : `Could not read ${file.name}.` }
  }
}
