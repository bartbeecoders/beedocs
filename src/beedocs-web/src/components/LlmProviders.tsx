import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useBlocker } from 'react-router-dom'
import { useInlineSuggestions, useInlineSuggestionsChosen } from '../hooks/useLlmAssist'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import type { LlmKind, LlmModel, LlmProvider, LlmTestResult, UpdateLlmProviderRequest } from '../types'
import { refreshLlmProviders } from '../hooks/useLlmAssist'

type KindOption = {
  kind: LlmKind
  /** Product name — a proper noun, never translated. The hint is `providers.kindHint.{kind}`. */
  label: string
  /** Shown before the row exists — the server fills the same value in on create. */
  baseUrl: string
}

const KINDS: KindOption[] = [
  { kind: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { kind: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { kind: 'claude-cli', label: 'Claude Code', baseUrl: '' },
  { kind: 'grok-cli', label: 'Grok CLI', baseUrl: '' },
]

const KIND_LABELS: Record<LlmKind, string> = {
  openrouter: 'OpenRouter',
  xai: 'xAI',
  openai: 'OpenAI',
  lmstudio: 'LM Studio',
  'claude-cli': 'Claude Code',
  'grok-cli': 'Grok CLI',
}

/**
 * The CLI kinds run a local command instead of calling an endpoint: no base URL,
 * no key, and a blank model means "whatever the CLI's default model is". Value is
 * the executable, resolved from the API process's PATH.
 */
const CLI_COMMANDS: Partial<Record<LlmKind, string>> = {
  'claude-cli': 'claude',
  'grok-cli': 'grok',
}

const isCliKind = (kind: LlmKind): boolean => kind in CLI_COMMANDS

/**
 * A blank model means "whatever the provider lists first" ('providers.autoModel'
 * / 'providers.autoSubListed'). It is a *setting*, not a model id, so it never
 * appears as a value in the model box — only as its placeholder and as the first
 * row of the browse list.
 */

type Draft = { name: string; baseUrl: string; model: string; apiKey: string }

const BLANK_DRAFT: Draft = { name: '', baseUrl: '', model: '', apiKey: '' }

type ModelsState = {
  /** `needs-key`: listing was never attempted, because it would be a guaranteed 502. */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'needs-key'
  items: LlmModel[]
  error: string | null
}

const BLANK_MODELS: ModelsState = { status: 'idle', items: [], error: null }

/** `request` already unwraps the API's message, so this is only Error → string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Host *and* path — the scheme is noise, but the path is not: a proxy at
 * /v1/openai and one at /v1/anthropic are the same host, and this sub-line is
 * the only place the endpoint shows without expanding the card.
 */
function endpointOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\/+$/, '')
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }
}

function isDirty(d: Draft, p: LlmProvider): boolean {
  return (
    d.apiKey !== '' ||
    d.name.trim() !== p.name ||
    d.baseUrl.trim() !== p.baseUrl ||
    d.model.trim() !== p.model
  )
}

/** A key-requiring provider with no stored key cannot answer a single call. */
function canBeEnabled(p: LlmProvider): boolean {
  return p.hasKey || !p.requiresKey
}

type ModelFieldProps = {
  id: string
  value: string
  models: ModelsState
  onChange: (model: string) => void
  onRetry: () => void
  /** Mid-save: block edits without moving focus (`disabled` blurs to <body>). */
  readOnly: boolean
  /** Mid-save or mid-row-request: buttons are genuinely unavailable. */
  busy: boolean
  /** What a blank model means for this kind. Defaults to the listing's first model. */
  autoSub?: string
}

/**
 * Model id entry, with the listing as *suggestions* rather than as the control.
 *
 * The one invariant: **what is in the box is what gets saved.** The box is a
 * plain text input bound straight to the draft — there is no second "typed"
 * state, and no blur, Enter or keystroke handler that can substitute a different
 * value. Three rewrites of a hand-rolled combobox each shipped a way for the
 * control to save something the user could not see:
 *
 *  - a <select> plus a filter box blanked itself when the filter excluded the
 *    selection;
 *  - a hand-rolled combobox committed every keystroke as the model, and its
 *    popup was clipped by the card;
 *  - portalling the popup fixed the clip and added three more: Enter on an
 *    exact match chose "Automatic", blur committed the filter text as a model
 *    id, and the popup's mousedown guard ate the next click on Save.
 *
 * All of those come from one control having to arbitrate between "filter text"
 * and "value". This one never does:
 *
 *  - suggestions come from a native <datalist>. Filtering, keyboard handling,
 *    scrolling and viewport placement are the browser's, it cannot be clipped by
 *    an ancestor, and picking a suggestion is an ordinary input change.
 *  - "Browse models" opens a plain in-flow list below the field for the case
 *    where you want to read the catalogue rather than recall an id. Its filter
 *    box is a separate control that commits nothing; only a click on a row sets
 *    the model. Being in flow, it has no placement, no clipping and no
 *    re-measure-on-pane-resize problem to get wrong.
 */
