/**
 * Media kind detection for embeddable assets (images, PDFs, 3D models).
 * Used by MediaEmbed and future markdown fence wiring.
 */

export type MediaKind = 'image' | 'pdf' | 'model3d' | 'unknown'

export type Model3dFormat = 'glb' | 'gltf' | 'obj'

/** Fence languages that map to PDF or 3D model embeds. */
export type MediaFenceLang = 'pdf' | 'glb' | 'gltf' | 'obj' | 'model'

export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
  'ico',
])

export const PDF_EXTENSIONS = new Set(['pdf'])

export const MODEL3D_EXTENSIONS = new Set(['glb', 'gltf', 'obj'])

export const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
}

export const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'application/pdf': 'pdf',
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'model/obj': 'obj',
  'text/plain': 'obj', // some servers serve OBJ as text/plain
}

/** Strip query/hash and take the last path segment extension (lowercase). */
export function extensionFromPath(pathOrUrl: string): string | null {
  if (!pathOrUrl) return null
  try {
    // Absolute URLs: use pathname only
    if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('//')) {
      const u = new URL(pathOrUrl.startsWith('//') ? `https:${pathOrUrl}` : pathOrUrl)
      pathOrUrl = u.pathname
    }
  } catch {
    // fall through with original string
  }
  const clean = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl
  const base = clean.split('/').pop() ?? clean
  const dot = base.lastIndexOf('.')
  if (dot < 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}

export function filenameFromPath(pathOrUrl: string): string {
  if (!pathOrUrl) return ''
  try {
    if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith('//')) {
      const u = new URL(pathOrUrl.startsWith('//') ? `https:${pathOrUrl}` : pathOrUrl)
      pathOrUrl = u.pathname
    }
  } catch {
    /* ignore */
  }
  const clean = pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl
  return decodeURIComponent(clean.split('/').pop() || clean)
}

export function mimeForExtension(ext: string | null | undefined): string | null {
  if (!ext) return null
  return MIME_BY_EXTENSION[ext.toLowerCase()] ?? null
}

export function isModel3dFormat(value: string | null | undefined): value is Model3dFormat {
  return value === 'glb' || value === 'gltf' || value === 'obj'
}

export function modelFormatFromExtension(ext: string | null | undefined): Model3dFormat | null {
  if (!ext) return null
  const e = ext.toLowerCase()
  if (e === 'glb' || e === 'gltf' || e === 'obj') return e
  return null
}

/**
 * Map a markdown fence language to a media kind.
 * `model` is a generic 3D fence; format may be refined from URL or body metadata.
 */
export function kindFromFenceLang(lang: string | null | undefined): MediaKind | null {
  if (!lang) return null
  const l = lang.trim().toLowerCase()
  if (l === 'pdf') return 'pdf'
  if (l === 'glb' || l === 'gltf' || l === 'obj' || l === 'model') return 'model3d'
  return null
}

export function formatFromFenceLang(lang: string | null | undefined): Model3dFormat | null {
  if (!lang) return null
  const l = lang.trim().toLowerCase()
  if (l === 'glb' || l === 'gltf' || l === 'obj') return l
  return null
}

export type DetectMediaInput = {
  filename?: string | null
  url?: string | null
  contentType?: string | null
  /** Fence lang or explicit format hint */
  lang?: string | null
  format?: string | null
}

/**
 * Detect media kind from available hints (content-type wins over extension).
 */
export function detectMediaKind(input: DetectMediaInput): MediaKind {
  const fromLang = kindFromFenceLang(input.lang)
  if (fromLang) return fromLang

  const fmt = (input.format || '').toLowerCase()
  if (fmt === 'pdf') return 'pdf'
  if (isModel3dFormat(fmt)) return 'model3d'

  const ct = (input.contentType || '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (ct === 'application/pdf') return 'pdf'
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'model/gltf-binary' || ct === 'model/gltf+json' || ct === 'model/obj') return 'model3d'
  if (ct.startsWith('model/')) return 'model3d'

  const path = input.filename || input.url || ''
  const ext = extensionFromPath(path)
  if (!ext) return 'unknown'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (MODEL3D_EXTENSIONS.has(ext)) return 'model3d'
  return 'unknown'
}

/**
 * Resolve a 3D format from format/lang/url/filename hints.
 */
export function detectModelFormat(input: DetectMediaInput): Model3dFormat | null {
  if (isModel3dFormat(input.format)) return input.format
  const fromLang = formatFromFenceLang(input.lang)
  if (fromLang) return fromLang

  const ct = (input.contentType || '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (ct === 'model/gltf-binary') return 'glb'
  if (ct === 'model/gltf+json') return 'gltf'
  if (ct === 'model/obj') return 'obj'

  return modelFormatFromExtension(extensionFromPath(input.filename || input.url || ''))
}

/** Whether a relative path should be routed through `withApiBase` (uploads / API). */
export function isApiRelativePath(url: string): boolean {
  return url.startsWith('/uploads/') || url.startsWith('/api/')
}
