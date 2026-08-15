import { Suspense, lazy, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { BeeDiagramWorkbench } from '../components/BeeDiagramWorkbench'
import { MarkdownView } from '../components/MarkdownView'
import type { Diagram } from '../types'

const IsometricEditor = lazy(() => import('../isometric/IsometricEditor'))

export function DiagramEditorPage() {
  const { bookId = '', diagramId = '' } = useParams()
  const navigate = useNavigate()
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [kind, setKind] = useState('beediagram')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const d = await api.getDiagram(diagramId)
        setDiagram(d)
        setTitle(d.title)
        setSource(d.source)
        setKind(d.kind)
        setDirty(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [diagramId])

  const onSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateDiagram(diagramId, { title, kind, source })
      setDiagram(updated)
      setSavedAt(new Date().toLocaleTimeString())
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!confirm('Delete this diagram?')) return
    await api.deleteDiagram(diagramId)
    navigate(`/books/${bookId}`)
  }

  const embedSnippet =
    kind === 'beediagram' || kind === 'isometric'
      ? `\`\`\`${kind === 'isometric' ? 'isometric-ref' : 'beediagram-ref'}\n${diagramId}\n\`\`\``
      : `\`\`\`${kind === 'c4' ? 'mermaid' : kind}\n${source}\n\`\`\``

  if (!diagram && !error) return <p className="muted">Loading diagram…</p>

  return (
    <div className="page diagram-editor-page">
      <nav className="crumbs">
        <Link to="/">Books</Link>
        <span>/</span>
        <Link to={`/books/${bookId}`}>Book</Link>
        <span>/</span>
        <span>{diagram?.title ?? '…'}</span>
      </nav>

      {error && <div className="banner error">{error}</div>}

      <div className="editor-toolbar">
        <input
          className="title-input"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setDirty(true)
          }}
          placeholder="Diagram title"
        />
        <div className="toolbar-group">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value)
              setDirty(true)
            }}
            aria-label="Diagram kind"
          >
            <option value="beediagram">BeeDiagram (canvas)</option>
            <option value="isometric">Isometric</option>
            <option value="mermaid">Mermaid source</option>
            <option value="c4">C4 (Mermaid)</option>
          </select>
          <button type="button" className="btn primary" disabled={saving || !dirty} onClick={() => void onSave()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" className="btn danger ghost" onClick={() => void onDelete()}>
            Delete
          </button>
        </div>
      </div>

      <p className="meta">
        {diagram && (
          <>
            Kind {kind}
            {savedAt && ` · saved ${savedAt}`}
            {dirty && ' · unsaved changes'}
            {' · '}
            embed in Markdown with <code>beediagram-ref</code>
          </>
        )}
      </p>

      {kind === 'beediagram' ? (
        <BeeDiagramWorkbench
          bookId={bookId}
          source={source}
          onChange={(s) => {
            setSource(s)
            setDirty(true)
          }}
        />
      ) : kind === 'isometric' ? (
        <Suspense fallback={<p className="muted">Loading isometric editor…</p>}>
          <IsometricEditor
            key={diagramId}
            source={source}
            title={title}
            onChange={(s) => {
              setSource(s)
              setDirty(true)
            }}
          />
        </Suspense>
      ) : (
        <div className="editor-panes mode-split">
          <textarea
            className="editor-textarea"
            value={source}
            onChange={(e) => {
              setSource(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            placeholder="Mermaid / C4 source…"
          />
          <div className="editor-preview">
            <MarkdownView content={'```mermaid\n' + source + '\n```'} />
          </div>
        </div>
      )}

      <section className="card embed-card">
        <h3>Embed in a page</h3>
        <p className="muted">Paste this into a Markdown page:</p>
        <pre className="embed-snippet">{embedSnippet}</pre>
        <button
          type="button"
          className="btn"
          onClick={() => void navigator.clipboard.writeText(embedSnippet)}
        >
          Copy embed
        </button>
      </section>
    </div>
  )
}
