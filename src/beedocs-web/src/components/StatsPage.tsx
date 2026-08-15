import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
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

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInt(n)} ${n === 1 ? singular : pluralForm}`
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
        <h1>Statistics</h1>
        <p className="muted">What this instance holds, and who has been writing to it.</p>
      </header>

      {blocked ? (
        <section className="settings-section">
          <p className="muted sm">
            Only an admin can see instance statistics — the activity list names who works on what.
            Per-book numbers are on each book&apos;s <Link to="/">overview page</Link>.
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
          <p className="muted sm">Loading statistics…</p>
        </section>
      ) : (
        <>
          <section className="settings-section stats-tiles" aria-label="Totals">
            <div className="stats-tile">
              <span className="stats-tile-value">{formatInt(stats.documents.total)}</span>
              <span className="stats-tile-label">Documents</span>
              <span className="stats-tile-detail muted sm">
                {plural(stats.documents.pages, 'page')} · {plural(stats.documents.diagrams, 'diagram')} ·{' '}
                {plural(stats.documents.slideDecks, 'slide deck')}
              </span>
              <span className="stats-tile-detail muted sm">
                in {plural(stats.documents.books, 'book')}
                {stats.documents.shelves > 0 &&
                  ` on ${plural(stats.documents.shelves, 'shelf', 'shelves')}`}
              </span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.contentBytes)}</span>
              <span className="stats-tile-label">Document content</span>
              <span className="stats-tile-detail muted sm">
                + {formatBytes(stats.storage.revisionBytes)} of page history
              </span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.databaseBytes)}</span>
              <span className="stats-tile-label">Database on disk</span>
              <span className="stats-tile-detail muted sm">SQLite file incl. WAL</span>
            </div>
            <div className="stats-tile">
              <span className="stats-tile-value">{formatBytes(stats.storage.uploadsBytes)}</span>
              <span className="stats-tile-label">Uploads</span>
              <span className="stats-tile-detail muted sm">Images and attached files</span>
            </div>
          </section>

          <section className="settings-section">
            <div className="stats-chart-head">
              <div>
                <h3>Activity per day</h3>
                <p className="muted sm">
                  New documents, and documents changed — one count per page per editing sitting.
                </p>
              </div>
              <label className="stats-window">
                <span className="muted sm">Window</span>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      {w} days
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ActivityChart stats={stats} />
          </section>

          <section className="settings-section">
            <h3>Authors</h3>
            <p className="muted sm">
              From the page change log. A change is an editing sitting — rapid auto-saves count
              once. Diagram and slide edits keep no log yet, so they are not listed here.
            </p>
            {stats.users.length === 0 ? (
              <p className="muted sm">No page changes recorded yet.</p>
            ) : (
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>Author</th>
                      <th className="num">Last {stats.windowDays} days</th>
                      <th className="num">All time</th>
                      <th className="num">Pages touched</th>
                      <th>Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.users.map((u) => (
                      <tr key={u.userId ?? `anon:${u.name}`}>
                        <td>
                          {u.name}
                          {u.userId === null && (
                            <span className="muted sm"> (no account)</span>
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
            Snapshot taken {formatWhen(stats.generatedAt)} · days are UTC
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
  const [hover, setHover] = useState<number | null>(null)
  const days = stats.activity
  const max = Math.max(1, ...days.map((d) => Math.max(d.created, d.updated)))
  const hovered = hover !== null ? days[hover] : null

  return (
    <div>
      <div className="stats-legend" aria-hidden>
        <span className="stats-legend-item">
          <span className="stats-swatch created" /> Created
        </span>
        <span className="stats-legend-item">
          <span className="stats-swatch updated" /> Updated
        </span>
        <span className="muted sm stats-legend-max">max {formatInt(max)}/day</span>
      </div>
      <div className="stats-chart" role="img" aria-label="Documents created and updated per day">
        {hovered && hover !== null && (
          <div
            className="stats-tooltip"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
          >
            <strong>{formatDay(hovered.day)}</strong>
            <span>
              <span className="stats-swatch created" /> {formatInt(hovered.created)} created
            </span>
            <span>
              <span className="stats-swatch updated" /> {formatInt(hovered.updated)} updated
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
