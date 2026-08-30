import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n } from '../i18n'
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
  const { t } = useI18n()
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
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('dialogs.import')}>
        <header className="modal-header">
          <h2>{t('dialogs.import')}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={importing} aria-label={t('common.close')}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {!result && (
            <>
              <label className="field">
                <span className="field-label">{t('dialogs.file')}</span>
                <input
                  type="file"
                  accept={ACCEPT}
                  onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                />
                <span className="field-hint muted sm">
                  {t('dialogs.fileHint1')}
                  <code>.beedocs</code>
                  {t('dialogs.fileHint2')}
                  <code>.md</code>
                  {t('dialogs.fileHint3')}
                </span>
              </label>

              {inspecting && <p className="muted sm">{t('dialogs.readingFile')}</p>}

              {preview && (
                <>
                  <div className="import-summary">
                    <div className="import-summary-title">
                      {preview.kind === 'page' ? '📄' : '📚'} {preview.bookTitle}
                    </div>
                    <div className="import-summary-counts muted sm">
                      {t('dialogs.countPages', { count: preview.pageCount })} ·{' '}
                      {t('dialogs.countFolders', { count: preview.chapterCount })} ·{' '}
                      {t('dialogs.countDiagrams', { count: preview.diagramCount })} ·{' '}
                      {(preview.collectionCount ?? 0) > 0
                        ? `${t('dialogs.countCollections', { count: preview.collectionCount ?? 0 })} · `
                        : ''}
                      {t('dialogs.countImages', { count: preview.assetCount })}
                      {preview.source !== 'archive' && ` · ${t('dialogs.fromMarkdown')}`}
                    </div>
                    {preview.pageTitles.length > 0 && (
                      <ul className="import-page-list">
                        {preview.pageTitles.slice(0, 8).map((pageTitle, i) => (
                          <li key={`${pageTitle}-${i}`}>{pageTitle}</li>
                        ))}
                        {preview.pageTitles.length > 8 && (
                          <li className="muted">
                            {t('dialogs.andMore', { count: preview.pageTitles.length - 8 })}
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
                    <span className="field-label">{t('dialogs.destination')}</span>
                    <select
                      value={targetBookId}
                      onChange={(e) => setTargetBookId(e.target.value)}
                    >
                      <option value="">{t('dialogs.createNewBook')}</option>
                      {books.map((b) => (
                        <option key={b.id} value={b.id}>
                          {t('dialogs.addToBook', { title: b.title })}
                        </option>
                      ))}
                    </select>
                  </label>

                  {!targetBookId && (
                    <>
                      <fieldset className="field import-mode">
                        <legend className="field-label">
                          {t('common.name')}
                          {preview.bookTitleExists && (
                            <span className="muted sm">
                              {' '}
                              {t('dialogs.alreadyExists', { title: preview.bookTitle })}
                            </span>
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
                            {t('dialogs.renameFree')}
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
                            {t('dialogs.keepOriginal')}
                            {preview.bookTitleExists && (
                              <span className="muted sm">
                                {' '}
                                {t('dialogs.createsSecond', { title: preview.bookTitle })}
                              </span>
                            )}
                          </span>
                        </label>
                      </fieldset>

                      <label className="field">
                        <span className="field-label">{t('dialogs.titleOptional')}</span>
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
                      <legend className="field-label">{t('dialogs.clashLegend')}</legend>
                      <label className="radio">
                        <input
                          type="radio"
                          name="import-mode"
                          checked={mode === 'rename'}
                          onChange={() => setMode('rename')}
                        />
                        <span>
                          {t('dialogs.renameThem')}{' '}
                          <span className="muted sm">{t('dialogs.renameExample')}</span>
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
                          {t('dialogs.keepSame')}{' '}
                          <span className="muted sm">{t('dialogs.keepSameHint')}</span>
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
                {result.bookCreated
                  ? t('dialogs.importedNew', { title: result.bookTitle })
                  : t('dialogs.importedExisting', { title: result.bookTitle })}
              </p>
              <ul className="import-page-list">
                <li>{t('dialogs.countPages', { count: result.pagesCreated })}</li>
                <li>{t('dialogs.countFolders', { count: result.chaptersCreated })}</li>
                <li>{t('dialogs.countDiagrams', { count: result.diagramsCreated })}</li>
                <li>{t('dialogs.countImages', { count: result.assetsCreated })}</li>
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
                {t('common.close')}
              </button>
              <button type="button" className="btn primary" onClick={openImported}>
                {t('dialogs.openIt')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={importing}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!preview || importing || inspecting}
                onClick={() => void doImport()}
              >
                {importing ? t('dialogs.importing') : t('dialogs.import')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
