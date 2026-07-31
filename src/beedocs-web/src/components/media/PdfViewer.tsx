import { useCallback, useEffect, useMemo, useState } from 'react'
import { withApiBase } from '../../basePath'
import { filenameFromPath } from '../../media/mediaKinds'

export type PdfViewerProps = {
  url: string
  /** Display title; falls back to filename from URL */
  title?: string
  className?: string
}

function resolvePdfUrl(url: string): string {
  if (!url) return url
  if (
    /^https?:\/\//i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')
  ) {
    return url
  }
  const path = url.startsWith('/') ? url : `/${url}`
  return withApiBase(path)
}

/**
 * Embed-friendly PDF URL. Prefer FitH for document-first layout.
 * Avoid toolbar=0 — some Chromium builds render a blank dark frame with it.
 * BeeDocs chrome still wraps the embed; native page chrome is acceptable.
 */
function embedPdfUrl(url: string): string {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.includes('#')) return url
  return `${url}#view=FitH`
}

/**
 * Full-bleed professional PDF embed shell.
 * Uses the browser's native PDF viewer via iframe for reliability and zero extra deps.
 */
export function PdfViewer({ url, title, className }: PdfViewerProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const resolved = useMemo(() => resolvePdfUrl(url), [url])
  const embedSrc = useMemo(() => embedPdfUrl(resolved), [resolved])
  const displayName = title?.trim() || filenameFromPath(url) || 'Document.pdf'

  const handleLoad = useCallback(() => setStatus('ready'), [])
  const handleError = useCallback(() => setStatus('error'), [])

  // Reset + soft timeout: some browsers never fire iframe load for PDFs
  useEffect(() => {
    setStatus('loading')
    const t = window.setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'ready' : s))
    }, 1600)
    return () => window.clearTimeout(t)
  }, [embedSrc])

  return (
    <figure
      className={['media-embed', 'media-embed--pdf', className].filter(Boolean).join(' ')}
      aria-label={displayName}
    >
      <header className="media-embed-chrome">
        <div className="media-embed-chrome-left">
          <span className="media-embed-badge" title="PDF document">
            PDF
          </span>
          <span className="media-embed-title" title={displayName}>
            {displayName}
          </span>
        </div>
        <div className="media-embed-chrome-actions" role="toolbar" aria-label="PDF actions">
          <a
            className="btn sm ghost media-embed-action"
            href={resolved}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
            aria-label="Open PDF in new tab"
          >
            <OpenIcon />
            <span className="media-embed-action-label">Open</span>
          </a>
          <a
            className="btn sm ghost media-embed-action"
            href={resolved}
            download={displayName}
            title="Download PDF"
            aria-label="Download PDF"
          >
            <DownloadIcon />
            <span className="media-embed-action-label">Download</span>
          </a>
        </div>
      </header>

      <div className="media-embed-body media-embed-body--pdf">
        {status === 'loading' && (
          <div className="media-embed-status" role="status" aria-live="polite">
            <span className="media-embed-spinner" aria-hidden />
            <span>Loading PDF…</span>
          </div>
        )}
        {status === 'error' && (
          <div className="media-embed-status media-embed-status--error" role="alert">
            <span>Could not load this PDF.</span>
            <a className="btn sm" href={resolved} target="_blank" rel="noopener noreferrer">
              Open in new tab
            </a>
          </div>
        )}
        <iframe
          className="media-embed-frame"
          src={embedSrc}
          title={displayName}
          onLoad={handleLoad}
          onError={handleError}
          // Keep frame interactive even while "loading" (browser may not fire load for all PDFs)
          style={{ opacity: status === 'error' ? 0 : 1 }}
        />
      </div>
    </figure>
  )
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9 2h5v5M14 2 7 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 2v8m0 0 3-3m-3 3L5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 12.5v.5A1.5 1.5 0 0 0 4.5 14.5h7a1.5 1.5 0 0 0 1.5-1.5v-.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
