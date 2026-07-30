import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type { ImportNameMode, ImportPreview, ImportResult } from '../types'

type Props = {
  onClose: () => void
  /** Preselect a destination book (used from a book's context menu). */
  defaultTargetBookId?: string
}

const ACCEPT = '.beedocs,.zip,.md,.markdown'

/**
 * Import a BeeDocs archive, a zip of Markdown, or a single .md file.
 *
 * The file is inspected first so the user can see what is inside and resolve a
 * name clash before anything is written.
 */
export function ImportDialog({ onClose, defaultTargetBookId }: Props) {
  const navigate = useNavigate()
  const { books, refreshTree } = useWorkspace()

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mode, setMode] = useState<ImportNameMode>('rename')
  const [targetBookId, setTargetBookId] = useState(defaultTargetBookId ?? '')
  const [title, setTitle] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, importing])

  const pick = async (picked: File | null) => {
    setFile(picked)
    setPreview(null)
    setResult(null)
    setError(null)
    setTitle('')
    if (!picked) return

    setInspecting(true)
    try {
      const p = await api.inspectImport(picked)
      setPreview(p)
      // Default to a safe name when the title is already taken.
      setMode(p.bookTitleExists ? 'rename' : 'keep')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setInspecting(false)
    }
  }

  const doImport = async () => {
    if (!file) return
    setImporting(true)
    setError(null)
    try {
      const res = await api.importFile(file, {
        mode,
        targetBookId: targetBookId || undefined,
        title: title.trim() || undefined,
      })
      setResult(res)
      await refreshTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  const openImported = () => {
    if (!result) return
    onClose()
    const firstPage = result.pages[0]
    navigate(
      firstPage
        ? `/books/${result.bookId}/pages/${firstPage.id}`
        : `/books/${result.bookId}`,
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !importing) onClose()
      }}
    >
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Import">
        <header className="modal-header">
          <h2>Import</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={importing}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {!result && (
            <>
              <label className="field">
                <span className="field-label">File</span>
                <input
                  type="file"
                  accept={ACCEPT}
                  onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                />
                <span className="field-hint muted sm">
                  A BeeDocs archive (<code>.beedocs</code>), a zip of Markdown files, or a single{' '}
                  <code>.md</code> document.
                </span>
              </label>

              {inspecting && <p className="muted sm">Reading file…</p>}

              {preview && (
                <>
                  <div className="import-summary">
                    <div className="import-summary-title">
                      {preview.kind === 'page' ? '📄' : '📚'} {preview.bookTitle}
                    </div>
                    <div className="import-summary-counts muted sm">
                      {preview.pageCount} page(s) · {preview.chapterCount} folder(s) ·{' '}
                      {preview.diagramCount} diagram(s) ·{' '}
                      {(preview.collectionCount ?? 0) > 0
                        ? `${preview.collectionCount} collection(s) · `
                        : ''}
                      {preview.assetCount} image(s)
                      {preview.source !== 'archive' && ' · from Markdown'}
                    </div>
                    {preview.pageTitles.length > 0 && (
                      <ul className="import-page-list">
                        {preview.pageTitles.slice(0, 8).map((t, i) => (
                          <li key={`${t}-${i}`}>{t}</li>
                        ))}
                        {preview.pageTitles.length > 8 && (
                          <li className="muted">
                            …and {preview.pageTitles.length - 8} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>

                  {preview.warnings.map((w, i) => (
                    <div key={i} className="banner warn compact">
                      {w}
                    </div>
                  ))}

                  <label className="field">
                    <span className="field-label">Destination</span>
                    <select
                      value={targetBookId}
                      onChange={(e) => setTargetBookId(e.target.value)}
                    >
                      <option value="">Create a new book</option>
                      {books.map((b) => (
                        <option key={b.id} value={b.id}>
                          Add to “{b.title}”
                        </option>
                      ))}
                    </select>
                  </label>

                  {!targetBookId && (
                    <>
                      <fieldset className="field import-mode">
                        <legend className="field-label">
                          Name
                          {preview.bookTitleExists && (
                            <span className="muted sm"> — “{preview.bookTitle}” already exists</span>
                          )}
                        </legend>
                        <label className="radio">
                          <input
                            type="radio"
                            name="import-mode"
                            checked={mode === 'rename'}
                            onChange={() => setMode('rename')}
                          />
                          <span>
                            Rename to a free name
                            {preview.suggestedTitle && (
                              <span className="muted sm"> — “{preview.suggestedTitle}”</span>
                            )}
                          </span>
                        </label>
                        <label className="radio">
                          <input
                            type="radio"
                            name="import-mode"
                            checked={mode === 'keep'}
                            onChange={() => setMode('keep')}
                          />
                          <span>
                            Keep the original name
                            {preview.bookTitleExists && (
                              <span className="muted sm"> — creates a second “{preview.bookTitle}”</span>
                            )}
                          </span>
                        </label>
                      </fieldset>

                      <label className="field">
                        <span className="field-label">Title (optional)</span>
                        <input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder={preview.bookTitle}
                        />
                      </label>
                    </>
                  )}

                  {targetBookId && (
                    <fieldset className="field import-mode">
                      <legend className="field-label">Pages with a name that already exists</legend>
                      <label className="radio">
                        <input
                          type="radio"
                          name="import-mode"
                          checked={mode === 'rename'}
                          onChange={() => setMode('rename')}
                        />
                        <span>
                          Rename them <span className="muted sm">— “Deploying (2)”</span>
                        </span>
                      </label>
                      <label className="radio">
                        <input
                          type="radio"
                          name="import-mode"
                          checked={mode === 'keep'}
                          onChange={() => setMode('keep')}
                        />
                        <span>
                          Keep the same name{' '}
                          <span className="muted sm">— existing pages are left untouched</span>
                        </span>
                      </label>
                    </fieldset>
                  )}
                </>
              )}
            </>
          )}

          {result && (
            <div className="import-result">
              <p>
                Imported into <strong>{result.bookTitle}</strong>
                {result.bookCreated ? ' (new book)' : ' (existing book)'}.
              </p>
              <ul className="import-page-list">
                <li>{result.pagesCreated} page(s)</li>
                <li>{result.chaptersCreated} folder(s)</li>
                <li>{result.diagramsCreated} diagram(s)</li>
                <li>{result.assetsCreated} image(s)</li>
              </ul>
              {result.warnings.map((w, i) => (
                <div key={i} className="banner warn compact">
                  {w}
                </div>
              ))}
            </div>
          )}

          {error && <div className="banner error compact">{error}</div>}
        </div>

        <footer className="modal-footer">
          {result ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn primary" onClick={openImported}>
                Open it
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={importing}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!preview || importing || inspecting}
                onClick={() => void doImport()}
              >
                {importing ? 'Importing…' : 'Import'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
