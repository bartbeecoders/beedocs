import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { api } from '../api'
import type {
  StorageProvider,
  StorageProviderKind,
  StorageTestResult,
  UpdateStorageProviderRequest,
} from '../types'

type KindOption = {
  kind: StorageProviderKind
  label: string
  hint: string
}

const KINDS: KindOption[] = [
  { kind: 'azure-blob', label: 'Azure Blob Storage', hint: 'A container + connection string' },
  { kind: 'google-drive', label: 'Google Drive', hint: 'Your OAuth app, connect an account' },
]

const KIND_LABELS: Record<StorageProviderKind, string> = {
  'azure-blob': 'Azure Blob Storage',
  'google-drive': 'Google Drive',
}

type Draft = {
  name: string
  container: string
  connectionString: string
  clientId: string
  clientSecret: string
}

const BLANK_DRAFT: Draft = {
  name: '',
  container: '',
  connectionString: '',
  clientId: '',
  clientSecret: '',
}

/** `request` already unwraps the API's message, so this is only Error → string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isDirty(d: Draft, p: StorageProvider): boolean {
  return (
    d.connectionString !== '' ||
    d.clientSecret !== '' ||
    d.name.trim() !== p.name ||
    (p.kind === 'azure-blob' && d.container.trim() !== (p.container ?? '')) ||
    (p.kind === 'google-drive' && d.clientId.trim() !== (p.googleClientId ?? ''))
  )
}

/**
 * A provider a shelf can actually be assigned to. There is no enable switch —
 * "configured or not" is the only state a storage backend has.
 */