function ModelField({ id, value, models, onChange, onRetry, readOnly, busy, autoSub }: ModelFieldProps) {
  const { t } = useI18n()
  const auto = autoSub ?? t('providers.autoSubListed')
  const [browsing, setBrowsing] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listId = `${id}-suggestions`
  const panelId = `${id}-browse`
  const hintId = `${id}-hint`

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return models.items
    return models.items.filter(
      (m) => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false),
    )
  }, [models.items, filter])

  // Every row of the browse list ends here, and nowhere else writes the value.
  const pick = (next: string) => {
    setBrowsing(false)
    setFilter('')
    onChange(next)
    inputRef.current?.focus()
  }

  const closeBrowse = () => {
    setBrowsing(false)
    setFilter('')
    inputRef.current?.focus()
  }

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // The card body is a <form>, so Enter here would submit it — and this box
    // is not a value, it only narrows the list below.
    if (e.key === 'Enter') {
      e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Settings is a page today and could be a dialog tomorrow; closing the
      // list must not also close whatever encloses it.
      e.stopPropagation()
      closeBrowse()
    }
  }

  const listed = models.items.length

  return (
    <div className="llm-field">
      <label htmlFor={id}>{t('providers.model')}</label>
      <div className="llm-inline">
        <input
          id={id}
          ref={inputRef}
          className="llm-mono"
          // Suggestions only when there are some: an empty datalist paints an
          // empty dropdown in some browsers.
          list={listed > 0 ? listId : undefined}
          autoComplete="off"
          spellCheck={false}
          readOnly={readOnly}
          aria-describedby={hintId}
          placeholder={`${t('providers.autoModel')} — ${auto}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || listed === 0}
          aria-expanded={browsing}
          aria-controls={panelId}
          onClick={() => (browsing ? closeBrowse() : setBrowsing(true))}
        >
          {browsing ? t('providers.hideModels') : t('providers.browseModels')}
        </button>
      </div>

      {listed > 0 ? (
        <datalist id={listId}>
          {models.items.map((m) => (
            <option
              key={m.id}
              value={m.id}
              label={m.name && m.name !== m.id ? m.name : undefined}
            />
          ))}
        </datalist>
      ) : null}

      {browsing ? (
        <div className="llm-browse" id={panelId}>
          <input
            type="search"
            className="llm-browse-filter"
            aria-label={t('providers.filterModelsAria')}
            placeholder={t(listed === 1 ? 'providers.filterModels.one' : 'providers.filterModels.other', {
              count: listed,
            })}
            readOnly={readOnly}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKey}
          />
          <ul className="llm-browse-list">
            <li>
              <button
                type="button"
                className={`llm-browse-row${value === '' ? ' is-chosen' : ''}`}
                disabled={busy}
                onClick={() => pick('')}
              >
                <span className="llm-browse-id">{t('providers.autoModel')}</span>
                <span className="llm-browse-note">{auto}</span>
              </button>
            </li>
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={`llm-browse-row${m.id === value ? ' is-chosen' : ''}`}
                  disabled={busy}
                  onClick={() => pick(m.id)}
                >
                  <span className="llm-browse-id">{m.id}</span>
                  {m.name && m.name !== m.id ? (
                    <span className="llm-browse-note">{m.name}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {matches.length === 0 ? (
            <p className="llm-hint">{t('providers.browseNoMatch', { filter: filter.trim() })}</p>
          ) : null}
        </div>
      ) : null}

      <p className="llm-hint" id={hintId}>
        {models.status === 'loading' ? t('providers.modelsLoading') : null}
        {models.status === 'ready'
          ? t(listed === 1 ? 'providers.modelHintReady.one' : 'providers.modelHintReady.other', {
              count: listed,
              sub: auto,
            })
          : null}
        {models.status === 'needs-key' ? t('providers.modelHintNeedsKey', { sub: auto }) : null}
        {models.status === 'idle' || models.status === 'error'
          ? t('providers.modelHintIdle', { sub: auto })
          : null}
      </p>

      {models.status === 'error' ? (
        <p className="llm-inline llm-hint is-warn">
          {/* Server messages are already sentences — drop the full stop rather
              than end up with "…v1.. Enter the model id". */}
          <span>{t('providers.modelsError', { error: (models.error ?? '').replace(/\.\s*$/, '') })}</span>
          <button type="button" className="btn sm" disabled={busy} onClick={onRetry}>
            {t('providers.retryList')}
          </button>
        </p>
      ) : null}
    </div>
  )
}

/**
 * Configure which model the writing help talks to.
 *
 * Keys are write-only: the API answers with hasKey/keyHint and never the key
 * itself, so the key box starts empty on every open and an untouched box has to
 * omit `apiKey` — sending the empty string is how you *clear* a stored key.
 *
 * "Default" is not a stored flag. The server picks the first enabled provider by
 * sortOrder, so making one the default means moving it to the top of the list —
 * which /providers/{id}/default does in one atomic step.
 *
 * Everything the open card owns — draft, models, test, save state — is one set of
 * fields, so every async handler captures the id it started on and drops its
 * result if the user has since opened another card. Without that, provider A's
 * response lands in provider B's form.
 */
export function LlmProviders() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<LlmProvider[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState<LlmKind | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Reordering rewrites every row, so nothing else in the list may be touched
  // while it runs.
  const [listBusy, setListBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Removing a stored key destroys a secret that cannot be read back — same
  // two-step as Delete, which destroys strictly less.
  const [confirmKeyId, setConfirmKeyId] = useState<string | null>(null)
  // seq is only there to re-key the paragraph: role="alert" does not re-announce
  // text identical to what it already holds.
  const [rowError, setRowError] = useState<{ id: string; message: string; seq: number } | null>(null)

  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT)
  const [models, setModels] = useState<ModelsState>(BLANK_MODELS)
  const [test, setTest] = useState<{ id: string; result: LlmTestResult } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [focusNew, setFocusNew] = useState<string | null>(null)

  // Identifies the listing request rather than the provider: reopening a card
  // mid-flight would otherwise let the older, slower answer overwrite the newer.
  const modelsToken = useRef(0)
  const modelsAbort = useRef<AbortController | null>(null)
  const testAbort = useRef<AbortController | null>(null)
  const flashTimer = useRef<number | null>(null)
  const rowErrorSeq = useRef(0)
  // Read after an await, where the openId of that render is already stale.
  const openIdRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      window.clearTimeout(flashTimer.current ?? undefined)
      modelsAbort.current?.abort()
      testAbort.current?.abort()
    },
    [],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setProviders(await api.listLlmProviders())
      setLoadError(null)
      // The rows it pointed at have just been replaced; a stale red bar under a
      // fresh row is a lie.
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

  // A deployment with BeeDocs:ApiKey set locks /api/llm out of the browser
  // entirely; api.ts has no header for it. Only the status text survives.
  const unavailable = loadError !== null && /unauthorized|\b401\b/i.test(loadError)

  const defaultId = useMemo(() => {
    const enabled = (providers ?? []).filter((p) => p.enabled)
    if (enabled.length === 0) return null
    const first = [...enabled].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
    )[0]
    return first.id
  }, [providers])

  const openProvider = useMemo(
    () => (providers ?? []).find((p) => p.id === openId) ?? null,
    [providers, openId],
  )
  const openDirty = openProvider !== null && isDirty(draft, openProvider)
  const openName = openProvider?.name ?? t('providers.thisProvider')

  // Several kinds of the same provider are otherwise indistinguishable rows.
  const kindCounts = useMemo(() => {
    const counts = new Map<LlmKind, number>()
    for (const p of providers ?? []) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1)
    return counts
  }, [providers])

  const subLine = (p: LlmProvider): string => {
    const parts: string[] = []
    // The server names a new provider after its kind, so repeating the kind
    // gives "LM Studio · LM Studio".
    if (p.name !== KIND_LABELS[p.kind]) parts.push(KIND_LABELS[p.kind])
    const cli = CLI_COMMANDS[p.kind]
    parts.push(
      p.model || (cli ? t('providers.subCliDefaultModel') : t('providers.subFirstListedModel')),
    )
    // Unconditionally, even with a single provider: whether a key is stored is
    // the one thing you come to this screen to check, and it was previously only
    // visible by expanding the card. A CLI kind has neither endpoint nor key —
    // the command and its own sign-in are the whole story.
    parts.push(cli ? t('providers.subCliCommand', { cmd: cli }) : endpointOf(p.baseUrl))
    parts.push(
      cli
        ? t('providers.subCliSignIn')
        : p.hasKey
          ? t('providers.subKeyStored', { hint: p.keyHint ?? '' })
          : p.requiresKey
            ? t('providers.subNoKey')
            : t('providers.subNoKeyNeeded'),
    )
    return parts.join(' · ')
  }

  // The editor holds its own copy of the provider list, loaded once. Every
  // mutation here has to poke it or the assist bar keeps offering a provider
  // that was just disabled, renamed or deleted.
  const replace = (next: LlmProvider) => {
    setProviders((list) => (list ?? []).map((p) => (p.id === next.id ? next : p)))
    refreshLlmProviders()
  }

  const flashSaved = () => {
    setSavedFlash(true)
    window.clearTimeout(flashTimer.current ?? undefined)
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 2400)
  }

  const failRow = (id: string, e: unknown) =>
    setRowError({ id, message: errText(e), seq: (rowErrorSeq.current += 1) })

  const clearRowError = (id: string) =>
    setRowError((r) => (r === null || r.id === id ? null : r))

  // Every edit invalidates the last test: a green "Connected · 3 models" under
  // a model or key the user has since changed is a lie.
  const editDraft = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setTest(null)
  }

  const loadModels = async (id: string) => {
    modelsAbort.current?.abort()
    const ctrl = new AbortController()
    modelsAbort.current = ctrl
    const token = (modelsToken.current += 1)
    setModels({ ...BLANK_MODELS, status: 'loading' })
    try {
      const items = await api.listLlmModels(id, ctrl.signal)
      if (modelsToken.current !== token) return
      setModels({ status: 'ready', items, error: null })
    } catch (e) {
      if (modelsToken.current !== token || ctrl.signal.aborted) return
      setModels({ status: 'error', items: [], error: errText(e) })
    }
  }

  /**
   * Listing without a key is a guaranteed 502, and a red "Could not list models"
   * the instant a fresh card opens reads as a fault the user caused.
   */
  const loadOrDeferModels = (p: LlmProvider) => {
    if (p.requiresKey && !p.hasKey) {
      modelsAbort.current?.abort()
      modelsToken.current += 1
      setModels({ status: 'needs-key', items: [], error: null })
      return
    }
    void loadModels(p.id)
  }

  /** Drop anything still in flight for the card being left. */
  const dropCardWork = () => {
    modelsAbort.current?.abort()
    modelsToken.current += 1
    // A test is per-card too: without this the next card shows "Testing…" for
    // the previous one's request and then paints its result.
    testAbort.current?.abort()
    testAbort.current = null
    setTestingId(null)
    setTest(null)
  }

  const reveal = (p: LlmProvider) => {
    dropCardWork()
    openIdRef.current = p.id
    setOpenId(p.id)
    setDraft({ name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: '' })
    setSaveError(null)
    setSavedFlash(false)
    setConfirmId(null)
    setConfirmKeyId(null)
    clearRowError(p.id)
    loadOrDeferModels(p)
  }

  const closeCard = () => {
    dropCardWork()
    openIdRef.current = null
    setOpenId(null)
    setModels(BLANK_MODELS)
    setSaveError(null)
    setConfirmKeyId(null)
    setRowError(null)
  }

  // The draft is one shared object, so leaving an edited card throws the edit
  // away. Losing a pasted key without a word is not acceptable — ask first.
  const mayLeaveDraft = () =>
    !openDirty || window.confirm(t('providers.discardConfirm', { name: openName }))

  const openCard = (p: LlmProvider) => {
    if (!mayLeaveDraft()) return
    if (openId === p.id) {
      closeCard()
      return
    }
    reveal(p)
  }

  /**
   * Every in-app move is a router navigation, and only the router sees them all:
   * the shell navigates programmatically from Ctrl+K search results and from the
   * tree's context menus, and Back/Forward move without firing beforeunload or a
   * click. A document-level click guard saw anchors only, so all three silently
   * destroyed a pasted key. beforeunload stays for the real unloads — reload,
   * tab close, external link — which the blocker does not see.
   */
  const [, setInline] = useInlineSuggestions()
  const inlineChosen = useInlineSuggestionsChosen()
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
      // Safari still gates its dialog on the legacy channel.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [openDirty])

  const create = async (kind: LlmKind) => {
    if (!mayLeaveDraft()) return
    setCreating(kind)
    setCreateError(null)
    try {
      const made = await api.createLlmProvider({ kind })
      setProviders((list) => [...(list ?? []), made])
      refreshLlmProviders()
      reveal(made)
      setFocusNew(made.id)
    } catch (e) {
      setCreateError(errText(e))
    } finally {
      setCreating(null)
    }
  }

  // The new row is appended above the Add grid, so on a scrolled page the
  // primary action otherwise looks like it did nothing at all.
  useEffect(() => {
    if (focusNew === null) return
    setFocusNew(null)
    const input = document.getElementById(`llm-name-${focusNew}`)
    if (!(input instanceof HTMLInputElement)) return
    input.closest('.llm-card')?.scrollIntoView({ block: 'nearest' })
    input.focus()
    input.select()
  }, [focusNew])

  /**
   * A key-requiring provider is *created* switched off so it cannot become a
   * default that 401s. The moment a key arrives that reason is gone — leaving it
   * off would mean the first run ends on "Saved" with the banner still reading
   * "Writing help is off" and no control on screen saying what is left to do.
   */
  const savingTurnsOn = (p: LlmProvider) =>
    !p.enabled && p.requiresKey && !p.hasKey && draft.apiKey.trim() !== ''

  const save = async (p: LlmProvider) => {
    const target = p.id
    const name = draft.name.trim()
    const baseUrl = draft.baseUrl.trim()
    // The server keeps the stored value for a blank name or URL, so saving one
    // would look like it worked and quietly revert. Save is disabled too. A CLI
    // kind has no base URL at all — blank is its only correct value.
    if (name === '' || (baseUrl === '' && !isCliKind(p.kind))) return
    const turnOn = savingTurnsOn(p)
    setSavingId(target)
    setSaveError(null)
    try {
      const body: UpdateLlmProviderRequest = { name, baseUrl, model: draft.model.trim() }
      // An empty box means "keep the stored key" — "" would wipe it.
      if (draft.apiKey) body.apiKey = draft.apiKey
      if (turnOn) body.enabled = true
      const next = await api.updateLlmProvider(target, body)
      // The list row is addressed by id, so it is always safe to refresh. The
      // form is not: it belongs to whatever card is open *now*.
      replace(next)
      if (openIdRef.current !== target) return
      setDraft({ name: next.name, baseUrl: next.baseUrl, model: next.model, apiKey: '' })
      clearRowError(target)
      flashSaved()
      // The listing was skipped because there was no key. There is one now.
      if (models.status === 'needs-key' && (next.hasKey || !next.requiresKey)) {
        void loadModels(target)
      }
    } catch (e) {
      if (openIdRef.current === target) setSaveError(errText(e))
    } finally {
      setSavingId((id) => (id === target ? null : id))
    }
  }

  const clearKey = async (p: LlmProvider) => {
    const target = p.id
    setSavingId(target)
    setSaveError(null)
    try {
      // Switch it off in the same write. Left enabled, a key-requiring provider
      // with no key stays the resolved default and fails every completion, while
      // the card shows a "cannot be turned on" hint above a switch that is on.
      const next = await api.updateLlmProvider(target, {
        apiKey: '',
        ...(p.requiresKey ? { enabled: false } : {}),
      })
      replace(next)
      setConfirmKeyId((id) => (id === target ? null : id))
      if (openIdRef.current !== target) return
      setDraft((d) => ({ ...d, apiKey: '' }))
      setTest(null)
      loadOrDeferModels(next)
    } catch (e) {
      if (openIdRef.current === target) setSaveError(errText(e))
    } finally {
      setSavingId((id) => (id === target ? null : id))
    }
  }

  const toggleEnabled = async (p: LlmProvider) => {
    setBusyId(p.id)
    // Only this row's error: acting on row B must not wipe row A's unread one.
    clearRowError(p.id)
    try {
      replace(await api.updateLlmProvider(p.id, { enabled: !p.enabled }))
    } catch (e) {
      failRow(p.id, e)
    } finally {
      setBusyId(null)
    }
  }

  const makeDefault = async (p: LlmProvider) => {
    setListBusy(true)
    clearRowError(p.id)
    try {
      await api.makeLlmProviderDefault(p.id)
      await refresh()
      refreshLlmProviders()
    } catch (e) {
      failRow(p.id, e)
    } finally {
      setListBusy(false)
    }
  }

  const remove = async (p: LlmProvider) => {
    setBusyId(p.id)
    clearRowError(p.id)
    try {
      await api.deleteLlmProvider(p.id)
      setProviders((list) => (list ?? []).filter((x) => x.id !== p.id))
      refreshLlmProviders()
      setConfirmId(null)
      if (openIdRef.current === p.id) closeCard()
    } catch (e) {
      failRow(p.id, e)
    } finally {
      setBusyId(null)
    }
  }

  const runTest = async (p: LlmProvider) => {
    const target = p.id
    testAbort.current?.abort()
    const ctrl = new AbortController()
    testAbort.current = ctrl
    setTestingId(target)
    setTest(null)
    try {
      const result = await api.testLlmProvider(target, ctrl.signal)
      if (!ctrl.signal.aborted && openIdRef.current === target) setTest({ id: target, result })
    } catch (e) {
      // A cancel is not a failure — say nothing rather than paint a red row.
      if (!ctrl.signal.aborted && openIdRef.current === target) {
        setTest({ id: target, result: { ok: false, message: errText(e), modelCount: null, elapsedMs: 0 } })
      }
    } finally {
      if (testAbort.current === ctrl) testAbort.current = null
      setTestingId((id) => (id === target ? null : id))
    }
  }

  const addBlock = (
    <div className="llm-add">
      <h3 className="llm-add-title">{t('providers.addTitle')}</h3>
      <div className="llm-add-grid">
        {KINDS.map((k) => {
          const already = kindCounts.get(k.kind) ?? 0
          return (
            <button
              key={k.kind}
              type="button"
              className="llm-kind-btn"
              disabled={creating !== null || listBusy}
              aria-label={
                already > 0
                  ? t('providers.addAnotherAria', { label: k.label })
                  : t('providers.addAria', { label: k.label })
              }
              onClick={() => void create(k.kind)}
            >
              <span className="llm-kind-name">
                {k.label}
                {/* The count is the whole message. "Add another" underneath it
                    said the same thing a second time in a 200px tile. */}
                {already > 0 ? (
                  <span className="llm-kind-count">{t('providers.kindCount', { count: already })}</span>
                ) : null}
              </span>
              <span className="llm-kind-hint">
                {creating === k.kind
                  ? t('providers.adding')
                  : t(`providers.kindHint.${k.kind}` as MessageKey)}
              </span>
              <span className="llm-kind-url">
                {CLI_COMMANDS[k.kind]
                  ? t('providers.subCliCommand', { cmd: CLI_COMMANDS[k.kind]! })
                  : endpointOf(k.baseUrl)}
              </span>
            </button>
          )
        })}
      </div>
      {createError ? <p className="banner error">{createError}</p> : null}
    </div>
  )

  if (unavailable) {
    return (
      <div className="llm-providers">
        <p className="llm-intro">{t('providers.introShort')}</p>
        <div className="llm-empty">
          <h3>{t('providers.unavailableTitle')}</h3>
          <p>{t('providers.unavailableBody')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="llm-providers">
      <p className="llm-intro">{t('providers.intro')}</p>

      {loadError ? (
        <p className="banner error llm-load-error">
          <span>{loadError}</span>
          {/* Without a retry the only way back is a page reload, and the Add
              grid below is hidden precisely because the list is unknown. */}
          <button type="button" className="btn sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? t('providers.retrying') : t('common.retry')}
          </button>
        </p>
      ) : null}

      {providers === null && !loadError ? (
        <div className="llm-list" aria-busy="true">
          <div className="llm-skeleton" />
          <div className="llm-skeleton" />
        </div>
      ) : null}

      {providers !== null && providers.length === 0 ? (
        <div className="llm-empty">
          <h3>{t('providers.emptyTitle')}</h3>
          <p>{t('providers.emptyBody')}</p>
        </div>
      ) : null}

      {/* Turning the last provider off has no other visible consequence: the
          default simply disappears and writing help stops answering. role=status
          because the default also migrates between cards without a click here. */}
      {providers !== null && providers.length > 0 && defaultId === null ? (
        <p className="llm-notice" role="status">
          <strong>{t('providers.offStrong')}</strong> {t('providers.offRest')}
        </p>
      ) : null}

      {/* Inline suggestions are off until asked for, because they send the block
          you are writing plus its surroundings to the provider on every pause.
          The offer belongs here: configuring a provider is the moment someone
          decides they want this, and the editor's own control is not somewhere
          they have any reason to look first. */}
      {providers !== null && defaultId !== null && !inlineChosen ? (
        <div className="llm-notice llm-offer" role="status">
          <p>
            <strong>{t('providers.inlineTitle')}</strong> {t('providers.inlineBody')}
          </p>
          <div className="llm-offer-actions">
            <button type="button" className="btn primary sm" onClick={() => setInline(true)}>
              {t('providers.turnOn')}
            </button>
            <button type="button" className="btn sm" onClick={() => setInline(false)}>
              {t('providers.notNow')}
            </button>
          </div>
        </div>
      ) : null}

      {providers !== null && providers.length > 0 ? (
        <div className="llm-list">
          {providers.map((p) => {
            const open = openId === p.id
            // With a single provider the badge marks the only row there is.
            const isDefault = p.id === defaultId && providers.length > 1
            const rowBusy = busyId === p.id || listBusy
            const isSaving = savingId === p.id
            const isTesting = testingId === p.id
            // A save is a read-modify-write of the whole row. Anything that
            // fires a second write while it runs — the enable switch, or a
            // collapse that discards the draft — has to be out of bounds too.
            const formBusy = rowBusy || isSaving
            const isCli = isCliKind(p.kind)
            const dirty = open && isDirty(draft, p)
            const nameMissing = open && draft.name.trim() === ''
            const urlMissing = open && !isCli && draft.baseUrl.trim() === ''
            const canSave = dirty && !formBusy && !nameMissing && !urlMissing
            const turnOn = open && savingTurnsOn(p)
            const mayEnable = canBeEnabled(p)
            const result = test?.id === p.id ? test.result : null
            const testHintId = `llm-test-hint-${p.id}`
            const keyGateId = `llm-key-gate-${p.id}`
            const nameErrId = `llm-name-err-${p.id}`
            const urlErrId = `llm-url-err-${p.id}`

            return (
              <section
                key={p.id}
                className={`llm-card${open ? ' is-open' : ''}${p.enabled ? '' : ' is-off'}`}
              >
                <div className="llm-card-head">
                  <button
                    type="button"
                    className="llm-card-open"
                    aria-expanded={open}
                    // A card that collapses mid-save prompts "Discard unsaved
                    // changes?" for edits that are already on their way.
                    disabled={formBusy}
                    onClick={() => openCard(p)}
                  >
                    <span className="llm-chevron" aria-hidden>
                      ▾
                    </span>
                    <span className="llm-card-title">
                      <span className="llm-name-row">
                        <span className="llm-name">{p.name}</span>
                        {isDefault ? (
                          <span className="llm-badge is-default">{t('providers.badgeDefault')}</span>
                        ) : null}
                        {p.requiresKey && !p.hasKey ? (
                          <span className="llm-badge is-warn">{t('providers.badgeKeyNeeded')}</span>
                        ) : null}
                        {dirty ? (
                          <span className="llm-badge is-dirty">{t('providers.badgeUnsaved')}</span>
                        ) : null}
                      </span>
                      <span className="llm-card-sub">{subLine(p)}</span>
                    </span>
                  </button>

                  <div className="llm-card-tools">
                    <label className={`llm-switch${busyId === p.id ? ' is-working' : ''}`}>
                      <input
                        type="checkbox"
                        role="switch"
                        // Without this the accessible name is the visible "On"
                        // text, so every row announces as a switch called "On".
                        aria-label={t('providers.enableAria', { name: p.name })}
                        checked={p.enabled}
                        // Turning *off* is always allowed. Turning on a
                        // key-requiring row that has no key is not: it would
                        // become the first enabled row, i.e. the default, and
                        // 401 on every call.
                        disabled={formBusy || (!p.enabled && !mayEnable)}
                        title={
                          !p.enabled && !mayEnable
                            ? t('providers.needsKeyTitle', { name: p.name })
                            : undefined
                        }
                        onChange={() => void toggleEnabled(p)}
                      />
                      <span className="llm-switch-text" aria-hidden>
                        {p.enabled ? t('providers.on') : t('providers.off')}
                      </span>
                    </label>
                  </div>
                </div>

                {/* Beside the row that caused it: the section banner is often
                    scrolled out of view by the time a row action fails. */}
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
                    // Enter in Name, Base URL or Model saves, like every other
                    // form on the web. Without this it did nothing at all.
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (canSave) void save(p)
                    }}
                  >
                    <div className="llm-grid">
                      <div className="llm-field">
                        <label htmlFor={`llm-name-${p.id}`}>{t('common.name')}</label>
                        <input
                          id={`llm-name-${p.id}`}
                          value={draft.name}
                          // readOnly, not disabled: the response overwrites the
                          // draft so mid-save keystrokes must not land, but
                          // `disabled` blurs the focused field to <body> on
                          // every save and never gives the focus back.
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
                      {isCli ? (
                        <div className="llm-field">
                          <label htmlFor={`llm-cmd-${p.id}`}>{t('providers.command')}</label>
                          <input
                            id={`llm-cmd-${p.id}`}
                            className="llm-mono"
                            value={CLI_COMMANDS[p.kind]}
                            readOnly
                            aria-describedby={`llm-cli-hint-${p.id}`}
                          />
                        </div>
                      ) : (
                        <div className="llm-field">
                          <label htmlFor={`llm-url-${p.id}`}>{t('providers.baseUrl')}</label>
                          <input
                            id={`llm-url-${p.id}`}
                            className="llm-mono"
                            spellCheck={false}
                            autoComplete="off"
                            value={draft.baseUrl}
                            readOnly={formBusy}
                            aria-invalid={urlMissing}
                            aria-describedby={urlMissing ? urlErrId : undefined}
                            onChange={(e) => editDraft({ baseUrl: e.target.value })}
                          />
                          {urlMissing ? (
                            <p className="llm-hint is-warn" id={urlErrId}>
                              {t('providers.baseUrlRequired')}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </div>

                    {isCli ? (
                      <p className="llm-hint" id={`llm-cli-hint-${p.id}`}>
                        {t('providers.cliHint', { cmd: CLI_COMMANDS[p.kind]! })}
                      </p>
                    ) : null}

                    {isCli ? null : (
                    <div className="llm-field">
                      <label htmlFor={`llm-key-${p.id}`}>{t('providers.apiKeyLabel')}</label>
                      <div className="llm-inline">
                        <input
                          id={`llm-key-${p.id}`}
                          type="password"
                          className="llm-mono llm-key"
                          // "new-password" made Chrome offer to *generate* and
                          // store a password over an API key field. "off" plus
                          // the two manager opt-outs is what actually keeps
                          // 1Password, LastPass and Chrome out of it.
                          autoComplete="off"
                          data-1p-ignore=""
                          data-lpignore="true"
                          spellCheck={false}
                          readOnly={formBusy}
                          placeholder={
                            p.hasKey
                              ? `•••••••• ${p.keyHint ?? ''}`.trim()
                              : p.requiresKey
                                ? t('providers.keyPlaceholder')
                                : ''
                          }
                          value={draft.apiKey}
                          onChange={(e) => editDraft({ apiKey: e.target.value })}
                        />
                        {p.hasKey ? (
                          <button
                            type="button"
                            className="btn ghost danger"
                            disabled={formBusy || confirmKeyId === p.id}
                            onClick={() => setConfirmKeyId(p.id)}
                          >
                            {t('providers.removeKey')}
                          </button>
                        ) : null}
                      </div>
                      {confirmKeyId === p.id ? (
                        <div className="llm-confirm">
                          <span>{t('providers.removeKeyConfirm', { name: p.name })}</span>
                          <span className="llm-confirm-actions">
                            <button
                              type="button"
                              className="btn"
                              disabled={rowBusy}
                              onClick={() => setConfirmKeyId(null)}
                            >
                              {t('providers.keepIt')}
                            </button>
                            <button
                              type="button"
                              className="btn danger"
                              disabled={formBusy}
                              onClick={() => void clearKey(p)}
                            >
                              {isSaving ? t('providers.removing') : t('providers.removeKey')}
                            </button>
                          </span>
                        </div>
                      ) : null}
                      {p.hasKey ? (
                        <p className="llm-hint">{t('providers.keyStoredHint')}</p>
                      ) : !p.requiresKey ? (
                        <p className="llm-hint">
                          {t('providers.noKeyHint', { label: KIND_LABELS[p.kind] })}
                        </p>
                      ) : null}
                    </div>
                    )}

                    <ModelField
                      id={`llm-model-${p.id}`}
                      value={draft.model}
                      models={models}
                      readOnly={formBusy}
                      busy={formBusy}
                      autoSub={isCli ? t('providers.autoSubCli') : undefined}
                      onChange={(model) => editDraft({ model })}
                      onRetry={() => void loadModels(p.id)}
                    />

                    {result ? (
                      <p className={`llm-result ${result.ok ? 'is-ok' : 'is-fail'}`}>
                        <span className="llm-result-mark" aria-hidden>
                          {result.ok ? '✓' : '✕'}
                        </span>
                        <span>
                          {result.message}
                          <span className="llm-result-meta">
                            {result.modelCount !== null
                              ? ` · ${t(
                                  result.modelCount === 1
                                    ? 'providers.modelCount.one'
                                    : 'providers.modelCount.other',
                                  { count: result.modelCount },
                                )}`
                              : ''}
                            {result.elapsedMs > 0 ? ` · ${result.elapsedMs} ms` : ''}
                          </span>
                        </span>
                      </p>
                    ) : null}

                    {saveError ? <p className="banner error">{saveError}</p> : null}

                    {/* Rendered next to the actions, not instead of them —
                        confirming a delete used to hide Save with edits pending. */}
                    {confirmId === p.id ? (
                      <div className="llm-confirm">
                        <span>{t('providers.deleteConfirm', { name: p.name })}</span>
                        <span className="llm-confirm-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={rowBusy}
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
                            {rowBusy ? t('providers.deleting') : t('providers.deleteProvider')}
                          </button>
                        </span>
                      </div>
                    ) : null}

                    {!mayEnable ? (
                      <p className="llm-hint" id={keyGateId}>
                        {t('providers.keyGateHint', { label: KIND_LABELS[p.kind] })}
                      </p>
                    ) : !p.enabled ? (
                      <p className="llm-hint">{t('providers.offHint')}</p>
                    ) : null}

                    {dirty ? (
                      <p className="llm-hint" id={testHintId}>
                        {t('providers.saveFirstHint')}
                      </p>
                    ) : null}

                    <div className="llm-actions">
                      <div className="llm-actions-main">
                        {/* No onClick: the form's onSubmit is the single entry
                            point, so a click and an Enter cannot both fire. */}
                        <button type="submit" className="btn primary" disabled={!canSave}>
                          {isSaving
                            ? t('common.saving')
                            : turnOn
                              ? t('providers.saveAndTurnOn')
                              : t('providers.saveChanges')}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={isTesting || formBusy || dirty}
                          aria-describedby={dirty ? testHintId : undefined}
                          onClick={() => void runTest(p)}
                        >
                          {isTesting ? t('providers.testing') : t('providers.testConnection')}
                        </button>
                        {isTesting ? (
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
                        {p.id === defaultId ? null : (
                          <button
                            type="button"
                            className="btn"
                            // Promoting a keyless key-requiring row is exactly
                            // how the 401-ing default gets recreated.
                            disabled={formBusy || !mayEnable}
                            aria-describedby={!mayEnable ? keyGateId : undefined}
                            onClick={() => void makeDefault(p)}
                          >
                            {listBusy
                              ? t('providers.working')
                              : p.enabled
                                ? t('providers.makeDefault')
                                : t('providers.enableMakeDefault')}
                          </button>
                        )}
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
    </div>
  )
}
