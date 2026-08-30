import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { withBase } from '../basePath'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import { MarkdownView } from '../components/MarkdownView'
import { PageOutlineNav } from '../components/PageOutlineNav'
import { bookshelfSitePath } from '../markdownLinks'
import { THEMES, useTheme } from '../theme'
import type {
  BookshelfSite as SiteTree,
  BookshelfSiteBook,
  BookshelfSitePage,
  BookshelfSitePageSummary,
  SearchHit,
  SearchResponse,
} from '../types'
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from '../types'
import { MarkdownSiteContext } from './markdownSite'
import '../styles/bookshelf-site.css'

type RouteParams = {
  shelfName?: string
  bookSlug?: string
  pageSlug?: string
}

type FlatPage = {
  book: BookshelfSiteBook
  page: BookshelfSitePageSummary
  chapterTitle?: string
}

/** Drop a leading `# Title` that repeats the page name the site already shows. */
function withoutRedundantTitle(content: string, title: string): string {
  const match = content.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/)
  if (!match) return content
  if (match[1].trim().toLowerCase() !== title.trim().toLowerCase()) return content
  return content.slice(match[0].length)
}

/** Pick the .one/.other plural key for a count ("3 books", "1 result"). */
function countLabel(
  t: TFunction,
  base: 'site.booksCount' | 'site.pagesCount' | 'site.resultsCount',
  count: number,
): string {
  return t(`${base}.${count === 1 ? 'one' : 'other'}` as MessageKey, { count })
}

function flattenPages(site: SiteTree): FlatPage[] {
  const out: FlatPage[] = []
  for (const book of site.books) {
    for (const page of book.pages) out.push({ book, page })
    for (const chapter of book.chapters) {
      for (const page of chapter.pages) out.push({ book, page, chapterTitle: chapter.title })
    }
  }
  return out
}

