import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import { useAuth } from '../auth/AuthContext'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { bumpGitStatus } from '../hooks/useGitRepos'
import { gitFilePath } from '../gitPaths'
import { MarkdownView } from './MarkdownView'
import type { GitAssistJob, GitAssistKind } from '../types'

const JOB_KINDS: readonly GitAssistKind[] = ['readme', 'documentation', 'manual', 'summary']

const SUGGESTED_PATHS: Record<GitAssistKind, string> = {
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
 * The repo page's window onto background AI drafting: every job for this repo,
 * newest first, polled while any is still queued or running — the git-clone
 * pattern, the row is the status. From here a finished draft is reviewed,
 * published into the library (or its book page updated), saved into the repo,
 * re-generated, or deleted.
 */
export function GitAssistJobs({ repoId }: { repoId: string }) {
  const { t } = useI18n()
  const { canWrite } = useAuth()
  const [jobs, setJobs] = useState<GitAssistJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setJobs(await api.listGitAssistJobs(repoId))
      setError(null)
    } catch (e) {
      setError(errText(e))
    }
  }, [repoId])

  useEffect(() => {
    setJobs(null)
    void reload()
  }, [reload])

  // Re-poll every few seconds while anything is active — an LLM run is
  // minutes-scale and the row is the only progress signal. Each reload replaces
  // `jobs`, re-arming this effect, so polling stops by itself once all jobs
  // are done and restarts when a re-run adds an active one.
  useEffect(() => {
    if (!jobs?.some((j) => j.status === 'queued' || j.status === 'running')) return
    const timer = window.setTimeout(() => void reload(), 3000)
    return () => window.clearTimeout(timer)
  }, [jobs, reload])

  const rerun = async (job: GitAssistJob) => {
    setBusyId(job.id)
    try {
      await api.rerunGitAssistJob(job.id)
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (job: GitAssistJob) => {
    setBusyId(job.id)
    try {
      await api.deleteGitAssistJob(job.id)
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  if (jobs === null) {
    // Not loaded yet — no flash of an empty section.
    return error ? <p className="banner error">{error}</p> : null
  }

  if (jobs.length === 0) {
    // Editors get a one-line pointer to where jobs come from; viewers (who
    // cannot start one) see nothing.
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

  const openJob = openJobId ? (jobs.find((j) => j.id === openJobId) ?? null) : null

  return (
    <div className="git-assist-jobs">
      <h2 className="book-overview-subhead">✨ {t('gitadmin.jobsTitle')}</h2>
      {error ? <p className="banner error">{error}</p> : null}
      <ul className="git-job-list">
        {jobs.map((job) => (
          <li key={job.id} className="git-job-row">
            <span className={`git-job-chip ${job.status}`}>
              {t(`gitadmin.jobStatus.${job.status}` as MessageKey)}
            </span>
            <div className="git-job-main">
              <strong>{kindLabel(t, job.kind)}</strong>
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
              {job.bookId && job.pageId ? (
                <span className="muted sm">
                  {t('gitadmin.published')}{' '}
                  <Link to={`/books/${job.bookId}/pages/${job.pageId}`}>
                    {t('gitadmin.openBookPage')}
                  </Link>
                </span>
              ) : null}
            </div>
            <div className="git-job-actions">
              {job.status === 'completed' ? (
                <button type="button" className="btn ghost sm" onClick={() => setOpenJobId(job.id)}>
                  {t('gitadmin.viewDraft')}
                </button>
              ) : null}
              {canWrite && (job.status === 'completed' || job.status === 'failed') ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busyId === job.id}
                  onClick={() => void rerun(job)}
                  title={job.pageId ? t('gitadmin.rerunUpdateTitle') : t('gitadmin.rerunTitle')}
                >
                  {job.pageId ? t('gitadmin.rerunUpdate') : t('gitadmin.rerun')}
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

      {openJob ? (
        <JobResultDialog
          job={openJob}
          repoId={repoId}
          onClose={() => setOpenJobId(null)}
          onChanged={() => void reload()}
        />
      ) : null}
    </div>
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
  const { shelves, refreshTree } = useWorkspace()
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [shelfId, setShelfId] = useState(job.shelfId ?? '')
  const [repoPath, setRepoPath] = useState(
    SUGGESTED_PATHS[job.kind as GitAssistKind] ?? 'docs/DRAFT.md',
  )
  const [busy, setBusy] = useState<null | 'publish' | 'save'>(null)

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
      const updated = await api.publishGitAssistJob(job.id, {
        shelfId: job.pageId ? undefined : shelfId || undefined,
      })
      await refreshTree()
      onChanged()
      onClose()
      if (updated.bookId && updated.pageId)
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
          ) : (
            <MarkdownView content={markdown} />
          )}
        </div>

        {canWrite && markdown !== null ? (
          <div className="git-job-exits">
            <div className="git-job-exit">
              {job.pageId ? (
                <>
                  <span className="muted sm">{t('gitadmin.alreadyPublished')}</span>
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => void publish()}
                  >
                    {busy === 'publish' ? t('gitadmin.updating') : t('gitadmin.updateBookPage')}
                  </button>
                </>
              ) : (
                <>
                  <label className="git-assist-field">
                    <span>{t('gitadmin.addToLibrary')}</span>
                    <select
                      value={shelfId}
                      disabled={busy !== null}
                      onChange={(e) => setShelfId(e.target.value)}
                    >
                      <option value="">{t('gitadmin.libraryRoot')}</option>
                      {shelves.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                    </select>
                  </label>
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
            onClick={() => void navigator.clipboard?.writeText(markdown ?? '')}
          >
            {t('gitadmin.copyMarkdown')}
          </button>
        </div>
      </div>
    </div>
  )
}
