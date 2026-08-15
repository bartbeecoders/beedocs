import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import type { Shelf, StorageProvider } from '../types'
import { withBase } from '../basePath'
import { bookshelfSitePath } from '../markdownLinks'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'
import type { SlideEditorState } from './SlideCanvas'
import { OwnerField } from './OwnerField'
import { PageHistoryPanel } from './PageHistoryPanel'
import { SyncedInput } from './SyncedText'

type Props = {
  pageState: PageEditorState | null
  diagramState: DiagramEditorState | null
  slideState: SlideEditorState | null
  view:
    | 'welcome'
    | 'shelf'
    | 'book'
    | 'page'
    | 'diagram'
    | 'slides'
    | 'settings'
    | 'users'
    | 'stats'
    | 'help'
}

export function PropertiesPane({ pageState, diagramState, slideState, view }: Props) {
  const { bookId, shelfId } = useParams()
  const { canWrite, authEnabled, canManageUsers, user } = useAuth()
  const { books, shelves, setShelfPublished } = useWorkspace()
  const book = books.find((b) => b.id === bookId)
  const shelf = shelves.find((s) => s.id === shelfId)

  if (view === 'help') {
    return (
      <div className="props-pane">
        <h3>About &amp; Help</h3>
        <p className="muted sm">
          Workspace guide, diagram shortcuts, and how to connect an AI agent to this instance over
          MCP.
        </p>
        <ul className="props-links">
          <li>
            <a href="#help-mcp">Connect an AI agent (MCP)</a>
          </li>
          <li>
            <a href="#help-diagrams">Diagrams</a>
          </li>
          <li>
            <a href="#help-shortcuts">Keyboard shortcuts</a>
          </li>
          <li>
            <a href="#help-troubleshooting">Troubleshooting</a>
          </li>
        </ul>
      </div>
    )
  }

  if (view === 'settings') {
    return (
      <div className="props-pane">
        <h3>Settings</h3>
        <p className="muted sm">
          Theme, density, and editor defaults are configured in the center panel.
        </p>
      </div>
    )
  }

  if (view === 'users') {
    return (
      <div className="props-pane">
        <h3>Users</h3>
        <p className="muted sm">
          Accounts and roles are managed in the center panel. Only admins can make changes; your
          own password lives in Settings.
        </p>
      </div>
    )
  }

  if (view === 'stats') {
    return (
      <div className="props-pane">
        <h3>Statistics</h3>
        <p className="muted sm">
          Instance-wide totals and activity. Per-book numbers live on each book&apos;s overview
          page; page-level history is in the History list of each page.
        </p>
      </div>
    )
  }

  if (view === 'page' && pageState) {
    const p = pageState.page
    // Mirrors the server rule: tracking settings belong to the page's owner or
    // an admin (which, with sign-in off, is everyone). Gated on the *saved*
    // owner — assigning yourself in the same edit doesn't grant it early.
    // canWrite too: a viewer who owns a page still cannot save one, and the
    // controls only take effect through a save.
    const canConfigureTracking =
      canWrite && (canManageUsers || (!!user?.id && user.id === (p?.ownerId ?? null)))
    return (
      <div className="props-pane">
        <h3>Page</h3>
        <Field label="Title">
          {canWrite ? (
            <SyncedInput value={pageState.title} onValueChange={pageState.setTitle} />
          ) : (
            <span>{pageState.title}</span>
          )}
        </Field>
        <Field label="Slug">
          <code className="mono-block">{p?.slug ?? '—'}</code>
        </Field>
        <Field label="Version">
          <span>{p?.version ?? '—'}</span>
        </Field>
        <Field label="Owner">
          <OwnerField
            value={pageState.ownerId}
            fallbackName={p?.ownerName}
            onChange={pageState.setOwnerId}
          />
        </Field>
        <Field label="Updated">
          <span className="sm">{p ? new Date(p.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        {p?.updatedByName && (
          <Field label="Last changed by">
            <span className="sm">{p.updatedByName}</span>
          </Field>
        )}
        {canConfigureTracking ? (
          <Field label="Track changes">
            <div className="props-tracking">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={pageState.trackChanges}
                  onChange={(e) => pageState.setTrackChanges(e.target.checked)}
                />
                <span className="sm">Keep every saved version</span>
              </label>
              {pageState.trackChanges && (
                <label className="props-tracking-limit">
                  <span className="sm">Copies to keep</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={pageState.maxRevisions}
                    onChange={(e) => {
                      const n = Math.floor(Number(e.target.value))
                      pageState.setMaxRevisions(Number.isFinite(n) && n > 0 ? n : 0)
                    }}
                  />
                  <span className="muted sm">0 = unlimited</span>
                </label>
              )}
              <p className="muted sm">Applies when you save the page.</p>
            </div>
          </Field>
        ) : (
          p?.trackChanges && (
            <Field label="Track changes">
              <span className="sm">
                On{p.maxRevisions > 0 ? ` · keeps ${p.maxRevisions} copies` : ' · unlimited copies'}
                <span className="muted sm"> — only the owner can change this</span>
              </span>
            </Field>
          )
        )}
        <div className="props-hint">
          <h4>History</h4>
          <PageHistoryPanel pageId={p?.id ?? ''} version={p?.version} />
        </div>
        {/* View mode, saving and the how-to-add-content note are all about
            editing. A read-only account is shown the page's facts and nothing
            it cannot act on. */}
        {canWrite && (
          <>
            <Field label="View mode">
              <select
                value={pageState.mode}
                onChange={(e) => pageState.setMode(e.target.value as PageEditorState['mode'])}
              >
                <option value="edit">Edit (visual diagrams)</option>
                <option value="source">Source (raw Markdown)</option>
                <option value="split">Split</option>
                <option value="preview">Preview</option>
              </select>
            </Field>
            <div className="props-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={pageState.saving || !pageState.dirty}
                onClick={() => void pageState.save()}
              >
                {pageState.saving ? 'Saving…' : 'Save page'}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void pageState.deletePage()}
              >
                Delete
              </button>
            </div>
            <div className="props-hint">
              <h4>Add content</h4>
              <p className="muted sm">
                In <strong>edit</strong> mode use the sticky <strong>Add</strong> bar (or{' '}
                <strong>+</strong> between blocks): sections, lists, tables, BeeDiagram, Mermaid.
                Linked diagrams are book entities; inline BeeDiagram lives only on this page.
              </p>
            </div>
          </>
        )}
      </div>
    )
  }

  if (view === 'diagram' && diagramState) {
    const d = diagramState.diagram
    return (
      <div className="props-pane">
        <h3>Diagram</h3>
        <Field label="Title">
          {canWrite ? (
            <SyncedInput value={diagramState.title} onValueChange={diagramState.setTitle} />
          ) : (
            <span>{diagramState.title}</span>
          )}
        </Field>
        <Field label="Kind">
          {canWrite ? (
            <select
              value={diagramState.kind}
              onChange={(e) => diagramState.setKind(e.target.value)}
            >
              <option value="beediagram">BeeDiagram</option>
              <option value="isometric">Isometric</option>
              <option value="mermaid">Mermaid</option>
              <option value="c4">C4 (Mermaid)</option>
            </select>
          ) : (
            <span>{diagramState.kind}</span>
          )}
        </Field>
        <Field label="Updated">
          <span className="sm">{d ? new Date(d.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        {canWrite && (
          <div className="props-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={diagramState.saving || !diagramState.dirty}
              onClick={() => void diagramState.save()}
            >
              {diagramState.saving ? 'Saving…' : 'Save diagram'}
            </button>
            <button
              type="button"
              className="btn danger ghost sm"
              onClick={() => void diagramState.deleteDiagram()}
            >
              Delete
            </button>
          </div>
        )}
        <div className="props-hint">
          <h4>Markdown embed</h4>
          <pre className="embed-snippet sm">{diagramState.embedSnippet}</pre>
          <button
            type="button"
            className="btn sm"
            onClick={() => void navigator.clipboard.writeText(diagramState.embedSnippet)}
          >
            Copy embed
          </button>
        </div>
      </div>
    )
  }

  if (view === 'slides' && slideState) {
    const d = slideState.deck
    return (
      <div className="props-pane">
        <h3>Slides</h3>
        <Field label="Title">
          {canWrite ? (
            <SyncedInput value={slideState.title} onValueChange={slideState.setTitle} />
          ) : (
            <span>{slideState.title}</span>
          )}
        </Field>
        <Field label="Slides">
          <span>{slideState.slideCount}</span>
        </Field>
        <Field label="Updated">
          <span className="sm">{d ? new Date(d.updatedAt).toLocaleString() : '—'}</span>
        </Field>
        <div className="props-actions">
          <button type="button" className="btn primary sm" onClick={() => slideState.present()}>
            ▶ Present
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn primary sm"
                disabled={slideState.saving || !slideState.dirty}
                onClick={() => void slideState.save()}
              >
                {slideState.saving ? 'Saving…' : 'Save slides'}
              </button>
              <button
                type="button"
                className="btn danger ghost sm"
                onClick={() => void slideState.deleteDeck()}
              >
                Delete
              </button>
            </>
          )}
        </div>
        <div className="props-hint">
          <h4>Presenting</h4>
          <p className="muted sm">
            Arrow keys or click to advance, right-click to go back, <strong>Esc</strong> to end.
            Presenting starts from the selected slide.
          </p>
        </div>
      </div>
    )
  }

  if (view === 'shelf' && shelf) {
    return (
      <div className="props-pane">
        <h3>Shelf</h3>
        <Field label="Title">
          <span>{shelf.title}</span>
        </Field>
        <Field label="Slug">
          <code className="mono-block">{shelf.slug}</code>
        </Field>
        {shelf.description && (
          <Field label="Description">
            <span className="sm">{shelf.description}</span>
          </Field>
        )}
        <Field label="Books">
          <span>{shelf.bookCount}</span>
        </Field>
        <Field label="Owner">
          <ShelfOwnerField
            shelfId={shelf.id}
            title={shelf.title}
            ownerId={shelf.ownerId ?? ''}
            ownerName={shelf.ownerName}
          />
        </Field>
        <Field label="Storage">
          <ShelfStorageField shelf={shelf} />
        </Field>
        <Field label="Website">
          <div className="shelf-site-props">
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!shelf.published}
                disabled={!canWrite}
                onChange={(e) => void setShelfPublished(shelf.id, e.target.checked)}
              />
              <span>
                Serve as a public website
                <span className="muted sm" style={{ display: 'block' }}>
                  {withBase(bookshelfSitePath(shelf.slug))}
                  {authEnabled
                    ? shelf.published
                      ? ' — visitors do not need to sign in.'
                      : ' — unpublished; only people who can already read the workspace can preview it.'
                    : ' — this instance is open, so the URL already works.'}
                </span>
              </span>
            </label>
            <a
              className="btn ghost sm"
              href={withBase(bookshelfSitePath(shelf.slug))}
              target="_blank"
              rel="noreferrer"
            >
              Open website
            </a>
          </div>
        </Field>
        <p className="muted sm">
          A shelf groups books; it holds no pages of its own. Deleting it keeps every book —
          they move back to the library root.
        </p>
      </div>
    )
  }

  if (view === 'book' && book) {
    return (
      <div className="props-pane">
        <h3>Book</h3>
        <Field label="Title">
          <span>{book.title}</span>
        </Field>
        <Field label="Slug">
          <code className="mono-block">{book.slug}</code>
        </Field>
        {book.description && (
          <Field label="Description">
            <span className="sm">{book.description}</span>
          </Field>
        )}
        <Field label="Shelf">
          <BookShelfField bookId={book.id} title={book.title} shelfId={book.shelfId ?? ''} />
        </Field>
        <Field label="Pages">
          <span>{book.pages.length}</span>
        </Field>
        <Field label="Diagrams">
          <span>{book.diagrams.length}</span>
        </Field>
        <Field label="Slide decks">
          <span>{book.slideDecks.length}</span>
        </Field>
        <Field label="Owner">
          <BookOwnerField bookId={book.id} title={book.title} ownerId={book.ownerId ?? ''} ownerName={book.ownerName} />
        </Field>
        <p className="muted sm">
          {canWrite
            ? 'Select a page to edit in the canvas, or create one from the tree.'
            : 'Select a page or diagram in the tree to read it.'}
        </p>
      </div>
    )
  }

  return (
    <div className="props-pane">
      <h3>Properties</h3>
      <p className="muted sm">
        {canWrite
          ? 'Select a book, page, or diagram in the library to inspect and edit metadata.'
          : 'Select a book, page, or diagram in the library to inspect its details.'}
      </p>
      <ul className="props-legend">
        <li>
          <strong>Left</strong> — library tree
        </li>
        <li>
          <strong>Center</strong> — editor canvas
        </li>
        <li>
          <strong>Right</strong> — properties & actions
        </li>
      </ul>
    </div>
  )
}

