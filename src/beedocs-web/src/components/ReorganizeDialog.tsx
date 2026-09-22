import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import { useWorkspace } from '../workspace/WorkspaceContext'
import type {
  ReorgJob,
  ReorgPagePlan,
  ReorgProposal,
  ReorgRemoval,
  ReorgScope,
  ReorgSnapshot,
  ReorgStatus,
} from '../types'
import '../styles/reorganize.css'

const ACTIVE: ReorgStatus[] = ['queued', 'analyzing', 'applying']
const POLL_MS = 2000

type Selection = { items: Set<string>; removals: Set<string>; renames: Set<string> }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** A proposed page that changes nothing needs no tick — it only keeps its place in the order. */
function isNoop(p: ReorgPagePlan): boolean {
  return p.action === 'keep' && !p.moved && !p.renamed
}

function allItems(proposal: ReorgProposal): ReorgPagePlan[] {
  return proposal.books.flatMap((b) => b.folders.flatMap((f) => f.pages))
}

/** Everything ticked: the proposal is the AI's whole suggestion; the person trims it. */
function fullSelection(proposal: ReorgProposal): Selection {
  return {
    items: new Set(allItems(proposal).filter((p) => !isNoop(p)).map((p) => p.id)),
    removals: new Set(proposal.removals.map((r) => r.id)),
    renames: new Set(proposal.books.filter((b) => b.newTitle).map((b) => b.bookId)),
  }
}

/**
 * "Reorganise with AI" for a book or a shelf. The configured AI provider
 * studies every page and proposes a cleaner structure; the person reviews it
 * side by side with the current one, unticks what they disagree with, and
 * applies the rest. Both steps run on the server (ReorganizeService) and this
 * dialog polls — closing it mid-run loses nothing, reopening picks the job up.
 */
