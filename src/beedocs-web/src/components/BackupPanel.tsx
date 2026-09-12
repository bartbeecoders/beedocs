import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import type { BackupArchive, BackupRun, BackupSettings, BackupStatus } from '../types'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** The schedule select's fixed choices; anything else stored shows as its hour count. */
const SCHEDULES = [0, 6, 12, 24, 168] as const

/**
 * Settings → Backup. Configuration (targets, schedule, retention, contents)
 * lives server-side; a backup is a background run the panel polls, and a
 * restore additionally raises the maintenance gate — every other API call
 * answers 503 until it drops, which is why the panel keeps polling the one
 * endpoint that still answers and tells the admin to reload when it is done.
 */
export function BackupPanel() {
  const { t } = useI18n()
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Settings draft, seeded from the server answer.
  const [draft, setDraft] = useState<BackupSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const [starting, setStarting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Restore from a provider.
  const [archiveProvider, setArchiveProvider] = useState('')
  const [archives, setArchives] = useState<BackupArchive[] | null>(null)
  const [listing, setListing] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [archiveBusy, setArchiveBusy] = useState<string | null>(null)

  // Restore from a file.
  const [file, setFile] = useState<File | null>(null)
  const [confirmFile, setConfirmFile] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Set once a restore this panel watched has finished — the library on
  // screen is the old one until the page reloads.
  const [restoreDone, setRestoreDone] = useState(false)
  const sawRestore = useRef(false)
  const flashTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.getBackupStatus()
      setStatus(next)
      setLoadError(null)
      setDraft((d) => d ?? next.settings)
      if (next.current?.kind === 'restore' || next.restoring) sawRestore.current = true
      else if (sawRestore.current) {
        sawRestore.current = false
        setRestoreDone(true)
      }
    } catch (e) {
      setLoadError(errText(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Poll while something runs. 2 s is quick enough to feel live and slow
  // enough not to matter during a multi-minute upload.
  const busy = status?.current !== null && status?.current !== undefined
  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(id)
  }, [busy, refresh])

  useEffect(() => () => window.clearTimeout(flashTimer.current ?? undefined), [])

  const flashSaved = () => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current ?? undefined)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2400)
  }

  const editDraft = (patch: Partial<BackupSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const toggleProvider = (id: string, on: boolean) =>
    setDraft((d) => {
      if (!d) return d
      const ids = d.providerIds.filter((x) => x !== id)
      return { ...d, providerIds: on ? [...ids, id] : ids }
    })

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await api.updateBackupSettings(draft)
      setDraft(saved)
      setStatus((s) => (s ? { ...s, settings: saved } : s))
      await refresh()
      flashSaved()
    } catch (e) {
      setSaveError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async () => {
    setStarting(true)
    setActionError(null)
    try {
      await api.runBackup()
      await refresh()
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setStarting(false)
    }
  }

  const listArchives = async (providerId: string) => {
    setListing(true)
    setListError(null)
    setArchives(null)
    setConfirmRestore(null)
    setConfirmDelete(null)
    try {
      setArchives(await api.listBackupArchives(providerId))
    } catch (e) {
      setListError(errText(e))
    } finally {
      setListing(false)
    }
  }

  const restoreArchive = async (key: string) => {
    setArchiveBusy(key)
    setActionError(null)
    try {
      await api.restoreBackup(archiveProvider, key)
      setConfirmRestore(null)
      await refresh()
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setArchiveBusy(null)
    }
  }

  const deleteArchive = async (key: string) => {
    setArchiveBusy(key)
    setActionError(null)
    try {
      await api.deleteBackupArchive(archiveProvider, key)
      setArchives((list) => (list ?? []).filter((a) => a.key !== key))
      setConfirmDelete(null)
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setArchiveBusy(null)
    }
  }

  const restoreFile = async () => {
    if (!file) return
    setUploading(true)
    setActionError(null)
    try {
      await api.restoreBackupFromFile(file)
      setConfirmFile(false)
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      await refresh()
    } catch (e) {
      setActionError(errText(e))
    } finally {
      setUploading(false)
    }
  }

  const runLabel = (run: BackupRun) => {
    const bits = [t(`backup.kind.${run.kind}` as MessageKey), t(`backup.trigger.${run.trigger}` as MessageKey)]
    if (run.startedBy) bits.push(t('backup.by', { name: run.startedBy }))
    return bits.join(' · ')
  }

  const providerName = (id: string) => status?.providers.find((p) => p.id === id)?.name ?? id
  const archiveName = (key: string) => key.slice(key.lastIndexOf('/') + 1)

  if (loadError && !status) {
    return (
      <p className="banner error llm-load-error">
        <span>{loadError}</span>
        <button type="button" className="btn sm" onClick={() => void refresh()}>
          {t('common.retry')}
        </button>
      </p>
    )
  }
  if (!status || !draft) {
    return (
      <div className="llm-list" aria-busy="true">
        <div className="llm-skeleton" />
      </div>
    )
  }

  const current = status.current
  const disabled = busy || saving
  const readyTargets = draft.providerIds.filter((id) => status.providers.find((p) => p.id === id)?.ready)
  // A backup runs against the *saved* settings, so unsaved edits must be saved
  // first — same rule as the provider panels' Test button.
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings)

  return (
    <div className="backup-panel">
      <p className="llm-intro">{t('backup.intro')}</p>

      {restoreDone ? (
        <p className="banner warn backup-banner">
          <span>{t('backup.restoreDone')}</span>
          <button type="button" className="btn sm primary" onClick={() => window.location.reload()}>
            {t('backup.reload')}
          </button>
        </p>
      ) : null}

      {current ? (
        <p className="banner backup-banner backup-running" role="status">
          <span className="llm-spinner" aria-hidden />
          <span>
            {current.kind === 'restore' ? t('backup.restoring') : t('backup.running')}
            {current.targets.length > 0
              ? ` ${current.targets.filter((x) => x.ok).length}/${current.targets.length}`
              : ''}
          </span>
        </p>
      ) : null}

      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      {/* ── Targets ── */}
      <h3 className="backup-h">{t('backup.targets')}</h3>
      {status.providers.length === 0 ? (
        <p className="muted sm">
          {t('backup.noProviders')} <Link to="/settings/storage">{t('settings.tab.storage')}</Link>
        </p>
      ) : (
        <div className="backup-targets">
          {status.providers.map((p) => (
            <label key={p.id} className="check-row">
              <input
                type="checkbox"
                checked={draft.providerIds.includes(p.id)}
                disabled={disabled}
                onChange={(e) => toggleProvider(p.id, e.target.checked)}
              />
              <span>
                {p.name}
                {!p.ready ? <span className="llm-badge is-warn backup-badge">{t('backup.targetNotReady')}</span> : null}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* ── Schedule & retention ── */}
      <div className="users-form backup-form">
        <label className="users-field">
          <span>{t('backup.schedule')}</span>
          <select
            value={SCHEDULES.includes(draft.scheduleHours as (typeof SCHEDULES)[number]) ? draft.scheduleHours : 'custom'}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value !== 'custom') editDraft({ scheduleHours: Number(e.target.value) })
            }}
          >
            <option value={0}>{t('backup.schedule.manual')}</option>
            <option value={6}>{t('backup.schedule.hours', { count: 6 })}</option>
            <option value={12}>{t('backup.schedule.hours', { count: 12 })}</option>
            <option value={24}>{t('backup.schedule.daily')}</option>
            <option value={168}>{t('backup.schedule.weekly')}</option>
            {!SCHEDULES.includes(draft.scheduleHours as (typeof SCHEDULES)[number]) ? (
              <option value="custom">{t('backup.schedule.hours', { count: draft.scheduleHours })}</option>
            ) : null}
          </select>
        </label>
        <label className="users-field">
          <span>{t('backup.keepLast')}</span>
          <span className="backup-inline">
            <input
              type="number"
              min={0}
              max={1000}
              value={draft.keepLast}
              disabled={disabled}
              onChange={(e) => editDraft({ keepLast: Math.max(0, Number(e.target.value) || 0) })}
              style={{ width: '6rem' }}
            />
            <span className="muted sm">{t('backup.keepLastUnit')}</span>
          </span>
          <span className="muted sm">{t('backup.keepLastHint')}</span>
        </label>

        <p className="backup-sub">{t('backup.contents')}</p>
        <label className="check-row">
          <input type="checkbox" checked disabled />
          <span>{t('backup.includeDatabase')}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.includeUploads}
            disabled={disabled}
            onChange={(e) => editDraft({ includeUploads: e.target.checked })}
          />
          <span>{t('backup.includeUploads')}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.includeAttachments}
            disabled={disabled}
            onChange={(e) => editDraft({ includeAttachments: e.target.checked })}
          />
          <span>{t('backup.includeAttachments')}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.includeBranding}
            disabled={disabled}
            onChange={(e) => editDraft({ includeBranding: e.target.checked })}
          />
          <span>{t('backup.includeBranding')}</span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.includeOffloaded}
            disabled={disabled}
            onChange={(e) => editDraft({ includeOffloaded: e.target.checked })}
          />
          <span>{t('backup.includeOffloaded')}</span>
        </label>
        <p className="muted sm">{t('backup.gitNote')}</p>
      </div>

      {saveError ? (
        <p className="banner error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="users-form-actions backup-actions">
        <button type="button" className="btn sm primary" disabled={disabled} onClick={() => void save()}>
          {saving ? t('common.saving') : t('backup.save')}
        </button>
        <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
          {savedFlash ? t('common.saved') : ''}
        </span>
        <span className="backup-actions-side">
          <button
            type="button"
            className="btn sm"
            disabled={disabled || starting || readyTargets.length === 0 || dirty}
            title={
              dirty
                ? t('providers.saveFirstHint')
                : readyTargets.length === 0
                  ? t('backup.runNeedsTarget')
                  : undefined
            }
            onClick={() => void runNow()}
          >
            {starting ? t('backup.starting') : t('backup.runNow')}
          </button>
          <a
            className={`btn sm${busy ? ' is-disabled' : ''}`}
            href={busy ? undefined : api.backupExportUrl()}
            aria-disabled={busy}
            title={t('backup.downloadHint')}
            download
          >
            {t('backup.download')}
          </a>
        </span>
      </div>
      {status.nextScheduledAt ? (
        <p className="muted sm">{t('backup.nextScheduled', { when: formatWhen(status.nextScheduledAt) })}</p>
      ) : null}

      {/* ── Restore ── */}
      <h3 className="backup-h">{t('backup.restoreTitle')}</h3>
      <p className="muted sm">{t('backup.restoreIntro')}</p>

      <div className="backup-restore">
        <div className="backup-restore-row">
          <label className="users-field">
            <span>{t('backup.restoreFrom')}</span>
            <select
              value={archiveProvider}
              disabled={busy || listing}
              onChange={(e) => {
                setArchiveProvider(e.target.value)
                setArchives(null)
                setListError(null)
                if (e.target.value) void listArchives(e.target.value)
              }}
            >
              <option value="">{t('backup.pickProvider')}</option>
              {status.providers
                .filter((p) => p.ready)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          {archiveProvider ? (
            <button
              type="button"
              className="btn sm"
              disabled={busy || listing}
              onClick={() => void listArchives(archiveProvider)}
            >
              {listing ? t('backup.listing') : t('common.refresh')}
            </button>
          ) : null}
        </div>

        {listError ? (
          <p className="banner error" role="alert">
            {listError}
          </p>
        ) : null}

        {archives !== null ? (
          archives.length === 0 ? (
            <p className="muted sm">{t('backup.noArchives')}</p>
          ) : (
            <ul className="backup-archives">
              {archives.map((a) => (
                <li key={a.key} className="backup-archive">
                  <span className="backup-archive-name">
                    <span className="llm-mono">{archiveName(a.key)}</span>
                    <span className="muted sm">
                      {formatSize(a.size)}
                      {a.lastModified ? ` · ${formatWhen(a.lastModified)}` : ''}
                    </span>
                  </span>
                  <span className="backup-archive-actions">
                    <a className="btn sm ghost" href={api.backupArchiveUrl(archiveProvider, a.key)} download>
                      {t('common.download')}
                    </a>
                    <button
                      type="button"
                      className="btn sm ghost danger"
                      disabled={busy || archiveBusy !== null}
                      onClick={() => {
                        setConfirmRestore(null)
                        setConfirmDelete(a.key)
                      }}
                    >
                      {t('common.delete')}
                    </button>
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={busy || archiveBusy !== null}
                      onClick={() => {
                        setConfirmDelete(null)
                        setConfirmRestore(a.key)
                      }}
                    >
                      {t('backup.restoreThis')}
                    </button>
                  </span>
                  {confirmRestore === a.key ? (
                    <div className="llm-confirm backup-confirm">
                      <span>{t('backup.restoreConfirm', { name: archiveName(a.key) })}</span>
                      <span className="llm-confirm-actions">
                        <button type="button" className="btn" disabled={archiveBusy !== null} onClick={() => setConfirmRestore(null)}>
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          disabled={archiveBusy !== null}
                          onClick={() => void restoreArchive(a.key)}
                        >
                          {archiveBusy === a.key ? t('backup.starting') : t('backup.confirm')}
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {confirmDelete === a.key ? (
                    <div className="llm-confirm backup-confirm">
                      <span>
                        {t('backup.deleteArchiveConfirm', {
                          name: archiveName(a.key),
                          provider: providerName(archiveProvider),
                        })}
                      </span>
                      <span className="llm-confirm-actions">
                        <button type="button" className="btn" disabled={archiveBusy !== null} onClick={() => setConfirmDelete(null)}>
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          disabled={archiveBusy !== null}
                          onClick={() => void deleteArchive(a.key)}
                        >
                          {archiveBusy === a.key ? t('providers.deleting') : t('common.delete')}
                        </button>
                      </span>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}

        <div className="backup-restore-row">
          <label className="users-field">
            <span>{t('backup.restoreFromFile')}</span>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              disabled={busy || uploading}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setConfirmFile(false)
              }}
            />
          </label>
          <button
            type="button"
            className="btn sm"
            disabled={busy || uploading || !file || confirmFile}
            onClick={() => setConfirmFile(true)}
          >
            {t('backup.restoreFile')}
          </button>
        </div>
        {confirmFile && file ? (
          <div className="llm-confirm backup-confirm">
            <span>{t('backup.restoreConfirm', { name: file.name })}</span>
            <span className="llm-confirm-actions">
              <button type="button" className="btn" disabled={uploading} onClick={() => setConfirmFile(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn danger" disabled={uploading} onClick={() => void restoreFile()}>
                {uploading ? t('backup.uploading') : t('backup.confirm')}
              </button>
            </span>
          </div>
        ) : null}
      </div>

      {/* ── History ── */}
      <h3 className="backup-h">{t('backup.history')}</h3>
      {status.runs.length === 0 ? (
        <p className="muted sm">{t('backup.noHistory')}</p>
      ) : (
        <ul className="backup-runs">
          {status.runs.map((run) => (
            <li key={run.id} className={`backup-run is-${run.status}`}>
              <span className="backup-run-head">
                <span className={`llm-badge ${run.status === 'completed' ? 'is-ok' : run.status === 'failed' ? 'is-warn' : ''}`}>
                  {t(`backup.status.${run.status}` as MessageKey)}
                </span>
                <span className="backup-run-label">{runLabel(run)}</span>
                <span className="muted sm">{formatWhen(run.startedAt)}</span>
                {run.sizeBytes !== null ? <span className="muted sm">{formatSize(run.sizeBytes)}</span> : null}
              </span>
              {run.archiveKey ? <span className="llm-mono sm backup-run-key">{archiveName(run.archiveKey)}</span> : null}
              {run.targets.length > 0 ? (
                <ul className="backup-run-targets">
                  {run.targets.map((x) => (
                    <li key={x.providerId} className={x.ok ? 'is-ok' : 'is-fail'}>
                      <span aria-hidden>{x.ok ? '✓' : '✕'}</span> {x.providerName}: {x.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              {run.message ? <span className="muted sm backup-run-msg">{run.message}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
