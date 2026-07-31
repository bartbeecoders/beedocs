import {
  detectMediaKind,
  detectModelFormat,
  type MediaKind,
  type Model3dFormat,
} from '../../media/mediaKinds'
import { ModelViewer } from './ModelViewer'
import { PdfViewer } from './PdfViewer'

export type ParsedMediaFence = {
  url: string
  title?: string
  format?: string
}

/**
 * Parse a markdown fence body for media embeds.
 *
 * Supports:
 * - Bare URL: `/uploads/model.glb`
 * - Multi-line metadata:
 *   ```
 *   title: Pump assembly
 *   format: glb
 *   /uploads/pump.glb
 *   ```
 * - Explicit `url:` key
 */
export function parseMediaFenceBody(body: string): ParsedMediaFence {
  const lines = (body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  let url = ''
  let title: string | undefined
  let format: string | undefined
  const leftover: string[] = []

  for (const line of lines) {
    const kv = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.+)$/)
    if (kv) {
      const key = kv[1].toLowerCase()
      const value = kv[2].trim()
      if (key === 'url' || key === 'src' || key === 'href') {
        url = value
        continue
      }
      if (key === 'title' || key === 'name') {
        title = value
        continue
      }
      if (key === 'format' || key === 'type' || key === 'kind') {
        format = value.toLowerCase()
        continue
      }
    }
    leftover.push(line)
  }

  if (!url) {
    // Prefer a line that looks like a path/URL
    const candidate =
      leftover.find((l) => /^(https?:\/\/|\/\/|\/|blob:|data:)/i.test(l)) ||
      leftover.find((l) => /\.[a-z0-9]{2,5}(\?|#|$)/i.test(l)) ||
      leftover[0] ||
      ''
    url = candidate.trim()
  }

  // Strip surrounding angle brackets or quotes sometimes used in markdown
  url = url.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '')

  return {
    url,
    ...(title ? { title } : {}),
    ...(format ? { format } : {}),
  }
}

export type MediaEmbedProps = {
  /** Media URL (relative `/uploads/...` or absolute). If omitted, parsed from `body`. */
  url?: string
  /** Fence language: pdf | glb | gltf | obj | model */
  lang?: string
  /** Explicit format override (e.g. glb) */
  format?: string
  title?: string
  /** Raw fence body — URL + optional `title:` / `format:` lines */
  body?: string
  className?: string
}

/**
 * Dispatcher that renders PdfViewer or ModelViewer from a URL and/or fence body.
 * Used by MarkdownView (preview) and HybridPageEditor media fence blocks.
 */
export function MediaEmbed({
  url: urlProp,
  lang,
  format: formatProp,
  title: titleProp,
  body,
  className,
}: MediaEmbedProps) {
  const parsed = body != null ? parseMediaFenceBody(body) : { url: '' }
  const url = (urlProp || parsed.url || '').trim()
  const title = titleProp || parsed.title
  const format = formatProp || parsed.format

  if (!url) {
    return (
      <div className={['media-embed', 'media-embed--empty', className].filter(Boolean).join(' ')}>
        <div className="media-embed-status media-embed-status--error" role="alert">
          No media URL provided.
        </div>
      </div>
    )
  }

  const kind: MediaKind = detectMediaKind({ url, lang, format })
  const modelFormat: Model3dFormat | null = detectModelFormat({ url, lang, format })

  if (kind === 'pdf' || (lang && lang.toLowerCase() === 'pdf')) {
    return <PdfViewer url={url} title={title} className={className} />
  }

  if (kind === 'model3d') {
    return (
      <ModelViewer
        url={url}
        title={title}
        format={modelFormat ?? undefined}
        className={className}
      />
    )
  }

  // Unknown kind — soft fallback based on extension-ish hints in lang
  const langLower = (lang || '').toLowerCase()
  if (langLower === 'pdf') {
    return <PdfViewer url={url} title={title} className={className} />
  }
  if (['glb', 'gltf', 'obj', 'model'].includes(langLower)) {
    return (
      <ModelViewer
        url={url}
        title={title}
        format={(modelFormat || langLower) as Model3dFormat}
        className={className}
      />
    )
  }

  return (
    <div className={['media-embed', 'media-embed--unknown', className].filter(Boolean).join(' ')}>
      <div className="media-embed-status media-embed-status--error" role="alert">
        <span>Unsupported media type for</span>
        <code className="media-embed-code">{url}</code>
        <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer">
          Open file
        </a>
      </div>
    </div>
  )
}
