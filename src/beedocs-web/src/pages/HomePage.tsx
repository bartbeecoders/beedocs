import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Book } from '../types'

export function HomePage() {
  const [books, setBooks] = useState<Book[]>([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setBooks(await api.listBooks())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const onCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await api.createBook({ title: title.trim(), description: description.trim() || undefined })
      setTitle('')
      setDescription('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDelete = async (id: string, bookTitle: string) => {
    if (!confirm(`Delete book “${bookTitle}” and all its pages?`)) return
    await api.deleteBook(id)
    await load()
  }

  return (
    <div className="page home">
      <section className="hero">
        <h1>Your documentation shelves</h1>
        <p className="muted">
          Books hold architecture docs, hardware inventories, and system design. Start with a book,
          then add Markdown pages with Mermaid diagrams.
        </p>
      </section>

      <section className="card">
        <h2>New book</h2>
        <form className="stack" onSubmit={onCreate}>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Platform Architecture" required />
          </label>
          <label>
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="C4 context, containers, network topology…"
            />
          </label>
          <button className="btn primary" type="submit">
            Create book
          </button>
        </form>
      </section>

      {error && <div className="banner error">{error}</div>}

      <section className="book-grid">
        {loading && <p className="muted">Loading…</p>}
        {!loading && books.length === 0 && (
          <p className="muted">No books yet. Create your first shelf above.</p>
        )}
        {books.map((book) => (
          <article key={book.id} className="book-card card">
            <div className="book-card-body">
              <h3>
                <Link to={`/books/${book.id}`}>{book.title}</Link>
              </h3>
              {book.description && <p className="muted">{book.description}</p>}
              <p className="meta">/{book.slug}</p>
            </div>
            <div className="book-card-actions">
              <Link className="btn" to={`/books/${book.id}`}>
                Open
              </Link>
              <button type="button" className="btn danger ghost" onClick={() => void onDelete(book.id, book.title)}>
                Delete
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}
