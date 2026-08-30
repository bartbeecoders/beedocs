import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useGitRepos, refreshGitRepos } from '../hooks/useGitRepos'
import type {
  GitAvailableRepo,
  GitConnection,
  GitConnectionKind,
  GitConnectionTestResult,
  GitRepo,
} from '../types'

type KindOption = {
  kind: GitConnectionKind
  label: string
  hint: string
}

const KINDS: KindOption[] = [
  { kind: 'github', label: 'GitHub', hint: 'List and clone with a fine-grained PAT' },
  { kind: 'azure-devops', label: 'Azure DevOps', hint: 'One connection per organization' },
  { kind: 'git', label: 'Any git URL', hint: 'Paste clone URLs, https only' },
]

const KIND_LABELS: Record<GitConnectionKind, string> = {
  github: 'GitHub',
  'azure-devops': 'Azure DevOps',
  git: 'Git repository',
}

type Draft = { name: string; baseUrl: string; username: string; token: string }

const BLANK_DRAFT: Draft = { name: '', baseUrl: '', username: '', token: '' }

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isDirty(d: Draft, c: GitConnection): boolean {
  return (
    d.token !== '' ||
    d.name.trim() !== c.name ||
    d.baseUrl.trim() !== c.baseUrl ||
    d.username.trim() !== c.username
  )
}

const STATUS_LABEL: Record<GitRepo['status'], string> = {
  cloning: 'Cloning…',
  ready: 'Ready',
  error: 'Failed',
}

/**
 * Settings → Git repositories: connections ("the bookshelf") and which repos
 * are added to each. Reuses the llm-* card chrome like StorageProviders does.
 * Tokens are write-only: the API answers hasToken/tokenHint only, so the token
 * box starts empty on every open and an untouched box omits the field.
 */
