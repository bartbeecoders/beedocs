import { api } from '../api'
import { withApiBase } from '../basePath'

const IMAGE_MIME = /^image\//i
const MAX_BYTES = 8 * 1024 * 1024

export type UploadedImage = {
  url: string
  fileName: string
  contentType: string
  size: number
}

export function isImageFile(file: File | Blob): boolean {
  if (file.type && IMAGE_MIME.test(file.type)) return true
  if (file instanceof File && /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name)) return true
  return false
}

export function collectImageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  if (dt.files?.length) {
    for (const f of Array.from(dt.files)) {
      if (isImageFile(f)) out.push(f)
    }
  }
  // Some browsers put files only in items
  if (out.length === 0 && dt.items?.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f && isImageFile(f)) out.push(f)
      }
    }
  }
  return out
}

export async function collectImagesFromClipboard(e: ClipboardEvent): Promise<File[]> {
  const items = e.clipboardData?.items
  if (!items) return []
  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}

export async function uploadImageFile(file: File | Blob, fileName?: string): Promise<UploadedImage> {
  if (file.size > MAX_BYTES) {
    throw new Error(`Image exceeds ${MAX_BYTES / (1024 * 1024)} MB limit`)
  }
  if (!isImageFile(file)) {
    throw new Error('Not an image file')
  }
  const result = await api.uploadImage(file, fileName)
  return {
    url: result.url,
    fileName: result.fileName || fileName || 'image',
    contentType: result.contentType,
    size: result.size,
  }
}

export function markdownImageSnippet(url: string, alt: string): string {
  const safeAlt = alt.replace(/[[\]]/g, '') || 'image'
  return `![${safeAlt}](${url})`
}

/** Inline markdown image: ![alt](url) — not reference-style */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export type MdImageMatch = {
  alt: string
  url: string
  raw: string
  index: number
  length: number
}

export function findMarkdownImages(text: string): MdImageMatch[] {
  const out: MdImageMatch[] = []
  const re = new RegExp(MD_IMAGE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      alt: m[1] ?? '',
      url: m[2] ?? '',
      raw: m[0],
      index: m.index,
      length: m[0].length,
    })
  }
  return out
}

export type TextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'image'; alt: string; url: string; raw: string }

/** Split a text segment so markdown images can render as previews in edit mode. */
export function splitTextWithImages(text: string): TextPiece[] {
  const images = findMarkdownImages(text)
  if (images.length === 0) return [{ kind: 'text', text }]
  const pieces: TextPiece[] = []
  let cursor = 0
  for (const img of images) {
    if (img.index > cursor) {
      pieces.push({ kind: 'text', text: text.slice(cursor, img.index) })
    }
    pieces.push({ kind: 'image', alt: img.alt, url: img.url, raw: img.raw })
    cursor = img.index + img.length
  }
  if (cursor < text.length) {
    pieces.push({ kind: 'text', text: text.slice(cursor) })
  }
  return pieces
}

/** Insert image markdown into a text body at a character offset. */
export function insertMarkdownAt(text: string, offset: number, snippet: string): string {
  const o = Math.max(0, Math.min(text.length, offset))
  const before = text.slice(0, o)
  const after = text.slice(o)
  const padBefore = before.length > 0 && !before.endsWith('\n') ? '\n\n' : before.length === 0 ? '' : '\n'
  const padAfter = after.length > 0 && !after.startsWith('\n') ? '\n\n' : after.length === 0 ? '\n' : '\n'
  return before + padBefore + snippet + padAfter + after
}

/** Approximate character offset in a textarea from pointer Y (for drop placement). */
export function textOffsetFromPointer(textarea: HTMLTextAreaElement, clientY: number): number {
  const style = window.getComputedStyle(textarea)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45 || 20
  const rect = textarea.getBoundingClientRect()
  const y = clientY - rect.top + textarea.scrollTop
  const lineIndex = Math.max(0, Math.floor(y / lineHeight))
  const lines = textarea.value.split('\n')
  if (lineIndex >= lines.length) return textarea.value.length
  let offset = 0
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1 // + newline
  }
  return Math.min(textarea.value.length, offset)
}

/** Read natural dimensions when possible (for diagram placement). */
export function loadImageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const maxW = 360
      const maxH = 280
      let w = img.naturalWidth || 220
      let h = img.naturalHeight || 160
      const scale = Math.min(1, maxW / w, maxH / h)
      resolve({ w: Math.round(w * scale), h: Math.round(h * scale) })
    }
    img.onerror = () => resolve({ w: 220, h: 160 })
    img.src = withApiBase(url)
  })
}
