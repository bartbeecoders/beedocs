import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useI18n } from '../i18n'
import type { SearchKind } from '../types'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { KIND_ICON } from '../searchKinds'

/** A document the picker can link to — a search hit or an item of the current book. */
export type LinkTarget = { kind: SearchKind; id: string; title: string; url: string; bookTitle?: string | null }

/** Kinds worth linking from prose: documents with a route of their own. */
const LINKABLE: SearchKind[] = ['page', 'diagram', 'slides', 'kanban', 'project', 'note', 'attachment', 'book', 'shelf']

type Props = {
  bookId?: string
  /** The page being edited — left out of the list, a page linking to itself is noise. */
  pageId?: string
  onPick: (target: LinkTarget) => void
  onClose: () => void
}

/**
 * "Link to document…" from the section context menu: pick any page, diagram,
 * board, plan, note, file, book or shelf and get a Markdown link to its
 * workspace route. With no query it lists the current book, which is where a
 * link usually points; typing searches the whole library (the same FTS index
 * as Ctrl+K), so it only offers what the reader can see.
 */
export function LinkDocumentDialog({ bookId, pageId, onPick, onClose }: Props) {
  const { t } = useI18n()
  const { books } = useWorkspace()
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<LinkTarget[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const book = books.find((b) => b.id === bookId)
  const local = useMemo<LinkTarget[]>(() => {
    if (!book) return []
    const base = `/books/${book.id}`
    return [
      ...book.pages
        .filter((p) => p.id !== pageId)
        .map((p) => ({ kind: 'page' as const, id: p.id, title: p.title, url: `${base}/pages/${p.id}` })),
      ...book.diagrams.map((d) => ({ kind: 'diagram' as const, id: d.id, title: d.title, url: `${base}/diagrams/${d.id}` })),
      ...book.slideDecks.map((d) => ({ kind: 'slides' as const, id: d.id, title: d.title, url: `${base}/slides/${d.id}` })),
      ...book.kanbanBoards.map((d) => ({ kind: 'kanban' as const, id: d.id, title: d.title, url: `${base}/kanban/${d.id}` })),
      ...book.projectPlans.map((d) => ({ kind: 'project' as const, id: d.id, title: d.title, url: `${base}/project/${d.id}` })),
      ...book.notes.map((d) => ({ kind: 'note' as const, id: d.id, title: d.title, url: `${base}/notes/${d.id}` })),
      ...book.attachments.map((d) => ({ kind: 'attachment' as const, id: d.id, title: d.title, url: `${base}/files/${d.id}` })),
    ]
  }, [book, pageId])

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setHits(null)
      setError(null)
      setBusy(false)
      return
    }
    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(() => {
      api
        .search(text, { limit: 30, kinds: LINKABLE, signal: controller.signal })
        .then((res) => {
          setHits(
            res.hits
              .filter((h) => !(h.kind === 'page' && h.id === pageId))
              .map((h) => ({ kind: h.kind, id: h.id, title: h.title, url: h.url, bookTitle: h.bookTitle })),
          )
          setError(null)
          setActive(0)
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          setError(err instanceof Error ? err.message : String(err))
          setHits(null)
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false)
        })
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, pageId])

  const list = hits ?? local

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (list.length ? (i + 1) % list.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (list.length ? (i - 1 + list.length) % list.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = list[active]
      if (pick) onPick(pick)
    }
  }

  return createPortal(
    <div className="search-overlay link-doc-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="search-palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('sectionMenu.link.title')}
      >
        <div className="search-field">
          <span className="search-field-icon" aria-hidden="true">
            {'\u{1F517}'}
          </span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={t('sectionMenu.link.placeholder')}
            aria-label={t('sectionMenu.link.title')}
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
          {!hits && list.length > 0 && (
            <div className="search-group-label">
              {book ? t('sectionMenu.link.inBook', { book: book.title }) : ''}
            </div>
          )}
          {!error && list.length === 0 && !busy && (
            <p className="search-empty muted sm">
              {query.trim() ? t('sectionMenu.link.noMatches') : t('sectionMenu.link.typeToSearch')}
            </p>
          )}
          {list.map((item, index) => (
            <button
              key={`${item.kind}-${item.id}`}
              type="button"
              className="search-hit"
              data-active={index === active}
              onMouseMove={() => setActive(index)}
              onClick={() => onPick(item)}
            >
              <span className="search-hit-icon" aria-hidden="true">
                {KIND_ICON[item.kind]}
              </span>
              <span className="search-hit-body">
                <span className="search-hit-title">{item.title}</span>
              </span>
              {item.bookTitle && item.kind !== 'book' && <span className="search-hit-book">{item.bookTitle}</span>}
            </button>
          ))}
        </div>
        <div className="search-footer muted sm">
          <span>
            <kbd>{'↑'}</kbd>
            <kbd>{'↓'}</kbd> {t('search.footerNavigate')} <kbd>{'↵'}</kbd> {t('sectionMenu.link.insert')}
          </span>
          <span>{busy ? t('search.searching') : ''}</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}
