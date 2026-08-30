import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useGitRepos, refreshGitRepos } from '../hooks/useGitRepos'
import { highlightCode } from '../syntaxHighlight'
import { MarkdownView } from './MarkdownView'
import { gitFilePath } from '../gitPaths'
import type { GitFile, GitStatus, GitTreeEntry } from '../types'
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
 * The repo's own toolbar — branch, ahead/behind, dirty count, Sync. Shared by
 * both git canvases so the git verbs are wherever the repo's content is.
 */
function GitToolbar({ repoId }: { repoId: string }) {
  const { canWrite } = useAuth()
  const repos = useGitRepos()
  const repo = repos?.find((r) => r.id === repoId) ?? null
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [statusSeq, setStatusSeq] = useState(0)

  const ready = repo?.status === 'ready'

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    api
      .getGitStatus(repoId)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        // The toolbar degrades to name + Sync; the canvas shows real errors.
      })
    return () => {
      cancelled = true
    }
  }, [repoId, ready, statusSeq])

  const sync = async () => {
    setSyncing(true)
    setSyncError(null)
    try {
      await api.syncGitRepo(repoId)
      refreshGitRepos()
      setStatusSeq((n) => n + 1)
    } catch (e) {
      setSyncError(errText(e))
    } finally {
      setSyncing(false)
    }
  }

  if (!repo) return null

  return (
    <div className="git-toolbar">
      <span className="git-toolbar-branch" title="Checked-out branch (shared by everyone on this server)">
        ⎇ {status?.branch ?? repo.defaultBranch ?? '…'}
      </span>
      {status && (status.ahead > 0 || status.behind > 0) ? (
        <span className="git-toolbar-ab" title={`${status.ahead} ahead, ${status.behind} behind the remote`}>
          {status.ahead > 0 ? `↑${status.ahead}` : ''}
          {status.behind > 0 ? `↓${status.behind}` : ''}
        </span>
      ) : null}
      {status && status.dirty.length > 0 ? (
        <span className="git-toolbar-dirty" title="Uncommitted changes in the server's working copy">
          {status.dirty.length} changed
        </span>
      ) : null}
      {repo.fetchedAt ? (
        <span className="muted sm">synced {new Date(repo.fetchedAt).toLocaleString()}</span>
      ) : null}
      <span className="git-toolbar-spacer" />
      {canWrite ? (
        <button type="button" className="btn sm" disabled={syncing || !ready} onClick={() => void sync()}>
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      ) : null}
      {syncError ? (
        <span className="git-toolbar-error" role="alert">
          {syncError}
        </span>
      ) : null}
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
  }, [repoId, ready, repo?.fetchedAt])

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

/** One file from the working tree, rendered by what it is. */
export function GitFileCanvas() {
  const { repoId, '*': splat } = useParams()
  const path = useMemo(
    () => (splat ?? '').split('/').map(decodeURIComponent).join('/'),
    [splat],
  )
  const [file, setFile] = useState<GitFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!repoId || !path) return
    let cancelled = false
    setFile(null)
    setError(null)
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

  if (!repoId) return null

  const rawUrl = path ? api.gitRawUrl(repoId, path) : ''
  const isImage = file !== null && IMAGE_EXTENSIONS.includes(extensionOf(file.name))

  return (
    <div className="git-canvas">
      <GitToolbar repoId={repoId} />
      <div className="git-file-canvas">
        <div className="git-file-head">
          <h1 className="git-file-path" title={path}>
            {path}
          </h1>
          {file ? <span className="muted sm">{formatSize(file.size)}</span> : null}
          <a className="btn sm" href={rawUrl} download>
            Download
          </a>
        </div>

        {error ? <p className="banner error">{error}</p> : null}
        {file === null && error === null ? <p className="muted">Loading…</p> : null}

        {file !== null && isMarkdown(file.name) && file.content !== null ? (
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