function buildResolver(site: SiteTree) {
  const pageById = new Map<string, { bookSlug: string; pageSlug: string }>()
  const bookById = new Map<string, string>()
  for (const book of site.books) {
    bookById.set(book.id, book.slug)
    for (const page of book.pages) {
      pageById.set(page.id, { bookSlug: book.slug, pageSlug: page.slug })
    }
    for (const chapter of book.chapters) {
      for (const page of chapter.pages) {
        pageById.set(page.id, { bookSlug: book.slug, pageSlug: page.slug })
      }
    }
  }

  return (href: string) => {
    const pageMatch = href.match(/^\/books\/([^/?#]+)\/pages\/([^/?#]+)/)
    if (pageMatch) {
      const loc = pageById.get(pageMatch[2])
      if (loc) return bookshelfSitePath(site.shelf.slug, loc.bookSlug, loc.pageSlug)
    }
    const bookMatch = href.match(/^\/books\/([^/?#]+)\/?$/)
    if (bookMatch) {
      const slug = bookById.get(bookMatch[1])
      if (slug) return bookshelfSitePath(site.shelf.slug, slug)
    }
    const shelfMatch = href.match(/^\/shelves\/([^/?#]+)/)
    if (shelfMatch && shelfMatch[1] === site.shelf.id) {
      return bookshelfSitePath(site.shelf.slug)
    }
    return href
  }
}

export function BookshelfSite() {
  const { shelfName = '', bookSlug, pageSlug } = useParams<RouteParams>()
  const navigate = useNavigate()
  const { t } = useI18n()
  const { themeDef, setTheme, theme } = useTheme()
  const { authEnabled, needsLogin, user } = useAuth()
  const [site, setSite] = useState<SiteTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set())

  const load = useCallback(async (name: string) => {
    setError(null)
    try {
      const next = await api.getBookshelfSite(name)
      setSite(next)
    } catch (e) {
      setSite(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (!shelfName) return
    void load(shelfName)
  }, [shelfName, load])

  // Canonicalise /bookshelf-serve/My%20Shelf → /bookshelf-serve/my-shelf
  useEffect(() => {
    if (!site) return
    if (decodeURIComponent(shelfName) === site.shelf.slug) return
    const next = bookshelfSitePath(site.shelf.slug, bookSlug, pageSlug)
    navigate(next, { replace: true })
  }, [site, shelfName, bookSlug, pageSlug, navigate])

  useEffect(() => {
    if (!site) return
    if (bookSlug) {
      const book = site.books.find((b) => b.slug === bookSlug)
      if (book) {
        setExpandedBooks((prev) => {
          if (prev.has(book.id)) return prev
          const next = new Set(prev)
          next.add(book.id)
          return next
        })
      }
    } else if (expandedBooks.size === 0 && site.books.length > 0) {
      setExpandedBooks(new Set(site.books.slice(0, 3).map((b) => b.id)))
    }
  }, [site, bookSlug, expandedBooks.size])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') {
        setSearchOpen(false)
        setNavOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    setNavOpen(false)
  }, [shelfName, bookSlug, pageSlug])

  const pages = useMemo(() => (site ? flattenPages(site) : []), [site])
  const markdownSite = useMemo(() => {
    if (!site) return {}
    const resolveHref = buildResolver(site)
    return {
      resolveHref,
      getDiagram: (id: string) => api.getBookshelfSiteDiagram(site.shelf.slug, id),
    }
  }, [site])

  const book = site?.books.find((b) => b.slug === bookSlug)
  const currentIndex = pages.findIndex(
    (p) => p.book.slug === bookSlug && p.page.slug === pageSlug,
  )
  const current = currentIndex >= 0 ? pages[currentIndex] : undefined
  const prev = currentIndex > 0 ? pages[currentIndex - 1] : undefined
  const next = currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : undefined

  useEffect(() => {
    const previous = document.title
    if (!site) {
      document.title = t('site.bookshelf')
      return () => {
        document.title = previous
      }
    }
    if (current) document.title = `${current.page.title} · ${site.shelf.title}`
    else if (book) document.title = `${book.title} · ${site.shelf.title}`
    else document.title = site.shelf.title
    return () => {
      document.title = previous
    }
  }, [site, book, current, t])

  const cycleTheme = () => {
    const i = THEMES.findIndex((th) => th.id === theme)
    setTheme(THEMES[(i + 1) % THEMES.length]!.id)
  }

  if (error && !site) {
    // Split on the {name} token so the shelf name keeps its <code> styling in
    // every language, wherever the sentence puts it.
    const [leadBefore, leadAfter = ''] = t('site.notOnWebLead').split('{name}')
    return (
      <div className="bsite bsite--empty">
        <div className="bsite-missing">
          <p className="bsite-missing-mark" aria-hidden>
            📚
          </p>
          <h1>{t('site.notOnWebTitle')}</h1>
          <p className="muted">
            {leadBefore}
            <code>{decodeURIComponent(shelfName)}</code>
            {leadAfter}
          </p>
          <div className="bsite-missing-actions">
            {authEnabled && needsLogin && (
              <Link to="/" className="btn primary">
                {t('site.signInToPreview')}
              </Link>
            )}
            <Link to="/" className="btn ghost">
              {t('site.openWorkspace')}
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!site) {
    return (
      <div className="bsite bsite--empty">
        <p className="muted">{t('site.loadingWebsite')}</p>
      </div>
    )
  }

  const home = bookshelfSitePath(site.shelf.slug)
  const canEdit = !needsLogin

  return (
    <MarkdownSiteContext.Provider value={markdownSite}>
      <div className="bsite">
        <header className="bsite-header">
          <button
            type="button"
            className="bsite-nav-toggle"
            aria-expanded={navOpen}
            aria-controls="bsite-nav"
            onClick={() => setNavOpen((v) => !v)}
          >
            {navOpen ? t('common.close') : t('site.menu')}
          </button>
          <Link to={home} className="bsite-brand">
            <span className="bsite-brand-mark" aria-hidden>
              📚
            </span>
            <span className="bsite-brand-text">{site.shelf.title}</span>
          </Link>
          <div className="bsite-header-actions">
            <button
              type="button"
              className="bsite-search-btn"
              onClick={() => setSearchOpen(true)}
              title={t('site.searchButtonTitle')}
            >
              <span aria-hidden>⌕</span>
              <span className="bsite-search-label">{t('common.search')}</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button type="button" className="bsite-theme" onClick={cycleTheme} title={t('site.switchTheme')}>
              {themeDef.label}
            </button>
            {canEdit && (
              <a
                className="btn ghost sm"
                href={withBase(`/shelves/${site.shelf.id}`)}
                title={t('site.openInWorkspace')}
              >
                {t('site.workspace')}
              </a>
            )}
            {user && <span className="bsite-user muted sm">{user.displayName || user.username}</span>}
          </div>
        </header>

        {!site.shelf.published && (
          <div className="bsite-preview-banner" role="status">
            {t('site.previewBanner')}
          </div>
        )}

        <div className="bsite-body">
          {navOpen && (
            <button
              type="button"
              className="bsite-nav-backdrop"
              aria-label={t('site.closeNav')}
              onClick={() => setNavOpen(false)}
            />
          )}
          <aside id="bsite-nav" className={`bsite-nav${navOpen ? ' is-open' : ''}`}>
            <SiteNav
              site={site}
              bookSlug={bookSlug}
              pageSlug={pageSlug}
              expandedBooks={expandedBooks}
              onToggleBook={(id) =>
                setExpandedBooks((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
            />
          </aside>

          <main className="bsite-main">
            {pageSlug && book ? (
              <SitePageView
                shelfSlug={site.shelf.slug}
                book={book}
                pageSlug={pageSlug}
                prev={prev}
                next={next}
              />
            ) : book ? (
              <SiteBookView site={site} book={book} />
            ) : (
              <SiteHome site={site} />
            )}
          </main>
        </div>

        {searchOpen && (
          <SiteSearch
            shelfSlug={site.shelf.slug}
            onClose={() => setSearchOpen(false)}
            onOpen={(url) => {
              setSearchOpen(false)
              navigate(url)
            }}
          />
        )}
      </div>
    </MarkdownSiteContext.Provider>
  )
}

function SiteNav({
  site,
  bookSlug,
  pageSlug,
  expandedBooks,
  onToggleBook,
}: {
  site: SiteTree
  bookSlug?: string
  pageSlug?: string
  expandedBooks: Set<string>
  onToggleBook: (id: string) => void
}) {
  const { t } = useI18n()
  const home = bookshelfSitePath(site.shelf.slug)
  return (
    <nav className="bsite-toc" aria-label={t('site.navAria')}>
      <Link to={home} className={`bsite-toc-home${!bookSlug ? ' is-active' : ''}`}>
        {t('site.overview')}
      </Link>
      {site.books.length === 0 && <p className="muted sm">{t('site.noBooksNav')}</p>}
      {site.books.map((book) => {
        const open = expandedBooks.has(book.id)
        const bookActive = book.slug === bookSlug && !pageSlug
        const pageCount =
          book.pages.length + book.chapters.reduce((n, c) => n + c.pages.length, 0)
        return (
          <div key={book.id} className="bsite-toc-book">
            <div className="bsite-toc-book-row">
              <button
                type="button"
                className="bsite-toc-twist"
                aria-expanded={open}
                onClick={() => onToggleBook(book.id)}
              >
                {open ? '▾' : '▸'}
              </button>
              <Link
                to={bookshelfSitePath(site.shelf.slug, book.slug)}
                className={`bsite-toc-book-link${bookActive ? ' is-active' : ''}`}
              >
                {book.title}
                <span className="bsite-toc-count">{pageCount}</span>
              </Link>
            </div>
            {open && (
              <ul className="bsite-toc-pages">
                {book.pages.map((page) => (
                  <li key={page.id}>
                    <Link
                      to={bookshelfSitePath(site.shelf.slug, book.slug, page.slug)}
                      className={
                        book.slug === bookSlug && page.slug === pageSlug ? 'is-active' : undefined
                      }
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
                {book.chapters.map((chapter) => (
                  <li key={chapter.id} className="bsite-toc-chapter">
                    <span className="bsite-toc-chapter-label">{chapter.title}</span>
                    <ul>
                      {chapter.pages.map((page) => (
                        <li key={page.id}>
                          <Link
                            to={bookshelfSitePath(site.shelf.slug, book.slug, page.slug)}
                            className={
                              book.slug === bookSlug && page.slug === pageSlug
                                ? 'is-active'
                                : undefined
                            }
                          >
                            {page.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </nav>
  )
}

function SiteHome({ site }: { site: SiteTree }) {
  const { t } = useI18n()
  const pageCount = site.books.reduce(
    (n, b) => n + b.pages.length + b.chapters.reduce((m, c) => m + c.pages.length, 0),
    0,
  )
  return (
    <article className="bsite-article">
      <header className="bsite-hero">
        <p className="bsite-kicker">{t('site.bookshelf')}</p>
        <h1>{site.shelf.title}</h1>
        {site.shelf.description && <p className="bsite-lead">{site.shelf.description}</p>}
        <p className="bsite-meta muted sm">
          {countLabel(t, 'site.booksCount', site.books.length)}
          {' · '}
          {countLabel(t, 'site.pagesCount', pageCount)}
        </p>
      </header>
      {site.books.length === 0 ? (
        <p className="muted">{t('site.homeNoBooks')}</p>
      ) : (
        <ul className="bsite-book-grid">
          {site.books.map((book) => {
            const count =
              book.pages.length + book.chapters.reduce((n, c) => n + c.pages.length, 0)
            const first = flattenPages({ shelf: site.shelf, books: [book] })[0]
            return (
              <li key={book.id}>
                <Link
                  to={bookshelfSitePath(site.shelf.slug, book.slug)}
                  className="bsite-book-card"
                >
                  <h2>{book.title}</h2>
                  {book.description && <p className="muted sm">{book.description}</p>}
                  <p className="bsite-card-meta">
                    {countLabel(t, 'site.pagesCount', count)}
                    {first && (
                      <>
                        {' · '}
                        {t('site.startWith', { title: first.page.title })}
                      </>
                    )}
                  </p>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}

function SiteBookView({ site, book }: { site: SiteTree; book: BookshelfSiteBook }) {
  const { t } = useI18n()
  const first = flattenPages({ shelf: site.shelf, books: [book] })[0]
  return (
    <article className="bsite-article">
      <header className="bsite-hero">
        <p className="bsite-kicker">
          <Link to={bookshelfSitePath(site.shelf.slug)}>{site.shelf.title}</Link>
        </p>
        <h1>{book.title}</h1>
        {book.description && <p className="bsite-lead">{book.description}</p>}
        {first && (
          <Link
            className="btn primary"
            to={bookshelfSitePath(site.shelf.slug, book.slug, first.page.slug)}
          >
            {t('site.startReading')}
          </Link>
        )}
      </header>
      <section className="bsite-contents">
        <h2>{t('site.contents')}</h2>
        {book.pages.length === 0 && book.chapters.length === 0 && (
          <p className="muted">{t('site.bookNoPages')}</p>
        )}
        {book.pages.length > 0 && (
          <ol className="bsite-contents-list">
            {book.pages.map((page) => (
              <li key={page.id}>
                <Link to={bookshelfSitePath(site.shelf.slug, book.slug, page.slug)}>
                  {page.title}
                </Link>
              </li>
            ))}
          </ol>
        )}
        {book.chapters.map((chapter) => (
          <div key={chapter.id} className="bsite-contents-chapter">
            <h3>{chapter.title}</h3>
            <ol className="bsite-contents-list">
              {chapter.pages.map((page) => (
                <li key={page.id}>
                  <Link to={bookshelfSitePath(site.shelf.slug, book.slug, page.slug)}>
                    {page.title}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>
    </article>
  )
}

function SitePageView({
  shelfSlug,
  book,
  pageSlug,
  prev,
  next,
}: {
  shelfSlug: string
  book: BookshelfSiteBook
  pageSlug: string
  prev?: FlatPage
  next?: FlatPage
}) {
  const { t } = useI18n()
  const [page, setPage] = useState<BookshelfSitePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    setPage(null)
    setError(null)
    void api
      .getBookshelfSitePage(shelfSlug, book.slug, pageSlug)
      .then((p) => {
        if (!cancelled) setPage(p)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [shelfSlug, book.slug, pageSlug])

  useEffect(() => {
    articleRef.current?.scrollTo?.({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [pageSlug, book.slug])

  if (error) {
    return (
      <article className="bsite-article">
        <div className="banner error">{error}</div>
      </article>
    )
  }

  if (!page) {
    return (
      <article className="bsite-article">
        <p className="muted">{t('site.loadingPage')}</p>
      </article>
    )
  }

  return (
    <div className="bsite-page">
      <article className="bsite-article" ref={articleRef}>
        <header className="bsite-page-head">
          <p className="bsite-kicker">
            <Link to={bookshelfSitePath(shelfSlug, book.slug)}>{book.title}</Link>
            {page.chapterTitle && (
              <>
                <span aria-hidden> · </span>
                {page.chapterTitle}
              </>
            )}
          </p>
          <h1>{page.title}</h1>
        </header>
        {page.content.trim() ? (
          <MarkdownView
            content={withoutRedundantTitle(page.content, page.title)}
            bookId={page.bookId}
          />
        ) : (
          <p className="muted">{t('site.pageEmpty')}</p>
        )}
        <nav className="bsite-pager" aria-label={t('common.page')}>
          {prev ? (
            <Link
              className="bsite-pager-link prev"
              to={bookshelfSitePath(shelfSlug, prev.book.slug, prev.page.slug)}
            >
              <span className="muted sm">{t('site.previous')}</span>
              <span>{prev.page.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              className="bsite-pager-link next"
              to={bookshelfSitePath(shelfSlug, next.book.slug, next.page.slug)}
            >
              <span className="muted sm">{t('site.next')}</span>
              <span>{next.page.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
      {page.content.trim() && (
        <PageOutlineNav
          content={withoutRedundantTitle(page.content, page.title)}
          rootRef={articleRef}
          className="bsite-outline"
        />
      )}
    </div>
  )
}

function SiteSearch({
  shelfSlug,
  onClose,
  onOpen,
}: {
  shelfSlug: string
  onClose: () => void
  onOpen: (url: string) => void
}) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hits = response?.hits ?? []

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
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
        .searchBookshelfSite(shelfSlug, text, { limit: 30, signal: controller.signal })
        .then((res) => {
          setResponse(res)
          setError(null)
          setActive(0)
        })
        .catch((e) => {
          if (e instanceof Error && e.name === 'AbortError') return
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => setBusy(false))
    }, 120)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, shelfSlug])

  const open = (hit: SearchHit) => onOpen(hit.url)

  return (
    <div className="bsite-search" role="dialog" aria-label={t('site.searchWebsite')}>
      <button type="button" className="bsite-search-backdrop" aria-label={t('site.closeSearch')} onClick={onClose} />
      <div className="bsite-search-panel">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('site.searchPlaceholder')}
          aria-label={t('common.search')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(hits.length - 1, i + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(0, i - 1))
            }
            if (e.key === 'Enter' && hits[active]) open(hits[active])
          }}
        />
        <div className="bsite-search-results">
          {error && <p className="banner error compact">{error}</p>}
          {!query.trim() && <p className="muted sm">{t('site.searchHint')}</p>}
          {query.trim() && !error && response && hits.length === 0 && !busy && (
            <NoMatches text={t('site.noMatches')} query={query.trim()} />
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.kind}-${hit.id}`}
              type="button"
              className="bsite-search-hit"
              data-active={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => open(hit)}
            >
              <span className="bsite-search-kind">{t(`site.kind.${hit.kind}` as MessageKey)}</span>
              <span className="bsite-search-hit-body">
                <span className="bsite-search-title">{hit.title}</span>
                {hit.snippet && (
                  <span className="bsite-search-snippet">
                    <Highlighted text={hit.snippet} />
                  </span>
                )}
              </span>
              {hit.bookTitle && hit.kind !== 'book' && (
                <span className="muted sm">{hit.bookTitle}</span>
              )}
            </button>
          ))}
        </div>
        <p className="bsite-search-foot muted sm">
          {busy ? t('site.searching') : response ? countLabel(t, 'site.resultsCount', response.total) : ''}
        </p>
      </div>
    </div>
  )
}

/**
 * "No matches for <strong>query</strong>." — the message is split on its
 * {query} token so the query keeps its emphasis wherever the sentence puts it.
 */
function NoMatches({ text, query }: { text: string; query: string }) {
  const [before, after = ''] = text.split('{query}')
  return (
    <p className="muted sm">
      {before}
      <strong>{query}</strong>
      {after}
    </p>
  )
}

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
      rest = rest.slice(start + HIGHLIGHT_OPEN.length)
      const end = rest.indexOf(HIGHLIGHT_CLOSE)
      if (end === -1) {
        out.push({ text: rest, match: true })
        break
      }
      out.push({ text: rest.slice(0, end), match: true })
      rest = rest.slice(end + HIGHLIGHT_CLOSE.length)
    }
    return out
  }, [text])

  return (
    <>
      {parts.map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  )
}
