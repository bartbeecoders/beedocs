import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { api } from '../api'
import type { LlmProvider, LlmTask } from '../types'

/**
 * Idle time before a continuation is asked for.
 *
 * Long enough that a mid-sentence pause does not fire a request, short enough
 * that a finished phrase still feels assisted. Reasoning models used to need
 * the old 1400ms+ because the answer itself took 7–10s; with effort:none on the
 * server a ~1s pause is enough to feel intentional without feeling broken.
 */
export const GHOST_DELAY_MS = 900
/** Ceiling once the wait starts doubling on ignored suggestions. */
const GHOST_MAX_DELAY_MS = 6000
/** A request that answers inside this is never announced as work in progress. */
const GHOST_BUSY_GRACE_MS = 250
/** Fewer new characters than this is the same sentence being finished. */
const MIN_NEW_CHARS = 3
/** Dismissals in one visit to a field before it stops offering until focus leaves. */
const MAX_DISMISSALS = 3
/** Below this a "selection" is a mis-drag, not something anyone wants rewritten. */
const MIN_SELECTION = 2
/** The server truncates to these anyway; cutting here keeps the request small. */
const MAX_PROMPT = 4000
const MAX_CONTEXT = 6000
const MAX_SELECTION = 16000

/** Keys that only arm a shortcut — they leave a suggestion on screen. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

/**
 * Which modifier means "command" here.
 *
 * Accepting on `ctrlKey || metaKey` took both on both platforms, so every chord
 * built on it also fired for the *other* platform's window-manager shortcut.
 */
export const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

/** The platform's own command modifier, and only that one. */
function hasCommandModifier(e: KeyboardEvent): boolean {
  if (e.altKey) return false
  return IS_APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

/**
 * The API client throws with the response body verbatim, so a failed call
 * arrives as JSON. The sentences inside it are already written for the reader —
 * this only unwraps them.
 */
function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (!raw.trim().startsWith('{')) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return raw
    const body = parsed as {
      error?: unknown
      message?: unknown
      title?: unknown
      errors?: Record<string, unknown>
    }
    const problems = Object.values(body.errors ?? {})
      .flat()
      .filter((v): v is string => typeof v === 'string')
    if (problems.length) return problems.join(' ')
    for (const field of [body.error, body.message, body.title]) {
      if (typeof field === 'string' && field) return field
    }
    return raw
  } catch {
    return raw
  }
}

/** A cancelled fetch is not a failure — it is the next keystroke arriving. */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError'
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

function head(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * Where the block being edited sits inside the page text.
 *
 * Page state is a keystroke or two behind the field it came from, so the block
 * rarely matches whole; its opening run places it accurately enough for
 * grounding. -1 when the block belongs to another document altogether.
 */
function blockStart(doc: string, block: string): number {
  const exact = doc.indexOf(block)
  if (exact >= 0) return exact
  for (const size of [200, 80, 32]) {
    if (block.length < size) continue
    const at = doc.indexOf(block.slice(0, size))
    if (at >= 0) return at
  }
  return -1
}

/**
 * Document text around the block being edited.
 *
 * A continuation is grounded by what leads *into* it, so the window is centred
 * on the block rather than taken off the end of the page — the end of the page
 * is the text after the cursor, which is the half the model needs least. The
 * block itself travels as the prompt and is cut out here so it is never sent
 * twice, and the cut is approximate for the same lag `blockStart` handles: a few
 * characters either way cost nothing in grounding.
 */
function surroundingContext(doc: string, block: string): string {
  const at = blockStart(doc, block)
  // Unknown block: the top of the page (title, intro) grounds better than its end.
  if (at < 0) return head(doc, MAX_CONTEXT)
  const before = doc.slice(0, at)
  const after = doc.slice(Math.min(doc.length, at + block.length))
  const share = Math.floor(MAX_CONTEXT / 2)
  const trail = head(after, Math.max(share, MAX_CONTEXT - before.length))
  const lead = tail(before, MAX_CONTEXT - trail.length)
  if (!lead) return trail
  if (!trail) return lead
  // A marker where the block was removed, so the two halves do not read as one.
  return `${lead}\n\n[…]\n\n${trail}`
}

/* ===== Provider availability (one fetch for the whole editor) ===== */

export type LlmAvailability = {
  loaded: boolean
  /** The provider an omitted `providerId` resolves to, or null when there is none. */
  active: LlmProvider | null
  /** Why nothing is available. A 401 lands here too: gated deployment, same outcome. */
  reason: string | null
}

let availability: LlmAvailability = { loaded: false, active: null, reason: null }
let providersInFlight: Promise<void> | null = null
const availabilityListeners = new Set<() => void>()

function publishAvailability(next: LlmAvailability): void {
  availability = next
  for (const listener of availabilityListeners) listener()
}

/** Same order the API resolves an omitted providerId in: enabled, sortOrder, then age. */
function pickActive(list: LlmProvider[]): LlmProvider | null {
  const enabled = list
    .filter((p) => p.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
  return enabled[0] ?? null
}

function loadProviders(): Promise<void> {
  if (providersInFlight) return providersInFlight
  providersInFlight = api
    .listLlmProviders()
    .then((list) => {
      const active = pickActive(list)
      publishAvailability({
        loaded: true,
        active,
        reason: active
          ? null
          : list.length
            ? 'No AI provider is enabled.'
            : 'No AI provider is configured.',
      })
    })
    .catch((e: unknown) => {
      publishAvailability({ loaded: true, active: null, reason: messageOf(e) })
    })
    .finally(() => {
      providersInFlight = null
    })
  return providersInFlight
}

/** Re-read providers after they were changed in settings. */
export function refreshLlmProviders(): void {
  availability = { ...availability, loaded: false }
  // Settings changed: a wrong API key is exactly what put continuations into
  // backoff, so fixing one must not leave the user locked out for five minutes.
  resetGhostHealth()
  void loadProviders()
}

function subscribeAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener)
  return () => {
    availabilityListeners.delete(listener)
  }
}

