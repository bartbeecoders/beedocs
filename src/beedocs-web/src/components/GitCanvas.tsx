import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n'
import {
  useGitRepos,
  refreshGitRepos,
  bumpGitStatus,
  useGitStatusVersion,
} from '../hooks/useGitRepos'
import { highlightCode } from '../syntaxHighlight'
import { MarkdownView } from './MarkdownView'
import { GitAssistJobs } from './GitAssistJobs'
import { gitFilePath } from '../gitPaths'
import type { GitBranch, GitCommitDetail, GitFile, GitLogEntry, GitStatus, GitTreeEntry } from '../types'
import '../styles/git.css'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif']

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function isMarkdown(name: string): boolean {
  const ext = extensionOf(name)
  return ext === '.md' || ext === '.markdown'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Where the provider creates a pull request for the current branch. Both hosts
 * pick their default base branch themselves, so only the source side is named.
 */
function prUrl(repo: { connectionKind: string; cloneUrl: string }, branch: string): string | null {
  if (!branch) return null
  if (repo.connectionKind === 'github') {
    const base = repo.cloneUrl.replace(/\.git$/, '')
    return `${base}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`
  }
  if (repo.connectionKind === 'azure-devops') {
    // Clone URLs sometimes carry a user@ prefix; the web UI does not want it.
    const base = repo.cloneUrl.replace(/^(https?:\/\/)[^@/]+@/, '$1')
    return `${base}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`
  }
  return null
}

/**
 * The repo's own toolbar — branch picker, ahead/behind, Pull, Push, Commit.
 * Shared by both git canvases so the git verbs are wherever the repo's content
 * is. All state here is the *server's* shared working copy, which is why every
 * verb refreshes from it rather than optimistically updating.
 */
function GitToolbar({ repoId }: { repoId: string }) {
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const repos = useGitRepos()
  const repo = repos?.find((r) => r.id === repoId) ?? null
  const statusVersion = useGitStatusVersion()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [newBranch, setNewBranch] = useState(false)

  const ready = repo?.status === 'ready'

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void Promise.all([api.getGitStatus(repoId), api.getGitBranches(repoId)])
      .then(([s, b]) => {
        if (cancelled) return
        setStatus(s)
        setBranches(b)
      })
      .catch(() => {
        // The toolbar degrades to name + verbs; the canvas shows real errors.
      })
    return () => {
      cancelled = true
    }
  }, [repoId, ready, statusVersion])

  const run = async (verb: string, action: () => Promise<unknown>) => {
    setBusy(verb)
    setError(null)
    try {
      await action()
      refreshGitRepos()
      bumpGitStatus()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
    }
  }

  if (!repo) return null

  const branch = status?.branch ?? repo.defaultBranch
  const dirtyCount = status?.dirty.length ?? 0

  return (
    <div className="git-toolbar">
      {canWrite && branches !== null ? (
        <select
          className="git-branch-select"
          aria-label={t('git.branchAria')}
          title={t('git.branchSwitchTitle')}
          value={branch}
          disabled={busy !== null || !ready}
          onChange={(e) => {
            const next = e.target.value
            if (next === '__new__') {
              setNewBranch(true)
              return
            }
            if (next !== branch) {
              void run('checkout', () => api.checkoutGitBranch(repoId, next))
            }
          }}
        >
          {/* The current branch may be missing from the list mid-refresh. */}
          {branches.every((b) => b.name !== branch) ? (
            <option value={branch}>⎇ {branch}</option>
          ) : null}
          {branches.map((b) => (
            <option key={`${b.isRemote ? 'r' : 'l'}:${b.name}`} value={b.name}>
              ⎇ {b.name}
              {b.isRemote ? ` ${t('git.remoteSuffix')}` : ''}
            </option>
          ))}
          <option value="__new__">＋ {t('git.newBranchOption')}</option>
        </select>
      ) : (
        <span className="git-toolbar-branch" title={t('git.checkedOutBranch')}>
          ⎇ {branch || '…'}
        </span>
      )}

      {status && (status.ahead > 0 || status.behind > 0) ? (
        <span
          className="git-toolbar-ab"
          title={t('git.aheadBehind', { ahead: status.ahead, behind: status.behind })}
        >
          {status.ahead > 0 ? `↑${status.ahead}` : ''}
          {status.behind > 0 ? `↓${status.behind}` : ''}
        </span>
      ) : null}
      {dirtyCount > 0 ? (
        <span className="git-toolbar-dirty" title={t('git.dirtyTitle')}>
          {t('git.changedCount', { count: dirtyCount })}
        </span>
      ) : null}
      {repo.fetchedAt ? (
        <span className="muted sm">
          {t('git.syncedAt', { date: new Date(repo.fetchedAt).toLocaleString() })}
        </span>
      ) : null}
      <span className="git-toolbar-spacer" />

      {canWrite ? (
        <>
          {dirtyCount > 0 ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={busy !== null || !ready}
              onClick={() => setCommitting(true)}
            >
              {t('git.commitCount', { count: dirtyCount })}
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null || !ready}
            onClick={() => void run('pull', () => api.pullGitRepo(repoId))}
          >
            {busy === 'pull' ? t('git.pulling') : t('git.pull')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null || !ready}
            title={
              status && status.ahead > 0
                ? t('git.commitsToPush', { count: status.ahead })
                : t('git.pushCurrentBranch')
            }
            onClick={() => void run('push', () => api.pushGitRepo(repoId))}
          >
            {busy === 'push'
              ? t('git.pushing')
              : status && status.ahead > 0
                ? `${t('git.push')} ↑${status.ahead}`
                : t('git.push')}
          </button>
          {(() => {
            const url = prUrl(repo, branch)
            return url ? (
              <a
                className="btn sm"
                href={url}
                target="_blank"
                rel="noreferrer"
                title={t('git.prTitle', {
                  branch,
                  host: repo.connectionKind === 'github' ? 'GitHub' : 'Azure DevOps',
                })}
              >
                {t('git.prButton')}
              </a>
            ) : null
          })()}
        </>
      ) : null}

      {error ? (
        <span className="git-toolbar-error" role="alert">
          {error}
          {/* A conflicted pull was backed out; the honest retries are the two
              merge strategies — keep the server's lines, or take the remote's. */}
          {canWrite && /conflict/i.test(error) ? (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null}
                title={t('git.keepOursTitle')}
                onClick={() => void run('pull', () => api.pullGitRepo(repoId, 'ours'))}
              >
                {t('git.keepOurs')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={busy !== null}
                title={t('git.takeTheirsTitle')}
                onClick={() => void run('pull', () => api.pullGitRepo(repoId, 'theirs'))}
              >
                {t('git.takeTheirs')}
              </button>
            </>
          ) : null}
        </span>
      ) : null}

      {committing && status ? (
        <CommitDialog
          repoId={repoId}
          dirty={status.dirty.map((d) => d.path)}
          onClose={() => setCommitting(false)}
        />
      ) : null}
      {newBranch ? (
        <NewBranchDialog repoId={repoId} onClose={() => setNewBranch(false)} />
      ) : null}
    </div>
  )
}