export function ReorganizeDialog({
  scope,
  scopeId,
  title,
  onClose,
}: {
  scope: ReorgScope
  scopeId: string
  title: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { refreshTree } = useWorkspace()
  const [job, setJob] = useState<ReorgJob | null>(null)
  const [earlier, setEarlier] = useState<ReorgJob[]>([])
  const [loading, setLoading] = useState(true)
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState<Selection>({ items: new Set(), removals: new Set(), renames: new Set() })
  const [now, setNow] = useState(() => Date.now())
  /** Apply was clicked once — the footer asks to confirm in place. */
  const [confirming, setConfirming] = useState(false)

  const running = job != null && ACTIVE.includes(job.status)

  // Through a ref, so `adopt` stays stable and the load effect runs once.
  const refreshRef = useRef(refreshTree)
  useEffect(() => {
    refreshRef.current = refreshTree
  }, [refreshTree])

  /** Take a fresh job row; a proposal arriving resets the ticks, an apply finishing reloads the tree. */
  const adopt = useCallback(
    (next: ReorgJob, prev: ReorgJob | null) => {
      setJob(next)
      if (next.status === 'proposed' && next.proposal && (prev?.id !== next.id || prev.status !== 'proposed'))
        setSel(fullSelection(next.proposal))
      if (next.status !== prev?.status && (next.status === 'applied' || (prev?.status === 'applying' && next.status === 'failed')))
        void refreshRef.current()
    },
    [],
  )

  // Pick up where the last visit left off: a run in progress or an unapplied proposal.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const jobs = await api.listReorgJobs(scope, scopeId)
        if (cancelled) return
        setEarlier(jobs)
        const resume = jobs.find((j) => ACTIVE.includes(j.status) || j.status === 'proposed')
        if (resume) adopt(await api.getReorgJob(resume.id), null)
      } catch (e) {
        if (!cancelled) setError(errText(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope, scopeId, adopt])

  // Poll while the server works.
  useEffect(() => {
    if (!job || !running) return
    const ctrl = new AbortController()
    const timer = setInterval(() => {
      setNow(Date.now())
      api
        .getReorgJob(job.id, ctrl.signal)
        .then((next) => adopt(next, job))
        .catch(() => {
          /* transient — the next tick retries */
        })
    }, POLL_MS)
    return () => {
      clearInterval(timer)
      ctrl.abort()
    }
  }, [job, running, adopt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Esc backs out of the confirmation first, then closes the dialog.
      if (confirming) setConfirming(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, confirming])

  const analyse = async () => {
    setBusy(true)
    setError(null)
    try {
      adopt(await api.startReorg({ scope, scopeId, instructions: instructions.trim() || undefined }), null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const selectedCount = sel.items.size + sel.removals.size + sel.renames.size

  const apply = async () => {
    if (!job) return
    setConfirming(false)
    setBusy(true)
    setError(null)
    try {
      adopt(
        await api.applyReorg(job.id, {
          items: [...sel.items],
          removals: [...sel.removals],
          renameBooks: [...sel.renames],
        }),
        job,
      )
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  /** Discard a proposal, or cancel a run — the job row goes either way. */
  const discard = async () => {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteReorgJob(job.id)
      setEarlier((list) => list.filter((j) => j.id !== job.id))
      setJob(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const openScope = () => {
    onClose()
    void navigate(scope === 'book' ? `/books/${scopeId}` : `/shelves/${scopeId}`)
  }

  const elapsed = job?.startedAt ?? job?.createdAt
  const seconds = elapsed ? Math.max(0, Math.round((now - Date.parse(elapsed)) / 1000)) : 0
  const tokens = (job?.promptTokens ?? 0) + (job?.completionTokens ?? 0)

  return (
    <div className="reorg-overlay" role="presentation" onMouseDown={() => !busy && onClose()}>
      <div
        className="reorg-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('reorg.title')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="reorg-head">
          <h3>
            ✨ {t('reorg.title')} — {title}
          </h3>
          {job && <span className={`reorg-status is-${job.status}`}>{t(`reorg.status.${job.status}` as MessageKey)}</span>}
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </header>

        <div className="reorg-body">
          {error && <div className="banner error compact">{error}</div>}

          {loading ? (
            <p className="muted">…</p>
          ) : !job ? (
            <Setup
              t={t}
              title={title}
              instructions={instructions}
              setInstructions={setInstructions}
              earlier={earlier}
              onOpen={async (id) => {
                try {
                  adopt(await api.getReorgJob(id), null)
                } catch (e) {
                  setError(errText(e))
                }
              }}
            />
          ) : running ? (
            <div className="reorg-running">
              <div className="reorg-spinner" aria-hidden="true" />
              <div>
                <p>
                  <strong>{job.progress || t(`reorg.status.${job.status}` as MessageKey)}</strong>{' '}
                  <span className="muted">· {seconds}s</span>
                </p>
                <p className="muted sm">{t('reorg.runningHint')}</p>
                {job.log && job.log.length > 0 && <LogList t={t} job={job} onNavigate={onClose} />}
              </div>
            </div>
          ) : job.status === 'proposed' && job.proposal ? (
            <ProposalView t={t} job={job} proposal={job.proposal} sel={sel} setSel={setSel} />
          ) : (
            <div className="reorg-result">
              {job.status === 'applied' ? (
                <p className="reorg-done">✓ {t('reorg.done')}</p>
              ) : (
                <>
                  {job.error && <div className="banner error">{job.error}</div>}
                  {job.log && job.log.length > 0 && <p className="muted sm">{t('reorg.partial')}</p>}
                </>
              )}
              {job.log && job.log.length > 0 && <LogList t={t} job={job} onNavigate={onClose} />}
            </div>
          )}
        </div>

        <footer className="reorg-foot">
          {job?.providerName && (
            <span className="muted sm reorg-usage">
              {t('reorg.usage', { provider: job.providerName, model: job.model ?? '—', tokens: tokens.toLocaleString() })}
            </span>
          )}
          <span className="reorg-foot-spacer" />
          {!loading && !job && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void analyse()}>
              {t('reorg.analyse')}
            </button>
          )}
          {running && job.status !== 'applying' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void discard()}>
              {t('common.cancel')}
            </button>
          )}
          {job?.status === 'proposed' && confirming && (
            <div className="reorg-confirm" role="alertdialog" aria-label={t('reorg.title')}>
              <span className="reorg-confirm-text">
                {t('reorg.applyConfirm', { n: selectedCount, title })}
              </span>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                autoFocus
                disabled={busy || selectedCount === 0}
                onClick={() => void apply()}
              >
                {t('reorg.confirmApply')}
              </button>
            </div>
          )}
          {job?.status === 'proposed' && !confirming && (
            <>
              <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void discard()}>
                {t('reorg.discard')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || selectedCount === 0}
                onClick={() => setConfirming(true)}
              >
                {t('reorg.apply', { n: selectedCount })}
              </button>
            </>
          )}
          {(job?.status === 'applied' || job?.status === 'failed') && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setJob(null)}>
                {t('reorg.startOver')}
              </button>
              <button type="button" className="btn primary" onClick={openScope}>
                {scope === 'book' ? t('reorg.openBook') : t('reorg.openShelf')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

function Setup({
  t,
  title,
  instructions,
  setInstructions,
  earlier,
  onOpen,
}: {
  t: TFunction
  title: string
  instructions: string
  setInstructions: (v: string) => void
  earlier: ReorgJob[]
  onOpen: (id: string) => void
}) {
  return (
    <div className="reorg-setup">
      <p>{t('reorg.intro', { title })}</p>
      <p className="muted sm">🛟 {t('reorg.safety')}</p>
      <label className="reorg-field">
        <span>{t('reorg.instructions')}</span>
        <textarea
          rows={3}
          value={instructions}
          placeholder={t('reorg.instructionsPlaceholder')}
          autoFocus
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {earlier.length > 0 && (
        <div className="reorg-earlier">
          <div className="reorg-section-label">{t('reorg.earlier')}</div>
          {earlier.slice(0, 5).map((j) => (
            <button key={j.id} type="button" className="reorg-earlier-row" onClick={() => onOpen(j.id)}>
              <span className={`reorg-status is-${j.status}`}>{t(`reorg.status.${j.status}` as MessageKey)}</span>
              <span className="muted sm">
                {new Date(j.createdAt).toLocaleString()}
                {j.createdByName ? ` · ${j.createdByName}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type Marker = 'move' | 'rename' | 'merge' | 'rewrite' | 'archive' | 'private'

/** How each current page is affected by the *ticked* parts of the proposal. */
function markersFor(proposal: ReorgProposal, sel: Selection): Map<string, Marker> {
  const m = new Map<string, Marker>()
  for (const item of allItems(proposal)) {
    if (!sel.items.has(item.id)) continue
    item.sources.forEach((s, i) => {
      if (i > 0) m.set(s.pageId, 'archive')
      else if (item.action === 'merge') m.set(s.pageId, 'merge')
      else if (item.action === 'rewrite') m.set(s.pageId, 'rewrite')
      else if (item.moved) m.set(s.pageId, 'move')
      else if (item.renamed) m.set(s.pageId, 'rename')
    })
  }
  for (const r of proposal.removals) if (sel.removals.has(r.id)) m.set(r.page.pageId, 'archive')
  return m
}

function ProposalView({
  t,
  job,
  proposal,
  sel,
  setSel,
}: {
  t: TFunction
  job: ReorgJob
  proposal: ReorgProposal
  sel: Selection
  setSel: (s: Selection) => void
}) {
  const items = allItems(proposal)
  const changeable = items.filter((p) => !isNoop(p))
  const markers = useMemo(() => markersFor(proposal, sel), [proposal, sel])
  const itemTitle = (id: string | null) => items.find((p) => p.id === id)?.title
  const stats = {
    moves: changeable.filter((p) => p.action === 'keep').length,
    merges: changeable.filter((p) => p.action === 'merge').length,
    rewrites: changeable.filter((p) => p.action === 'rewrite').length,
    archives:
      proposal.removals.length + changeable.reduce((n, p) => n + (p.action === 'merge' ? p.sources.length - 1 : 0), 0),
  }

  const toggle = (key: keyof Selection, id: string) => {
    const next = new Set(sel[key])
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSel({ ...sel, [key]: next })
  }

  if (changeable.length === 0 && proposal.removals.length === 0 && !proposal.books.some((b) => b.newTitle)) {
    return (
      <div className="reorg-proposal">
        {proposal.summary && <p className="reorg-summary">{proposal.summary}</p>}
        <p className="muted">{t('reorg.nothing')}</p>
      </div>
    )
  }

  return (
    <div className="reorg-proposal">
      <section className="reorg-summary-box">
        <div className="reorg-section-label">{t('reorg.summary')}</div>
        {proposal.summary && <p className="reorg-summary">{proposal.summary}</p>}
        <div className="reorg-stats muted sm">
          <span>{t('reorg.stats', stats)}</span>
          <span className="reorg-foot-spacer" />
          <button type="button" className="btn ghost sm" onClick={() => setSel(fullSelection(proposal))}>
            {t('reorg.selectAll')}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setSel({ items: new Set(), removals: new Set(), renames: new Set() })}
          >
            {t('reorg.selectNone')}
          </button>
        </div>
      </section>

      <div className="reorg-columns">
        <section className="reorg-col reorg-col--now">
          <div className="reorg-section-label">{t('reorg.now')}</div>
          {job.current && <CurrentTree t={t} snapshot={job.current} markers={markers} />}
        </section>

        <section className="reorg-col reorg-col--proposed">
          <div className="reorg-section-label">{t('reorg.proposed')}</div>
          {proposal.books.map((book) => (
            <div key={book.bookId} className="reorg-book">
              <div className="reorg-book-title">📘 {book.newTitle && sel.renames.has(book.bookId) ? book.newTitle : book.currentTitle}</div>
              {book.newTitle && (
                <label className="reorg-item reorg-item--rename">
                  <input
                    type="checkbox"
                    checked={sel.renames.has(book.bookId)}
                    onChange={() => toggle('renames', book.bookId)}
                  />
                  <span className="reorg-badge is-rename">{t('reorg.badge.rename')}</span>
                  <span>{t('reorg.renameBook', { title: book.newTitle })}</span>
                </label>
              )}
              {book.folders.map((folder, fi) => (
                <div key={`${folder.title ?? ''}-${fi}`} className="reorg-folder">
                  <div className="reorg-folder-title">
                    {folder.title === null ? (
                      <span className="muted">{t('reorg.topLevel')}</span>
                    ) : (
                      <>
                        📁 {folder.title}
                        {!folder.exists && <span className="reorg-new"> · {t('reorg.newFolder')}</span>}
                      </>
                    )}
                  </div>
                  {folder.pages.map((item) => (
                    <PlanItem
                      key={item.id}
                      t={t}
                      item={item}
                      checked={sel.items.has(item.id)}
                      onToggle={() => toggle('items', item.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}

          {proposal.removals.length > 0 && (
            <div className="reorg-book">
              <div className="reorg-book-title">🗄 {t('reorg.removals')}</div>
              {proposal.removals.map((r) => (
                <RemovalItem
                  key={r.id}
                  t={t}
                  removal={r}
                  duplicateTitle={itemTitle(r.duplicateOf)}
                  checked={sel.removals.has(r.id)}
                  onToggle={() => toggle('removals', r.id)}
                />
              ))}
            </div>
          )}

          {proposal.untouched.length > 0 && (
            <details className="reorg-untouched">
              <summary className="muted sm">{t('reorg.untouched', { n: proposal.untouched.length })}</summary>
              <ul>
                {proposal.untouched.map((s) => (
                  <li key={s.pageId} className="muted sm">
                    {s.title}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </div>
  )
}

function badgesFor(item: ReorgPagePlan): ('merge' | 'rewrite' | 'move' | 'rename' | 'keep')[] {
  const out: ('merge' | 'rewrite' | 'move' | 'rename' | 'keep')[] = []
  if (item.action === 'merge') out.push('merge')
  if (item.action === 'rewrite') out.push('rewrite')
  if (item.moved) out.push('move')
  if (item.renamed) out.push('rename')
  return out.length ? out : ['keep']
}

function PlanItem({
  t,
  item,
  checked,
  onToggle,
}: {
  t: TFunction
  item: ReorgPagePlan
  checked: boolean
  onToggle: () => void
}) {
  const noop = isNoop(item)
  const showSources = item.sources.length > 1 || item.renamed
  return (
    <label className={`reorg-item${noop ? ' is-noop' : ''}${!noop && !checked ? ' is-off' : ''}`}>
      {noop ? <span className="reorg-check-spacer" /> : <input type="checkbox" checked={checked} onChange={onToggle} />}
      <span className="reorg-item-main">
        <span className="reorg-item-title">
          {badgesFor(item).map((b) => (
            <span key={b} className={`reorg-badge is-${b}`}>
              {t(`reorg.badge.${b}` as MessageKey)}
            </span>
          ))}{' '}
          📄 {item.title}
        </span>
        {showSources && (
          <span className="reorg-item-from muted sm">
            {t('reorg.from')}{' '}
            {item.sources.map((s, i) => (
              <span key={s.pageId}>
                {i > 0 && ' + '}“{s.title}”<span className="reorg-words"> ({t('reorg.words', { n: s.words })})</span>
              </span>
            ))}
          </span>
        )}
        {item.reason && !noop && <span className="reorg-item-reason sm">{item.reason}</span>}
      </span>
    </label>
  )
}

function RemovalItem({
  t,
  removal,
  duplicateTitle,
  checked,
  onToggle,
}: {
  t: TFunction
  removal: ReorgRemoval
  duplicateTitle: string | undefined
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className={`reorg-item${checked ? '' : ' is-off'}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="reorg-item-main">
        <span className="reorg-item-title">
          <span className="reorg-badge is-archive">{t('reorg.badge.archive')}</span> 📄 {removal.page.title}
        </span>
        {duplicateTitle && (
          <span className="reorg-item-from muted sm">{t('reorg.duplicateOf', { title: duplicateTitle })}</span>
        )}
        {removal.reason && <span className="reorg-item-reason sm">{removal.reason}</span>}
      </span>
    </label>
  )
}

function CurrentTree({ t, snapshot, markers }: { t: TFunction; snapshot: ReorgSnapshot; markers: Map<string, Marker> }) {
  return (
    <>
      {snapshot.books.map((book) => {
        const folders = [...book.folders].sort((a, b) => a.sortOrder - b.sortOrder)
        const pagesIn = (folderId: string | null) =>
          book.pages.filter((p) => p.folderId === folderId).sort((a, b) => a.sortOrder - b.sortOrder)
        const row = (p: ReorgSnapshot['books'][number]['pages'][number]) => {
          const marker: Marker | undefined = p.excluded ? 'private' : markers.get(p.id)
          return (
            <div key={p.id} className={`reorg-now-page${marker ? ` is-${marker}` : ''}`}>
              📄 {p.title}
              {marker && (
                <span className={`reorg-badge is-${marker}`}>{t(`reorg.badge.${marker}` as MessageKey)}</span>
              )}
            </div>
          )
        }
        return (
          <div key={book.id} className="reorg-book">
            <div className="reorg-book-title">📘 {book.title}</div>
            <div className="reorg-folder">{pagesIn(null).map(row)}</div>
            {folders.map((f) => (
              <div key={f.id} className="reorg-folder">
                <div className="reorg-folder-title">📁 {f.title}</div>
                {pagesIn(f.id).map(row)}
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

function LogList({ t, job, onNavigate }: { t: TFunction; job: ReorgJob; onNavigate: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="reorg-log">
      <div className="reorg-section-label">{t('reorg.log')}</div>
      <ul>
        {(job.log ?? []).map((entry, i) => (
          <li key={i} className={`reorg-log-row is-${entry.status}`}>
            <span className="reorg-log-icon" aria-hidden="true">
              {entry.status === 'ok' ? '✓' : entry.status === 'skipped' ? '–' : '✕'}
            </span>
            <span>{entry.message}</span>
            {entry.pageId && entry.bookId && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  onNavigate()
                  void navigate(`/books/${entry.bookId}/pages/${entry.pageId}`)
                }}
              >
                {t('common.open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