export function useLlmAvailability(): LlmAvailability {
  const state = useSyncExternalStore(subscribeAvailability, () => availability)
  useEffect(() => {
    if (!availability.loaded) void loadProviders()
  }, [])
  return state
}

/* ===== Health of the speculative half ===== */

/**
 * Nobody asked for a continuation out loud, so a failed one must not answer out
 * loud either: a red alert planted in the paragraph interrupts a screen reader
 * and shoves the text below it down over a background failure. Failures go here
 * instead — a muted state on the editor's AI control — and retry on their own
 * after a widening pause instead of latching the feature off until dismissed.
 */
export type GhostHealth = { degraded: boolean; reason: string | null }

const GHOST_RETRY_MS = [15_000, 60_000, 300_000]

let ghostHealth: GhostHealth = { degraded: false, reason: null }
let ghostRetryAt = 0
let ghostFailures = 0
let ghostRecoverTimer: ReturnType<typeof setTimeout> | null = null
const healthListeners = new Set<() => void>()

function publishHealth(next: GhostHealth): void {
  ghostHealth = next
  for (const listener of healthListeners) listener()
}

function noteGhostFailure(reason: string): void {
  ghostFailures += 1
  const wait = GHOST_RETRY_MS[Math.min(ghostFailures - 1, GHOST_RETRY_MS.length - 1)]
  ghostRetryAt = Date.now() + wait
  publishHealth({ degraded: true, reason })
  // "Paused, will try again shortly" was a claim nothing kept: only a *success*
  // cleared the flag, and no success could happen while the control still said
  // paused. The backoff expiring is itself news, so it is published.
  if (ghostRecoverTimer != null) clearTimeout(ghostRecoverTimer)
  ghostRecoverTimer = setTimeout(() => {
    ghostRecoverTimer = null
    if (ghostHealth.degraded) publishHealth({ degraded: false, reason: null })
  }, wait)
}

function noteGhostSuccess(): void {
  ghostFailures = 0
  ghostRetryAt = 0
  if (ghostRecoverTimer != null) {
    clearTimeout(ghostRecoverTimer)
    ghostRecoverTimer = null
  }
  if (ghostHealth.degraded) publishHealth({ degraded: false, reason: null })
}

/** Providers were reconfigured: whatever the old ones were doing no longer applies. */
function resetGhostHealth(): void {
  ghostFailures = 0
  noteGhostSuccess()
}

/**
 * Lift the backoff — the user has done something about the failure (or simply
 * disagrees with the wait). The failure count is kept, so a provider that is
 * genuinely down still backs off rather than being hammered one click at a time.
 *
 * It does not send anything. The request lives on the field's own idle timer,
 * the field is not focused while this button is (focus is in the popover), and
 * a request from an unfocused field is refused by design — so this clears the
 * way for the next typing pause and the control says exactly that. It used to
 * be labelled "Try again now", which promised a call that never happened.
 */
export function resumeGhostNow(): void {
  ghostRetryAt = 0
  if (ghostRecoverTimer != null) {
    clearTimeout(ghostRecoverTimer)
    ghostRecoverTimer = null
  }
  if (ghostHealth.degraded) publishHealth({ degraded: false, reason: null })
}

function ghostReady(): boolean {
  return Date.now() >= ghostRetryAt
}

function subscribeHealth(listener: () => void): () => void {
  healthListeners.add(listener)
  return () => {
    healthListeners.delete(listener)
  }
}

export function useGhostHealth(): GhostHealth {
  return useSyncExternalStore(subscribeHealth, () => ghostHealth)
}

/* ===== Per-field dismissal lockout, surfaced editor-wide ===== */

/**
 * Three dismissals in one visit stop the offers until focus leaves — which was
 * silent, while the control went on claiming continuations were on. Each field
 * in that state registers the callback that lifts it, so the control can both
 * say so and undo it.
 */
const snoozeResets = new Set<() => void>()
const snoozeListeners = new Set<() => void>()
let snoozeCount = 0

function publishSnooze(): void {
  snoozeCount = snoozeResets.size
  for (const listener of snoozeListeners) listener()
}

function subscribeSnooze(listener: () => void): () => void {
  snoozeListeners.add(listener)
  return () => {
    snoozeListeners.delete(listener)
  }
}

export function useGhostSnoozed(): boolean {
  return useSyncExternalStore(subscribeSnooze, () => snoozeCount > 0)
}

/** One click on "Resume" in the AI control clears every snoozed field. */
export function resumeGhostSuggestions(): void {
  for (const reset of [...snoozeResets]) reset()
}

/* ===== Inline-suggestion preference ===== */

const GHOST_PREF_KEY = 'beedocs.ai.inline-suggestions'
const prefListeners = new Set<() => void>()

/**
 * Off until someone says otherwise.
 *
 * On, this ships the block being written plus several thousand characters of
 * page context to the provider on every typing pause. Reading "not '0'" as
 * consent meant configuring a provider — a separate decision, in a separate
 * screen — silently started that. Selection actions stay available either way,
 * and they only ever send text the user picked out by hand.
 */
function readGhostPref(): boolean {
  try {
    return window.localStorage.getItem(GHOST_PREF_KEY) === '1'
  } catch {
    return false
  }
}

/** Whether the choice has been made at all, so the control can offer it once. */
function readGhostPrefChosen(): boolean {
  try {
    return window.localStorage.getItem(GHOST_PREF_KEY) != null
  } catch {
    return false
  }
}

let ghostPref = readGhostPref()
let ghostPrefChosen = readGhostPrefChosen()

function subscribePref(listener: () => void): () => void {
  prefListeners.add(listener)
  return () => {
    prefListeners.delete(listener)
  }
}

