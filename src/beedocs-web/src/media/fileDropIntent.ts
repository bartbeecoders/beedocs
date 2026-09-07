import { attachmentExtension, attachmentRejection } from './attachments'

export type DropIntent = 'markdown' | 'attachment' | 'reject'

const MARKDOWN_EXT = new Set(['md', 'markdown'])
const MARKDOWN_MIME = new Set(['text/markdown', 'text/x-markdown'])

/** Don't bother reading zip/PDF/image bytes looking for headings. */
const BINARY_EXT = new Set([
  'pdf',
  'zip',
  '7z',
  'tar',
  'gz',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'vsd',
  'vsdx',
])

const SNIFF_BYTES = 2048
const SNIFF_MAX = 1024 * 1024

/**
 * What a library drop should do with one file: become a page (Markdown), land
 * in Files (PDF, zip, images, …), or be refused.
 *
 * Extension and MIME win. For `.txt` / no extension / `text/*`, a short sniff
 * looks for Markdown front matter or ATX headings so a renamed note still
 * gets the page/file choice.
 */
export async function classifyDroppedFile(file: File): Promise<DropIntent> {
  const ext = attachmentExtension(file.name)
  if (MARKDOWN_EXT.has(ext) || MARKDOWN_MIME.has(file.type)) return 'markdown'
  if (!BINARY_EXT.has(ext) && file.size > 0 && file.size <= SNIFF_MAX) {
    const sniffable =
      ext === 'txt' ||
      ext === '' ||
      file.type.startsWith('text/') ||
      file.type === 'application/octet-stream' ||
      file.type === ''
    if (sniffable && (await looksLikeMarkdown(file))) return 'markdown'
  }
  return attachmentRejection(file) ? 'reject' : 'attachment'
}

export async function looksLikeMarkdown(file: File): Promise<boolean> {
  try {
    const text = await file.slice(0, SNIFF_BYTES).text()
    const head = text.replace(/^\uFEFF/, '').trimStart()
    if (head.startsWith('---\n') || head.startsWith('---\r\n')) return true
    if (/^#{1,6}\s+\S/m.test(head)) return true
    return false
  } catch {
    return false
  }
}

/** Title from YAML `title:`, the first ATX heading, or the file name. */
export function titleFromMarkdownFile(fileName: string, content: string): string {
  const text = content.replace(/^\uFEFF/, '')
  let body = text
  if (body.startsWith('---')) {
    const nl = body.indexOf('\n')
    const closer = body.indexOf('\n---', nl < 0 ? 3 : nl)
    if (closer >= 0) {
      const fm = body.slice(nl < 0 ? 3 : nl + 1, closer)
      const titled = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm)
      if (titled?.[1]?.trim()) return titled[1].trim()
      body = body.slice(closer + 4)
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body)
  if (heading?.[1]?.trim()) return heading[1].trim()
  const stem = fileName.replace(/\.(md|markdown|txt)$/i, '').trim()
  return stem || 'Untitled'
}