function isReady(p: StorageProvider): boolean {
  return p.kind === 'azure-blob' ? p.hasConnectionString : p.googleConnected
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
  const [providers, setProviders] = useState<StorageProvider[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState<StorageProviderKind | null>(null)
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
  const openName = openProvider?.name ?? 'this provider'

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
      parts.push(`container ${p.container ?? 'beedocs'}`)
      parts.push(p.hasConnectionString ? `secret ····${p.connectionStringHint ?? ''}` : 'no connection string')
    } else {
      parts.push(p.googleConnected ? 'connected' : 'not connected')
    }
    parts.push(p.shelfCount === 1 ? '1 shelf' : `${p.shelfCount} shelves`)
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
    setTest(null)
    connectToken.current += 1
    setConnectingId(null)
  }

  const reveal = (p: StorageProvider) => {
    dropCardWork()
    openIdRef.current = p.id
    setOpenId(p.id)
    setDraft({
      name: p.name,
      container: p.container ?? '',
      clientId: p.googleClientId ?? '',
      connectionString: '',
      clientSecret: '',
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
  const mayLeaveDraft = () => !openDirty || window.confirm(`Discard unsaved changes to ${openName}?`)

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
    if (window.confirm(`Discard unsaved changes to ${openName}?`)) blocker.proceed()
    else blocker.reset()
  }, [blocker, openName])

  useEffect(() => {
    if (!openDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [openDirty])

  const create = async (kind: StorageProviderKind) => {
    if (!mayLeaveDraft()) return
    setCreating(kind)
    setCreateError(null)
    try {
      const made = await api.createStorageProvider({ kind })
      setProviders((list) => [...(list ?? []), made])
      reveal(made)
      setFocusNew(made.id)
    } catch (e) {
      setCreateError(errText(e))
    } finally {
      setCreating(null)
    }
  }

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
        name: next.name,
        container: next.container ?? '',
        clientId: next.googleClientId ?? '',
        connectionString: '',
        clientSecret: '',
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
        p.kind === 'azure-blob' ? { connectionString: '' } : { clientSecret: '' },
      )
      replace(next)
      setConfirmSecretId((id) => (id === target ? null : id))
      if (openIdRef.current !== target) return
      setDraft((d) => ({ ...d, connectionString: '', clientSecret: '' }))
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

  const runTest = async (p: StorageProvider) => {
    const target = p.id
    testAbort.current?.abort()
    const ctrl = new AbortController()
    testAbort.current = ctrl
    setTestingId(target)
    setTest(null)
    try {
      const result = await api.testStorageProvider(target, ctrl.signal)
      if (!ctrl.signal.aborted && openIdRef.current === target) setTest({ id: target, result })
    } catch (e) {
      // A cancel is not a failure — say nothing rather than paint a red row.
      if (!ctrl.signal.aborted && openIdRef.current === target) {
        setTest({ id: target, result: { ok: false, message: errText(e) } })
      }
    } finally {
      if (testAbort.current === ctrl) testAbort.current = null
      setTestingId((id) => (id === target ? null : id))
    }
  }

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
      <h3 className="llm-add-title">Add a storage provider</h3>
      <div className="llm-add-grid">
        {KINDS.map((k) => {
          const already = kindCounts.get(k.kind) ?? 0
          return (
            <button
              key={k.kind}
              type="button"
              className="llm-kind-btn"
              disabled={creating !== null}
              aria-label={already > 0 ? `Add another ${k.label} provider` : `Add ${k.label}`}
              onClick={() => void create(k.kind)}
            >
              <span className="llm-kind-name">
                {k.label}
                {already > 0 ? <span className="llm-kind-count">{already} added</span> : null}
              </span>
              <span className="llm-kind-hint">{creating === k.kind ? 'Adding…' : k.hint}</span>
            </button>
          )
        })}
      </div>
      {createError ? <p className="banner error">{createError}</p> : null}
    </div>
  )

  return (
    <div className="llm-providers storage-providers">
      <p className="llm-intro">
        Bookshelves are stored in the embedded database by default. A provider added here becomes an
        option in a shelf's <strong>Storage</strong> field (properties pane) — assigning it moves
        that shelf's pages, revisions, diagrams and slide decks to the provider. Credentials are
        stored on the server and never sent back to the browser.
      </p>

      {loadError ? (
        <p className="banner error llm-load-error">
          <span>{loadError}</span>
          <button type="button" className="btn sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? 'Retrying…' : 'Retry'}
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
                          <span className="llm-badge is-ok">Ready</span>
                        ) : (
                          <span className="llm-badge is-warn">Setup needed</span>
                        )}
                        {dirty ? <span className="llm-badge is-dirty">Unsaved</span> : null}
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
                      aria-label="Dismiss this error"
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
                      <label htmlFor={`sp-name-${p.id}`}>Name</label>
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
                          Name is required.
                        </p>
                      ) : null}
                    </div>

                    {p.kind === 'azure-blob' ? (
                      <>
                        <div className="llm-field">
                          <label htmlFor={`sp-container-${p.id}`}>Container</label>
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
                          <p className="llm-hint">
                            Created in the storage account if it does not exist yet.
                          </p>
                        </div>
                        <div className="llm-field">
                          <label htmlFor={`sp-conn-${p.id}`}>Connection string</label>
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
                                  : "Paste it from the storage account's Access keys"
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
                                Remove
                              </button>
                            ) : null}
                          </div>
                          {p.hasConnectionString ? (
                            <p className="llm-hint">
                              A connection string is stored. Leave this blank to keep it, or enter a
                              new one to replace it.
                            </p>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="llm-field">
                          <label htmlFor={`sp-client-id-${p.id}`}>OAuth client id</label>
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
                          <label htmlFor={`sp-client-secret-${p.id}`}>Client secret</label>
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
                                  ? '•••••••• stored'
                                  : 'From your Google Cloud OAuth client'
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
                                Remove
                              </button>
                            ) : null}
                          </div>
                          <p className="llm-hint">
                            Create an OAuth client (type “Web application”) in Google Cloud Console
                            and add this server's{' '}
                            <code>/api/storage-providers/google/callback</code> URL as an authorized
                            redirect URI. Changing the client drops the stored connection.
                          </p>
                        </div>
                        <div className="llm-field">
                          <span className="sp-connect">
                            <button
                              type="button"
                              className="btn"
                              disabled={formBusy || connecting || dirty || !p.hasGoogleClientSecret || !p.googleClientId}
                              title={
                                dirty
                                  ? 'Save first — the consent flow uses the saved client.'
                                  : !p.hasGoogleClientSecret || !p.googleClientId
                                    ? 'Store the OAuth client id and secret first.'
                                    : undefined
                              }
                              onClick={() => void connectGoogle(p)}
                            >
                              {p.googleConnected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                            </button>
                            {connecting ? (
                              <>
                                <span className="llm-hint sp-waiting">
                                  Waiting for you to finish in the Google window…
                                </span>
                                <button type="button" className="btn ghost sm" onClick={stopWaiting}>
                                  Stop waiting
                                </button>
                              </>
                            ) : null}
                          </span>
                          {p.googleConnected && !connecting ? (
                            <p className="llm-hint">
                              Connected. Content is stored in a “BeeDocs” folder in that account's
                              Drive.
                            </p>
                          ) : null}
                        </div>
                      </>
                    )}

                    {confirmSecretId === p.id ? (
                      <div className="llm-confirm">
                        <span>
                          Remove the stored {p.kind === 'azure-blob' ? 'connection string' : 'client secret'}{' '}
                          for <strong>{p.name}</strong>? It cannot be shown again — you would have to
                          paste a new one{p.kind === 'google-drive' ? ', and the Drive connection is dropped with it' : ''}.
                        </span>
                        <span className="llm-confirm-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={formBusy}
                            onClick={() => setConfirmSecretId(null)}
                          >
                            Keep it
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={formBusy}
                            onClick={() => void clearSecret(p)}
                          >
                            {isSaving ? 'Removing…' : 'Remove'}
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
                        <span>
                          Delete <strong>{p.name}</strong>? Its stored credentials go with it. The
                          server refuses while any shelf still keeps content there — move those
                          shelves back to Local first.
                        </span>
                        <span className="llm-confirm-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={formBusy}
                            onClick={() => setConfirmId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={formBusy}
                            onClick={() => void remove(p)}
                          >
                            {busyId === p.id ? 'Deleting…' : 'Delete provider'}
                          </button>
                        </span>
                      </div>
                    ) : null}

                    {dirty ? (
                      <p className="llm-hint" id={testHintId}>
                        Save first — the test runs against the saved settings, not what is in these
                        boxes.
                      </p>
                    ) : null}

                    <div className="llm-actions">
                      <div className="llm-actions-main">
                        <button type="submit" className="btn primary" disabled={!canSave}>
                          {isSaving ? 'Saving…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={isTesting || formBusy || dirty}
                          aria-describedby={dirty ? testHintId : undefined}
                          onClick={() => void runTest(p)}
                        >
                          {isTesting ? 'Testing…' : 'Test connection'}
                        </button>
                        {isTesting ? (
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => testAbort.current?.abort()}
                          >
                            Cancel
                          </button>
                        ) : null}
                        <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
                          {savedFlash ? 'Saved' : ''}
                        </span>
                      </div>
                      <div className="llm-actions-side">
                        <button
                          type="button"
                          className="btn ghost danger"
                          disabled={formBusy || confirmId === p.id}
                          onClick={() => setConfirmId(p.id)}
                        >
                          Delete
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
    </div>
  )
}
