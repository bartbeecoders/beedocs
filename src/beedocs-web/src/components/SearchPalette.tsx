import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import {
  HIGHLIGHT_CLOSE,
  HIGHLIGHT_OPEN,
  type SearchHit,
  type SearchKind,
  type SearchResponse,
} from '../types'

/** Kind order and labels for the grouped result list. */
const KIND_GROUPS: { kind: SearchKind; label: string }[] = [
  { kind: 'page', label: 'Pages' },
  { kind: 'diagram', label: 'Diagrams' },
  { kind: 'slides', label: 'Slides' },
  { kind: 'attachment', label: 'Files' },
  { kind: 'book', label: 'Books' },
  { kind: 'folder', label: 'Folders' },
  { kind: 'shelf', label: 'Shelves' },
]

const KIND_ICON: Record<SearchKind, string> = {
  page: '\u{1F4C4}',
  diagram: '\u2B21',
  slides: '\u{1F39E}\uFE0F',
  attachment: '\u{1F4CE}',
  book: '\u{1F4D8}',
  folder: '\u{1F4C1}',
  shelf: '\u{1F4DA}',
}

/** Debounce long enough to skip intermediate keystrokes, short enough to feel live. */
const DEBOUNCE_MS = 120

type Props = {
  open: boolean
  onClose: () => void
}

export function SearchPalette({ open, onClose }: Props) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Flat, in group order — arrow keys walk this while the list renders grouped.
  const hits = useMemo(() => {
    if (!response) return []
    return KIND_GROUPS.flatMap((g) => response.hits.filter((h) => h.kind === g.kind))
  }, [response])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setResponse(null)
    setError(null)
    setActive(0)
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const text = query.trim()
    if (!text) {
      setResponse(null)
      setError(null)
      setBusy(false)
      return
    }

    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(() => {
      api
        .search(text, { limit: 30, signal: controller.signal })
        .then((res) => {
          setResponse(res)
          setError(null)
          setActive(0)
        })
        .catch((err: unknown) => {
          // An aborted request is a keystroke landing, not a failure.
          if (err instanceof DOMException && err.name === 'AbortError') return
          setError(err instanceof Error ? err.message : String(err))
          setResponse(null)
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  const openHit = useCallback(
    (hit: SearchHit) => {
      onClose()
      void navigate(hit.url)
    },
    [navigate, onClose],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      setActive((i) => (hits.length === 0 ? 0 : (i + 1) % hits.length))
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      setActive((i) => (hits.length === 0 ? 0 : (i - 1 + hits.length) % hits.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[active]
      if (hit) openHit(hit)
    }
  }

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const trimmed = query.trim()
  const groups = KIND_GROUPS.map((g) => ({
    ...g,
    items: (response?.hits ?? []).filter((h) => h.kind === g.kind),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="search-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="search-palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
      >
        <div className="search-field">
          <span className="search-field-icon" aria-hidden="true">
            {'\u2315'}
          </span>
          {/* The palette unmounts when closed, so autoFocus fires on every open —
              and the effect above covers a re-open that React can batch away. */}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, diagrams and books…"
            aria-label="Search query"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <button type="button" className="btn ghost sm" onClick={onClose}>
            Esc
          </button>
        </div>

        <div className="search-results" ref={listRef}>
          {error && <div className="banner error compact">{error}</div>}

          {!trimmed && !error && (
            <p className="search-empty muted sm">
              Type to search across every book. Wrap a phrase in <code>"quotes"</code> to match it
              exactly.
            </p>
          )}

          {trimmed && !error && response && hits.length === 0 && !busy && (
            <p className="search-empty muted sm">
              No matches for <strong>{trimmed}</strong>.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.kind} className="search-group">
              <div className="search-group-label">{group.label}</div>
              {group.items.map((hit) => {
                const index = hits.indexOf(hit)
                return (
                  <button
                    key={`${hit.kind}-${hit.id}`}
                    type="button"
                    className="search-hit"
                    data-active={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => openHit(hit)}
                  >
                    <span className="search-hit-icon" aria-hidden="true">
                      {KIND_ICON[hit.kind]}
                    </span>
                    <span className="search-hit-body">
                      <span className="search-hit-title">{hit.title}</span>
                      {hit.snippet && (
                        <span className="search-hit-snippet">
                          <Highlighted text={hit.snippet} />
                        </span>
                      )}
                    </span>
                    {hit.bookTitle && hit.kind !== 'book' && (
                      <span className="search-hit-book">{hit.bookTitle}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="search-footer muted sm">
          <span>
            <kbd>{'\u2191'}</kbd>
            <kbd>{'\u2193'}</kbd> navigate <kbd>{'\u21B5'}</kbd> open
          </span>
          <span>
            {busy
              ? 'Searching…'
              : response
                ? `${response.total} result${response.total === 1 ? '' : 's'}${
                    response.total > response.hits.length ? ` · showing ${response.hits.length}` : ''
                  }`
                : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Render a snippet, bolding the matched terms.
 *
 * The API marks matches with private-use sentinels rather than HTML, so the text
 * stays plain and nothing from a document can inject markup here.
 */
function Highlighted({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: { text: string; match: boolean }[] = []
    let rest = text
    while (rest.length > 0) {
      const start = rest.indexOf(HIGHLIGHT_OPEN)
      if (start === -1) {
        out.push({ text: rest, match: false })
        break
      }
      if (start > 0) out.push({ text: rest.slice(0, start), match: false })
      const end = rest.indexOf(HIGHLIGHT_CLOSE, start)
      if (end === -1) {
        out.push({ text: rest.slice(start + 1), match: false })
        break
      }
      out.push({ text: rest.slice(start + 1, end), match: true })
      rest = rest.slice(end + 1)
    }
    return out
  }, [text])

  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i}>{part.text}</mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}