/**
 * Which shelf the book sits on. Written on change like the owner field, and for
 * the same reason: a book has no save button of its own.
 */
function BookShelfField({
  bookId,
  title,
  shelfId,
}: {
  bookId: string
  title: string
  shelfId: string
}) {
  const { canWrite } = useAuth()
  const { shelves, moveBookToShelf } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canWrite) {
    return <span>{shelves.find((s) => s.id === shelfId)?.title ?? 'Library root'}</span>
  }

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await moveBookToShelf(bookId, next || null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <select
        value={shelfId}
        disabled={busy || shelves.length === 0}
        onChange={(e) => void assign(e.target.value)}
        title={title}
      >
        <option value="">Library root (no shelf)</option>
        {shelves.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      {shelves.length === 0 && <span className="muted sm">No shelves yet.</span>}
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

/**
 * Where the shelf's content bodies live. Unlike every other write-on-change
 * field in this pane, picking a value MOVES data server-side and can take
 * minutes — so the change is confirmed in a modal first, and the select never
 * shows the target until the server says it holds. Admin-only: the API refuses
 * anyone else, and non-admins get the read-only name instead.
 */
function ShelfStorageField({ shelf }: { shelf: Shelf }) {
  const { canManageUsers } = useAuth()
  const { refreshTree } = useWorkspace()
  const [providers, setProviders] = useState<StorageProvider[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The target awaiting confirmation. undefined = no dialog; null = "Local".
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentLabel = shelf.storageProviderName ?? 'Local (SQLite)'

  useEffect(() => {
    if (!canManageUsers) return
    let alive = true
    api
      .listStorageProviders()
      .then((list) => {
        if (alive) setProviders(list)
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [canManageUsers])

  if (!canManageUsers) return <span>{currentLabel}</span>

  const ready = (p: StorageProvider) =>
    p.kind === 'azure-blob' ? p.hasConnectionString : p.googleConnected
  // Ready providers, plus the assigned one even if since broken — the select
  // must be able to show the truth.
  const options = (providers ?? []).filter((p) => ready(p) || p.id === shelf.storageProviderId)
  const pendingName = pending
    ? (options.find((p) => p.id === pending)?.name ?? 'that provider')
    : 'Local (SQLite)'

  return (
    <>
      <select
        value={shelf.storageProviderId ?? ''}
        disabled={moving || providers === null}
        onChange={(e) => {
          const next = e.target.value || null
          if (next !== (shelf.storageProviderId ?? null)) {
            setError(null)
            setPending(next)
          }
        }}
      >
        <option value="">Local (SQLite)</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {providers !== null && options.length === 0 && (
        <span className="muted sm">Add a provider in Settings → Storage providers.</span>
      )}
      {loadError && (
        <span className="users-error" role="alert">
          {loadError}
        </span>
      )}
      {pending !== undefined && (
        <ShelfStorageConfirm
          shelf={shelf}
          currentLabel={currentLabel}
          targetName={pendingName}
          moving={moving}
          error={error}
          onCancel={() => {
            if (!moving) {
              setPending(undefined)
              setError(null)
            }
          }}
          onConfirm={async () => {
            setMoving(true)
            setError(null)
            try {
              await api.setShelfStorage(shelf.id, pending ?? null)
              // The tree carries the Shelf DTO this pane renders from.
              await refreshTree()
              setPending(undefined)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setMoving(false)
            }
          }}
        />
      )}
    </>
  )
}

/** The confirm/progress dialog for a shelf storage move — ImportDialog's modal idiom. */
function ShelfStorageConfirm({
  shelf,
  currentLabel,
  targetName,
  moving,
  error,
  onCancel,
  onConfirm,
}: {
  shelf: Shelf
  currentLabel: string
  targetName: string
  moving: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !moving) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moving, onCancel])

  // A timeout is not a verdict: the server keeps moving after the client hangs up.
  const timedOut = error !== null && /did not respond/i.test(error)

  return (
    <div className="modal-backdrop" onClick={moving ? undefined : onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Move shelf storage</h2>
        </div>
        <div className="modal-body">
          <p>
            Move the content of <strong>{shelf.title}</strong> ({shelf.bookCount}{' '}
            {shelf.bookCount === 1 ? 'book' : 'books'}) from <strong>{currentLabel}</strong> to{' '}
            <strong>{targetName}</strong>?
          </p>
          <p className="muted sm">
            Every page, revision, diagram and slide deck body is moved to the new location. This
            runs on the server and can take several minutes for a large shelf. If it is
            interrupted, running the same move again resumes where it stopped.
          </p>
          {moving && (
            <p className="banner warn compact">Moving content… keep this tab open.</p>
          )}
          {error && (
            <p className="banner error compact">
              {error}
              {timedOut
                ? ' The move may still be finishing on the server — wait a moment, then run the same move again; finished items are skipped.'
                : ''}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" disabled={moving} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={moving} onClick={onConfirm}>
            {moving ? 'Moving…' : 'Move content'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The shelf equivalent of {@link BookOwnerField} — same write-on-change reason. */
function ShelfOwnerField({
  shelfId,
  title,
  ownerId,
  ownerName,
}: {
  shelfId: string
  title: string
  ownerId: string
  ownerName?: string | null
}) {
  const { refreshTree } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateShelf(shelfId, { title, ownerId: next })
      await refreshTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <OwnerField
        value={ownerId}
        fallbackName={ownerName}
        disabled={busy}
        onChange={(next) => void assign(next)}
      />
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

/**
 * A book has no editor to save through, so its owner is written on change.
 * The title rides along because the API requires it on every book update.
 */
function BookOwnerField({
  bookId,
  title,
  ownerId,
  ownerName,
}: {
  bookId: string
  title: string
  ownerId: string
  ownerName?: string | null
}) {
  const { refreshTree } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const assign = async (next: string) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateBook(bookId, { title, ownerId: next })
      // The tree carries the book DTO the pane renders from, so it has to be the
      // thing that learns about the new owner.
      await refreshTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <OwnerField
        value={ownerId}
        fallbackName={ownerName}
        disabled={busy}
        onChange={(next) => void assign(next)}
      />
      {error && (
        <span className="users-error" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="props-field">
      <span className="props-label">{label}</span>
      {children}
    </label>
  )
}
