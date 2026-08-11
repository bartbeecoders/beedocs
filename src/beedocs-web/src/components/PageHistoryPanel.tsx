import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PageHistory, PageHistoryEntry } from '../types'

type Props = {
  pageId: string
  /**
   * The page's live version. Every save bumps it, which is exactly when the log
   * has a new entry — so this is what re-fetches the list.
   */
  version: number | undefined
}

/** Same day → time only; this year → day and month; older → include the year. */
function formatChangedAt(value: string): string {
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return '—'

  const now = new Date()
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate()

  if (sameDay) return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return when.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: when.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

function whoChanged(entry: PageHistoryEntry): string {
  if (entry.changedByName) return entry.changedByName
  // Three different nobodies, and the distinction matters when auditing: a
  // change made by a machine, one made before sign-in was switched on, and a
  // revision that predates the log entirely.
  return entry.changeKind === 'legacy' ? 'before history was kept' : 'unattributed'
}

/**
 * The page's change log: who changed it and when, newest first. Lives in the
 * properties pane beside the page's other facts.
 */
export function PageHistoryPanel({ pageId, version }: Props) {
  const [history, setHistory] = useState<PageHistory | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pageId) return
    let cancelled = false
    api
      .getPageHistory(pageId, 25)
      .then((h) => {
        if (cancelled) return
        setHistory(h)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // `version` is not read in the body — it is the signal that a save landed
    // and the log has grown.
  }, [pageId, version])

  if (error) {
    return (
      <p className="muted sm" role="alert">
        History unavailable — {error}
      </p>
    )
  }

  if (!history) return <p className="muted sm">Loading history…</p>

  if (history.entries.length === 0) {
    return <p className="muted sm">No changes recorded yet.</p>
  }

  return (
    <ol className="page-history">
      {history.entries.map((entry) => (
        <li key={entry.id} className={`page-history-row${entry.isCurrent ? ' current' : ''}`}>
          <span className="page-history-version" title={`Version ${entry.version}`}>
            v{entry.version}
          </span>
          <span className="page-history-body">
            <span className="page-history-who">{whoChanged(entry)}</span>
            <span className="muted sm">
              {entry.changeKind === 'created' ? 'created' : 'changed'}{' '}
              <time dateTime={entry.changedAt} title={new Date(entry.changedAt).toLocaleString()}>
                {formatChangedAt(entry.changedAt)}
              </time>
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}