export function GitConnections() {
  const [connections, setConnections] = useState<GitConnection[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState<GitConnectionKind | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [test, setTest] = useState<{ id: string; result: GitConnectionTestResult } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  // The repo picker inside the open card.
  const [available, setAvailable] = useState<GitAvailableRepo[] | null>(null)
  const [availableError, setAvailableError] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [addingUrl, setAddingUrl] = useState('')
  const [addBusy, setAddBusy] = useState<string | null>(null)
  const [repoError, setRepoError] = useState<string | null>(null)

  const repos = useGitRepos()
  const flashTimer = useRef<number | null>(null)
  const openIdRef = useRef<string | null>(null)

  useEffect(() => () => window.clearTimeout(flashTimer.current ?? undefined), [])

  const refresh = async () => {
    try {
      setConnections(await api.listGitConnections())
      setLoadError(null)
    } catch (e) {
      setLoadError(errText(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const replace = (next: GitConnection) =>
    setConnections((list) => (list ?? []).map((c) => (c.id === next.id ? next : c)))

  const reveal = (c: GitConnection) => {
    openIdRef.current = c.id
    setOpenId(c.id)
    setDraft({ name: c.name, baseUrl: c.baseUrl, username: c.username, token: '' })
    setSaveError(null)
    setSavedFlash(false)
    setConfirmId(null)
    setTest(null)
    setBrowsing(false)
    setAvailable(null)
    setAvailableError(null)
    setAddingUrl('')
    setRepoError(null)
  }

  const openCard = (c: GitConnection) => {
    if (openId === c.id) {
      openIdRef.current = null
      setOpenId(null)
      return
    }
    reveal(c)
  }

  const create = async (kind: GitConnectionKind) => {
    setCreating(kind)
    setCreateError(null)
    try {
      const made = await api.createGitConnection({ kind })
      setConnections((list) => [...(list ?? []), made])
      reveal(made)
    } catch (e) {
      setCreateError(errText(e))
    } finally {
      setCreating(null)
    }
  }

  const save = async (c: GitConnection) => {
    const target = c.id
    setSavingId(target)
    setSaveError(null)
    try {
      const body: Record<string, string> = {
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        username: draft.username.trim(),
      }
      // An empty box means "keep the stored token" — "" would wipe it.
      if (draft.token) body.token = draft.token
      const next = await api.updateGitConnection(target, body)
      replace(next)
      if (openIdRef.current !== target) return
      setDraft({ name: next.name, baseUrl: next.baseUrl, username: next.username, token: '' })
      setTest(null)
      setSavedFlash(true)
      window.clearTimeout(flashTimer.current ?? undefined)
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2400)
    } catch (e) {
      if (openIdRef.current === target) setSaveError(errText(e))
    } finally {
      setSavingId((id) => (id === target ? null : id))
    }
  }

  const remove = async (c: GitConnection) => {
    setSavingId(c.id)
    try {
      await api.deleteGitConnection(c.id)
      setConnections((list) => (list ?? []).filter((x) => x.id !== c.id))
      if (openIdRef.current === c.id) {
        openIdRef.current = null
        setOpenId(null)
      }
    } catch (e) {
      setSaveError(errText(e))
    } finally {
      setSavingId(null)
      setConfirmId(null)
    }
  }

  const runTest = async (c: GitConnection) => {
    const target = c.id
    setTestingId(target)
    setTest(null)
    try {
      const result = await api.testGitConnection(target)
      if (openIdRef.current === target) setTest({ id: target, result })
    } catch (e) {
      if (openIdRef.current === target) {
        setTest({ id: target, result: { ok: false, message: errText(e), repoCount: null } })
      }
    } finally {
      setTestingId((id) => (id === target ? null : id))
    }
  }

  const browse = async (c: GitConnection) => {
    setBrowsing(true)
    setAvailable(null)
    setAvailableError(null)
    try {
      const list = await api.listGitAvailableRepos(c.id)
      if (openIdRef.current === c.id) setAvailable(list)
    } catch (e) {
      if (openIdRef.current === c.id) setAvailableError(errText(e))
    }
  }

  const addRepo = async (c: GitConnection, cloneUrl: string, name?: string) => {
    setAddBusy(cloneUrl)
    setRepoError(null)
    try {
      await api.addGitRepo(c.id, { cloneUrl, name })
      refreshGitRepos()
      setConnections((list) =>
        (list ?? []).map((x) => (x.id === c.id ? { ...x, repoCount: x.repoCount + 1 } : x)),
      )
      setAvailable((list) =>
        list ? list.map((r) => (r.cloneUrl === cloneUrl ? { ...r, added: true } : r)) : list,
      )
      setAddingUrl('')
    } catch (e) {
      setRepoError(errText(e))
    } finally {
      setAddBusy(null)
    }
  }

  const removeRepo = async (c: GitConnection, repo: GitRepo) => {
    setAddBusy(repo.id)
    setRepoError(null)
    try {
      await api.deleteGitRepo(repo.id)
      refreshGitRepos()
      setConnections((list) =>
        (list ?? []).map((x) =>
          x.id === c.id ? { ...x, repoCount: Math.max(0, x.repoCount - 1) } : x,
        ),
      )
      setAvailable((list) =>
        list ? list.map((r) => (r.cloneUrl === repo.cloneUrl ? { ...r, added: false } : r)) : list,
      )
    } catch (e) {
      setRepoError(errText(e))
    } finally {
      setAddBusy(null)
    }
  }

  const toggleIndexed = async (repo: GitRepo) => {
    setAddBusy(repo.id)
    setRepoError(null)
    try {
      await api.updateGitRepo(repo.id, { indexed: !repo.indexed })
      refreshGitRepos()
    } catch (e) {
      setRepoError(errText(e))
    } finally {
      setAddBusy(null)
    }
  }

  return (
    <div className="llm-providers git-connections">
      <p className="llm-intro">
        Browse and search git repositories like books on a shelf. Repos are cloned server-side;
        tokens are stored on the server and never sent back to the browser.
      </p>

      {loadError ? <p className="banner error">{loadError}</p> : null}

      {connections !== null && connections.length === 0 ? (
        <div className="llm-empty">
          <h3>No git connection configured</h3>
          <p>
            Add a connection below, store its access token, then pick which repositories go on the
            shelf. They appear in the left pane under “Repositories”.
          </p>
        </div>
      ) : null}

      {connections !== null && connections.length > 0 ? (
        <div className="llm-list">
          {connections.map((c) => {
            const open = openId === c.id
            const isSaving = savingId === c.id
            const dirty = open && isDirty(draft, c)
            const result = test?.id === c.id ? test.result : null
            const mine = (repos ?? []).filter((r) => r.connectionId === c.id)
            const canBrowse = c.kind !== 'git'

            return (
              <section key={c.id} className={`llm-card${open ? ' is-open' : ''}`}>
                <div className="llm-card-head">
                  <button
                    type="button"
                    className="llm-card-open"
                    aria-expanded={open}
                    disabled={isSaving}
                    onClick={() => openCard(c)}
                  >
                    <span className="llm-chevron" aria-hidden>
                      ▾
                    </span>
                    <span className="llm-card-title">
                      <span className="llm-name-row">
                        <span className="llm-name">{c.name}</span>
                        {dirty ? <span className="llm-badge is-dirty">Unsaved</span> : null}
                      </span>
                      <span className="llm-card-sub">
                        {[
                          KIND_LABELS[c.kind],
                          `${c.repoCount} repo${c.repoCount === 1 ? '' : 's'}`,
                          c.hasToken ? `token ····${c.tokenHint ?? ''}` : 'no token',
                        ].join(' · ')}
                      </span>
                    </span>
                  </button>
                </div>

                {open ? (
                  <form
                    className="llm-card-body"
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (dirty && !isSaving) void save(c)
                    }}
                  >
                    <div className="llm-grid">
                      <div className="llm-field">
                        <label htmlFor={`git-name-${c.id}`}>Name</label>
                        <input
                          id={`git-name-${c.id}`}
                          value={draft.name}
                          readOnly={isSaving}
                          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        />
                      </div>
                      {c.kind !== 'git' ? (
                        <div className="llm-field">
                          <label htmlFor={`git-url-${c.id}`}>
                            {c.kind === 'github' ? 'Organization or user' : 'Organization URL'}
                          </label>
                          <input
                            id={`git-url-${c.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            placeholder={
                              c.kind === 'github'
                                ? 'blank = repos your token can access'
                                : 'https://dev.azure.com/my-org'
                            }
                            value={draft.baseUrl}
                            readOnly={isSaving}
                            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                          />
                        </div>
                      ) : null}
                    </div>

                    <div className="llm-grid">
                      <div className="llm-field">
                        <label htmlFor={`git-user-${c.id}`}>Username</label>
                        <input
                          id={`git-user-${c.id}`}
                          className="llm-mono"
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="optional — sent with the token"
                          value={draft.username}
                          readOnly={isSaving}
                          onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
                        />
                      </div>
                      <div className="llm-field">
                        <label htmlFor={`git-token-${c.id}`}>Personal access token</label>
                        <input
                          id={`git-token-${c.id}`}
                          type="password"
                          className="llm-mono llm-key"
                          autoComplete="off"
                          data-1p-ignore=""
                          data-lpignore="true"
                          spellCheck={false}
                          readOnly={isSaving}
                          placeholder={
                            c.hasToken
                              ? `•••••••• ${c.tokenHint ?? ''}`.trim()
                              : 'needed for private repos and push'
                          }
                          value={draft.token}
                          onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
                        />
                      </div>
                    </div>
                    <p className="llm-hint">
                      {c.kind === 'github'
                        ? 'A fine-grained PAT with Contents read (write for later phases) is enough.'
                        : c.kind === 'azure-devops'
                          ? 'A PAT with Code (Read) for this organization. Organization URL or just the org name.'
                          : 'Only https clone URLs are supported. Leave the token empty for public repos.'}{' '}
                      A token is stored server-side; leave the box blank to keep it, or save with a
                      new one to replace it.
                    </p>

                    {result ? (
                      <p className={`llm-result ${result.ok ? 'is-ok' : 'is-fail'}`}>
                        <span className="llm-result-mark" aria-hidden>
                          {result.ok ? '✓' : '✕'}
                        </span>
                        <span>{result.message}</span>
                      </p>
                    ) : null}
                    {saveError ? <p className="banner error">{saveError}</p> : null}

                    <div className="llm-actions">
                      <div className="llm-actions-main">
                        <button type="submit" className="btn primary" disabled={!dirty || isSaving}>
                          {isSaving ? 'Saving…' : 'Save changes'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={testingId === c.id || isSaving || dirty}
                          title={dirty ? 'Save first — the test runs against saved settings.' : undefined}
                          onClick={() => void runTest(c)}
                        >
                          {testingId === c.id ? 'Testing…' : 'Test connection'}
                        </button>
                        <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
                          {savedFlash ? 'Saved' : ''}
                        </span>
                      </div>
                      <div className="llm-actions-side">
                        <button
                          type="button"
                          className="btn ghost danger"
                          disabled={isSaving || confirmId === c.id}
                          onClick={() => setConfirmId(c.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {confirmId === c.id ? (
                      <div className="llm-confirm">
                        <span>
                          Delete <strong>{c.name}</strong>?{' '}
                          {c.repoCount > 0
                            ? 'Remove its repositories first — the server refuses otherwise.'
                            : 'Its stored token goes with it.'}
                        </span>
                        <span className="llm-confirm-actions">
                          <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={isSaving}
                            onClick={() => void remove(c)}
                          >
                            Delete connection
                          </button>
                        </span>
                      </div>
                    ) : null}

                    <div className="git-repos-block">
                      <h4>Repositories on the shelf</h4>
                      {mine.length === 0 ? (
                        <p className="llm-hint">None yet.</p>
                      ) : (
                        <ul className="git-repo-rows">
                          {mine.map((r) => (
                            <li key={r.id} className="git-repo-row">
                              <span className={`git-repo-status is-${r.status}`}>
                                {STATUS_LABEL[r.status]}
                              </span>
                              <span className="git-repo-name" title={r.cloneUrl}>
                                {r.name}
                              </span>
                              {r.status === 'error' && r.lastError ? (
                                <span className="git-repo-error" title={r.lastError}>
                                  {r.lastError}
                                </span>
                              ) : null}
                              <label className="git-repo-indexed" title="Include this repo's text files in Ctrl+K search">
                                <input
                                  type="checkbox"
                                  checked={r.indexed}
                                  disabled={addBusy === r.id}
                                  onChange={() => void toggleIndexed(r)}
                                />
                                <span>Search</span>
                              </label>
                              <button
                                type="button"
                                className="btn ghost danger sm"
                                disabled={addBusy === r.id}
                                onClick={() => void removeRepo(c, r)}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {canBrowse ? (
                        <div className="git-add-repos">
                          {!browsing || availableError ? (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => void browse(c)}
                            >
                              {availableError ? 'Retry listing' : 'Browse repositories'}
                            </button>
                          ) : null}
                          {availableError ? (
                            <p className="llm-hint is-warn">{availableError}</p>
                          ) : null}
                          {browsing && !availableError && available === null ? (
                            <p className="llm-hint">Listing repositories…</p>
                          ) : null}
                          {available !== null ? (
                            <ul className="git-available-list">
                              {available.map((r) => (
                                <li key={r.cloneUrl} className="git-available-row">
                                  <span className="git-repo-name" title={r.cloneUrl}>
                                    {r.name}
                                  </span>
                                  {r.description ? (
                                    <span className="muted sm">{r.description}</span>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn sm"
                                    disabled={r.added || addBusy === r.cloneUrl}
                                    onClick={() => void addRepo(c, r.cloneUrl, r.name)}
                                  >
                                    {r.added ? 'Added' : addBusy === r.cloneUrl ? 'Adding…' : 'Add'}
                                  </button>
                                </li>
                              ))}
                              {available.length === 0 ? (
                                <li className="llm-hint">The provider lists no repositories.</li>
                              ) : null}
                            </ul>
                          ) : null}
                        </div>
                      ) : (
                        <div className="git-add-repos llm-inline">
                          <input
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="https://host/path/repo.git"
                            value={addingUrl}
                            onChange={(e) => setAddingUrl(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                if (addingUrl.trim()) void addRepo(c, addingUrl.trim())
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            disabled={addingUrl.trim() === '' || addBusy !== null}
                            onClick={() => void addRepo(c, addingUrl.trim())}
                          >
                            {addBusy !== null ? 'Adding…' : 'Add repository'}
                          </button>
                        </div>
                      )}
                      {repoError ? <p className="llm-hint is-warn">{repoError}</p> : null}
                    </div>
                  </form>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : null}

      {connections !== null ? (
        <div className="llm-add">
          <h3 className="llm-add-title">Add a connection</h3>
          <div className="llm-add-grid">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className="llm-kind-btn"
                disabled={creating !== null}
                onClick={() => void create(k.kind)}
              >
                <span className="llm-kind-name">{k.label}</span>
                <span className="llm-kind-hint">{creating === k.kind ? 'Adding…' : k.hint}</span>
              </button>
            ))}
          </div>
          {createError ? <p className="banner error">{createError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
