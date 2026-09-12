import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import type {
  StorageProvider,
  StorageProviderKind,
  StorageTestResult,
  UpdateStorageProviderRequest,
  CreateStorageProviderRequest,
} from '../types'

type KindOption = {
  kind: StorageProviderKind
  /** Product name — a proper noun, never translated. The hint is `providers.kindHint.{kind}`. */
  label: string
}

const KINDS: KindOption[] = [
  { kind: 'azure-blob', label: 'Azure Blob Storage' },
  { kind: 'google-drive', label: 'Google Drive' },
  { kind: 's3', label: 'S3-compatible storage' },
]

const KIND_LABELS: Record<StorageProviderKind, string> = {
  'azure-blob': 'Azure Blob Storage',
  'google-drive': 'Google Drive',
  s3: 'S3-compatible storage',
}

type Draft = {
  name: string
  container: string
  connectionString: string
  clientId: string
  clientSecret: string
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  pathStyle: boolean
  prefix: string
}

const BLANK_DRAFT: Draft = {
  name: '',
  container: '',
  connectionString: '',
  clientId: '',
  clientSecret: '',
  endpoint: '',
  region: '',
  bucket: '',
  accessKey: '',
  secretKey: '',
  pathStyle: true,
  prefix: '',
}

/** The editable, non-secret S3 fields of a stored provider, as draft values. */
function s3Draft(p: StorageProvider): Pick<Draft, 'endpoint' | 'region' | 'bucket' | 'accessKey' | 'pathStyle' | 'prefix'> {
  return {
    endpoint: p.s3Endpoint ?? '',
    region: p.s3Region ?? '',
    bucket: p.s3Bucket ?? '',
    accessKey: p.s3AccessKey ?? '',
    pathStyle: p.s3PathStyle,
    prefix: p.s3Prefix ?? '',
  }
}

/** `request` already unwraps the API's message, so this is only Error → string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isDirty(d: Draft, p: StorageProvider): boolean {
  if (d.connectionString !== '' || d.clientSecret !== '' || d.secretKey !== '' || d.name.trim() !== p.name)
    return true
  switch (p.kind) {
    case 'azure-blob':
      return d.container.trim() !== (p.container ?? '')
    case 'google-drive':
      return d.clientId.trim() !== (p.googleClientId ?? '')
    case 's3': {
      const stored = s3Draft(p)
      return (
        d.endpoint.trim().replace(/\/+$/, '') !== stored.endpoint ||
        d.region.trim().toLowerCase() !== stored.region ||
        d.bucket.trim() !== stored.bucket ||
        d.accessKey.trim() !== stored.accessKey ||
        d.pathStyle !== stored.pathStyle ||
        d.prefix.trim().replace(/^\/+|\/+$/g, '') !== stored.prefix
      )
    }
  }
}

/**
 * A provider a shelf can actually be assigned to. There is no enable switch —
 * "configured or not" is the only state a storage backend has.
 */
function isReady(p: StorageProvider): boolean {
  switch (p.kind) {
    case 'azure-blob':
      return p.hasConnectionString
    case 'google-drive':
      return p.googleConnected
    case 's3':
      return !!p.s3Bucket && !!p.s3AccessKey && p.hasS3SecretKey
  }
}

/**
 * Configure where shelf content is stored. A shelf on the default Local
 * (SQLite) backend needs nothing from here; each provider added becomes an
 * option in the shelf's Storage field in the properties pane.
 *
 * Secrets are write-only, LlmProviders-style: the API answers with has/hint
 * fields and never the value, so the secret boxes start empty on every open and
 * an untouched box must omit the field — sending "" is how a secret is cleared.
 */