/** Whether ghost text may appear. Persisted, and shared by every block on the page. */
export function useInlineSuggestions(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribePref, () => ghostPref)
  const set = useCallback((next: boolean) => {
    ghostPref = next
    ghostPrefChosen = true
    try {
      window.localStorage.setItem(GHOST_PREF_KEY, next ? '1' : '0')
    } catch {
      // Storage denied (private window) — the setting just stops surviving a reload.
    }
    for (const listener of prefListeners) listener()
  }, [])
  return [value, set]
}

/** False until the switch has been touched once, so the offer can be made explicitly. */
export function useInlineSuggestionsChosen(): boolean {
  return useSyncExternalStore(subscribePref, () => ghostPrefChosen)
}

/* ===== Writing into an uncontrolled textarea ===== */

/**
 * Replace a range of a SyncedTextarea the way typing over it would — or say so
 * when the browser refuses.
 *
 * `execCommand('insertText')` is deprecated and is still the only insertion path
 * browsers put on the native undo stack. That matters more here than the
 * deprecation does: Ctrl+Z is the only undo this editor has, and text nobody
 * typed is exactly the text people reach for it after.
 *
 * There is deliberately no fallback. `setRangeText` writes the value without
 * touching that stack, so it needed a hand-rolled shim to make one undo work —
 * and that shim, armed twice, took out the wrong insertion and left the AI text
 * behind. Silently deleting the wrong paragraph is a worse outcome than not
 * inserting, so a refusal is reported to the caller and the text offered for
 * copying instead. Every browser this editor supports implements insertText;
 * this is a rare path, not a feature.
 *
 * @returns whether the text was written into the field.
 */
export function replaceRange(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): boolean {
  el.focus()
  el.setSelectionRange(start, end)
  try {
    return document.execCommand('insertText', false, text)
  } catch {
    return false
  }
}

/**
 * The outcome of writing AI text into a field, for the two places that do it.
 *
 * `inserted` ticks so the live region can say so — nothing used to be announced
 * after acceptance, which left a screen-reader user with no confirmation that
 * the text they had just heard had landed. `failedText` is the suggestion the
 * browser would not insert, kept so it can still be copied.
 */
type InsertOutcome = {
  inserted: number
  failedText: string | null
  write: (el: HTMLTextAreaElement, start: number, end: number, text: string) => boolean
  clearFailed: () => void
}

function useInsertOutcome(): InsertOutcome {
  const [inserted, setInserted] = useState(0)
  const [failedText, setFailedText] = useState<string | null>(null)

  const write = useCallback(
    (el: HTMLTextAreaElement, start: number, end: number, text: string) => {
      if (replaceRange(el, start, end, text)) {
        setInserted((n) => n + 1)
        return true
      }
      setFailedText(text)
      return false
    },
    [],
  )

  const clearFailed = useCallback(() => setFailedText(null), [])
  return { inserted, failedText, write, clearFailed }
}

/**
 * The suggestion as it should meet the text it continues.
 *
 * Models answer with or without the space that holds the completion off the last
 * word, depending on how the prompt ended — and without it "dead letter" plus
 * "Settlement" is committed as "dead letterSettlement". One function decides, so
 * the ghost on screen and the text that lands are the same string.
 */
/**
 * Markdown whose meaning depends on starting a line.
 *
 * `#` mid-line is a literal hash, `- ` is a hyphen, `1.` is a date fragment, a
 * fence that does not open a line never opens anything, and `|` in running text
 * is a pipe. Glued on with a space — which is what a prose continuation wants —
 * every one of these silently stops being Markdown.
 */
const BLOCK_OPENER = /^(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|~~~|\||([-*_])[ \t]*\2[ \t]*\2)/

/** Whether the text ends inside a list item, where the next block is one newline away. */
function endsInListItem(base: string): boolean {
  return /(^|\n)[^\S\n]*(?:[-*+]|\d+[.)])[ \t][^\n]*$/.test(base)
}

export function continuationSuffix(base: string, text: string): string {
  if (!text) return ''
  const opener = text.replace(/^\s+/, '')
  if (!opener) return ''
  if (!base) return opener

  // A block construct gets the line break it needs, and the ghost is drawn from
  // this same string — so the preview shows the break that will be committed
  // rather than a heading welded into the paragraph above it.
  if (BLOCK_OPENER.test(opener)) {
    const have = /\n*$/.exec(base)?.[0].length ?? 0
    const want = endsInListItem(base) ? 1 : 2
    return '\n'.repeat(Math.max(0, want - have)) + opener
  }

  // Already spaced (or a fresh field): only a doubled-up space needs removing.
  if (/\s$/.test(base)) return text.replace(/^[^\S\r\n]+/, '')
  if (/^\s/.test(text)) return text
  // Punctuation closes the previous word instead of following it.
  return /^[)\]}.,;:!?%…'"’”-]/.test(text) ? text : ` ${text}`
}

/* ===== Geometry: overlays that line up with the text ===== */

/**
 * Everything that decides where a glyph lands. Copied onto the overlay so the
 * ghost text wraps and sits exactly where the textarea's own text would.
 */
const MIRRORED_STYLES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-feature-settings',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'text-rendering',
  'direction',
  'tab-size',
  'white-space',
  'overflow-wrap',
  'word-break',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const

function copyTextMetrics(from: CSSStyleDeclaration, to: HTMLElement): void {
  for (const prop of MIRRORED_STYLES) to.style.setProperty(prop, from.getPropertyValue(prop))
}

function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Everything that can move text under an overlay without an edit happening.
 *
 * The field is user-resizable and the pane it sits in is draggable, the page
 * scrolls, a webfont can land late, and a theme or density switch relays the
 * same characters at a different size inside a box that never changes — so an
 * overlay measured once is wrong within seconds. Shared, because the caret
 * anchor used to listen for only two of these and drifted on the rest.
 */
