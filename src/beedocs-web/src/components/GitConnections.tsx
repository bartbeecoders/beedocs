import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import { useGitRepos, refreshGitRepos } from '../hooks/useGitRepos'
import type {
  GitAvailableRepo,
  GitConnection,
  GitConnectionKind,
  GitConnectionTestResult,
  GitRepo,
} from '../types'

/** Names and hints render via `gitadmin.kindName.*` / `gitadmin.kindHint.*`. */
const KINDS: GitConnectionKind[] = ['github', 'azure-devops', 'git']

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

/**
 * Settings → Git repositories: connections ("the bookshelf") and which repos
 * are added to each. Reuses the llm-* card chrome like StorageProviders does.
 * Tokens are write-only: the API answers hasToken/tokenHint only, so the token
 * box starts empty on every open and an untouched box omits the field.
 */
export function GitConnections() {
  const { t } = useI18n()
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
      <p className="llm-intro">{t('gitadmin.intro')}</p>

      {loadError ? <p className="banner error">{loadError}</p> : null}

      {connections !== null && connections.length === 0 ? (
        <div className="llm-empty">
          <h3>{t('gitadmin.emptyTitle')}</h3>
          <p>{t('gitadmin.emptyBody', { repositories: t('common.repositories') })}</p>
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
                        {dirty ? <span className="llm-badge is-dirty">{t('gitadmin.unsaved')}</span> : null}
                      </span>
                      <span className="llm-card-sub">
                        {[
                          t(`gitadmin.kindLabel.${c.kind}` as MessageKey),
                          c.repoCount === 1
                            ? t('gitadmin.repoCount.one', { count: c.repoCount })
                            : t('gitadmin.repoCount.other', { count: c.repoCount }),
                          c.hasToken
                            ? t('gitadmin.tokenShort', { hint: c.tokenHint ?? '' })
                            : t('gitadmin.noToken'),
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
                        <label htmlFor={`git-name-${c.id}`}>{t('common.name')}</label>
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
                            {c.kind === 'github' ? t('gitadmin.orgOrUser') : t('gitadmin.orgUrl')}
                          </label>
                          <input
                            id={`git-url-${c.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            placeholder={
                              c.kind === 'github'
                                ? t('gitadmin.githubUrlPlaceholder')
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
                        <label htmlFor={`git-user-${c.id}`}>{t('auth.username')}</label>
                        <input
                          id={`git-user-${c.id}`}
                          className="llm-mono"
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={t('gitadmin.usernamePlaceholder')}
                          value={draft.username}
                          readOnly={isSaving}
                          onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
                        />
                      </div>
                      <div className="llm-field">
                        <label htmlFor={`git-token-${c.id}`}>{t('gitadmin.patLabel')}</label>
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
                              : t('gitadmin.tokenPlaceholder')
                          }
                          value={draft.token}
                          onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
                        />
                      </div>
                    </div>
                    <p className="llm-hint">
                      {t(`gitadmin.patHint.${c.kind}` as MessageKey)} {t('gitadmin.patHintCommon')}
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
                          {isSaving ? t('common.saving') : t('gitadmin.saveChanges')}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={testingId === c.id || isSaving || dirty}
                          title={dirty ? t('gitadmin.testNeedsSave') : undefined}
                          onClick={() => void runTest(c)}
                        >
                          {testingId === c.id ? t('gitadmin.testing') : t('gitadmin.testConnection')}
                        </button>
                        <span className={`llm-flash${savedFlash ? ' is-on' : ''}`} aria-live="polite">
                          {savedFlash ? t('common.saved') : ''}
                        </span>
                      </div>
                      <div className="llm-actions-side">
                        <button
                          type="button"
                          className="btn ghost danger"
                          disabled={isSaving || confirmId === c.id}
                          onClick={() => setConfirmId(c.id)}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>

                    {confirmId === c.id ? (
                      <div className="llm-confirm">
                        <span>
                          {t('gitadmin.deleteConfirm', { name: c.name })}{' '}
                          {c.repoCount > 0
                            ? t('gitadmin.deleteHasRepos')
                            : t('gitadmin.deleteTokenGone')}
                        </span>
                        <span className="llm-confirm-actions">
                          <button type="button" className="btn" onClick={() => setConfirmId(null)}>
                            {t('common.cancel')}
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={isSaving}
                            onClick={() => void remove(c)}
                          >
                            {t('gitadmin.deleteConnection')}
                          </button>
                        </span>
                      </div>
                    ) : null}

                    <div className="git-repos-block">
                      <h4>{t('gitadmin.reposOnShelf')}</h4>
                      {mine.length === 0 ? (
                        <p className="llm-hint">{t('gitadmin.noneYet')}</p>
                      ) : (
                        <ul className="git-repo-rows">
                          {mine.map((r) => (
                            <li key={r.id} className="git-repo-row">
                              <span className={`git-repo-status is-${r.status}`}>
                                {t(`gitadmin.status.${r.status}` as MessageKey)}
                              </span>
                              <span className="git-repo-name" title={r.cloneUrl}>
                                {r.name}
                              </span>
                              {r.status === 'error' && r.lastError ? (
                                <span className="git-repo-error" title={r.lastError}>
                                  {r.lastError}
                                </span>
                              ) : null}
                              <label className="git-repo-indexed" title={t('gitadmin.indexedTitle')}>
                                <input
                                  type="checkbox"
                                  checked={r.indexed}
                                  disabled={addBusy === r.id}
                                  onChange={() => void toggleIndexed(r)}
                                />
                                <span>{t('common.search')}</span>
                              </label>
                              <button
                                type="button"
                                className="btn ghost danger sm"
                                disabled={addBusy === r.id}
                                onClick={() => void removeRepo(c, r)}
                              >
                                {t('common.remove')}
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
                              {availableError ? t('gitadmin.retryListing') : t('gitadmin.browseRepos')}
                            </button>
                          ) : null}
                          {availableError ? (
                            <p className="llm-hint is-warn">{availableError}</p>
                          ) : null}
                          {browsing && !availableError && available === null ? (
                            <p className="llm-hint">{t('gitadmin.listingRepos')}</p>
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
                                    {r.added
                                      ? t('gitadmin.added')
                                      : addBusy === r.cloneUrl
                                        ? t('gitadmin.adding')
                                        : t('common.add')}
                                  </button>
                                </li>
                              ))}
                              {available.length === 0 ? (
                                <li className="llm-hint">{t('gitadmin.providerEmpty')}</li>
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
                            {addBusy !== null ? t('gitadmin.adding') : t('gitadmin.addRepository')}
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
          <h3 className="llm-add-title">{t('gitadmin.addConnection')}</h3>
          <div className="llm-add-grid">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="llm-kind-btn"
                disabled={creating !== null}
                onClick={() => void create(kind)}
              >
                <span className="llm-kind-name">{t(`gitadmin.kindName.${kind}` as MessageKey)}</span>
                <span className="llm-kind-hint">
                  {creating === kind
                    ? t('gitadmin.adding')
                    : t(`gitadmin.kindHint.${kind}` as MessageKey)}
                </span>
              </button>
            ))}
          </div>
          {createError ? <p className="banner error">{createError}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
