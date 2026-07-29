import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { PageEditorState } from './PageCanvas'
import type { DiagramEditorState } from './DiagramCanvas'

type Props = {
  pageState: PageEditorState | null
  diagramState: DiagramEditorState | null
  view: 'welcome' | 'book' | 'page' | 'diagram' | 'settings'
}

export function PropertiesPane({ pageState, diagramState, view }: Props) {
  const { bookId } = useParams()
  const { books } = useWorkspace()
  const book = books.find((b) => b.id === bookId)

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
          <input
            value={pageState.title}
            onChange={(e) => pageState.setTitle(e.target.value)}
          />
        </Field>
        <Field label="Slug">
          <code className="mono-block">{p?.slug ?? '—'}</code>
        </Field>
        <Field label="Version">
          <span>{p?.version ?? '—'}</span>
        </Field>
        <Field label="Updated">
          <span className="sm">{p ? new Date(p.updatedAt).toLocaleString() : '—'}</span>
        </Field>
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
          <button type="button" className="btn danger ghost sm" onClick={() => void pageState.deletePage()}>
            Delete
          </button>
        </div>
        <div className="props-hint">
          <h4>Add content</h4>
          <p className="muted sm">
            In <strong>edit</strong> mode use the sticky <strong>Add</strong> bar (or <strong>+</strong> between
            blocks): sections, lists, tables, BeeDiagram, Mermaid. Linked diagrams are book entities; inline
            BeeDiagram lives only on this page.
          </p>
        </div>
      </div>
    )
  }

  if (view === 'diagram' && diagramState) {
    const d = diagramState.diagram
    return (
      <div className="props-pane">
        <h3>Diagram</h3>
        <Field label="Title">
          <input
            value={diagramState.title}
            onChange={(e) => diagramState.setTitle(e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <select
            value={diagramState.kind}
            onChange={(e) => diagramState.setKind(e.target.value)}
          >
            <option value="beediagram">BeeDiagram</option>
            <option value="mermaid">Mermaid</option>
            <option value="c4">C4 (Mermaid)</option>
          </select>
        </Field>
        <Field label="Updated">
          <span className="sm">{d ? new Date(d.updatedAt).toLocaleString() : '—'}</span>
        </Field>
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
        <Field label="Pages">
          <span>{book.pages.length}</span>
        </Field>
        <Field label="Diagrams">
          <span>{book.diagrams.length}</span>
        </Field>
        <p className="muted sm">
          Select a page to edit in the canvas, or create one from the tree.
        </p>
      </div>
    )
  }

  return (
    <div className="props-pane">
      <h3>Properties</h3>
      <p className="muted sm">
        Select a book, page, or diagram in the library to inspect and edit metadata.
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="props-field">
      <span className="props-label">{label}</span>
      {children}
    </label>
  )
}