export function StorageProviders() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<StorageProvider[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState<StorageProviderKind | null>(null)
  const [setupKind, setSetupKind] = useState<StorageProviderKind | null>(null)
  const [setupDraft, setSetupDraft] = useState<Draft>(BLANK_DRAFT)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Removing a stored secret destroys a value that cannot be read back — same
  // two-step as Delete.
  const [confirmSecretId, setConfirmSecretId] = useState<string | null>(null)
  // seq re-keys the paragraph: role="alert" does not re-announce identical text.
  const [rowError, setRowError] = useState<{ id: string; message: string; seq: number } | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [test, setTest] = useState<{ id: string; result: StorageTestResult } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  // Create bucket shares the test's abort + result slot: both are remote
  // probes whose one message lands under the same buttons.
  const [creatingBucketId, setCreatingBucketId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [focusNew, setFocusNew] = useState<string | null>(null)
  // Which provider a Google consent window is open for.
  const [connectingId, setConnectingId] = useState<string | null>(null)

  const testAbort = useRef<AbortController | null>(null)
  const flashTimer = useRef<number | null>(null)
  const rowErrorSeq = useRef(0)
  // Read after an await, where the openId of that render is already stale.
  const openIdRef = useRef<string | null>(null)
  // Identifies the connect-poll loop; bumping it cancels the loop.
  const connectToken = useRef(0)

  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current ?? undefined)
      testAbort.current?.abort()
      connectToken.current += 1
    },
    [],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setProviders(await api.listStorageProviders())
      setLoadError(null)
      setRowError(null)
    } catch (e) {
      setLoadError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openProvider = useMemo(
    () => (providers ?? []).find((p) => p.id === openId) ?? null,
    [providers, openId],
  )
  const openDirty = openProvider !== null && isDirty(draft, openProvider)
  const openName = openProvider?.name ?? t('providers.thisProvider')

  const kindCounts = useMemo(() => {
    const counts = new Map<StorageProviderKind, number>()
    for (const p of providers ?? []) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
    return counts
  }, [providers])

  const subLine = (p: StorageProvider): string => {
    const parts: string[] = []
    // The server names a new provider after its kind, so repeating the kind
    // would read "Google Drive · Google Drive".
    if (p.name !== KIND_LABELS[p.kind]) parts.push(KIND_LABELS[p.kind])
    if (p.kind === 'azure-blob') {
      parts.push(t('providers.subContainer', { name: p.container ?? 'beedocs' }))
      parts.push(
        p.hasConnectionString
          ? t('providers.subSecretStored', { hint: p.connectionStringHint ?? '' })
          : t('providers.subNoConnString'),
      )
    } else if (p.kind === 's3') {
      parts.push(t('providers.subBucket', { name: p.s3Bucket ?? '—' }))
      parts.push(
        p.hasS3SecretKey
          ? t('providers.subSecretStored', { hint: p.s3SecretKeyHint ?? '' })
          : t('providers.subNoS3Key'),
      )
    } else {
      parts.push(p.googleConnected ? t('providers.subConnected') : t('providers.subNotConnected'))
    }
    parts.push(
      t(p.shelfCount === 1 ? 'providers.shelfCount.one' : 'providers.shelfCount.other', {
        count: p.shelfCount,
      }),
    )
    return parts.join(' · ')
  }

  const replace = (next: StorageProvider) =>
    setProviders((list) => (list ?? []).map((p) => (p.id === next.id ? next : p)))

  const flashSaved = () => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current ?? undefined)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2400)
  }

  const failRow = (id: string, e: unknown) =>
    setRowError({ id, message: errText(e), seq: (rowErrorSeq.current += 1) })

  const clearRowError = (id: string) => setRowError((r) => (r === null || r.id === id ? null : r))

  // Every edit invalidates the last test: a green "Connected" under a
  // connection string the user has since changed is a lie.
  const editDraft = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setTest(null)
  }

  /** Drop anything still in flight for the card being left. */
  const dropCardWork = () => {
    testAbort.current?.abort()
    testAbort.current = null
    setTestingId(null)
    setCreatingBucketId(null)
    setTest(null)
    connectToken.current += 1
    setConnectingId(null)
  }

  const reveal = (p: StorageProvider) => {
    dropCardWork()
    openIdRef.current = p.id
    setOpenId(p.id)
    setDraft({
      ...BLANK_DRAFT,
      ...s3Draft(p),
      name: p.name,
      container: p.container ?? '',
      clientId: p.googleClientId ?? '',
    })
    setSaveError(null)
    setSavedFlash(false)
    setConfirmId(null)
    setConfirmSecretId(null)
    clearRowError(p.id)
  }

  const closeCard = () => {
    dropCardWork()
    openIdRef.current = null
    setOpenId(null)
    setSaveError(null)
    setConfirmSecretId(null)
    setRowError(null)
  }

  // The draft is one shared object, so leaving an edited card throws the edit
  // away. Losing a pasted connection string without a word is not acceptable.
  const mayLeaveDraft = () =>
    !openDirty || window.confirm(t('providers.discardConfirm', { name: openName }))

  const openCard = (p: StorageProvider) => {
    if (!mayLeaveDraft()) return
    if (openId === p.id) {
      closeCard()
      return
    }
    reveal(p)
  }

  // Router navigations are the only observer of Ctrl+K jumps and Back/Forward;
  // beforeunload stays for real unloads. Same rationale as LlmProviders.
  const blocker = useBlocker(openDirty)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(t('providers.discardConfirm', { name: openName }))) blocker.proceed()
    else blocker.reset()
  }, [blocker, openName, t])

  useEffect(() => {
    if (!openDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [openDirty])

  const setupTitleId = useId()

  const openSetup = (kind: StorageProviderKind) => {
    if (!mayLeaveDraft()) return
    setSetupKind(kind)
    setSetupDraft({ ...BLANK_DRAFT, name: KIND_LABELS[kind] })
    setCreateError(null)
  }

  const closeSetup = () => {
    if (creating) return
    setSetupKind(null)
    setSetupDraft(BLANK_DRAFT)
    setCreateError(null)
  }

  const submitSetup = async () => {
    if (!setupKind) return
    const name = setupDraft.name.trim()
    if (name === '') {
      setCreateError(t('providers.nameRequired'))
      return
    }
    if (setupKind === 'azure-blob' && !setupDraft.connectionString.trim()) {
      setCreateError(t('providers.setupNeedsConnString'))
      return
    }
    if (
      setupKind === 'google-drive' &&
      (!setupDraft.clientId.trim() || !setupDraft.clientSecret.trim())
    ) {
      setCreateError(t('providers.setupNeedsOauth'))
      return
    }
    if (
      setupKind === 's3' &&
      (!setupDraft.bucket.trim() || !setupDraft.accessKey.trim() || !setupDraft.secretKey.trim())
    ) {
      setCreateError(t('providers.setupNeedsS3'))
      return
    }

    setCreating(setupKind)
    setCreateError(null)
    try {
      const body: CreateStorageProviderRequest = { kind: setupKind, name }
      if (setupKind === 'azure-blob') {
        if (setupDraft.container.trim()) body.container = setupDraft.container.trim()
        body.connectionString = setupDraft.connectionString.trim()
      } else if (setupKind === 's3') {
        if (setupDraft.endpoint.trim()) body.endpoint = setupDraft.endpoint.trim()
        if (setupDraft.region.trim()) body.region = setupDraft.region.trim()
        body.bucket = setupDraft.bucket.trim()
        body.accessKey = setupDraft.accessKey.trim()
        body.secretKey = setupDraft.secretKey.trim()
        body.pathStyle = setupDraft.pathStyle
        if (setupDraft.prefix.trim()) body.prefix = setupDraft.prefix.trim()
      } else {
        body.clientId = setupDraft.clientId.trim()
        body.clientSecret = setupDraft.clientSecret.trim()
      }
      const made = await api.createStorageProvider(body)
      setProviders((list) => [...(list ?? []), made])
      reveal(made)
      setFocusNew(made.id)
      setSetupKind(null)
      setSetupDraft(BLANK_DRAFT)
    } catch (e) {
      setCreateError(errText(e))
    } finally {
      setCreating(null)
    }
  }

  useEffect(() => {
    if (!setupKind) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating) {
        setSetupKind(null)
        setSetupDraft(BLANK_DRAFT)
        setCreateError(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setupKind, creating])

  useEffect(() => {
    if (focusNew === null) return
    setFocusNew(null)
    const input = document.getElementById(`sp-name-${focusNew}`)
    if (!(input instanceof HTMLInputElement)) return
    input.closest('.llm-card')?.scrollIntoView({ block: 'nearest' })
    input.focus()
    input.select()
  }, [focusNew])

  const save = async (p: StorageProvider) => {
    const target = p.id
    const name = draft.name.trim()
    if (name === '') return
    setSavingId(target)
    setSaveError(null)
    try {
      const body: UpdateStorageProviderRequest = { name }
      if (p.kind === 'azure-blob') {
        body.container = draft.container.trim()
        // An empty box means "keep the stored value" — "" would wipe it.
        if (draft.connectionString) body.connectionString = draft.connectionString
      } else if (p.kind === 's3') {
        // Endpoint "" is meaningful (back to AWS), so every non-secret field is
        // sent as-is; only the secret follows the keep-when-blank rule.
        body.endpoint = draft.endpoint.trim()
        body.region = draft.region.trim()
        body.bucket = draft.bucket.trim()
        body.accessKey = draft.accessKey.trim()
        body.pathStyle = draft.pathStyle
        body.prefix = draft.prefix.trim()
        if (draft.secretKey) body.secretKey = draft.secretKey
      } else {
        // The client id round-trips, so it is sent only when actually changed —
        // any change (including clearing it) drops the refresh token server-side.
        if (draft.clientId.trim() !== (p.googleClientId ?? '')) body.clientId = draft.clientId.trim()
        if (draft.clientSecret) body.clientSecret = draft.clientSecret
      }
      const next = await api.updateStorageProvider(target, body)
      // The list row is addressed by id, so it is always safe to refresh. The
      // form is not: it belongs to whatever card is open *now*.
      replace(next)
      if (openIdRef.current !== target) return
      setDraft({
        ...BLANK_DRAFT,
        ...s3Draft(next),
        name: next.name,
        container: next.container ?? '',
        clientId: next.googleClientId ?? '',
      })
      clearRowError(target)
      flashSaved()
    } catch (e) {
      if (openIdRef.current === target) setSaveError(errText(e))
    } finally {
      setSavingId((id) => (id === target ? null : id))
    }
  }

  const clearSecret = async (p: StorageProvider) => {
    const target = p.id
    setSavingId(target)
    setSaveError(null)
    try {
      const next = await api.updateStorageProvider(
        target,
        p.kind === 'azure-blob'
          ? { connectionString: '' }
          : p.kind === 's3'
            ? { secretKey: '' }
            : { clientSecret: '' },
      )
      replace(next)
      setConfirmSecretId((id) => (id === target ? null : id))
      if (openIdRef.current !== target) return
      setDraft((d) => ({ ...d, connectionString: '', clientSecret: '', secretKey: '' }))
      setTest(null)
    } catch (e) {
      if (openIdRef.current === target) setSaveError(errText(e))
    } finally {
      setSavingId((id) => (id === target ? null : id))
    }
  }

  const remove = async (p: StorageProvider) => {
    setBusyId(p.id)
    clearRowError(p.id)
    try {
      await api.deleteStorageProvider(p.id)
      setProviders((list) => (list ?? []).filter((x) => x.id !== p.id))
      setConfirmId(null)
      if (openIdRef.current === p.id) closeCard()
    } catch (e) {
      // The server refuses while shelves (or stranded content) still use it —
      // that message lands here.
      failRow(p.id, e)
      setConfirmId(null)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * One remote probe at a time per provider — Test connection and Create
   * bucket both go through here, differing only in the call and which button
   * shows the spinner.
   */
  const runProbe = async (
    p: StorageProvider,
    call: (id: string, signal: AbortSignal) => Promise<StorageTestResult>,
    setBusy: (update: (id: string | null) => string | null) => void,
  ) => {
    const target = p.id
    testAbort.current?.abort()
    const ctrl = new AbortController()
    testAbort.current = ctrl
    setBusy(() => target)
    setTest(null)
    try {
      const result = await call(target, ctrl.signal)
      if (!ctrl.signal.aborted && openIdRef.current === target) setTest({ id: target, result })
    } catch (e) {
      // A cancel is not a failure — say nothing rather than paint a red row.
      if (!ctrl.signal.aborted && openIdRef.current === target) {
        setTest({ id: target, result: { ok: false, message: errText(e) } })
      }
    } finally {
      if (testAbort.current === ctrl) testAbort.current = null
      setBusy((id) => (id === target ? null : id))
    }
  }

  const runTest = (p: StorageProvider) => runProbe(p, api.testStorageProvider, setTestingId)
  const runCreateBucket = (p: StorageProvider) =>
    runProbe(p, api.createStorageProviderBucket, setCreatingBucketId)

  /**
   * The consent finishes in another window the app cannot see into, so the
   * panel polls the provider row until `googleConnected` flips — capped, and
   * cancelled by Stop waiting, switching cards, or unmount.
   */
  const connectGoogle = async (p: StorageProvider) => {
    const target = p.id
    clearRowError(target)
    let url: string
    try {
      ;({ url } = await api.connectGoogleStorageProvider(target))
    } catch (e) {
      failRow(target, e)
      return
    }
    window.open(url, '_blank', 'noopener')
    setConnectingId(target)
    const token = (connectToken.current += 1)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      if (connectToken.current !== token) return
      try {
        const fresh = await api.getStorageProvider(target)
        replace(fresh)
        if (fresh.googleConnected) break
      } catch {
        // Transient — keep polling until the cap.
      }
    }
    if (connectToken.current === token) setConnectingId(null)
  }

  const stopWaiting = () => {
    connectToken.current += 1
    setConnectingId(null)
  }

  const addBlock = (
    <div className="llm-add">
      <h3 className="llm-add-title">{t('providers.addStorageTitle')}</h3>
      <div className="llm-add-grid">
        {KINDS.map((k) => {
          const already = kindCounts.get(k.kind) ?? 0
          return (
            <button
              key={k.kind}
              type="button"
              className="llm-kind-btn"
              disabled={creating !== null}
              aria-label={
                already > 0
                  ? t('providers.addAnotherAria', { label: k.label })
                  : t('providers.addAria', { label: k.label })
              }
              onClick={() => openSetup(k.kind)}
            >
              <span className="llm-kind-name">
                {k.label}
                {already > 0 ? (
                  <span className="llm-kind-count">{t('providers.kindCount', { count: already })}</span>
                ) : null}
              </span>
              <span className="llm-kind-hint">
                {creating === k.kind
                  ? t('providers.adding')
                  : t(`providers.kindHint.${k.kind}` as MessageKey)}
              </span>
            </button>
          )
        })}
      </div>
      {createError && !setupKind ? <p className="banner error">{createError}</p> : null}
    </div>
  )

  return (
    <div className="llm-providers storage-providers">
      <p className="llm-intro">{t('providers.storageIntro')}</p>

      {loadError ? (
        <p className="banner error llm-load-error">
          <span>{loadError}</span>
          <button type="button" className="btn sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? t('providers.retrying') : t('common.retry')}
          </button>
        </p>
      ) : null}

      {providers === null && !loadError ? (
        <div className="llm-list" aria-busy="true">
          <div className="llm-skeleton" />
        </div>
      ) : null}

      {providers !== null && providers.length > 0 ? (
        <div className="llm-list">
          {providers.map((p) => {
            const open = openId === p.id
            const isSaving = savingId === p.id
            const isTesting = testingId === p.id
            const isCreatingBucket = creatingBucketId === p.id
            const isProbing = isTesting || isCreatingBucket
            const formBusy = busyId === p.id || isSaving
            const dirty = open && isDirty(draft, p)
            const nameMissing = open && draft.name.trim() === ''
            const canSave = dirty && !formBusy && !nameMissing
            const ready = isReady(p)
            const result = test?.id === p.id ? test.result : null
            const connecting = connectingId === p.id
            const testHintId = `sp-test-hint-${p.id}`
            const nameErrId = `sp-name-err-${p.id}`

            return (
              <section key={p.id} className={`llm-card${open ? ' is-open' : ''}`}>
                <div className="llm-card-head">
                  <button
                    type="button"
                    className="llm-card-open"
                    aria-expanded={open}
                    disabled={formBusy}
                    onClick={() => openCard(p)}
                  >
                    <span className="llm-chevron" aria-hidden>
                      ▾
                    </span>
                    <span className="llm-card-title">
                      <span className="llm-name-row">
                        <span className="llm-name">{p.name}</span>
                        {ready ? (
                          <span className="llm-badge is-ok">{t('providers.badgeReady')}</span>
                        ) : (
                          <span className="llm-badge is-warn">{t('providers.badgeSetupNeeded')}</span>
                        )}
                        {dirty ? (
                          <span className="llm-badge is-dirty">{t('providers.badgeUnsaved')}</span>
                        ) : null}
                      </span>
                      <span className="llm-card-sub">{subLine(p)}</span>
                    </span>
                  </button>
                </div>

                {rowError?.id === p.id ? (
                  <p className="llm-row-error" key={rowError.seq} role="alert">
                    <span>{rowError.message}</span>
                    <button
                      type="button"
                      className="llm-row-error-x"
                      aria-label={t('providers.dismissError')}
                      onClick={() => clearRowError(p.id)}
                    >
                      ✕
                    </button>
                  </p>
                ) : null}

                {open ? (
                  <form
                    className="llm-card-body"
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (canSave) void save(p)
                    }}
                  >
                    <div className="llm-field">
                      <label htmlFor={`sp-name-${p.id}`}>{t('common.name')}</label>
                      <input
                        id={`sp-name-${p.id}`}
                        value={draft.name}
                        // readOnly, not disabled: mid-save keystrokes must not
                        // land, but `disabled` blurs focus to <body>.
                        readOnly={formBusy}
                        aria-invalid={nameMissing}
                        aria-describedby={nameMissing ? nameErrId : undefined}
                        onChange={(e) => editDraft({ name: e.target.value })}
                      />
                      {nameMissing ? (
                        <p className="llm-hint is-warn" id={nameErrId}>
                          {t('providers.nameRequired')}
                        </p>
                      ) : null}
                    </div>

                    {p.kind === 'azure-blob' ? (
                      <>
                        <div className="llm-field">
                          <label htmlFor={`sp-container-${p.id}`}>{t('providers.container')}</label>
                          <input
                            id={`sp-container-${p.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="beedocs"
                            value={draft.container}
                            readOnly={formBusy}
                            onChange={(e) => editDraft({ container: e.target.value })}
                          />
                          <p className="llm-hint">{t('providers.containerHint')}</p>
                        </div>
                        <div className="llm-field">
                          <label htmlFor={`sp-conn-${p.id}`}>{t('providers.connectionString')}</label>
                          <div className="llm-inline">
                            <input
                              id={`sp-conn-${p.id}`}
                              type="password"
                              className="llm-mono llm-key"
                              autoComplete="off"
                              data-1p-ignore=""
                              data-lpignore="true"
                              spellCheck={false}
                              readOnly={formBusy}
                              placeholder={
                                p.hasConnectionString
                                  ? `•••••••• ${p.connectionStringHint ?? ''}`.trim()
                                  : t('providers.connStringPlaceholder')
                              }
                              value={draft.connectionString}
                              onChange={(e) => editDraft({ connectionString: e.target.value })}
                            />
                            {p.hasConnectionString ? (
                              <button
                                type="button"
                                className="btn ghost danger"
                                disabled={formBusy || confirmSecretId === p.id}
                                onClick={() => setConfirmSecretId(p.id)}
                              >
                                {t('common.remove')}
                              </button>
                            ) : null}
                          </div>
                          {p.hasConnectionString ? (
                            <p className="llm-hint">{t('providers.connStringStoredHint')}</p>
                          ) : null}
                        </div>
                      </>
                    ) : p.kind === 's3' ? (
                      <>
                        <div className="llm-grid">
                          <div className="llm-field">
                            <label htmlFor={`sp-endpoint-${p.id}`}>{t('providers.s3Endpoint')}</label>
                            <input
                              id={`sp-endpoint-${p.id}`}
                              className="llm-mono"
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="https://s3.amazonaws.com"
                              value={draft.endpoint}
                              readOnly={formBusy}
                              onChange={(e) => editDraft({ endpoint: e.target.value })}
                            />
                            <p className="llm-hint">{t('providers.s3EndpointHint')}</p>
                          </div>
                          <div className="llm-field">
                            <label htmlFor={`sp-region-${p.id}`}>{t('providers.s3Region')}</label>
                            <input
                              id={`sp-region-${p.id}`}
                              className="llm-mono"
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="us-east-1"
                              value={draft.region}
                              readOnly={formBusy}
                              onChange={(e) => editDraft({ region: e.target.value })}
                            />
                            <p className="llm-hint">{t('providers.s3RegionHint')}</p>
                          </div>
                        </div>
                        <div className="llm-grid">
                          <div className="llm-field">
                            <label htmlFor={`sp-bucket-${p.id}`}>{t('providers.s3Bucket')}</label>
                            <input
                              id={`sp-bucket-${p.id}`}
                              className="llm-mono"
                              spellCheck={false}
                              autoComplete="off"
                              value={draft.bucket}
                              readOnly={formBusy}
                              onChange={(e) => editDraft({ bucket: e.target.value })}
                            />
                            <p className="llm-hint">{t('providers.s3BucketHint')}</p>
                          </div>
                          <div className="llm-field">
                            <label htmlFor={`sp-prefix-${p.id}`}>{t('providers.s3Prefix')}</label>
                            <input
                              id={`sp-prefix-${p.id}`}
                              className="llm-mono"
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="beedocs"
                              value={draft.prefix}
                              readOnly={formBusy}
                              onChange={(e) => editDraft({ prefix: e.target.value })}
                            />
                            <p className="llm-hint">{t('providers.s3PrefixHint')}</p>
                          </div>
                        </div>
                        <div className="llm-field">
                          <label htmlFor={`sp-access-${p.id}`}>{t('providers.s3AccessKey')}</label>
                          <input
                            id={`sp-access-${p.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            value={draft.accessKey}
                            readOnly={formBusy}
                            onChange={(e) => editDraft({ accessKey: e.target.value })}
                          />
                        </div>
                        <div className="llm-field">
                          <label htmlFor={`sp-secret-${p.id}`}>{t('providers.s3SecretKey')}</label>
                          <div className="llm-inline">
                            <input
                              id={`sp-secret-${p.id}`}
                              type="password"
                              className="llm-mono llm-key"
                              autoComplete="off"
                              data-1p-ignore=""
                              data-lpignore="true"
                              spellCheck={false}
                              readOnly={formBusy}
                              placeholder={
                                p.hasS3SecretKey
                                  ? `•••••••• ${p.s3SecretKeyHint ?? ''}`.trim()
                                  : t('providers.s3SecretPlaceholder')
                              }
                              value={draft.secretKey}
                              onChange={(e) => editDraft({ secretKey: e.target.value })}
                            />
                            {p.hasS3SecretKey ? (
                              <button
                                type="button"
                                className="btn ghost danger"
                                disabled={formBusy || confirmSecretId === p.id}
                                onClick={() => setConfirmSecretId(p.id)}
                              >
                                {t('common.remove')}
                              </button>
                            ) : null}
                          </div>
                          {p.hasS3SecretKey ? (
                            <p className="llm-hint">{t('providers.s3SecretStoredHint')}</p>
                          ) : null}
                        </div>
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={draft.pathStyle}
                            disabled={formBusy}
                            onChange={(e) => editDraft({ pathStyle: e.target.checked })}
                          />
                          <span>{t('providers.s3PathStyle')}</span>
                        </label>
                        <p className="llm-hint">{t('providers.s3PathStyleHint')}</p>
                      </>
                    ) : (
                      <>
                        <div className="llm-field">
                          <label htmlFor={`sp-client-id-${p.id}`}>{t('providers.oauthClientId')}</label>
                          <input
                            id={`sp-client-id-${p.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="….apps.googleusercontent.com"
                            value={draft.clientId}
                            readOnly={formBusy}
                            onChange={(e) => editDraft({ clientId: e.target.value })}
                          />
                        </div>
                        <div className="llm-field">
                          <label htmlFor={`sp-client-secret-${p.id}`}>{t('providers.clientSecret')}</label>
                          <div className="llm-inline">
                            <input
                              id={`sp-client-secret-${p.id}`}
                              type="password"
                              className="llm-mono llm-key"
                              autoComplete="off"
                              data-1p-ignore=""
                              data-lpignore="true"
                              spellCheck={false}
                              readOnly={formBusy}
                              placeholder={
                                p.hasGoogleClientSecret
                                  ? t('providers.secretStoredPlaceholder')
                                  : t('providers.clientSecretPlaceholder')
                              }
                              value={draft.clientSecret}
                              onChange={(e) => editDraft({ clientSecret: e.target.value })}
                            />
                            {p.hasGoogleClientSecret ? (
                              <button
                                type="button"
                                className="btn ghost danger"
                                disabled={formBusy || confirmSecretId === p.id}
                                onClick={() => setConfirmSecretId(p.id)}
                              >
                                {t('common.remove')}
                              </button>
                            ) : null}
                          </div>
                          <p className="llm-hint">{t('providers.googleClientHint')}</p>
                        </div>
                        <div className="llm-field">
                          <span className="sp-connect">
                            <button
                              type="button"
                              className="btn"
                              disabled={formBusy || connecting || dirty || !p.hasGoogleClientSecret || !p.googleClientId}
                              title={
                                dirty
                                  ? t('providers.connectSaveFirst')
                                  : !p.hasGoogleClientSecret || !p.googleClientId
                                    ? t('providers.connectNeedsClient')
                                    : undefined
                              }
                              onClick={() => void connectGoogle(p)}
                            >
                              {p.googleConnected
                                ? t('providers.reconnectGoogle')
                                : t('providers.connectGoogle')}
                            </button>
                            {connecting ? (
                              <>
                                <span className="llm-hint sp-waiting">
                                  {t('providers.googleWaiting')}
                                </span>
                                <button type="button" className="btn ghost sm" onClick={stopWaiting}>
                                  {t('providers.stopWaiting')}
                                </button>
                              </>
                            ) : null}
                          </span>
                          {p.googleConnected && !connecting ? (
                            <p className="llm-hint">{t('providers.googleConnectedHint')}</p>
                          ) : null}
                        </div>
                      </>
                    )}

                    {confirmSecretId === p.id ? (
                      <div className="llm-confirm">
                        <span>
                          {t(
                            p.kind === 'azure-blob'
                              ? 'providers.removeSecretConfirmAzure'
                              : p.kind === 's3'
                                ? 'providers.removeSecretConfirmS3'
                                : 'providers.removeSecretConfirmGoogle',
                            { name: p.name },
                          )}
                        </span>
                        <span className="llm-confirm-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={formBusy}
                            onClick={() => setConfirmSecretId(null)}
                          >
                            {t('providers.keepIt')}
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={formBusy}
                            onClick={() => void clearSecret(p)}
                          >
                            {isSaving ? t('providers.removing') : t('common.remove')}
                          </button>
                        </span>
                      </div>
                    ) : null}

                    {result ? (
                      <p className={`llm-result ${result.ok ? 'is-ok' : 'is-fail'}`}>
                        <span className="llm-result-mark" aria-hidden>
                          {result.ok ? '✓' : '✕'}
                        </span>
                        <span>{result.message}</span>
                      </p>
                    ) : null}

                    {saveError ? <p className="banner error">{saveError}</p> : null}

                    {confirmId === p.id ? (
                      <div className="llm-confirm">
                        <span>{t('providers.deleteStorageConfirm', { name: p.name })}</span>
                        <span className="llm-confirm-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={formBusy}
                            onClick={() => setConfirmId(null)}
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={formBusy}
                            onClick={() => void remove(p)}
                          >
                            {busyId === p.id ? t('providers.deleting') : t('providers.deleteProvider')}
                          </button>
                        </span>
                      </div>
                    ) : null}

                    {dirty ? (
                      <p className="llm-hint" id={testHintId}>
                        {t('providers.saveFirstHint')}
                      </p>
                    ) : null}

                    <div className="llm-actions">
                      <div className="llm-actions-main">
                        <button type="submit" className="btn primary" disabled={!canSave}>
                          {isSaving ? t('common.saving') : t('providers.saveChanges')}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={isProbing || formBusy || dirty}
                          aria-describedby={dirty ? testHintId : undefined}
                          onClick={() => void runTest(p)}
                        >
                          {isTesting ? t('providers.testing') : t('providers.testConnection')}
                        </button>
                        {p.kind === 's3' ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={isProbing || formBusy || dirty || !ready}
                            aria-describedby={dirty ? testHintId : undefined}
                            title={t('providers.createBucketTitle')}
                            onClick={() => void runCreateBucket(p)}
                          >
                            {isCreatingBucket ? t('providers.creatingBucket') : t('providers.createBucket')}
                          </button>
                        ) : null}
                        {isProbing ? (
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => testAbort.current?.abort()}
                          >
                            {t('common.cancel')}
                          </button>
                        ) : null}
                        <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
                          {savedFlash ? t('common.saved') : ''}
                        </span>
                      </div>
                      <div className="llm-actions-side">
                        <button
                          type="button"
                          className="btn ghost danger"
                          disabled={formBusy || confirmId === p.id}
                          onClick={() => setConfirmId(p.id)}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>
                  </form>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : null}

      {/* Only once the list is known: adding to an unknown list renders a
          one-item list that hides whatever else exists on the server. */}
      {providers !== null ? addBlock : null}

      {setupKind && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creating) closeSetup()
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={setupTitleId}
            onSubmit={(e) => {
              e.preventDefault()
              void submitSetup()
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2 id={setupTitleId}>
                {t('providers.setupStorageTitle', { kind: KIND_LABELS[setupKind] })}
              </h2>
              <button
                type="button"
                className="icon-btn"
                onClick={closeSetup}
                disabled={creating !== null}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </header>
            <div className="modal-body">
              <p className="muted sm">{t('providers.setupStorageLead')}</p>
              <label className="field">
                <span className="field-label">{t('common.name')}</span>
                <input
                  value={setupDraft.name}
                  onChange={(e) => setSetupDraft((d) => ({ ...d, name: e.target.value }))}
                  required
                  disabled={creating !== null}
                  autoComplete="off"
                  autoFocus
                />
              </label>
              {setupKind === 'azure-blob' ? (
                <>
                  <label className="field">
                    <span className="field-label">{t('providers.container')}</span>
                    <input
                      value={setupDraft.container}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, container: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      placeholder="beedocs"
                    />
                    <span className="muted sm">{t('providers.containerHint')}</span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.connectionString')}</span>
                    <input
                      type="password"
                      className="llm-mono"
                      value={setupDraft.connectionString}
                      onChange={(e) =>
                        setSetupDraft((d) => ({ ...d, connectionString: e.target.value }))
                      }
                      disabled={creating !== null}
                      autoComplete="off"
                      data-1p-ignore=""
                      spellCheck={false}
                      required
                      placeholder={t('providers.connStringPlaceholder')}
                    />
                  </label>
                </>
              ) : setupKind === 's3' ? (
                <>
                  <label className="field">
                    <span className="field-label">{t('providers.s3Endpoint')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.endpoint}
                      onChange={(e) =>
                        setSetupDraft((d) => ({
                          ...d,
                          endpoint: e.target.value,
                          // Self-hosted services want path-style; AWS does not.
                          pathStyle: e.target.value.trim() !== '',
                        }))
                      }
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://minio.example.com:9000"
                    />
                    <span className="muted sm">{t('providers.s3EndpointHint')}</span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.s3Region')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.region}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, region: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="us-east-1"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.s3Bucket')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.bucket}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, bucket: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                    <span className="muted sm">{t('providers.s3BucketHint')}</span>
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.s3AccessKey')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.accessKey}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, accessKey: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.s3SecretKey')}</span>
                    <input
                      type="password"
                      className="llm-mono"
                      value={setupDraft.secretKey}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, secretKey: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      data-1p-ignore=""
                      spellCheck={false}
                      required
                      placeholder={t('providers.s3SecretPlaceholder')}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.s3Prefix')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.prefix}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, prefix: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="beedocs"
                    />
                    <span className="muted sm">{t('providers.s3PrefixHint')}</span>
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={setupDraft.pathStyle}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, pathStyle: e.target.checked }))}
                      disabled={creating !== null}
                    />
                    <span>{t('providers.s3PathStyle')}</span>
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span className="field-label">{t('providers.oauthClientId')}</span>
                    <input
                      className="llm-mono"
                      value={setupDraft.clientId}
                      onChange={(e) => setSetupDraft((d) => ({ ...d, clientId: e.target.value }))}
                      disabled={creating !== null}
                      autoComplete="off"
                      spellCheck={false}
                      required
                      placeholder="….apps.googleusercontent.com"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">{t('providers.clientSecret')}</span>
                    <input
                      type="password"
                      className="llm-mono"
                      value={setupDraft.clientSecret}
                      onChange={(e) =>
                        setSetupDraft((d) => ({ ...d, clientSecret: e.target.value }))
                      }
                      disabled={creating !== null}
                      autoComplete="off"
                      data-1p-ignore=""
                      spellCheck={false}
                      required
                      placeholder={t('providers.clientSecretPlaceholder')}
                    />
                  </label>
                </>
              )}
              {createError ? <p className="banner error compact">{createError}</p> : null}
            </div>
            <footer className="modal-footer">
              <button type="button" className="btn ghost" disabled={creating !== null} onClick={closeSetup}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn primary" disabled={creating !== null}>
                {creating ? t('providers.adding') : t('common.create')}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  )
}
