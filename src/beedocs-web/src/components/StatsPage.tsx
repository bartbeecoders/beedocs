import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import type { InstanceStats } from '../types'

const WINDOWS = [14, 30, 90]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatInt(n: number): string {
  return n.toLocaleString()
}

type CountKind = 'page' | 'diagram' | 'slideDeck' | 'kanban' | 'file' | 'book' | 'shelf' | 'document'

/** "3 pages" via the stats.count.* .one/.other key pairs. */
function plural(t: TFunction, kind: CountKind, n: number): string {
  return t(`stats.count.${kind}.${n === 1 ? 'one' : 'other'}` as MessageKey, {
    count: formatInt(n),
  })
}

/** "2026-08-15" → "Aug 15" in the viewer's locale. */
function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function formatWhen(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/**
 * Instance-wide statistics at /stats: document counts, storage, a per-day
 * activity chart and per-author change totals. The API answers /api/stats only
 * to admins while sign-in is on, so for other roles this page explains rather
 * than rendering a guaranteed 403.
 */
export function StatsPage() {
  const { authEnabled, canManageUsers } = useAuth()
  const { t } = useI18n()
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState<InstanceStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  const blocked = authEnabled && !canManageUsers

  useEffect(() => {
    if (blocked) return
    let cancelled = false
    setError(null)
    api
      .getStats(days)
      .then((s) => !cancelled && setStats(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [days, blocked])

  return (
    <div className="settings-panel stats-page">
      <header className="settings-header">
        <h1>{t('stats.title')}</h1>
        <p className="muted">{t('stats.lead')}</p>
      </header>

      {blocked ? (
        <section className="settings-section">
          <p className="muted sm">
            {t('stats.adminOnly')} {t('stats.perBookPrefix')}{' '}
            <Link to="/">{t('stats.overviewPage')}</Link>
            {t('stats.perBookSuffix')}
          </p>
        </section>
      ) : error ? (
        <section className="settings-section">
          <p className="users-error" role="alert">
            {error}
          </p>
        </section>
      ) : !stats ? (
        <section className="settings-section">
          <p className="muted sm">{t('stats.loading')}</p>
        </section>
      ) : (
        <>
          <section className="settings-section stats-tiles" aria-label={t('stats.totals')}>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatInt(stats.documents.total)}</span>
              <span className="stats-tile-label">{t('stats.documents')}</span>
              <span className="stats-tile-detail muted sm">
                {plural(t, 'page', stats.documents.pages)} ·{' '}
                {plural(t, 'diagram', stats.documents.diagrams)} ·{' '}
                {plural(t, 'slideDeck', stats.documents.slideDecks)} ·{' '}
                {plural(t, 'kanban', stats.documents.kanbanBoards)} ·{' '}
                {plural(t, 'file', stats.documents.attachments)}
              </span>
              <span className="stats-tile-detail muted sm">
                {t('stats.inBooks', { books: plural(t, 'book', stats.documents.books) })}
                {stats.documents.shelves > 0 &&
                  ` ${t('stats.onShelves', { shelves: plural(t, 'shelf', stats.documents.shelves) })}`}
              </span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.contentBytes)}</span>
              <span className="stats-tile-label">{t('stats.contentLabel')}</span>
              <span className="stats-tile-detail muted sm">
                {t('stats.revisionDetail', { size: formatBytes(stats.storage.revisionBytes) })}
              </span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.databaseBytes)}</span>
              <span className="stats-tile-label">{t('stats.databaseLabel')}</span>
              <span className="stats-tile-detail muted sm">{t('stats.databaseDetail')}</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.uploadsBytes)}</span>
              <span className="stats-tile-label">{t('stats.uploadsLabel')}</span>
              <span className="stats-tile-detail muted sm">{t('stats.uploadsDetail')}</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.attachmentBytes)}</span>
              <span className="stats-tile-label">{t('stats.attachmentsLabel')}</span>
              <span className="stats-tile-detail muted sm">
                {t('stats.attachmentsDetail', {
                  count: plural(t, 'document', stats.documents.attachments),
                })}
              </span>
            </div>
          </section>

          <section className="settings-section">
            <div className="stats-chart-head">
              <div>
                <h3>{t('stats.activityTitle')}</h3>
                <p className="muted sm">{t('stats.activityLead')}</p>
              </div>
              <label className="stats-window">
                <span className="muted sm">{t('stats.window')}</span>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      {t('stats.daysOption', { count: w })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ActivityChart stats={stats} />
          </section>

          <section className="settings-section">
            <h3>{t('stats.authors')}</h3>
            <p className="muted sm">{t('stats.authorsLead')}</p>
            {stats.users.length === 0 ? (
              <p className="muted sm">{t('stats.noChanges')}</p>
            ) : (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>{t('stats.author')}</th>
                      <th className="num">{t('stats.lastNDays', { count: stats.windowDays })}</th>
                      <th className="num">{t('stats.allTime')}</th>
                      <th className="num">{t('stats.pagesTouched')}</th>
                      <th>{t('stats.lastActive')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.users.map((u) => (
                      <tr key={u.userId ?? `anon:${u.name}`}>
                        <td>
                          {u.name}
                          {u.userId === null && (
                            <span className="muted sm"> {t('stats.noAccount')}</span>
                          )}
                        </td>
                        <td className="num">{formatInt(u.changesInWindow)}</td>
                        <td className="num">{formatInt(u.changes)}</td>
                        <td className="num">{formatInt(u.pagesTouched)}</td>
                        <td className="muted sm">{formatWhen(u.lastActiveAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="muted sm stats-generated">
            {t('stats.snapshot', { when: formatWhen(stats.generatedAt) })}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * Grouped bars, one pair per day, zero-filled by the server so quiet days keep
 * their slot. Plain divs rather than a chart library: two series and a hover
 * tooltip do not justify a dependency.
 */
function ActivityChart({ stats }: { stats: InstanceStats }) {
  const { t } = useI18n()
  const [hover, setHover] = useState<number | null>(null)
  const days = stats.activity
  const max = Math.max(1, ...days.map((d) => Math.max(d.created, d.updated)))
  const hovered = hover !== null ? days[hover] : null

  return (
    <div>
      <div className="stats-legend" aria-hidden>
        <span className="stats-legend-item">
          <span className="stats-swatch created" /> {t('stats.created')}
        </span>
        <span className="stats-legend-item">
          <span className="stats-swatch updated" /> {t('stats.updated')}
        </span>
        <span className="muted sm stats-legend-max">
          {t('stats.maxPerDay', { count: formatInt(max) })}
        </span>
      </div>
      <div className="stats-chart" role="img" aria-label={t('stats.chartAria')}>
        {hovered && hover !== null && (
          <div
            className="stats-tooltip"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
          >
            <strong>{formatDay(hovered.day)}</strong>
            <span>
              <span className="stats-swatch created" />{' '}
              {t('stats.createdCount', { count: formatInt(hovered.created) })}
            </span>
            <span>
              <span className="stats-swatch updated" />{' '}
              {t('stats.updatedCount', { count: formatInt(hovered.updated) })}
            </span>
          </div>
        )}
        {days.map((d, i) => (
          <div
            key={d.day}
            className={`stats-day ${hover === i ? 'hover' : ''}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          >
            <div className="stats-bars">
              <div
                className="stats-bar created"
                style={{ height: `${(d.created / max) * 100}%` }}
              />
              <div
                className="stats-bar updated"
                style={{ height: `${(d.updated / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="stats-axis muted sm" aria-hidden>
        <span>{formatDay(days[0].day)}</span>
        <span>{formatDay(days[Math.floor(days.length / 2)].day)}</span>
        <span>{formatDay(days[days.length - 1].day)}</span>
      </div>
    </div>
  )
}
