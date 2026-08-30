import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api'
import { gitFilePath } from '../gitPaths'
import { useGitRepos } from '../hooks/useGitRepos'
import type { GitRepo, GitTreeEntry } from '../types'
import '../styles/git.css'

function fileIcon(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return '📄'
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) return '🖼️'
  return '📃'
}

/**
 * "Repositories" in the left pane: the git shelf. Connections group their
 * repos; folders expand lazily from `/tree`; a file navigates to its canvas.
 * Renders nothing while no repo is added — the section must not push the
 * library down for everyone who never connected git. Reuses the library tree's
 * row classes so a repo file reads as the same kind of thing as a page.
 */
export function GitTree() {
  const repos = useGitRepos()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('beedocs-git-collapsed') === '1'
    } catch {
      return false
    }
  })

  if (!repos || repos.length === 0) return null

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem('beedocs-git-collapsed', next ? '1' : '0')
      } catch {
        // Preference only.
      }
      return next
    })
  }

  // Group by connection, in list order (the API orders by connection, name).
  const groups: { id: string; name: string; repos: GitRepo[] }[] = []
  for (const repo of repos) {
    const group = groups.find((g) => g.id === repo.connectionId)
    if (group) group.repos.push(repo)
    else groups.push({ id: repo.connectionId, name: repo.connectionName, repos: [repo] })
  }

  return (
    <div className="git-tree-panel">
      <button
        type="button"
        className="git-tree-header"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        <span className="tree-twist">{collapsed ? '▸' : '▾'}</span>
        <span className="git-tree-title">⎇ Repositories</span>
        <span className="muted sm">({repos.length})</span>
      </button>
      {!collapsed && (
        <ul className="tree-root">
          {groups.map((group) => (
            <li key={group.id}>
              <div className="tree-row git-conn-row">
                <span className="tree-label">
                  <span className="tree-icon">📚</span>
                  <span className="tree-text">{group.name}</span>
                </span>
              </div>
              <ul className="tree-children">
                {group.repos.map((repo) => (
                  <RepoNode key={repo.id} repo={repo} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RepoNode({ repo }: { repo: GitRepo }) {
  const [expanded, setExpanded] = useState(false)
  const ready = repo.status === 'ready'

  return (
    <li>
      <div className="tree-row">
        <button
          type="button"
          className="tree-twist"
          aria-label={expanded ? `Collapse ${repo.name}` : `Expand ${repo.name}`}
          disabled={!ready}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <NavLink to={`/git/${repo.id}`} className="tree-label">
          <span className="tree-icon">📦</span>
          <span className="tree-text">{repo.name}</span>
          {repo.status === 'cloning' ? (
            <span className="git-badge is-cloning">cloning…</span>
          ) : repo.status === 'error' ? (
            <span className="git-badge is-error" title={repo.lastError ?? undefined}>
              failed
            </span>
          ) : null}
        </NavLink>
      </div>
      {expanded && ready ? <FolderChildren repoId={repo.id} path="" /> : null}
    </li>
  )
}

/**
 * One directory level, loaded when first shown. State lives per node, so
 * collapsing and re-expanding shows the cached listing instantly; Sync in the
 * repo canvas re-mounts the tree via the store refresh when content changes.
 */
function FolderChildren({ repoId, path }: { repoId: string; path: string }) {
  const [entries, setEntries] = useState<GitTreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getGitTree(repoId, path || undefined)
      .then((list) => {
        if (!cancelled) setEntries(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [repoId, path])

  if (error !== null) return <div className="git-tree-note is-warn">{error}</div>
  if (entries === null) return <div className="git-tree-note muted sm">Loading…</div>
  if (entries.length === 0) return <div className="git-tree-note muted sm">Empty folder</div>

  return (
    <ul className="tree-children">
      {entries.map((entry) =>
        entry.type === 'dir' ? (
          <FolderNode key={entry.path} repoId={repoId} entry={entry} />
        ) : (
          <li key={entry.path}>
            <div className="tree-row">
              <NavLink to={gitFilePath(repoId, entry.path)} className="tree-label">
                <span className="tree-icon">{fileIcon(entry.name)}</span>
                <span className="tree-text">{entry.name}</span>
              </NavLink>
            </div>
          </li>
        ),
      )}
    </ul>
  )
}

function FolderNode({ repoId, entry }: { repoId: string; entry: GitTreeEntry }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li>
      <div className="tree-row">
        <button
          type="button"
          className="tree-twist"
          aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" className="tree-label" onClick={() => setExpanded((v) => !v)}>
          <span className="tree-icon">📁</span>
          <span className="tree-text">{entry.name}</span>
        </button>
      </div>
      {expanded ? <FolderChildren repoId={repoId} path={entry.path} /> : null}
    </li>
  )
}
