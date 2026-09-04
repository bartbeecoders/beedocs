import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { bumpGitStatus, useGitRepos } from '../hooks/useGitRepos'
import { refreshGitAssistJobs, useGitAssistJobs } from '../hooks/useGitAssistJobs'
import { gitFilePath } from '../gitPaths'
import { MarkdownView } from './MarkdownView'
import { parseGitAssistBookDraft, flattenGitAssistBookDraft } from '../gitAssistBook'
import {
  GitAssistDestination,
  defaultDest,
  destToPublishBody,
  type GitAssistDest,
} from './GitAssistDestination'
import type { GitAssistJob, GitAssistKind } from '../types'
import '../styles/git.css'

const JOB_KINDS: readonly GitAssistKind[] = ['readme', 'documentation', 'manual', 'summary', 'book']

const SUGGESTED_PATHS: Partial<Record<GitAssistKind, string>> = {
  readme: 'README.md',
  documentation: 'docs/DOCUMENTATION.md',
  manual: 'docs/MANUAL.md',
  summary: 'docs/SUMMARY.md',
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A known kind renders via `gitadmin.jobKind.*`; an unknown one shows as-is. */
function kindLabel(t: TFunction, kind: string): string {
  return JOB_KINDS.includes(kind as GitAssistKind)
    ? t(`gitadmin.jobKind.${kind}` as MessageKey)
    : kind
}

/**
 * Header control: every background drafting job on the instance, with a live
 * badge while anything is queued or running. Renders nothing until a git repo
 * exists — there is nowhere to start a job without one.
 */
export function GitAssistJobsMenu() {
  const repos = useGitRepos()
  if (!repos?.length) return null
  return <GitAssistJobsMenuInner />
}

function GitAssistJobsMenuInner() {
  const { t } = useI18n()
  const { jobs, error } = useGitAssistJobs()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const active = (jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running').length

  useEffect(() => {
    if (!open) return
    refreshGitAssistJobs()
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="git-jobs-menu" ref={wrapRef}>
      <button
        type="button"
        className={`git-jobs-trigger ${active > 0 ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('gitadmin.jobsMenuTooltip')}
        aria-label={
          active > 0
            ? active === 1
              ? t('gitadmin.jobsRunning.one', { count: active })
              : t('gitadmin.jobsRunning.other', { count: active })
            : t('gitadmin.jobsMenuAria')
        }
      >
        <span aria-hidden>✨</span>
        <span className="git-jobs-trigger-text">{t('gitadmin.jobsTitle')}</span>
        {active > 0 ? <span className="git-jobs-badge">{active}</span> : null}
      </button>
      {open ? (
        <div className="git-jobs-panel" role="dialog" aria-label={t('gitadmin.jobsMenuAria')}>
          <div className="git-jobs-panel-head">
            <h2>✨ {t('gitadmin.jobsTitle')}</h2>
            <p className="muted sm">{t('gitadmin.jobsAllHint')}</p>
          </div>
          <GitAssistJobList
            jobs={jobs}
            error={error}
            showRepo
            empty={t('gitadmin.jobsAllEmpty')}
            onNavigate={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The repo page's window onto background AI drafting for this repo. The header
 * panel is the instance-wide list; this section stays so a repo's own jobs sit
 * with its files. Polling lives in the shared store, not here.
 */
export function GitAssistJobs({ repoId }: { repoId: string }) {
  const { t } = useI18n()
  const { canWrite } = useAuth()
  const { jobs, error } = useGitAssistJobs()
  const mine = jobs?.filter((j) => j.repoId === repoId) ?? null

  if (mine === null) {
    return error ? <p className="banner error">{error}</p> : null
  }

  if (mine.length === 0) {
    return canWrite ? (
      <div className="git-assist-jobs">
        <h2 className="book-overview-subhead">✨ {t('gitadmin.jobsTitle')}</h2>
        {error ? <p className="banner error">{error}</p> : null}
        <p className="muted sm">
          {t('gitadmin.jobsEmpty', { action: t('gitadmin.runInBackground') })}
        </p>
      </div>
    ) : null
  }

  return (
    <div className="git-assist-jobs">
      <h2 className="book-overview-subhead">✨ {t('gitadmin.jobsTitle')}</h2>
      <GitAssistJobList jobs={mine} error={error} />
    </div>
  )
}

function GitAssistJobList({
  jobs,
  error,
  showRepo = false,
  empty,
  onNavigate,
}: {
  jobs: GitAssistJob[] | null
  error: string | null
  showRepo?: boolean
  empty?: string
  onNavigate?: () => void
}) {
  const { t } = useI18n()
  const { canWrite } = useAuth()
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const rerun = async (job: GitAssistJob) => {
    setBusyId(job.id)
    setActionError(null)
    try {
      await api.rerunGitAssistJob(job.id)
      refreshGitAssistJobs()
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (job: GitAssistJob) => {
    setBusyId(job.id)
    setActionError(null)
    try {
      await api.deleteGitAssistJob(job.id)
      refreshGitAssistJobs()
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  if (jobs === null) {
    return error ? <p className="banner error">{error}</p> : <p className="muted sm">{t('common.loading')}</p>
  }

  const openJob = openJobId ? (jobs.find((j) => j.id === openJobId) ?? null) : null

  return (
    <>
      {error ? <p className="banner error">{error}</p> : null}
      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}
      {jobs.length === 0 ? (
        empty ? <p className="muted sm">{empty}</p> : null
      ) : (
        <ul className="git-job-list">
          {jobs.map((job) => (
            <li key={job.id} className="git-job-row">
              <span className={`git-job-chip ${job.status}`}>
                {t(`gitadmin.jobStatus.${job.status}` as MessageKey)}
              </span>
              <div className="git-job-main">
                <strong>{kindLabel(t, job.kind)}</strong>
                {showRepo ? (
                  <Link
                    to={`/git/${job.repoId}`}
                    className="git-job-repo muted sm"
                    onClick={onNavigate}
                  >
                    {job.repoName}
                  </Link>
                ) : null}
                <span className="muted sm">
                  {job.createdByName ? `${job.createdByName} · ` : ''}
                  {new Date(job.createdAt).toLocaleString()}
                  {job.providerName ? ` · ${job.providerName}` : ''}
                  {job.model ? ` · ${job.model}` : ''}
                  {job.elapsedMs != null ? ` · ${(job.elapsedMs / 1000).toFixed(1)}s` : ''}
                </span>
                {job.status === 'failed' && job.error ? (
                  <span className="git-job-error">{job.error}</span>
                ) : null}
                {job.bookId ? (
                  <span className="muted sm">
                    {t('gitadmin.published')}{' '}
                    {job.kind === 'book' ? (
                      <Link to={`/books/${job.bookId}`} onClick={onNavigate}>
                        {t('gitadmin.openBook')}
                      </Link>
                    ) : job.pageId ? (
                      <Link to={`/books/${job.bookId}/pages/${job.pageId}`} onClick={onNavigate}>
                        {t('gitadmin.openBookPage')}
                      </Link>
                    ) : (
                      <Link to={`/books/${job.bookId}`} onClick={onNavigate}>
                        {t('gitadmin.openBook')}
                      </Link>
                    )}
                  </span>
                ) : null}
              </div>
              <div className="git-job-actions">
                {job.status === 'completed' ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setOpenJobId(job.id)}
                  >
                    {t('gitadmin.viewDraft')}
                  </button>
                ) : null}
                {canWrite && (job.status === 'completed' || job.status === 'failed') ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busyId === job.id}
                    onClick={() => void rerun(job)}
                    title={job.bookId ? t('gitadmin.rerunUpdateTitle') : t('gitadmin.rerunTitle')}
                  >
                    {job.bookId ? t('gitadmin.rerunUpdate') : t('gitadmin.rerun')}
                  </button>
                ) : null}
                {canWrite ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busyId === job.id}
                    onClick={() => void remove(job)}
                    title={
                      job.status === 'running' || job.status === 'queued'
                        ? t('gitadmin.cancelJobTitle')
                        : t('gitadmin.removeJobTitle')
                    }
                  >
                    {job.status === 'running' || job.status === 'queued'
                      ? t('common.cancel')
                      : t('common.remove')}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {openJob ? (
        <JobResultDialog
          job={openJob}
          repoId={openJob.repoId}
          onClose={() => setOpenJobId(null)}
          onChanged={() => refreshGitAssistJobs()}
        />
      ) : null}
    </>
  )
}

/**
 * A completed job's draft in full: the Markdown preview plus the two exits —
 * into the library (create a book on a shelf, or update the already-published
 * page) and into the repo's working tree (the ordinary blob-guarded write).
 */
function JobResultDialog({
  job,
  repoId,
  onClose,
  onChanged,
}: {
  job: GitAssistJob
  repoId: string
  onClose: () => void
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const { canWrite } = useAuth()
  const { refreshTree } = useWorkspace()
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dest, setDest] = useState<GitAssistDest>(
    job.bookId ? { mode: 'existing', bookId: job.bookId } : defaultDest(),
  )
  const [repoPath, setRepoPath] = useState(
    SUGGESTED_PATHS[job.kind as GitAssistKind] ?? 'docs/DRAFT.md',
  )
  const [busy, setBusy] = useState<null | 'publish' | 'save'>(null)
  const isBook = job.kind === 'book'
  const bookDraft = parseGitAssistBookDraft(markdown)
  const copyText = bookDraft ? flattenGitAssistBookDraft(bookDraft) : (markdown ?? '')

  useEffect(() => {
    let cancelled = false
    api
      .getGitAssistJob(job.id)
      .then((full) => {
        if (!cancelled) setMarkdown(full.markdown ?? '')
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [job.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const publish = async () => {
    setBusy('publish')
    setActionError(null)
    try {
      const updated = await api.publishGitAssistJob(job.id, destToPublishBody(dest))
      await refreshTree()
      onChanged()
      onClose()
      if (updated.bookId && job.kind === 'book') void navigate(`/books/${updated.bookId}`)
      else if (updated.bookId && updated.pageId)
        void navigate(`/books/${updated.bookId}/pages/${updated.pageId}`)
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const saveToRepo = async () => {
    if (markdown === null) return
    const target = repoPath.trim()
    if (target === '') return
    setBusy('save')
    setActionError(null)
    try {
      // Overwrite-aware: an existing file's blob sha rides along so the save
      // fails honestly if someone changed it since the draft was made.
      let baseBlobSha: string | null = null
      try {
        baseBlobSha = (await api.getGitFile(repoId, target)).blobSha
      } catch {
        // Not there yet — a create.
      }
      await api.writeGitFile(repoId, target, markdown, baseBlobSha)
      bumpGitStatus()
      onClose()
      void navigate(gitFilePath(repoId, target))
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="git-dialog-overlay"
      onMouseDown={() => {
        if (busy === null) onClose()
      }}
      role="presentation"
    >
      <div
        className="git-dialog git-assist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('gitadmin.draftAria', { kind: kindLabel(t, job.kind) })}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>
          ✨ {kindLabel(t, job.kind)} — {job.repoName}
        </h3>
        <p className="git-assist-meta muted sm">
          {job.providerName ?? 'AI'}
          {job.model ? ` · ${job.model}` : ''}
          {job.elapsedMs != null ? ` · ${(job.elapsedMs / 1000).toFixed(1)}s` : ''}
          {job.completionTokens != null
            ? ` · ${t('gitadmin.tokens', { count: job.completionTokens })}`
            : ''}
          {job.contextFiles.length > 0
            ? ` · ${
                job.contextFiles.length === 1
                  ? t('gitadmin.groundedIn.one', { count: job.contextFiles.length })
                  : t('gitadmin.groundedIn.other', { count: job.contextFiles.length })
              }`
            : ''}
        </p>

        <div className="git-assist-preview">
          {loadError ? (
            <p className="banner error">{loadError}</p>
          ) : markdown === null ? (
            <p className="muted">{t('gitadmin.loadingDraft')}</p>
          ) : bookDraft ? (
            <div className="git-assist-book-preview">
              {bookDraft.bookTitle ? <h4>{bookDraft.bookTitle}</h4> : null}
              {bookDraft.bookDescription ? (
                <p className="muted sm">{bookDraft.bookDescription}</p>
              ) : null}
              <p className="muted sm">
                {bookDraft.pages.length === 1
                  ? t('gitadmin.bookPages.one', { count: bookDraft.pages.length })
                  : t('gitadmin.bookPages.other', { count: bookDraft.pages.length })}
              </p>
              {bookDraft.pages.map((page, i) => (
                <section key={`${page.title}-${i}`} className="git-assist-book-page">
                  <h4>{page.title}</h4>
                  <MarkdownView content={page.markdown} />
                </section>
              ))}
            </div>
          ) : (
            <MarkdownView content={markdown} />
          )}
        </div>

        {canWrite && markdown !== null ? (
          <div className="git-job-exits">
            <div className="git-job-exit git-job-exit-stack">
              {job.bookId ? (
                <>
                  <span className="muted sm">
                    {isBook ? t('gitadmin.alreadyPublishedBook') : t('gitadmin.alreadyPublished')}
                  </span>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => void publish()}
                  >
                    {busy === 'publish'
                      ? t('gitadmin.updating')
                      : isBook
                        ? t('gitadmin.updateBookPages')
                        : t('gitadmin.updateBookPage')}
                  </button>
                </>
              ) : (
                <>
                  <span className="muted sm">{t('gitadmin.addToLibrary')}</span>
                  <GitAssistDestination value={dest} onChange={setDest} disabled={busy !== null} />
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => void publish()}
                  >
                    {busy === 'publish' ? t('gitadmin.publishing') : t('gitadmin.publishToLibrary')}
                  </button>
                </>
              )}
            </div>
            {!isBook ? (
              <div className="git-job-exit">
                <label className="git-assist-field git-assist-path">
                  <span>{t('gitadmin.saveInRepoAs')}</span>
                  <input
                    className="llm-mono"
                    spellCheck={false}
                    value={repoPath}
                    disabled={busy !== null}
                    onChange={(e) => setRepoPath(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy !== null || repoPath.trim() === ''}
                  onClick={() => void saveToRepo()}
                >
                  {busy === 'save' ? t('common.saving') : t('gitadmin.saveDraftToRepo')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {actionError ? (
          <p className="banner error" role="alert">
            {actionError}
          </p>
        ) : null}

        <div className="git-dialog-actions">
          <button type="button" className="btn sm" disabled={busy !== null} onClick={onClose}>
            {t('common.close')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={markdown === null}
            onClick={() => void navigator.clipboard?.writeText(copyText)}
          >
            {t('gitadmin.copyMarkdown')}
          </button>
        </div>
      </div>
    </div>
  )
}
