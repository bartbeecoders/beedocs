import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import {
  useGitRepos,
  refreshGitRepos,
  bumpGitStatus,
  useGitStatusVersion,
} from '../hooks/useGitRepos'
import { highlightCode } from '../syntaxHighlight'
import { MarkdownView } from './MarkdownView'
import { gitFilePath } from '../gitPaths'
import type { GitBranch, GitFile, GitStatus, GitTreeEntry } from '../types'
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
 * The repo's own toolbar — branch picker, ahead/behind, Pull, Push, Commit.
 * Shared by both git canvases so the git verbs are wherever the repo's content
 * is. All state here is the *server's* shared working copy, which is why every
 * verb refreshes from it rather than optimistically updating.
 */
function GitToolbar({ repoId }: { repoId: string }) {
  const { canWrite } = useAuth()
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
          aria-label="Checked-out branch (shared by everyone on this server)"
          title="Switching branches affects everyone using this server"
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
              {b.isRemote ? ' (remote)' : ''}
            </option>
          ))}
          <option value="__new__">＋ New branch…</option>
        </select>
      ) : (
        <span className="git-toolbar-branch" title="Checked-out branch">
          ⎇ {branch || '…'}
        </span>
      )}

      {status && (status.ahead > 0 || status.behind > 0) ? (
        <span
          className="git-toolbar-ab"
          title={`${status.ahead} ahead, ${status.behind} behind the remote`}
        >
          {status.ahead > 0 ? `↑${status.ahead}` : ''}
          {status.behind > 0 ? `↓${status.behind}` : ''}
        </span>
      ) : null}
      {dirtyCount > 0 ? (
        <span className="git-toolbar-dirty" title="Uncommitted changes in the server's working copy">
          {dirtyCount} changed
        </span>
      ) : null}
      {repo.fetchedAt ? (
        <span className="muted sm">synced {new Date(repo.fetchedAt).toLocaleString()}</span>
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
              Commit ({dirtyCount})
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null || !ready}
            onClick={() => void run('pull', () => api.pullGitRepo(repoId))}
          >
            {busy === 'pull' ? 'Pulling…' : 'Pull'}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy !== null || !ready}
            title={status && status.ahead > 0 ? `${status.ahead} commit(s) to push` : 'Push the current branch'}
            onClick={() => void run('push', () => api.pushGitRepo(repoId))}
          >
            {busy === 'push' ? 'Pushing…' : status && status.ahead > 0 ? `Push ↑${status.ahead}` : 'Push'}
          </button>
        </>
      ) : null}

      {error ? (
        <span className="git-toolbar-error" role="alert">
          {error}
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
        aria-label="Commit changes"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>Commit changes</h3>
        {done ? (
          <>
            <p className="git-dialog-ok">
              Committed as <code>{done}</code>. Use <strong>Push</strong> in the toolbar to send it
              to the remote.
            </p>
            <div className="git-dialog-actions">
              <button type="button" className="btn primary sm" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="git-commit-message"
              placeholder="What changed, and why"
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
                Cancel
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={busy || message.trim() === '' || selected.size === 0}
                onClick={() => void commit()}
              >
                {busy
                  ? 'Committing…'
                  : `Commit ${selected.size} file${selected.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function NewBranchDialog({ repoId, onClose }: { repoId: string; onClose: () => void }) {
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
        aria-label="New branch"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>New branch</h3>
        <p className="muted sm">
          Created from the current branch and checked out — for everyone on this server.
        </p>
        <input
          className="llm-mono"
          placeholder="e.g. docs/update-readme"
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
            Cancel
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={busy || name.trim() === ''}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create and switch'}
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
  const { repoId } = useParams()
  const repos = useGitRepos()
  const repo = repos?.find((r) => r.id === repoId) ?? null
  const statusVersion = useGitStatusVersion()
  const [entries, setEntries] = useState<GitTreeEntry[] | null>(null)
  const [readme, setReadme] = useState<GitFile | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  if (repos === null) return <div className="canvas-message muted">Loading repository…</div>
  if (!repo) return <div className="canvas-message muted">This repository is no longer on the shelf.</div>

  return (
    <div className="git-canvas">
      <GitToolbar repoId={repoId} />
      <div className="book-overview">
        <div className="book-overview-head">
          <h1>📦 {repo.name}</h1>
        </div>
        <p className="muted sm git-clone-url">{repo.cloneUrl}</p>

        {repo.status === 'cloning' ? (
          <p className="muted">Cloning… the tree appears as soon as the clone finishes.</p>
        ) : null}
        {repo.status === 'error' ? (
          <p className="banner error">{repo.lastError ?? 'The clone failed.'}</p>
        ) : null}
        {error ? <p className="banner error">{error}</p> : null}

        {entries !== null && ready ? (
          <ul className="git-root-list">
            {entries.map((entry) => (
              <li key={entry.path}>
                {entry.type === 'dir' ? (
                  <span className="git-root-entry">
                    <span aria-hidden>📁</span> {entry.name}
                    <span className="muted sm"> — expand it in the left tree</span>
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
  const { repoId, '*': splat } = useParams()
  const path = useMemo(
    () => (splat ?? '').split('/').map(decodeURIComponent).join('/'),
    [splat],
  )
  const [file, setFile] = useState<GitFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(false)
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
    setPreview(false)
    setSaveError(null)
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
    setPreview(false)
    setSaveError(null)
  }

  const stopEdit = () => {
    if (dirty && !window.confirm('Discard the unsaved changes to this file?')) return
    setEditing(false)
    setSaveError(null)
  }

  if (!repoId) return null

  const rawUrl = path ? api.gitRawUrl(repoId, path) : ''
  const isImage = file !== null && IMAGE_EXTENSIONS.includes(extensionOf(file.name))
  const editable = canWrite && file !== null && !file.binary && !file.tooLarge && !isImage
  const markdown = file !== null && isMarkdown(file.name)

  return (
    <div className="git-canvas">
      <GitToolbar repoId={repoId} />
      <div className="git-file-canvas">
        <div className="git-file-head">
          <h1 className="git-file-path" title={path}>
            {path}
          </h1>
          {file ? <span className="muted sm">{formatSize(file.size)}</span> : null}
          {dirty ? <span className="llm-badge is-dirty">Unsaved</span> : null}
          <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
            {savedFlash ? 'Saved — commit when ready' : ''}
          </span>
          <span className="git-toolbar-spacer" />
          {editing ? (
            <>
              {markdown ? (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => setPreview((v) => !v)}
                >
                  {preview ? 'Edit source' : 'Preview'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary sm"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="btn sm" onClick={stopEdit}>
                Done
              </button>
            </>
          ) : editable ? (
            <button type="button" className="btn sm" onClick={startEdit}>
              Edit
            </button>
          ) : null}
          <a className="btn sm" href={rawUrl} download>
            Download
          </a>
        </div>

        {error ? <p className="banner error">{error}</p> : null}
        {saveError ? (
          <p className="banner error" role="alert">
            {saveError}
          </p>
        ) : null}
        {file === null && error === null ? <p className="muted">Loading…</p> : null}

        {editing && file !== null ? (
          preview && markdown ? (
            <div className="git-file-markdown">
              <MarkdownView content={draft} />
            </div>
          ) : (
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
            {file.tooLarge
              ? 'This file is too large to show inline — use Download.'
              : 'This is a binary file — use Download.'}
          </p>
        ) : null}
      </div>
    </div>
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