function watchLayout(el: HTMLTextAreaElement, run: () => void): () => void {
  const observer = new ResizeObserver(run)
  observer.observe(el)
  el.addEventListener('scroll', run)
  window.addEventListener('resize', run)

  let live = true
  const onFonts = () => {
    if (live) run()
  }
  void document.fonts.ready.then(onFonts)
  document.fonts.addEventListener('loadingdone', onFonts)
  const themeWatcher = new MutationObserver(run)
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-density'],
  })

  return () => {
    live = false
    observer.disconnect()
    themeWatcher.disconnect()
    document.fonts.removeEventListener('loadingdone', onFonts)
    el.removeEventListener('scroll', run)
    window.removeEventListener('resize', run)
  }
}

/**
 * How much of a run of text inside `box` is drawn above `bottom`.
 *
 * The overlay is clipped to whole lines, so "visible" is a property of
 * characters, not of pixels: the answer is the length of the longest prefix
 * whose last line fragment ends above the clip. Binary search, because the top
 * of a prefix only ever moves down as the prefix grows — about eight range
 * measurements for a suggestion of any length, with no writes in between.
 */
function visiblePrefix(node: Text, bottom: number): number {
  const len = node.length
  const range = document.createRange()
  const fits = (chars: number): boolean => {
    if (chars === 0) return true
    range.setStart(node, 0)
    range.setEnd(node, chars)
    const rects = range.getClientRects()
    for (let i = rects.length - 1; i >= 0; i -= 1) {
      const rect = rects[i]
      if (rect.height > 0) return rect.bottom <= bottom + 0.5
    }
    // No rect with height: collapsed whitespace, which cannot be the thing that
    // overflows.
    return true
  }
  if (fits(len)) return len
  let lo = 0
  let hi = len
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Keep an absolutely positioned overlay glued to a textarea's padding box, ending
 * on a whole line, and report where the suggestion stops being readable in it.
 *
 * The field's own geometry is never touched — growing it to fit a suggestion
 * pushed every block below it down, snapped back on the next keystroke and threw
 * away a resize made in between. So the overlay is clipped instead, and clipped
 * to the last *fully* visible line: letting it end wherever the box did rendered
 * a few pixels of a line sliced through the x-height, which is unreadable and
 * still counted as "shown" when the user was asked to commit it.
 *
 * The return value is the index in `text` where the field runs out of room, or
 * null when all of it fits. Exactly one place then shows any given character:
 * everything before the cut is in the field, everything after it is in the panel
 * below. The two used to overlap for the first two lines, at different sizes and
 * with different wrapping.
 */
export function useTextareaMirror(
  el: HTMLTextAreaElement | null,
  mirrorRef: RefObject<HTMLDivElement | null>,
  base: string,
  text: string,
): number | null {
  const [cut, setCut] = useState<number | null>(null)

  useLayoutEffect(() => {
    const box = mirrorRef.current
    if (!el || !box) {
      setCut(null)
      return
    }

    const run = () => {
      const cs = window.getComputedStyle(el)
      copyTextMetrics(cs, box)
      const line = px(cs.lineHeight) || px(cs.fontSize) * 1.2 || 16
      const padTop = px(cs.paddingTop)
      const padBottom = px(cs.paddingBottom)
      const room = Math.max(0, el.clientHeight - padTop - padBottom)
      // Half a pixel of slack: sub-pixel line heights otherwise drop a line that
      // is visibly, entirely there.
      const lines = Math.max(1, Math.floor((room + 0.5) / line))
      const height = padTop + lines * line

      box.style.top = `${el.offsetTop + px(cs.borderTopWidth)}px`
      box.style.left = `${el.offsetLeft + px(cs.borderLeftWidth)}px`
      box.style.width = `${el.clientWidth}px`
      box.style.height = `${height}px`
      box.scrollTop = el.scrollTop
      box.scrollLeft = el.scrollLeft

      const span = box.querySelector('[data-ghost-run]')
      const node = span?.firstChild
      if (!(node instanceof Text) || node.length === 0) {
        setCut(null)
        return
      }
      const shown = visiblePrefix(node, box.getBoundingClientRect().bottom)
      setCut(shown >= node.length ? null : shown)
    }

    run()
    return watchLayout(el, run)
  }, [el, mirrorRef, base, text])

  return cut
}

export type CaretPoint = { top: number; left: number; lineHeight: number }

/**
 * Where a character index sits, in the coordinates of the field wrapper.
 *
 * A textarea exposes no client rect for its text, so the run up to the index is
 * laid out once in a throwaway copy of the field and the marker read off that.
 */
export function measureCaret(el: HTMLTextAreaElement, index: number): CaretPoint {
  const cs = window.getComputedStyle(el)
  const mirror = document.createElement('div')
  copyTextMetrics(cs, mirror)
  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.width = `${el.clientWidth}px`
  mirror.style.boxSizing = 'border-box'
  mirror.style.visibility = 'hidden'
  mirror.style.pointerEvents = 'none'
  mirror.textContent = el.value.slice(0, index)

  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.appendChild(marker)

  const host = el.parentElement ?? document.body
  host.appendChild(mirror)
  const point: CaretPoint = {
    top: el.offsetTop + px(cs.borderTopWidth) + marker.offsetTop - el.scrollTop,
    left: el.offsetLeft + px(cs.borderLeftWidth) + marker.offsetLeft - el.scrollLeft,
    lineHeight: marker.offsetHeight || px(cs.lineHeight) || 16,
  }
  host.removeChild(mirror)
  return point
}

function samePoint(a: CaretPoint | null, b: CaretPoint): boolean {
  return a != null && a.top === b.top && a.left === b.left && a.lineHeight === b.lineHeight
}

/**
 * `measureCaret`, kept correct.
 *
 * Placement used to listen for scroll and resize only, so a late webfont or a
 * theme switch left whatever was anchored to it hanging off the wrong line.
 */
export function useCaretAnchor(
  el: HTMLTextAreaElement | null,
  index: number,
  active: boolean,
): CaretPoint | null {
  const [point, setPoint] = useState<CaretPoint | null>(null)

  useLayoutEffect(() => {
    if (!el || !active) {
      setPoint(null)
      return
    }
    const run = () => {
      const next = measureCaret(el, index)
      setPoint((prev) => (samePoint(prev, next) ? prev : next))
    }
    run()
    return watchLayout(el, run)
  }, [el, index, active])

  return point
}

/* ===== Ghost text ===== */

export type GhostSuggestion = {
  /** Normalised against the text before the caret: exactly what accepting inserts. */
  text: string
  /** Full field value the suggestion was written for; void once it differs. */
  base: string
  /**
   * Index in `base` where `text` inserts. Was end-of-field only, which meant any
   * block with content below the line you were writing never offered a ghost.
   */
  caret: number
}

export type GhostText = {
  ghost: GhostSuggestion | null
  busy: boolean
  /** Dismissed enough times in this visit that the field has stopped offering. */
  snoozed: boolean
  /** Bumped each time a suggestion was actually written into the field. */
  inserted: number
  /** A suggestion the browser refused to insert, kept so it can be copied. */
  failedText: string | null
  clearFailed: () => void
  /** Esc, or the field wrapper handling Esc for it. */
  dismiss: () => void
  /** Undo the lockout without leaving the field. */
  resume: () => void
}

type GhostOptions = {
  el: HTMLTextAreaElement | null
  enabled: boolean
  /** Page markdown, read at request time so typing does not re-arm the listeners. */
  contextRef: RefObject<string>
  /** Held off while a proposal is on screen — one suggestion at a time. */
  paused: boolean
}

/**
 * The accept chord: Ctrl+Enter, or Cmd+Enter on a Mac. Nothing else.
 *
 * Tab is deliberately not one. It is the only way out of the field for anyone
 * not using a pointer, and "pause to think, Tab to move on" would then commit
 * prose the writer never read.
 *
 * Ctrl/Cmd+→ was worse than unadvertised. Taking either modifier on either
 * platform made it macOS's "move right a space" (the desktop slides away *and*
 * the suggestion lands) and Windows' snap-right; with Shift unchecked, extending
 * the selection by word accepted too. There is one chord now, it is the one the
 * hint chip shows, and it takes the platform's own modifier only.
 */
function isAcceptChord(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && hasCommandModifier(e)
}

/**
 * The chord that opens the selection actions.
 *
 * Shift is *not* rejected here, unlike Enter: on French AZERTY and several other
 * layouts `.` is a shifted key, so rejecting it made the only advertised way
 * into the menu a dead chord on those keyboards. `e.code` covers the layouts
 * that put the character somewhere else entirely.
 */
function isMenuChord(e: KeyboardEvent): boolean {
  return (e.key === '.' || e.code === 'Period') && hasCommandModifier(e)
}

/**
 * A chord belonging to the application rather than to the block: Ctrl+S,
 * Ctrl+K, Ctrl+A and the rest.
 *
 * They neither edit the text nor move the caret off the end, so a suggestion
 * survives them untouched — saving the page used to cost the suggestion *and*
 * widen the next wait, and four such presses ratcheted it to the eight-second
 * ceiling for the life of the field. Any of them that does change the text
 * (paste, cut, undo) fires an input event, which is handled there.
 */
function isAppShortcut(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey
}

/** Whether a key press is the user typing a character into the field. */
function isTypingKey(e: KeyboardEvent): boolean {
  return e.key.length === 1
}

/** How much of a paragraph identifies it again after more has been typed into it. */
const PARAGRAPH_KEY_CHARS = 48

/**
 * A stable name for the paragraph an offset sits in.
 *
 * A positional index moved: inserting a paragraph above transferred the
 * dismissal to a paragraph the user had never dismissed, or lifted it off the
 * one they had. The opening run does not move, and it survives the typing that
 * continues after the dismissal.
 */
function paragraphKeyAt(value: string, caret: number): string {
  const before = value.slice(0, caret)
  const breaks = [...before.matchAll(/\n[^\S\n]*\n/g)]
  const last = breaks[breaks.length - 1]
  const from = last ? last.index + last[0].length : 0
  return before.slice(from, from + PARAGRAPH_KEY_CHARS).trim()
}

/**
 * Whether the text moved on enough since the last request to be worth another.
 *
 * Finishing the word that was already in flight is the same sentence, and would
 * come back the same answer. An edit or a deletion always counts.
 */
function meaningfulChange(previous: string | null, value: string): boolean {
  if (previous === null) return true
  if (previous === value) return false
  let shared = 0
  while (shared < previous.length && shared < value.length && previous[shared] === value[shared]) {
    shared += 1
  }
  if (shared < previous.length) return true
  return value.length - shared >= MIN_NEW_CHARS
}

/**
 * Inline continuation after a typing pause: Ctrl/Cmd+Enter (or Ctrl/Cmd+→)
 * accepts, Esc dismisses, anything else throws it away along with the request
 * that was still in flight for it.
 */
export function useGhostText({ el, enabled, contextRef, paused }: GhostOptions): GhostText {
  const [ghost, setGhost] = useState<GhostSuggestion | null>(null)
  const [busy, setBusy] = useState(false)
  const [snoozed, setSnoozed] = useState(false)

  const ghostRef = useRef<GhostSuggestion | null>(null)
  ghostRef.current = ghost
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** The paragraph a dismissal covers: it holds until the caret leaves it. */
  const dismissedAtRef = useRef<string | null>(null)
  const dismissCountRef = useRef(0)
  /** Suggestions typed straight past. Each one widens the next wait. */
  const wastedRef = useRef(0)
  /** Text the last request was made for, so the same text is never asked twice. */
  const lastRequestedRef = useRef<string | null>(null)
  /** Set across our own insertion, so accepting does not immediately ask for more. */
  const selfEditRef = useRef(false)
  const outcome = useInsertOutcome()
  const { write } = outcome

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (busyTimerRef.current != null) {
      clearTimeout(busyTimerRef.current)
      busyTimerRef.current = null
    }
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }, [])

  /** Take a suggestion off the screen without holding it against the next one. */
  const clear = useCallback(() => {
    ghostRef.current = null
    setGhost(null)
  }, [])

  /**
   * Throw a suggestion away, counting it against how eagerly the next is asked
   * for. Only for typing straight past one — the single gesture that actually
   * means "not interested". Clicking into your own paragraph and pressing Escape
   * both used to land here too, so four clicks in your own text ratcheted the
   * wait to eight seconds and left it there for the life of the field.
   */
  const drop = useCallback(() => {
    if (ghostRef.current) wastedRef.current += 1
    ghostRef.current = null
    setGhost(null)
  }, [])

  /** Lift the three-dismissal lockout — from leaving the field, or from the AI control. */
  const resume = useCallback(() => {
    dismissedAtRef.current = null
    dismissCountRef.current = 0
    setSnoozed(false)
  }, [])

  const accept = useCallback(() => {
    const current = ghostRef.current
    if (!el || !current) return
    stop()
    ghostRef.current = null
    setGhost(null)
    // Text moved on while the suggestion was on screen — dropping it beats
    // pasting a continuation of something the user no longer has. The keydown
    // handler checks this first and re-asks instead of swallowing the chord.
    if (el.value !== current.base) return
    wastedRef.current = 0
    resume()
    // Inserted at the caret through the undo stack, already spaced against the
    // preceding word. The input this fires must not arm the next request: the
    // moment after a suggestion is taken is the moment the writer is least idle.
    selfEditRef.current = true
    write(el, current.caret, current.caret, current.text)
    selfEditRef.current = false
  }, [el, resume, stop, write])

  const dismiss = useCallback(() => {
    if (!el) return
    stop()
    // Cleared rather than dropped: Escape already costs the user their
    // suggestion and the dismissal count. Charging the backoff as well made one
    // gesture two penalties.
    clear()
    dismissedAtRef.current = paragraphKeyAt(el.value, el.selectionStart ?? el.value.length)
    dismissCountRef.current += 1
    setSnoozed(dismissCountRef.current >= MAX_DISMISSALS)
  }, [el, clear, stop])

  // The lockout is editor-wide news: the AI control says "snoozed" instead of
  // claiming continuations are on, and offers the one click that lifts it.
  useEffect(() => {
    if (!snoozed) return
    snoozeResets.add(resume)
    publishSnooze()
    return () => {
      snoozeResets.delete(resume)
      publishSnooze()
    }
  }, [snoozed, resume])

  useEffect(() => {
    if (!el) return
    if (!enabled || paused) {
      stop()
      setGhost(null)
      return
    }

    /** Arm the next attempt. Kept above `request` so a backoff can re-arm itself. */
    const armIn = (delay: number) => {
      if (timerRef.current != null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void request()
      }, Math.max(0, delay))
    }

    /**
     * Whether this field is in a state where a continuation is allowed.
     * Shared by the idle timer and the focus/click re-arm paths so they agree.
     */
    const canContinue = (): boolean => {
      if (document.activeElement !== el) return false
      const value = el.value
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      // A real selection is for rewrite/grammar, not a ghost.
      if (start !== end) return false
      // Need something before the caret to continue from.
      if (!value.slice(0, start).trim()) return false
      if (dismissCountRef.current >= MAX_DISMISSALS) return false
      if (dismissedAtRef.current === paragraphKeyAt(value, start)) return false
      return true
    }

    const request = async () => {
      if (!canContinue()) return
      // A failing provider backs off on its own rather than being retried on
      // every pause, and says so in one muted place instead of in the text.
      if (!ghostReady()) {
        // Re-armed for the moment the backoff lifts. Returning flat meant a user
        // who stopped typing during a five-minute wait never got another
        // attempt, while the control promised one "shortly".
        armIn(ghostRetryAt - Date.now() + 50)
        return
      }
      const value = el.value
      const caret = el.selectionStart ?? 0
      // Prompt is only what leads into the caret — not the whole block. Latch on
      // that too, so typing below an earlier paragraph does not look like "same
      // request" as the prefix of a previous line.
      const before = value.slice(0, caret)
      // Latch only after a finished answer (usable or deliberately empty). Failures
      // leave this alone so the same text is asked again once backoff lifts —
      // previously a 502 permanently silenced the field until three more keystrokes,
      // while the control still promised it would "try again shortly".
      if (lastRequestedRef.current === before) return
      if (!meaningfulChange(lastRequestedRef.current, before)) return

      const controller = new AbortController()
      abortRef.current = controller
      // The pill only appears for a request slow enough to be worth mentioning,
      // so a quick answer no longer flashes one on and off.
      busyTimerRef.current = setTimeout(() => {
        busyTimerRef.current = null
        setBusy(true)
      }, GHOST_BUSY_GRACE_MS)
      try {
        const res = await api.llmComplete(
          {
            task: 'continue',
            prompt: tail(before, MAX_PROMPT),
            context: surroundingContext(contextRef.current, value),
          },
          controller.signal,
        )
        if (controller.signal.aborted) return
        // Still the same document and caret — otherwise this answer is for a
        // place the user has already left.
        if (el.value !== value || el.selectionStart !== caret || el.selectionEnd !== caret) {
          wastedRef.current += 1
          return
        }
        const suffix = continuationSuffix(before, res.text)
        if (!suffix.trim()) {
          // Empty is a real answer for "nothing sensible follows", but it must
          // not block a later retry if the user keeps editing nearby — only latch
          // so we do not re-hit the same exact string every idle tick.
          lastRequestedRef.current = before
          noteGhostSuccess()
          return
        }
        lastRequestedRef.current = before
        noteGhostSuccess()
        setGhost({ text: suffix, base: value, caret })
      } catch (e) {
        if (controller.signal.aborted || isAbort(e)) return
        // Leave lastRequested alone so the same text is asked again after backoff.
        noteGhostFailure(messageOf(e))
        armIn(ghostRetryAt - Date.now() + 50)
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null
          if (busyTimerRef.current != null) {
            clearTimeout(busyTimerRef.current)
            busyTimerRef.current = null
          }
          setBusy(false)
        }
      }
    }

    const schedule = () => {
      const ignored = Math.min(Math.max(wastedRef.current - 1, 0), 3)
      armIn(Math.min(GHOST_MAX_DELAY_MS, GHOST_DELAY_MS * 2 ** ignored))
    }

    /**
     * Re-arm when the caret is ready, without requiring more typing.
     * Click-to-place and focus used to kill the idle timer and never start another,
     * so "type a sentence, click, wait" produced nothing forever.
     */
    const scheduleIfReady = () => {
      if (!canContinue()) return
      if (
        ghostRef.current &&
        ghostRef.current.base === el.value &&
        ghostRef.current.caret === (el.selectionStart ?? 0)
      ) {
        return
      }
      schedule()
    }

    const onInput = () => {
      stop()
      if (selfEditRef.current) {
        // Our own insertion. Suggesting a continuation of the continuation the
        // instant it lands made the system most eager exactly after it was used.
        clear()
        return
      }
      clear()
      // A dismissal is not reset here: Esc used to buy exactly one keystroke.
      schedule()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const current = ghostRef.current
      if (current && isAcceptChord(e)) {
        if (el.value !== current.base) {
          // The field moved without an input event. Swallowing the chord here
          // made it a dead key that also took the suggestion with it; instead the
          // chord goes through untouched and a fresh continuation is asked for.
          clear()
          schedule()
          return
        }
        e.preventDefault()
        accept()
        return
      }
      if (current && e.key === 'Escape') {
        // Handled by the field wrapper's React onKeyDown, together with the
        // proposal card and the selection menu, so all three cancels decide about
        // propagation in one place instead of a native listener quietly eating
        // Escape before React's root ever sees it.
        return
      }
      if (MODIFIER_KEYS.has(e.key)) return
      if (isAppShortcut(e)) return
      if (!isTypingKey(e)) {
        // Navigation: the suggestion goes, because it was written for a caret
        // that has just moved — but it is not held against the next one, and the
        // next one is still coming. Pressing End before pausing to think used to
        // disarm the request for good, since nothing but an input event ever
        // re-armed it.
        clear()
        // Defer: selectionStart is not updated until after keydown for arrows/Home/End.
        queueMicrotask(scheduleIfReady)
        return
      }
      // Typing straight past a suggestion — the one gesture that actually means
      // "not interested". The input event that follows re-arms the timer.
      drop()
      stop()
    }

    const onPointerDown = () => {
      // Clicking inside your own paragraph is not a rejected suggestion. It used
      // to be counted as one, which is how four clicks bought an eight-second
      // wait on every later suggestion.
      stop()
      clear()
    }

    const onPointerUp = () => {
      // pointerdown killed the timer so a drag-select does not fire mid-gesture.
      // Once the caret has settled, re-arm when it landed at the end.
      queueMicrotask(scheduleIfReady)
    }

    const onFocus = () => {
      // Tabbing into a finished paragraph (or returning from the AI popover)
      // used to wait forever — only `input` armed the timer.
      queueMicrotask(scheduleIfReady)
    }

    const onBlur = () => {
      // Always disarm first. Returning early here left the idle timer running
      // through an alt-tab, and `request` treats a blurred window's
      // `activeElement` as still focused — so the guard meant to save a billed
      // call fired one from a background tab instead.
      stop()
      // Alt-tab is not leaving the field: the window lost focus, not the caret.
      // The suggestion and the field's own history stay as they were.
      if (!document.hasFocus()) return
      clear()
      // A fresh visit starts clean — including the backoff, which otherwise only
      // ever came down by accepting AI text or reloading the page.
      resume()
      wastedRef.current = 0
      lastRequestedRef.current = null
    }

    el.addEventListener('input', onInput)
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('focus', onFocus)
    el.addEventListener('blur', onBlur)
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    // Already focused when listeners attach (enabled just flipped on, or effect
    // re-ran after a selection closed): do not wait for another keystroke.
    if (document.activeElement === el) scheduleIfReady()
    return () => {
      el.removeEventListener('input', onInput)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('focus', onFocus)
      el.removeEventListener('blur', onBlur)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      stop()
    }
  }, [el, enabled, paused, contextRef, accept, clear, drop, resume, stop])

  return {
    ghost,
    busy,
    snoozed,
    inserted: outcome.inserted,
    failedText: outcome.failedText,
    clearFailed: outcome.clearFailed,
    dismiss,
    resume,
  }
}