/**
 * Message + a checklist of the changed files. Committing all of them sends no
 * path list (server stages everything, deletions included); a subset stages
 * exactly those paths.
 */
function CommitDialog({
  repoId,
  dirty,
  onClose,
}: {
  repoId: string
  dirty: string[]
  onClose: () => void
}) {
  const { t } = useI18n()
  // The prefilled commit message is repo content, not UI copy — kept English.
  const [message, setMessage] = useState(
    dirty.length === 1 ? `Update ${dirty[0].split('/').pop()}` : '',
  )
  const [selected, setSelected] = useState<Set<string>>(() => new Set(dirty))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const commit = async () => {
    if (busy || message.trim() === '' || selected.size === 0) return
    setBusy(true)
    setError(null)
    try {
      const paths = selected.size === dirty.length ? undefined : [...selected]
      const result = await api.commitGitRepo(repoId, message.trim(), paths)
      bumpGitStatus()
      refreshGitRepos()
      setDone(result.commitSha.slice(0, 8))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="git-dialog-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('git.commitChanges')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{t('git.commitChanges')}</h3>
        {done ? (
          <>
            <p className="git-dialog-ok">
              {t('git.committedAs', { sha: done })} {t('git.committedPushHint')}
            </p>
            <div className="git-dialog-actions">
              <button type="button" className="btn primary sm" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="git-commit-message"
              placeholder={t('git.commitPlaceholder')}
              value={message}
              autoFocus
              rows={3}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
            />
            <ul className="git-commit-files">
              {dirty.map((path) => (
                <li key={path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(path)}
                      disabled={busy}
                      onChange={() => toggle(path)}
                    />
                    <span className="git-repo-name">{path}</span>
                  </label>
                </li>
              ))}
            </ul>
            {error ? (
              <p className="banner error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="git-dialog-actions">
              <button type="button" className="btn sm" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={busy || message.trim() === '' || selected.size === 0}
                onClick={() => void commit()}
              >
                {busy
                  ? t('git.committing')
                  : t(selected.size === 1 ? 'git.commitFiles.one' : 'git.commitFiles.other', {
                      count: selected.size,
                    })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function NewBranchDialog({ repoId, onClose }: { repoId: string; onClose: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    if (busy || name.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await api.createGitBranch(repoId, name.trim(), true)
      refreshGitRepos()
      bumpGitStatus()
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="git-dialog-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('git.newBranch')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{t('git.newBranch')}</h3>
        <p className="muted sm">{t('git.newBranchLead')}</p>
        <input
          className="llm-mono"
          placeholder={t('git.newBranchPlaceholder')}
          value={name}
          autoFocus
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void create()
            }
          }}
        />
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="git-dialog-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || name.trim() === ''}
            onClick={() => void create()}
          >
            {busy ? t('git.creating') : t('git.createAndSwitch')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * A repo's front page: status, the root listing, and its README rendered the
 * way a book overview shows a description — the repo-as-book metaphor made
 * literal.
 */
export function GitRepoCanvas() {
  const { t } = useI18n()
  const { repoId } = useParams()
  const repos = useGitRepos()
  const repo = repos?.find((r) => r.id === repoId) ?? null
  const statusVersion = useGitStatusVersion()
  const [entries, setEntries] = useState<GitTreeEntry[] | null>(null)
  const [readme, setReadme] = useState<GitFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const ready = repo?.status === 'ready'

  useEffect(() => {
    if (!repoId || !ready) return
    let cancelled = false
    setError(null)
    api
      .getGitTree(repoId)
      .then(async (list) => {
        if (cancelled) return
        setEntries(list)
        const readmeEntry = list.find(
          (e) => e.type === 'file' && e.name.toLowerCase().startsWith('readme'),
        )
        if (readmeEntry && isMarkdown(readmeEntry.name)) {
          const file = await api.getGitFile(repoId, readmeEntry.path)
          if (!cancelled) setReadme(file)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoId, ready, repo?.fetchedAt, statusVersion])

  if (!repoId) return null
  if (repos === null) return <div className="canvas-message muted">{t('git.loadingRepo')}</div>
  if (!repo) return <div className="canvas-message muted">{t('git.repoGone')}</div>

  return (
    <div className="git-canvas">
      <GitToolbar repoId={repoId} />
      <div className="book-overview">
        <div className="book-overview-head">
          <h1>📦 {repo.name}</h1>
        </div>
        <p className="muted sm git-clone-url">{repo.cloneUrl}</p>

        {repo.status === 'cloning' ? (
          <p className="muted">{t('git.cloningNote')}</p>
        ) : null}
        {repo.status === 'error' ? (
          <p className="banner error">{repo.lastError ?? t('git.cloneFailed')}</p>
        ) : null}
        {error ? <p className="banner error">{error}</p> : null}

        {/* Background AI-drafting jobs for this repo — above the file list so a
            running job is not buried under a long tree. The header panel lists
            every repo's jobs. */}
        <GitAssistJobs repoId={repoId} />

        {entries !== null && ready ? (
          <ul className="git-root-list">
            {entries.map((entry) => (
              <li key={entry.path}>
                {entry.type === 'dir' ? (
                  <span className="git-root-entry">
                    <span aria-hidden>📁</span> {entry.name}
                    <span className="muted sm"> — {t('git.expandHint')}</span>
                  </span>
                ) : (
                  <Link to={gitFilePath(repoId, entry.path)} className="git-root-entry">
                    <span aria-hidden>📃</span> {entry.name}
                    {entry.size !== null ? <span className="muted sm"> · {formatSize(entry.size)}</span> : null}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {ready ? (
          <div className="git-readme">
            <button
              type="button"
              className="btn sm"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? t('git.hideHistory') : t('git.history')}
            </button>
            {/* Keyed by fetchedAt so a pull refreshes the list. */}
            {showHistory ? <HistoryList key={repo.fetchedAt ?? ''} repoId={repoId} /> : null}
          </div>
        ) : null}

        {readme?.content ? (
          <div className="git-readme">
            <h2 className="book-overview-subhead">{readme.name}</h2>
            <MarkdownView content={readme.content} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One file from the working tree, rendered by what it is — and, for text,
 * editable: explicit Save (Ctrl+S) writes the working tree guarded by the blob
 * sha the editor loaded, and the commit itself is a separate, deliberate step
 * in the toolbar. Deliberately no autosave — every save is a change everyone
 * on the server sees.
 */
export function GitFileCanvas() {
  const { canWrite } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const { repoId, '*': splat } = useParams()
  const path = useMemo(
    () => (splat ?? '').split('/').map(decodeURIComponent).join('/'),
    [splat],
  )
  const [file, setFile] = useState<GitFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 'diff' and 'history' are read panels under the content; a ref view swaps
  // the content itself for a historical version, read-only.
  const [panel, setPanel] = useState<'none' | 'diff' | 'history'>('none')
  const [refView, setRefView] = useState<{ entry: GitLogEntry; file: GitFile } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [mdView, setMdView] = useState<'edit' | 'split' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const flashTimer = useRef<number | null>(null)

  const dirty = editing && file !== null && draft !== (file.content ?? '')

  useEffect(() => {
    if (!repoId || !path) return
    let cancelled = false
    setFile(null)
    setError(null)
    setEditing(false)
    setMdView('edit')
    setSaveError(null)
    setPanel('none')
    setRefView(null)
    setActionError(null)
    api
      .getGitFile(repoId, path)
      .then((f) => {
        if (!cancelled) setFile(f)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoId, path])

  useEffect(() => () => window.clearTimeout(flashTimer.current ?? undefined), [])

  // An unsaved draft must survive neither a reload nor a tab close silently.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const save = useCallback(async () => {
    if (!repoId || !file || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const next = await api.writeGitFile(repoId, file.path, draft, file.blobSha)
      setFile(next)
      bumpGitStatus()
      setSavedFlash(true)
      window.clearTimeout(flashTimer.current ?? undefined)
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2400)
    } catch (e) {
      setSaveError(errText(e))
    } finally {
      setSaving(false)
    }
  }, [repoId, file, draft, saving])

  const startEdit = () => {
    if (!file) return
    setDraft(file.content ?? '')
    setEditing(true)
    setMdView('edit')
    setSaveError(null)
  }

  const stopEdit = () => {
    if (dirty && !window.confirm(t('git.discardConfirm'))) return
    setEditing(false)
    setSaveError(null)
  }

  if (!repoId) return null

  const rawUrl = path ? api.gitRawUrl(repoId, path) : ''
  const isImage = file !== null && IMAGE_EXTENSIONS.includes(extensionOf(file.name))
  const editable = canWrite && file !== null && !file.binary && !file.tooLarge && !isImage
  const markdown = file !== null && isMarkdown(file.name)

  const viewAt = async (entry: GitLogEntry) => {
    setActionError(null)
    try {
      const historic = await api.getGitFile(repoId, path, entry.sha)
      setRefView({ entry, file: historic })
    } catch (e) {
      setActionError(errText(e))
    }
  }

  const removeFile = async () => {
    if (!window.confirm(t('git.deleteConfirm', { path }))) {
      return
    }
    setActionError(null)
    try {
      await api.deleteGitFile(repoId, path)
      bumpGitStatus()
      void navigate(`/git/${repoId}`)
    } catch (e) {
      setActionError(errText(e))
    }
  }

  return (
    <div className="git-canvas">
      <GitToolbar repoId={repoId} />
      <div className="git-file-canvas">
        <div className="git-file-head">
          <h1 className="git-file-path" title={path}>
            {path}
          </h1>
          {file ? <span className="muted sm">{formatSize(file.size)}</span> : null}
          {dirty ? <span className="llm-badge is-dirty">{t('git.unsaved')}</span> : null}
          <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
            {savedFlash ? t('git.savedFlash') : ''}
          </span>
          <span className="git-toolbar-spacer" />
          {editing ? (
            <>
              {markdown ? (
                <span className="git-view-switch" role="group" aria-label={t('git.markdownViewAria')}>
                  {(['edit', 'split', 'preview'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`btn sm${mdView === mode ? ' active' : ''}`}
                      aria-pressed={mdView === mode}
                      onClick={() => setMdView(mode)}
                    >
                      {mode === 'edit'
                        ? t('common.edit')
                        : mode === 'split'
                          ? t('git.split')
                          : t('git.preview')}
                    </button>
                  ))}
                </span>
              ) : null}
              <button
                type="button"
                className="btn primary sm"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
              <button type="button" className="btn sm" onClick={stopEdit}>
                {t('common.done')}
              </button>
            </>
          ) : refView !== null ? null : (
            <>
              {editable ? (
                <button type="button" className="btn sm" onClick={startEdit}>
                  {t('common.edit')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn sm"
                aria-expanded={panel === 'diff'}
                title={t('git.fileChangesTitle')}
                onClick={() => setPanel((p) => (p === 'diff' ? 'none' : 'diff'))}
              >
                {t('git.changes')}
              </button>
              <button
                type="button"
                className="btn sm"
                aria-expanded={panel === 'history'}
                onClick={() => setPanel((p) => (p === 'history' ? 'none' : 'history'))}
              >
                {t('git.history')}
              </button>
              {canWrite ? (
                <>
                  <button type="button" className="btn sm" onClick={() => setRenaming(true)}>
                    {t('common.rename')}
                  </button>
                  <button type="button" className="btn ghost danger sm" onClick={() => void removeFile()}>
                    {t('common.delete')}
                  </button>
                </>
              ) : null}
            </>
          )}
          <a className="btn sm" href={rawUrl} download>
            {t('common.download')}
          </a>
        </div>

        {refView !== null ? (
          <p className="git-refview-banner" role="status">
            {t('git.viewingAt', {
              sha: refView.entry.shortSha,
              date: new Date(refView.entry.date).toLocaleString(),
              author: refView.entry.author,
            })}
            <button type="button" className="btn sm" onClick={() => setRefView(null)}>
              {t('git.backToCurrent')}
            </button>
          </p>
        ) : null}
        {actionError ? (
          <p className="banner error" role="alert">
            {actionError}
          </p>
        ) : null}

        {error ? <p className="banner error">{error}</p> : null}
        {saveError ? (
          <p className="banner error" role="alert">
            {saveError}
          </p>
        ) : null}
        {file === null && error === null ? <p className="muted">{t('common.loading')}</p> : null}

        {refView !== null ? (
          refView.file.content !== null && markdown ? (
            <div className="git-file-markdown">
              <MarkdownView content={refView.file.content} />
            </div>
          ) : refView.file.content !== null ? (
            <CodeView name={refView.file.name} content={refView.file.content} />
          ) : (
            <p className="muted">{t('git.versionNotInline')}</p>
          )
        ) : editing && file !== null ? (
          (() => {
            const editorBox = (
              <textarea
                className="git-editor"
                value={draft}
                spellCheck={markdown}
                disabled={saving}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void save()
                  }
                }}
              />
            )
            if (!markdown || mdView === 'edit') return editorBox
            if (mdView === 'preview') {
              return (
                <div className="git-file-markdown">
                  <MarkdownView content={draft} />
                </div>
              )
            }
            return (
              <div className="git-split">
                {editorBox}
                <div className="git-file-markdown git-split-preview">
                  <MarkdownView content={draft} />
                </div>
              </div>
            )
          })()
        ) : file !== null && markdown && file.content !== null ? (
          <div className="git-file-markdown">
            <MarkdownView content={file.content} />
          </div>
        ) : isImage ? (
          <div className="git-file-image">
            <img src={rawUrl} alt={file?.name ?? path} />
          </div>
        ) : file?.content != null ? (
          <CodeView name={file.name} content={file.content} />
        ) : file !== null ? (
          <p className="muted">
            {file.tooLarge ? t('git.tooLargeInline') : t('git.binaryInline')}
          </p>
        ) : null}

        {panel === 'diff' && refView === null ? (
          <div className="git-panel">
            <h2 className="book-overview-subhead">{t('git.uncommittedChanges')}</h2>
            {/* Keyed by blobSha so a save refreshes the diff. */}
            <FileDiffPanel key={file?.blobSha ?? ''} repoId={repoId} path={path} />
          </div>
        ) : null}
        {panel === 'history' && refView === null ? (
          <div className="git-panel">
            <h2 className="book-overview-subhead">{t('git.history')}</h2>
            <HistoryList repoId={repoId} path={path} onViewAt={(entry) => void viewAt(entry)} />
          </div>
        ) : null}

        {renaming ? (
          <RenameDialog
            repoId={repoId}
            from={path}
            onClose={() => setRenaming(false)}
            onRenamed={(to) => {
              bumpGitStatus()
              void navigate(gitFilePath(repoId, to))
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

/** The file's working-tree diff against HEAD, fetched when shown. */
function FileDiffPanel({ repoId, path }: { repoId: string; path: string }) {
  const { t } = useI18n()
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getGitDiff(repoId, path)
      .then((d) => {
        if (!cancelled) setPatch({ text: d.patch, truncated: d.truncated })
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoId, path])

  if (error !== null) return <p className="banner error">{error}</p>
  if (patch === null) return <p className="muted sm">{t('common.loading')}</p>
  return <DiffView patch={patch.text} truncated={patch.truncated} />
}

function RenameDialog({
  repoId,
  from,
  onClose,
  onRenamed,
}: {
  repoId: string
  from: string
  onClose: () => void
  onRenamed: (to: string) => void
}) {
  const { t } = useI18n()
  const [to, setTo] = useState(from)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rename = async () => {
    const target = to.trim()
    if (busy || target === '' || target === from) return
    setBusy(true)
    setError(null)
    try {
      await api.renameGitFile(repoId, from, target)
      onRenamed(target)
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="git-dialog-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="git-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('git.renameFile')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{t('git.renameMove')}</h3>
        <p className="muted sm">{t('git.renameLead')}</p>
        <input
          className="llm-mono"
          value={to}
          autoFocus
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void rename()
            }
          }}
        />
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="git-dialog-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || to.trim() === '' || to.trim() === from}
            onClick={() => void rename()}
          >
            {busy ? t('git.renaming') : t('common.rename')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * A unified diff, coloured line by line. Plain text in, spans out — nothing in
 * a patch is ever interpreted as markup.
 */
function DiffView({ patch, truncated }: { patch: string; truncated?: boolean }) {
  const { t } = useI18n()
  const lines = useMemo(() => patch.replace(/\n$/, '').split('\n'), [patch])

  if (patch.trim() === '') {
    return <p className="muted sm">{t('git.noChanges')}</p>
  }

  return (
    <pre className="git-diff">
      {lines.map((line, i) => {
        const kind = line.startsWith('diff --git') || line.startsWith('index ')
          || line.startsWith('--- ') || line.startsWith('+++ ')
          || line.startsWith('new file') || line.startsWith('deleted file')
          || line.startsWith('rename ') || line.startsWith('similarity ')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx'
        return (
          <span key={i} className={`git-diff-line is-${kind}`}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
      {truncated ? <span className="git-diff-line is-meta">{t('git.patchTruncated')}</span> : null}
    </pre>
  )
}

/**
 * Commit history — the whole branch or one file's. Each row expands into the
 * commit's patch; for a file, `onViewAt` additionally offers "view the file as
 * it was" at that commit.
 */
function HistoryList({
  repoId,
  path,
  onViewAt,
}: {
  repoId: string
  path?: string
  onViewAt?: (entry: GitLogEntry) => void
}) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<GitLogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openSha, setOpenSha] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(null)
    setOpenSha(null)
    setDetail(null)
    api
      .getGitLog(repoId, path, 30)
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoId, path])

  const openCommit = (sha: string) => {
    if (openSha === sha) {
      setOpenSha(null)
      setDetail(null)
      return
    }
    setOpenSha(sha)
    setDetail(null)
    setDetailError(null)
    api
      .getGitCommit(repoId, sha, path)
      .then(setDetail)
      .catch((e: unknown) => setDetailError(errText(e)))
  }

  if (error !== null) return <p className="banner error">{error}</p>
  if (entries === null) return <p className="muted sm">{t('git.loadingHistory')}</p>
  if (entries.length === 0) return <p className="muted sm">{t('git.noCommitsYet')}</p>

  return (
    <ul className="git-history">
      {entries.map((entry) => (
        <li key={entry.sha}>
          <button
            type="button"
            className={`git-history-row${openSha === entry.sha ? ' is-open' : ''}`}
            onClick={() => openCommit(entry.sha)}
          >
            <code className="git-history-sha">{entry.shortSha}</code>
            <span className="git-history-subject">{entry.subject}</span>
            <span className="muted sm">
              {entry.author} · {new Date(entry.date).toLocaleString()}
            </span>
          </button>
          {openSha === entry.sha ? (
            <div className="git-history-detail">
              {onViewAt ? (
                <button type="button" className="btn sm" onClick={() => onViewAt(entry)}>
                  {t('git.viewFileAtCommit')}
                </button>
              ) : null}
              {detailError ? <p className="banner error">{detailError}</p> : null}
              {detail === null && detailError === null ? (
                <p className="muted sm">{t('git.loadingPatch')}</p>
              ) : null}
              {detail !== null ? (
                <>
                  {detail.body ? <p className="git-history-body">{detail.body}</p> : null}
                  <DiffView patch={detail.patch} truncated={detail.patchTruncated} />
                </>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function CodeView({ name, content }: { name: string; content: string }) {
  const highlighted = useMemo(
    () => highlightCode(content, extensionOf(name).replace('.', '') || name.toLowerCase()),
    [name, content],
  )

  return (
    <pre className="git-code">
      {highlighted !== null ? (
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code>{content}</code>
      )}
    </pre>
  )
}
