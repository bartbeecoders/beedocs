import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { ExportBookButton } from '../components/ExportBookButton'
import type { Book, DiagramSummary, PageSummary } from '../types'

export function BookPage() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [pages, setPages] = useState<PageSummary[]>([])
  const [diagrams, setDiagrams] = useState<DiagramSummary[]>([])
  const [title, setTitle] = useState('')
  const [diagramTitle, setDiagramTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setError(null)
    try {
      const [b, p, d] = await Promise.all([
        api.getBook(bookId),
        api.listPages(bookId),
        api.listDiagrams(bookId),
      ])
      setBook(b)
      setPages(p)
      setDiagrams(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
  }, [bookId])

  const onCreatePage = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    const sample = `# ${title.trim()}

Write architecture notes in **Markdown**.

## C4 / Mermaid example

\`\`\`mermaid
C4Context
    title System Context
    Person(user, "Engineer", "Reads docs")
    System(beedocs, "BeeDocs", "Team documentation platform")
    Rel(user, beedocs, "Browses books & pages")
\`\`\`
`
    try {
      const page = await api.createPage(bookId, {
        title: title.trim(),
        content: sample,
      })
      setTitle('')
      void navigate(`/books/${bookId}/pages/${page.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onCreateDiagram = async (e: FormEvent) => {
    e.preventDefault()
    if (!diagramTitle.trim()) return
    try {
      const diagram = await api.createDiagram(bookId, {
        title: diagramTitle.trim(),
        kind: 'beediagram',
      })
      setDiagramTitle('')
      void navigate(`/books/${bookId}/diagrams/${diagram.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDeleteDiagram = async (id: string, name: string) => {
    if (!confirm(`Delete diagram “${name}”?`)) return
    await api.deleteDiagram(id)
    await load()
  }

  if (!book && !error) return <p className="muted">Loading book…</p>

  return (
    <div className="page book">
      <nav className="crumbs">
        <Link to="/">Books</Link>
        <span>/</span>
        <span>{book?.title ?? '…'}</span>
      </nav>

      {error && <div className="banner error">{error}</div>}

      {book && (
        <>
          <header className="page-header">
            <div>
              <h1>{book.title}</h1>
              {book.description && <p className="muted">{book.description}</p>}
            </div>
            <ExportBookButton bookId={bookId} bookTitle={book.title} />
          </header>

          <section className="card">
            <h2>New page</h2>
            <form className="row" onSubmit={onCreatePage}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Page title (e.g. System Context)"
                required
              />
              <button className="btn primary" type="submit">
                Add page
              </button>
            </form>
          </section>

          <section className="page-list">
            <h2>Pages</h2>
            {pages.length === 0 && <p className="muted">No pages yet.</p>}
            <ul>
              {pages.map((p) => (
                <li key={p.id}>
                  <Link to={`/books/${bookId}/pages/${p.id}`}>{p.title}</Link>
                  <span className="meta">v{p.version}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card" style={{ marginTop: '1.25rem' }}>
            <h2>New diagram</h2>
            <p className="muted">BeeDiagram canvas — boxes, people, systems, connectors.</p>
            <form className="row" onSubmit={onCreateDiagram}>
              <input
                value={diagramTitle}
                onChange={(e) => setDiagramTitle(e.target.value)}
                placeholder="Diagram title (e.g. Network overview)"
                required
              />
              <button className="btn primary" type="submit">
                Add diagram
              </button>
            </form>
          </section>

          <section className="page-list">
            <h2>Diagrams</h2>
            {diagrams.length === 0 && <p className="muted">No diagrams yet.</p>}
            <ul>
              {diagrams.map((d) => (
                <li key={d.id}>
                  <Link to={`/books/${bookId}/diagrams/${d.id}`}>{d.title}</Link>
                  <span className="meta row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    {d.kind}
                    <button
                      type="button"
                      className="btn danger ghost"
                      style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
                      onClick={() => void onDeleteDiagram(d.id, d.title)}
                    >
                      Delete
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