/* ===== Selection actions ===== */

export type TextSelection = { start: number; end: number; text: string }

export type LlmProposal = {
  task: LlmTask
  original: string
  /** Ready to drop in, outer whitespace of the selection included. */
  text: string
  start: number
  end: number
  /** Field contents the range refers to. */
  base: string
  providerName: string
  model: string
}

export type SelectionActions = {
  selection: TextSelection | null
  proposal: LlmProposal | null
  /** The task currently running, or null. */
  busy: LlmTask | null
  error: string | null
  /** The field changed under a proposal, so its range no longer means anything. */
  stale: boolean
  /** Bumped each time a replacement was actually written into the field. */
  inserted: number
  /** A replacement the browser refused to insert, kept so it can be copied. */
  failedText: string | null
  clearFailed: () => void
  /** Bumped when the keyboard asks for the menu, so it can take focus. */
  menuFocusTick: number
  run: (task: LlmTask) => void
  accept: () => void
  reject: () => void
  /** Abandon the request in flight, leaving the selection and the menu as they were. */
  cancel: () => void
  /** Esc on the menu: close it without touching the selected text. */
  close: () => void
  dismissError: () => void
}

type SelectionOptions = {
  el: HTMLTextAreaElement | null
  enabled: boolean
  contextRef: RefObject<string>
  /** The field wrapper: focus moving inside it (onto the menu) keeps the selection. */
  wrapRef: RefObject<HTMLElement | null>
}

