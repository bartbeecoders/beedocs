/**
 * Presentation helpers for book attachments — the files filed against a book
 * (PDF, Word, PowerPoint, …).
 *
 * The upload rules themselves live on the server (AttachmentService is the one
 * allow-list that counts). What is duplicated here is only what the browser
 * needs before a request exists: the `accept` string for a file picker, and a
 * size check so a 300 MB file is refused locally rather than after the upload.
 */

/** Extensions the API accepts, in the order a picker should offer them. */
export const ACCEPTED_ATTACHMENT_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.vsd',
  '.vsdx',
  '.odt',
  '.ods',
  '.odp',
  '.txt',
  '.md',
  '.rtf',
  '.csv',
  '.json',
  '.xml',
  '.yaml',
  '.yml',
  '.zip',
  '.7z',
  '.tar',
  '.gz',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
] as const

/** Value for an `<input type="file">` accept attribute. */
export const ATTACHMENT_ACCEPT = ACCEPTED_ATTACHMENT_EXTENSIONS.join(',')

/** Mirrors AttachmentService.MaxAttachmentBytes. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export function attachmentExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase()
}

/**
 * Reject locally what the server would reject anyway, so a 100 MB upload is not
 * spent finding out. Returns the message to show, or null when the file is fine.
 */
export function attachmentRejection(file: File): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `“${file.name}” is larger than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit.`
  }
  const ext = `.${attachmentExtension(file.name)}`
  if (!(ACCEPTED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `“${file.name}” is not a file type this library accepts.`
  }
  return null
}

/** One glyph per family of document, so a file list reads at a glance. */
export function attachmentIcon(fileName: string, contentType = ''): string {
  const ext = attachmentExtension(fileName)
  if (ext === 'pdf') return '\u{1F4D5}'
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '\u{1F4DD}'
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return '\u{1F4CA}'
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '\u{1F4C8}'
  if (['zip', '7z', 'tar', 'gz'].includes(ext)) return '\u{1F5DC}️'
  if (['vsd', 'vsdx'].includes(ext)) return '\u{1F5FA}️'
  if (contentType.startsWith('image/')) return '\u{1F5BC}️'
  if (['json', 'xml', 'yaml', 'yml'].includes(ext)) return '\u{1F9FE}'
  return '\u{1F4CE}'
}

/** Short human label for the type column — the media type is unreadable. */
export function attachmentTypeLabel(fileName: string, contentType = ''): string {
  const ext = attachmentExtension(fileName)
  if (ext) return ext.toUpperCase()
  return contentType || 'File'
}

/**
 * Whether the workspace renders the file in place rather than offering it as a
 * download. Deliberately narrower than "the browser could probably show it":
 * these are the types the API also agrees to serve inline.
 */
export function canPreviewAttachment(contentType: string): boolean {
  return (
    contentType === 'application/pdf' ||
    contentType === 'text/plain' ||
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)
  )
}

export function isImageAttachment(contentType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Whether a drag carries OS files rather than something the app itself started.
 *
 * The tree's own drags (pages, folders, books) put JSON on `text/plain`, so
 * every drop target that accepts both has to ask this first — otherwise a
 * dragged page would be read as an upload, or a dropped PDF as a page move.
 *
 * `types` is the only thing readable during dragover; `items`/`files` are
 * withheld until the drop in most browsers, which is why this checks the type
 * list rather than counting files.
 */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  if (Array.from(dt.types || []).includes('Files')) return true
  return !!dt.items && Array.from(dt.items).some((i) => i.kind === 'file')
}

/** The dropped files, from `files` or (where that is empty) `items`. */
export function collectDroppedFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  if (dt.files?.length) return Array.from(dt.files)
  if (dt.items?.length) {
    return Array.from(dt.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null)
  }
  return []
}
