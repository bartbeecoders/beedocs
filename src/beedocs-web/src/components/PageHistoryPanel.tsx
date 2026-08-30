import { useEffect, useState } from 'react'
import { api } from '../api'
import { useI18n, type TFunction } from '../i18n'
import type { PageHistory, PageHistoryEntry, PageRevision } from '../types'
import { MarkdownView } from './MarkdownView'

type Props = {
  pageId: string
  /**
   * The page's live version and last-write time. Version counts sittings (it
   * stays put while auto-saves fold into the current one); updatedAt moves on
   * every save, which is when the current log entry's timestamp changes.
   */
  version: number | undefined
  updatedAt?: string
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

function whoChanged(entry: PageHistoryEntry, t: TFunction): string {
  if (entry.changedByName) return entry.changedByName
  // Three different nobodies, and the distinction matters when auditing: a
  // change made by a machine, one made before sign-in was switched on, and a
  // revision that predates the log entirely.
  return entry.changeKind === 'legacy' ? t('props.historyLegacy') : t('props.historyUnattributed')
}

/**
 * The page's change log: who changed it and when, newest first. Lives in the
 * properties pane beside the page's other facts. When the page's owner has
 * change tracking switched on, each kept copy can be pulled up in full.
 */
export function PageHistoryPanel({ pageId, version, updatedAt }: Props) {
  const { t } = useI18n()
  const [history, setHistory] = useState<PageHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Entry whose full document is open in the viewer. */
  const [viewing, setViewing] = useState<PageHistoryEntry | null>(null)

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
    // `version` and `updatedAt` are not read in the body — they are the signal
    // that a save landed (a new sitting, or the current sitting's timestamp).
  }, [pageId, version, updatedAt])

  if (error) {
    return (
      <p className="muted sm" role="alert">
        {t('props.historyUnavailable', { error })}
      </p>
    )
  }

  if (!history) return <p className="muted sm">{t('props.loadingHistory')}</p>

  if (history.entries.length === 0) {
    return <p className="muted sm">{t('props.noChangesYet')}</p>
  }

  // The synthetic "current:" entry has no revision row behind it, and the
  // current entry is just the live page — the viewer earns its keep on the
  // older copies.
  const canView = (entry: PageHistoryEntry) =>
    history.trackChanges && !entry.isCurrent && !entry.id.startsWith('current:')

  return (
    <>
      <ol className="page-history">
        {history.entries.map((entry) => {
          const row = (
            <>
              <span className="page-history-version" title={t('props.versionTitle', { version: entry.version })}>
                v{entry.version}
              </span>
              <span className="page-history-body">
                <span className="page-history-who">{whoChanged(entry, t)}</span>
                <span className="muted sm">
                  {entry.changeKind === 'created' ? t('props.createdWord') : t('props.changedWord')}{' '}
                  <time dateTime={entry.changedAt} title={new Date(entry.changedAt).toLocaleString()}>
                    {formatChangedAt(entry.changedAt)}
                  </time>
                </span>
              </span>
            </>
          )
          return (
            <li key={entry.id} className={`page-history-row${entry.isCurrent ? ' current' : ''}`}>
              {canView(entry) ? (
                <button
                  type="button"
                  className="page-history-open"
                  onClick={() => setViewing(entry)}
                  title={t('props.viewThisVersion')}
                >
                  {row}
                </button>
              ) : (
                row
              )}
            </li>
          )
        })}
      </ol>
      {history.trackChanges && history.entries.some(canView) && (
        <p className="muted sm">{t('props.trackingHint')}</p>
      )}
      {viewing && (
        <RevisionViewer pageId={pageId} entry={viewing} onClose={() => setViewing(null)} />
      )}
    </>
  )
}

/**
 * A kept copy of the page, pulled up in full and rendered read-only. Fetched on
 * open rather than with the log: content is the heavy part, and most visits to
 * the history never open one.
 */
function RevisionViewer({
  pageId,
  entry,
  onClose,
}: {
  pageId: string
  entry: PageHistoryEntry
  onClose: () => void
}) {
  const { t } = useI18n()
  const [revision, setRevision] = useState<PageRevision | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getPageRevision(pageId, entry.id)
      .then((r) => {
        if (!cancelled) setRevision(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [pageId, entry.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={t('props.pageVersionAria', { version: entry.version })}
    >
      <div className="modal modal--wide">
        <header className="modal-header">
          <h2>
            v{entry.version} · {revision?.title ?? entry.title}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className="muted sm revision-meta">
            {whoChanged(entry, t)} · {new Date(entry.changedAt).toLocaleString()} —{' '}
            {t('props.readOnlyCopy')}
          </p>
          {error && (
            <p className="users-error" role="alert">
              {error}
            </p>
          )}
          {!revision && !error && <p className="muted sm">{t('props.loadingVersion')}</p>}
          {revision && <MarkdownView content={revision.content} />}
        </div>
      </div>
    </div>
  )
}