/**
 * Rewrite / grammar / format / summarize over the selected text.
 *
 * The result is never written back on its own — it is held as a proposal until
 * the user accepts it, so a bad answer costs one click instead of an undo.
 */
export function useSelectionActions({
  el,
  enabled,
  contextRef,
  wrapRef,
}: SelectionOptions): SelectionActions {
  const [selection, setSelection] = useState<TextSelection | null>(null)
  const [proposal, setProposal] = useState<LlmProposal | null>(null)
  const [busy, setBusy] = useState<LlmTask | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [menuFocusTick, setMenuFocusTick] = useState(0)
  const outcome = useInsertOutcome()
  const { write } = outcome

  const selectionRef = useRef<TextSelection | null>(null)
  selectionRef.current = selection
  const proposalRef = useRef<LlmProposal | null>(null)
  proposalRef.current = proposal
  const abortRef = useRef<AbortController | null>(null)
  /** A range whose menu was closed with Esc; it stays closed until the range moves. */
  const closedRef = useRef<{ start: number; end: number } | null>(null)

  useEffect(() => {
    if (!el || !enabled) {
      setSelection(null)
      return
    }

    const sync = () => {
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      const closed = closedRef.current
      if (closed && closed.start === start && closed.end === end) return
      closedRef.current = null
      const text = el.value.slice(start, end)
      setSelection(text.trim().length >= MIN_SELECTION ? { start, end, text } : null)
    }

    const onInput = () => {
      sync()
      if (proposalRef.current) setStale(true)
    }

    // Tabbing towards the menu must not take the menu away: only focus leaving
    // the whole field ends the selection. A pending proposal outlives it either
    // way, since accepting one necessarily moves focus to its buttons.
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget
      if (next instanceof Node && wrapRef.current?.contains(next)) return
      setSelection(null)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // An opening shortcut: the menu is otherwise only reachable by tabbing,
      // which is not obvious enough to be the only way in. Ctrl/Cmd+. rather
      // than the usual Ctrl+Shift+A, which Firefox keeps for its add-ons window.
      if (!isMenuChord(e)) return
      if (!selectionRef.current) return
      e.preventDefault()
      e.stopPropagation()
      setMenuFocusTick((n) => n + 1)
    }

    el.addEventListener('select', sync)
    el.addEventListener('keyup', sync)
    el.addEventListener('mouseup', sync)
    el.addEventListener('input', onInput)
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('focusout', onFocusOut)
    return () => {
      el.removeEventListener('select', sync)
      el.removeEventListener('keyup', sync)
      el.removeEventListener('mouseup', sync)
      el.removeEventListener('input', onInput)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [el, enabled, wrapRef])

  useEffect(() => () => abortRef.current?.abort(), [])

  const run = useCallback(
    (task: LlmTask) => {
      const sel = selectionRef.current
      if (!el || !sel) return
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const base = el.value
      setBusy(task)
      setError(null)
      setStale(false)

      void (async () => {
        try {
          const res = await api.llmComplete(
            {
              task,
              selection: sel.text.slice(0, MAX_SELECTION),
              context: surroundingContext(contextRef.current, base),
            },
            controller.signal,
          )
          if (controller.signal.aborted) return
          // Models answer without the spacing that held the selection to its
          // neighbours, so the original's outer whitespace is put back.
          const lead = /^\s*/.exec(sel.text)?.[0] ?? ''
          const trailing = /\s*$/.exec(sel.text.slice(lead.length))?.[0] ?? ''
          setProposal({
            task,
            original: sel.text,
            text: lead + res.text.trim() + trailing,
            start: sel.start,
            end: sel.end,
            base,
            providerName: res.providerName,
            model: res.model,
          })
          setStale(el.value !== base)
        } catch (e) {
          if (controller.signal.aborted || isAbort(e)) return
          setError(messageOf(e))
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null
            setBusy(null)
          }
        }
      })()
    },
    [el, contextRef],
  )

  const accept = useCallback(() => {
    const current = proposalRef.current
    if (!el || !current) return
    if (el.value !== current.base) {
      setStale(true)
      return
    }
    // Cleared first: writing the value fires input, which would otherwise flag
    // the proposal we are in the middle of applying as stale.
    proposalRef.current = null
    setProposal(null)
    setSelection(null)
    // Caret after the replacement rather than across it: re-selecting the text
    // would pop the action menu straight back up over what was just accepted.
    write(el, current.start, current.end, current.text)
  }, [el, write])

  const reject = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    proposalRef.current = null
    setProposal(null)
    setBusy(null)
    setStale(false)
  }, [])

  /**
   * Stop waiting for an answer.
   *
   * Escape had nothing to cancel while a request was running, because the button
   * that started it took `disabled` and dropped focus to <body> — so the
   * wrapper's key handler never fired in the one situation it was wanted most.
   */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(null)
  }, [])

  const close = useCallback(() => {
    const sel = selectionRef.current
    if (sel) closedRef.current = { start: sel.start, end: sel.end }
    setSelection(null)
    el?.focus()
  }, [el])

  const dismissError = useCallback(() => setError(null), [])

  return {
    selection,
    proposal,
    busy,
    error,
    stale,
    inserted: outcome.inserted,
    failedText: outcome.failedText,
    clearFailed: outcome.clearFailed,
    menuFocusTick,
    run,
    accept,
    reject,
    cancel,
    close,
    dismissError,
  }
}
