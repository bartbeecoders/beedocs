import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { MarkdownView } from '../components/MarkdownView'
import type { Page } from '../types'

export function PageEditor() {
  const { bookId = '', pageId = '' } = useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview' | 'split'>('split')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const p = await api.getPage(pageId)
        setPage(p)
        setTitle(p.title)
        setContent(p.content)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [pageId])

  const onSave = async (e?: FormEvent) => {
    e?.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updatePage(pageId, { title, content })
      setPage(updated)
      setSavedAt(new Date().toLocaleTimeString())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!confirm('Delete this page?')) return
    await api.deletePage(pageId)
    navigate(`/books/${bookId}`)
  }

  if (!page && !error) return <p className="muted">Loading page…</p>

  return (
    <div className="page editor">
      <nav className="crumbs">
        <Link to="/">Books</Link>
        <span>/</span>
        <Link to={`/books/${bookId}`}>Book</Link>
        <span>/</span>
        <span>{page?.title ?? '…'}</span>
      </nav>

      {error && <div className="banner error">{error}</div>}

      <div className="editor-toolbar">
        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Page title"
        />
        <div className="toolbar-group">
          <div className="segmented">
            {(['edit', 'split', 'preview'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? 'active' : ''}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void onSave()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn danger ghost" onClick={() => void onDelete()}>
            Delete
          </button>
        </div>
      </div>

      <p className="meta">
        {page && (
          <>
            Version {page.version}
            {savedAt && ` · saved ${savedAt}`}
            {' · '}
            fenced <code>```mermaid</code> blocks render in preview
          </>
        )}
      </p>

      <div className={`editor-panes mode-${mode}`}>
        {(mode === 'edit' || mode === 'split') && (
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder="Write Markdown… use ```mermaid for diagrams"
          />
        )}
        {(mode === 'preview' || mode === 'split') && (
          <div className="editor-preview">
            <MarkdownView content={content} />
          </div>
        )}
      </div>
    </div>
  )
}
