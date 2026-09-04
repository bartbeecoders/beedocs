import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { GitAssistJob } from '../types'

/**
 * One shared list of AI drafting jobs for the instance, outside React state so
 * the header panel and each repo page see the same rows and poll once. `null`
 * jobs means "never loaded". While any job is queued or running the store
 * re-polls itself — an LLM run is minutes-scale and the row is the status.
 */
let snapshot: { jobs: GitAssistJob[] | null; error: string | null } = {
  jobs: null,
  error: null,
}
let loading = false
let pollTimer: number | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setSnapshot(next: { jobs: GitAssistJob[] | null; error: string | null }) {
  snapshot = next
  emit()
}

async function load(): Promise<void> {
  if (loading) return
  loading = true
  try {
    const jobs = await api.listGitAssistJobs()
    setSnapshot({ jobs, error: null })
    schedulePoll()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    setSnapshot({ jobs: snapshot.jobs, error: message })
  } finally {
    loading = false
  }
}

function schedulePoll() {
  const active = (snapshot.jobs ?? []).some(
    (j) => j.status === 'queued' || j.status === 'running',
  )
  if (!active) {
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

/** Re-fetch the list. Call after starting, re-running or deleting a job. */
export function refreshGitAssistJobs(): void {
  void load()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return snapshot
}

/** The shared job list; null until first loaded. Mounting triggers the load. */
export function useGitAssistJobs(): { jobs: GitAssistJob[] | null; error: string | null } {
  const value = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (snapshot.jobs === null) void load()
  }, [])
  return value
}
