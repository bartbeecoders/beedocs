import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { GitRepo } from '../types'

/**
 * One shared list of the instance's git repos, outside React state so the tree
 * section, the canvases and the settings panel all see the same rows — the
 * refreshLlmProviders pattern. `null` means "never loaded"; the first mount
 * loads it, and anything that mutates repos calls {@link refreshGitRepos}.
 *
 * While any repo is still cloning the store re-polls itself, so the tree's
 * "cloning…" badge resolves without anyone pressing refresh.
 */
let repos: GitRepo[] | null = null
let loading = false
let pollTimer: number | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

async function load(): Promise<void> {
  if (loading) return
  loading = true
  try {
    repos = await api.listGitRepos()
    emit()
    schedulePollIfCloning()
  } catch {
    // A failed load leaves the last known list standing; the next refresh or
    // mount tries again. Repos are a side panel, not the workspace.
  } finally {
    loading = false
  }
}

function schedulePollIfCloning() {
  const cloning = (repos ?? []).some((r) => r.status === 'cloning')
  if (!cloning) {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer)
      pollTimer = null
    }
    return
  }
  if (pollTimer !== null) return
  pollTimer = window.setTimeout(() => {
    pollTimer = null
    void load()
  }, 3000)
}

/** Re-fetch the list. Call after any mutation (add, delete, sync, rename). */
export function refreshGitRepos(): void {
  void load()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The shared repo list; null until first loaded. Mounting triggers the load. */
export function useGitRepos(): GitRepo[] | null {
  const value = useSyncExternalStore(subscribe, () => repos)
  useEffect(() => {
    if (repos === null) void load()
  }, [])
  return value
}
