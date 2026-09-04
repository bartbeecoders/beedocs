import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import { bumpGitStatus } from '../hooks/useGitRepos'
import { refreshGitAssistJobs } from '../hooks/useGitAssistJobs'
import { gitFilePath } from '../gitPaths'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { MarkdownView } from './MarkdownView'
import {
  GitAssistDestination,
  defaultDest,
  destToPublishBody,
  type GitAssistDest,
} from './GitAssistDestination'
import type { GitAssistKind, GitAssistResult, GitRepo } from '../types'
import '../styles/git.css'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * One AI drafting action against a repo, start to finish: optional extra
 * instructions → generate (the server reads the clone and asks the configured
 * LLM provider) → review the rendered draft → save it into the working tree
 * and/or add it as a page in a library book.
 *
 * A documentation book is several LLM calls, so that kind always starts a
 * background job instead of generating in the dialog.
 */
export function GitAssistDialog({
  repo,
  kind,
  onClose,
}: {
  repo: GitRepo
  kind: GitAssistKind
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { refreshTree } = useWorkspace()
  const isBook = kind === 'book'
  const [instructions, setInstructions] = useState('')
  const [path, setPath] = useState('')
  const [result, setResult] = useState<GitAssistResult | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [background, setBackground] = useState(isBook)
  const [publishBook, setPublishBook] = useState(isBook)
  const [dest, setDest] = useState<GitAssistDest>(defaultDest)
  const [starting, setStarting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const title = t(`gitadmin.assist.${kind}.title` as MessageKey)
  const blurb = t(`gitadmin.assist.${kind}.blurb` as MessageKey)
  const runBackground = isBook || background

  useEffect(() => () => abortRef.current?.abort(), [])

  // Esc closes — but never mid-generation without asking, the draft cost money.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const generate = async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setGenerating(true)
    setError(null)
    try {
      const next = await api.gitAssist(
        repo.id,
        { kind, instructions: instructions.trim() || undefined },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) return
      setResult(next)
      setShowSource(false)
      setPath((p) => p || next.suggestedPath || 'docs/DRAFT.md')
    } catch (e) {
      if (!ctrl.signal.aborted) setError(errText(e))
    } finally {
      if (abortRef.current === ctrl) setGenerating(false)
    }
  }

  // The background path: the server answers immediately with a job row; the
  // repo page's jobs panel is where progress and the finished draft live, so
  // starting one lands the person there.
  const startBackground = async () => {
    setStarting(true)
    setError(null)
    try {
      const target = destToPublishBody(dest)
      await api.startGitAssistJob(repo.id, {
        kind,
        instructions: instructions.trim() || undefined,
        publishBook: publishBook || undefined,
        shelfId: publishBook ? target.shelfId : undefined,
        bookId: publishBook ? target.bookId : undefined,
      })
      refreshGitAssistJobs()
      onClose()
      void navigate(`/git/${repo.id}`)
    } catch (e) {
      setError(errText(e))
      setStarting(false)
    }
  }

  const save = async () => {
    if (!result || saving) return
    const target = path.trim()
    if (target === '') return
    setSaving(true)
    setError(null)
    try {
      // Overwrite-aware: an existing file's blob sha rides along so the save
      // fails honestly if someone changed it since the dialog opened.
      let baseBlobSha: string | null = null
      try {
        baseBlobSha = (await api.getGitFile(repo.id, target)).blobSha
      } catch {
        // Not there yet — a create.
      }
      await api.writeGitFile(repo.id, target, result.markdown, baseBlobSha)
      bumpGitStatus()
      onClose()
      void navigate(gitFilePath(repo.id, target))
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const addAsPage = async () => {
    if (!result || publishing) return
    setPublishing(true)
    setError(null)
    try {
      const updated = await api.publishGitAssistDraft(repo.id, {
        kind,
        markdown: result.markdown,
        ...destToPublishBody(dest),
      })
      await refreshTree()
      onClose()
      void navigate(`/books/${updated.bookId}/pages/${updated.pageId}`)
    } catch (e) {
      setError(errText(e))
    } finally {
      setPublishing(false)
    }
  }

  const busy = generating || saving || publishing || starting

  return (
    <div
      className="git-dialog-overlay"
      onMouseDown={() => {
        if (!busy) onClose()
      }}
      role="presentation"
    >
      <div
        className="git-dialog git-assist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>
          ✨ {title} — {repo.name}
        </h3>
        <p className="muted sm">{blurb}</p>

        {result === null ? (
          <>
            <label className="git-assist-field">
              <span>{t('gitadmin.extraInstructions')}</span>
              <textarea
                rows={3}
                placeholder={t('gitadmin.instructionsPlaceholder')}
                value={instructions}
                autoFocus
                disabled={generating || starting}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </label>
            {isBook ? (
              <p className="muted sm">{t('gitadmin.bookAlwaysBackground')}</p>
            ) : (
              <>
                <p className="muted sm">{t('gitadmin.generateExplain')}</p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={background}
                    disabled={generating || starting}
                    onChange={(e) => setBackground(e.target.checked)}
                  />
                  <span>{t('gitadmin.runInBackground')}</span>
                </label>
                <p className="muted sm settings-hint">{t('gitadmin.backgroundHint')}</p>
              </>
            )}
            {runBackground ? (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={publishBook}
                    disabled={starting}
                    onChange={(e) => setPublishBook(e.target.checked)}
                  />
                  <span>{t('gitadmin.publishWhenDone')}</span>
                </label>
                {publishBook ? (
                  <GitAssistDestination value={dest} onChange={setDest} disabled={starting} />
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            <p className="git-assist-meta muted sm">
              {result.providerName}
              {result.model ? ` · ${result.model}` : ''} · {(result.elapsedMs / 1000).toFixed(1)}s
              {result.completionTokens != null
                ? ` · ${t('gitadmin.tokens', { count: result.completionTokens })}`
                : ''}{' '}
              ·{' '}
              {result.contextFiles.length === 1
                ? t('gitadmin.groundedIn.one', { count: result.contextFiles.length })
                : t('gitadmin.groundedIn.other', { count: result.contextFiles.length })}
              <button type="button" className="btn ghost sm" onClick={() => setShowSource((v) => !v)}>
                {showSource ? t('gitadmin.preview') : t('gitadmin.source')}
              </button>
            </p>
            <div className="git-assist-preview">
              {showSource ? (
                <pre className="git-code">
                  <code>{result.markdown}</code>
                </pre>
              ) : (
                <MarkdownView content={result.markdown} />
              )}
            </div>
            <div className="git-job-exits">
              <div className="git-job-exit git-job-exit-stack">
                <span className="muted sm">{t('gitadmin.addAsPage')}</span>
                <GitAssistDestination value={dest} onChange={setDest} disabled={publishing || saving} />
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={publishing || saving}
                  onClick={() => void addAsPage()}
                >
                  {publishing ? t('gitadmin.addingPage') : t('gitadmin.addAsPage')}
                </button>
              </div>
              <div className="git-job-exit git-job-exit-stack">
                <label className="git-assist-field git-assist-path">
                  <span>{t('gitadmin.saveInRepoAs')}</span>
                  <input
                    className="llm-mono"
                    spellCheck={false}
                    value={path}
                    disabled={saving || publishing}
                    onChange={(e) => setPath(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn sm"
                  disabled={saving || publishing || path.trim() === ''}
                  onClick={() => void save()}
                >
                  {saving ? t('common.saving') : t('gitadmin.saveDraftToRepo')}
                </button>
              </div>
            </div>
          </>
        )}

        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="git-dialog-actions">
          <button type="button" className="btn sm" disabled={saving || publishing} onClick={onClose}>
            {result ? t('gitadmin.discard') : t('common.cancel')}
          </button>
          {result !== null ? (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={generating || saving || publishing}
                onClick={() => void navigator.clipboard?.writeText(result.markdown)}
              >
                {t('gitadmin.copyMarkdown')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={generating || saving || publishing}
                onClick={() => {
                  setResult(null)
                  setError(null)
                }}
              >
                {t('gitadmin.adjustRegenerate')}
              </button>
            </>
          ) : runBackground ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={starting}
              onClick={() => void startBackground()}
            >
              {starting ? t('gitadmin.starting') : t('gitadmin.startBackgroundJob')}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary sm"
              disabled={generating}
              onClick={() => void generate()}
            >
              {generating ? t('gitadmin.generating') : t('gitadmin.generateDraft')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
