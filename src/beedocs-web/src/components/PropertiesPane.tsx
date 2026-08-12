import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'
import { OwnerField } from './OwnerField'
import { PageHistoryPanel } from './PageHistoryPanel'
import { SyncedInput } from './SyncedText'

type Props = {
  pageState: PageEditorState | null
  diagramState: DiagramEditorState | null
  view: 'welcome' | 'shelf' | 'book' | 'page' | 'diagram' | 'settings' | 'help'
}

export function PropertiesPane({ pageState, diagramState, view }: Props) {
  const { bookId, shelfId } = useParams()
  const { canWrite } = useAuth()
  const { books, shelves } = useWorkspace()
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

  if (view === 'page' && pageState) {
    const p = pageState.page
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
