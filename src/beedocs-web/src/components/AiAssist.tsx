import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import {
  IS_APPLE,
  resumeGhostNow,
  resumeGhostSuggestions,
  useCaretAnchor,
  useGhostHealth,
  useGhostSnoozed,
  useGhostText,
  useInlineSuggestions,
  useInlineSuggestionsChosen,
  useLlmAvailability,
  useSelectionActions,
  useTextareaMirror,
  type GhostSuggestion,
  type LlmProposal,
  type TextSelection,
} from '../hooks/useLlmAssist'
import type { LlmTask } from '../types'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import '../styles/ai-assist.css'

/** The four selection actions, labelled at render via `editor.ai.task.*`. */
const TASK_ACTIONS: readonly LlmTask[] = ['rewrite', 'grammar', 'format', 'summarize']

/** The chord that accepts a continuation, written the way the keyboard has it. */
const ACCEPT_KEY = IS_APPLE ? '⌘' : 'Ctrl'
/** Spelled out for the live region: a screen reader reads "⌘" as nothing useful. */
const ACCEPT_SPOKEN_KEY: MessageKey = IS_APPLE
  ? 'editor.ai.spokenAcceptMac'
  : 'editor.ai.spokenAcceptWin'
/** A superseded suggestion must not queue an utterance of its own. */
const ANNOUNCE_DELAY_MS = 700

function taskLabel(t: TFunction, task: LlmTask): string {
  return t(`editor.ai.task.${task}` as MessageKey)
}

/**
 * A suggestion as it should be read out: whole.
 *
 * It used to be cut to 120 characters, which asked someone who cannot see the
 * field to commit prose they had only heard the opening of. Only the line breaks
 * are flattened — a screen reader announces a live region as one utterance
 * anyway.
 */
function speakable(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * What the assistant says out loud.
 *
 * Never the busy state: that fired on every typing pause, which is an
 * interruption every few seconds. A suggestion that has landed, with its text —
 * and the fact that it went in, which nothing used to confirm.
 */
function useAssistAnnouncement(
  ghost: GhostSuggestion | null,
  proposal: LlmProposal | null,
  inserted: number,
): string {
  const { t } = useI18n()
  const [message, setMessage] = useState('')
  // Two suggestions in a row can be identical, and identical state is no state
  // change — so the live region never spoke the second one. An alternating
  // zero-width space is a different string and nothing anyone hears.
  const seq = useRef(0)
  const say = useCallback((text: string) => {
    seq.current += 1
    setMessage(text ? text + '\u200b'.repeat(seq.current % 2) : '')
  }, [])
  const lastInserted = useRef(inserted)

  useEffect(() => {
    if (inserted !== lastInserted.current) {
      lastInserted.current = inserted
      say(t('editor.ai.announceInserted'))
      return
    }
    if (proposal) {
      say(
        t('editor.ai.announceReady', {
          task: taskLabel(t, proposal.task),
          text: speakable(proposal.text),
        }),
      )
      return
    }
    if (!ghost) {
      say('')
      return
    }
    // Debounced, so a suggestion replaced a moment later is never spoken at all.
    const timer = setTimeout(() => {
      say(
        t('editor.ai.announceGhost', {
          text: speakable(ghost.text),
          keys: t(ACCEPT_SPOKEN_KEY),
        }),
      )
    }, ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [ghost, proposal, inserted, say, t])

  return message
}

/**
 * The suggestion, drawn on top of the field rather than inserted into it.
 *
 * The text blocks are uncontrolled on purpose (see SyncedText), so anything
 * written into their value would either be lost or eat keystrokes. This copies
 * the field's own metrics onto a transparent duplicate of the current text and
 * puts the continuation right after it, which is the only way the two stay lined
 * up through resizes, wrapping and every theme.
 *
 * The field never changes size for it. What does not fit is clipped at the last
 * whole line — never a sliced one — and `onCut` reports the character the field
 * ran out of room at, so the panel below can carry on from exactly there and
 * nothing is shown twice.
 */
function GhostOverlay({
  el,
  base,
  text,
  onCut,
}: {
  el: HTMLTextAreaElement
  base: string
  text: string
  /** Index in `text` the field could not show, or null when all of it fits. */
  onCut: (cut: number | null) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const cut = useTextareaMirror(el, boxRef, base, text)

  useEffect(() => {
    onCut(cut)
    return () => onCut(null)
  }, [cut, onCut])

  return (
    <div className="ai-ghost" ref={boxRef} aria-hidden="true">
      <span className="ai-ghost-shadow">{base}</span>
      <span className="ai-ghost-text" data-ghost-run="">
        {text}
      </span>
    </div>
  )
}

/**
 * The strip under the field: how to accept, and the part of the suggestion the
 * field had no room for.
 *
 * In the flow, not over it. Floating it under the caret put it on top of the
 * next block — measured at 85% of that block's height — while `pointer-events:
 * none` let the user click into text they could not see and type blind into it.
 * Displacing what follows costs a reflow when a suggestion arrives; covering it
 * cost the user their words.
 */
function GhostPanel({
  ghost,
  busy,
  cut,
}: {
  ghost: GhostSuggestion | null
  busy: boolean
  cut: number | null
}) {
  const { t } = useI18n()
  // Exactly the characters the field could not draw. Leading blank lines are the
  // joiner rather than the suggestion — the field already shows the break that
  // will be committed, so repeating it here would open the strip with empty rows.
  const rest = ghost && cut != null ? ghost.text.slice(cut).replace(/^\n+/, '') : ''

  return (
    <div className={`ai-assist-hud${busy ? ' is-busy' : ''}`} aria-hidden="true">
      {busy ? (
        <span className="ai-assist-hud-keys">
          <span className="ai-assist-spark" />
          {t('editor.ai.thinking')}
        </span>
      ) : (
        <>
          {rest.trim() && (
            // The ellipsis is part of the text, not a chip beside it: it reads as
            // "this carries on from the field" rather than as a UI token parked
            // in the margin.
            <p className="ai-assist-hud-text">…{rest}</p>
          )}
          <span className="ai-assist-hud-keys">
            <kbd>{ACCEPT_KEY}</kbd>
            <kbd>Enter</kbd> {t('editor.ai.hudAccept')} · <kbd>Esc</kbd> {t('editor.ai.hudDismiss')}
          </span>
        </>
      )}
    </div>
  )
}

/**
 * The one thing to do when the browser will not accept an insertion.
 *
 * There used to be a `setRangeText` fallback here with a hand-rolled undo shim
 * behind it, and that shim removed the wrong insertion once two suggestions had
 * been accepted into the same block. Text is either written the way typing
 * writes it — on the native undo stack — or it is not written at all and offered
 * for copying. The suggestion is selected on arrival so the keystroke the
 * message names actually works.
 */
function InsertFallback({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const { t } = useI18n()
  const textRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const selectAll = useCallback(() => {
    const node = textRef.current
    if (!node) return
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.focus()
  }, [])

  useEffect(selectAll, [selectAll])

  const copy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      } catch {
        // Clipboard permission denied, or no secure context: the text is
        // already selected, so the keyboard route still works.
        selectAll()
      }
    })()
  }

  return (
    <div className="ai-assist-fallback" role="alert">
      <p className="ai-assist-fallback-msg sm">
        {t('editor.ai.copyFallback', { key: ACCEPT_KEY })}
      </p>
      <pre className="ai-assist-text is-proposed" ref={textRef} tabIndex={-1}>
        {text}
      </pre>
      <div className="ai-assist-proposal-actions">
        <button type="button" className="btn sm" onClick={copy}>
          {copied ? t('editor.ai.copied') : t('common.copy')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onDismiss}>
          {t('editor.ai.dismiss')}
        </button>
      </div>
    </div>
  )
}

type MenuItem = { key: string; label: string; run: () => void; inert: boolean }

/** Actions for the current selection, anchored under the line it ends on. */
function SelectionMenu({
  el,
  selection,
  busy,
  focusTick,
  onRun,
  onCancel,
}: {
  el: HTMLTextAreaElement
  selection: TextSelection
  busy: LlmTask | null
  /** Bumped when the keyboard shortcut asks the toolbar to take focus. */
  focusTick: number
  onRun: (task: LlmTask) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const point = useCaretAnchor(el, selection.end, true)
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([])

  const items: MenuItem[] = TASK_ACTIONS.map((task) => ({
    key: task,
    label: busy === task ? `${taskLabel(t, task)}…` : taskLabel(t, task),
    run: () => onRun(task),
    // Not `disabled`: disabling the button under the pointer that just pressed
    // it drops focus to <body>, which took Escape, Tab order and the announced
    // label change with it. aria-disabled says the same thing and keeps focus.
    inert: busy != null,
  }))
  // Always mounted, for the same reason. Pushing it only while busy meant the
  // click that cancelled unmounted the button under the pointer — re-creating
  // the exact focus drop aria-disabled is here to prevent.
  items.push({ key: 'cancel', label: t('common.cancel'), run: onCancel, inert: busy == null })

  // Measured, not assumed: the old clamp hardcoded the width of four English
  // labels, and never flipped, so a selection on the last line put the menu off
  // the bottom of the window.
  useLayoutEffect(() => {
    const menu = menuRef.current
    const host = menu?.offsetParent
    if (!menu || !(host instanceof HTMLElement) || !point) return
    const left = Math.max(0, Math.min(point.left, host.clientWidth - menu.offsetWidth))
    const below = point.top + point.lineHeight + 6
    const above = point.top - menu.offsetHeight - 6
    const hostTop = host.getBoundingClientRect().top
    const flip =
      hostTop + below + menu.offsetHeight > window.innerHeight && hostTop + above >= 0
    setBox({ top: flip ? above : below, left })
  }, [point, busy])

  useEffect(() => {
    if (focusTick === 0) return
    setActive(0)
    buttonsRef.current[0]?.focus()
  }, [focusTick])

  if (!point) return null

  // One tab stop for the whole toolbar, arrows between the actions — the pattern
  // a toolbar promises the moment it calls itself one.
  const current = Math.min(active, items.length - 1)
  const step = (delta: number) => {
    const next = (current + delta + items.length) % items.length
    setActive(next)
    buttonsRef.current[next]?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
      buttonsRef.current[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      const last = items.length - 1
      setActive(last)
      buttonsRef.current[last]?.focus()
    }
  }

  return (
    <div
      className="ai-assist-menu"
      role="toolbar"
      aria-label={t('editor.ai.menuLabel')}
      aria-orientation="horizontal"
      aria-busy={busy != null}
      ref={menuRef}
      style={{
        top: `${box ? box.top : point.top + point.lineHeight + 6}px`,
        left: `${box ? box.left : point.left}px`,
        visibility: box ? undefined : 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      <span className="ai-assist-badge">AI</span>
      {items.map((item, i) => (
        <button
          key={item.key}
          type="button"
          className="btn sm"
          ref={(node) => {
            buttonsRef.current[i] = node
          }}
          tabIndex={i === current ? 0 : -1}
          aria-disabled={item.inert || undefined}
          onFocus={() => setActive(i)}
          // The pointer must not drag the selection out from under the action it
          // is about to run, so focus is moved by hand rather than by the click.
          onMouseDown={(e) => {
            e.preventDefault()
            e.currentTarget.focus()
          }}
          onClick={() => {
            if (item.inert) return
            item.run()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** The answer, held next to the original until someone picks one. */
function ProposalCard({
  proposal,
  stale,
  onAccept,
  onReject,
}: {
  proposal: LlmProposal
  stale: boolean
  onAccept: () => void
  onReject: () => void
}) {
  const { t } = useI18n()
  const label = taskLabel(t, proposal.task)
  const cardRef = useRef<HTMLDivElement>(null)

  // The menu button that started this may have unmounted, so without this focus
  // lands on the body and Escape has nothing to close.
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const focused = document.activeElement
    if (focused && focused !== document.body && !card.contains(focused)) return
    card.focus()
  }, [])

  return (
    <div
      className="ai-assist-proposal"
      role="group"
      aria-label={t('editor.ai.proposalLabel', { task: label })}
      ref={cardRef}
      tabIndex={-1}
    >
      <div className="ai-assist-proposal-head">
        <span className="ai-assist-badge">{label}</span>
        <span className="muted sm">{proposal.model || proposal.providerName}</span>
      </div>
      <div className="ai-assist-proposal-body">
        <div className="ai-assist-proposal-col">
          <span className="ai-assist-col-label">{t('editor.ai.colSelected')}</span>
          <pre className="ai-assist-text is-original">{proposal.original}</pre>
        </div>
        <div className="ai-assist-proposal-col">
          <span className="ai-assist-col-label">{t('editor.ai.colProposed')}</span>
          <pre className="ai-assist-text is-proposed">{proposal.text}</pre>
        </div>
      </div>
      {stale && (
        <p className="ai-assist-note sm">{t('editor.ai.staleNote')}</p>
      )}
      <div className="ai-assist-proposal-actions">
        <button type="button" className="btn primary sm" disabled={stale} onClick={onAccept}>
          {t('editor.ai.replaceSelection')}
        </button>
        <button type="button" className="btn ghost sm" onClick={onReject}>
          {t('editor.ai.discard')}
        </button>
      </div>
    </div>
  )
}

type FieldProps = {
  /** Page markdown, sent as grounding for whatever this block asks for. */
  context: string
  /** Exactly one SyncedTextarea. */
  children: ReactNode
}

/**
 * Wraps a prose textarea with inline continuations and selection actions.
 *
 * The field is found in the DOM rather than handed over as a ref, so the
 * uncontrolled text blocks keep their own value handling untouched — nothing
 * here writes through React.
 *
 * Nothing here resizes the field either. The round-3 fit-to-content pass wrote a
 * `min-height` that beat the resize grip's inline height — a fitted block could
 * not be dragged shorter again — and its own early-out meant it never ran for a
 * block that was not already overflowing, which is nearly all of them. The
 * suggestion is clipped at the field's real bottom and continues in the strip
 * below it instead.
 */
export function AiAssistField({ context, children }: FieldProps) {
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null)
  /** Where the field ran out of room for the suggestion, in its characters. */
  const [cut, setCut] = useState<number | null>(null)
  const contextRef = useRef(context)
  contextRef.current = context

  // Once on mount: a wrapper holds the same textarea for its whole life. The
  // page editor keys blocks by identity and is itself keyed by page, so a
  // different block never arrives in this wrapper.
  useLayoutEffect(() => {
    setEl(wrapRef.current?.querySelector('textarea') ?? null)
  }, [])

  const { active } = useLlmAvailability()
  const [inlineOn] = useInlineSuggestions()
  const available = active != null

  const actions = useSelectionActions({ el, enabled: available, contextRef, wrapRef })
  const ghost = useGhostText({
    el,
    enabled: available && inlineOn,
    contextRef,
    // Never both at once: a live selection, a running action or a proposal on
    // screen all mean the user is working on text they already have.
    paused: actions.selection != null || actions.busy != null || actions.proposal != null,
  })

  const status = useAssistAnnouncement(
    ghost.ghost,
    actions.proposal,
    ghost.inserted + actions.inserted,
  )

  // One at a time, and whichever failed most recently owns the strip.
  const failedText = ghost.failedText ?? actions.failedText
  const clearFailed = ghost.failedText ? ghost.clearFailed : actions.clearFailed

  /**
   * Escape, in the order the things on screen were asked for: a request still
   * running, then the proposal, then the selection menu, then the ghost. All
   * four live here rather than half of them in a native listener, so exactly one
   * place decides whether Escape also reaches the pane behind the editor.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return
    if (actions.busy) {
      e.preventDefault()
      e.stopPropagation()
      actions.cancel()
      return
    }
    if (actions.proposal) {
      e.preventDefault()
      e.stopPropagation()
      actions.reject()
      el?.focus()
      return
    }
    if (actions.selection) {
      e.preventDefault()
      e.stopPropagation()
      actions.close()
      return
    }
    if (ghost.ghost) {
      e.preventDefault()
      e.stopPropagation()
      ghost.dismiss()
    }
  }

  return (
    <div className="ai-assist-field" ref={wrapRef} onKeyDown={onKeyDown}>
      {children}
      {el && ghost.ghost && (
        // Shadow only the text before the caret so the ghost sits at the caret,
        // not after the whole block (which is what made mid-page typing invisible).
        <GhostOverlay
          el={el}
          base={ghost.ghost.base.slice(0, ghost.ghost.caret)}
          text={ghost.ghost.text}
          onCut={setCut}
        />
      )}
      {/* Only ever the continuation's own work. A selection action already says
          "Rewrite…" on the button beside the selection, and a second "Thinking"
          card at the bottom of the block was reporting it twice. */}
      {el && (ghost.ghost || ghost.busy) && (
        <GhostPanel ghost={ghost.ghost} busy={ghost.busy} cut={cut} />
      )}
      {el && available && actions.selection && !actions.proposal && (
        <SelectionMenu
          el={el}
          selection={actions.selection}
          busy={actions.busy}
          focusTick={actions.menuFocusTick}
          onRun={actions.run}
          onCancel={actions.cancel}
        />
      )}
      <span className="ai-sr-only" role="status" aria-live="polite">
        {status}
      </span>
      {failedText && <InsertFallback text={failedText} onDismiss={clearFailed} />}
      {actions.proposal && (
        <ProposalCard
          proposal={actions.proposal}
          stale={actions.stale}
          onAccept={actions.accept}
          onReject={actions.reject}
        />
      )}
      {/* Only ever a failure the user asked for: a background continuation that
          fails goes to the AI control's muted state instead of shouting here. */}
      {actions.error && (
        <div className="ai-assist-error" role="alert">
          <span className="ai-assist-error-text">{actions.error}</span>
          <button type="button" className="btn ghost sm" onClick={actions.dismissError}>
            {t('editor.ai.dismiss')}
          </button>
        </div>
      )}
    </div>
  )
}

type AssistState = {
  key: 'inline' | 'selection' | 'paused' | 'snoozed'
  /** Shape as well as colour, so the state survives a monochrome reading. */
  glyph: string
}

/**
 * The state's word lives at `editor.ai.state.{key}` and what it means for the
 * user's prose at `editor.ai.stateDesc.{key}` — looked up where it is rendered.
 */
function assistState(inlineOn: boolean, degraded: boolean, snoozed: boolean): AssistState {
  // The deliberate choice wins over the failure: someone who turned inline
  // suggestions off was being told the feature was "paused", which reads as a
  // fault they should do something about.
  if (!inlineOn) return { key: 'selection', glyph: '○' }
  if (degraded) return { key: 'paused', glyph: '⚠' }
  // The snoozed copy is scoped honestly: the lockout belongs to a block, and it
  // lifts by itself when you leave that block.
  if (snoozed) return { key: 'snoozed', glyph: '◐' }
  return { key: 'inline', glyph: '●' }
}

/**
 * Editor-level AI control: one small affordance that opens what used to be a
 * permanent strip — a switch nobody touches twice a year, the help text, and
 * where the answers come from. Hidden entirely until a provider is configured,
 * so a workspace that never sets one up never hears about it.
 */
export function AiAssistBar() {
  const { t } = useI18n()
  const { active } = useLlmAvailability()
  const [inlineOn, setInlineOn] = useInlineSuggestions()
  const chosen = useInlineSuggestionsChosen()
  const health = useGhostHealth()
  const snoozed = useGhostSnoozed()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    const focused = document.activeElement
    // Only take focus back if it was ours to begin with — otherwise a click
    // elsewhere would be undone by the thing it was closing.
    if (restoreFocus || (focused instanceof Node && panelRef.current?.contains(focused))) {
      buttonRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, close])

  // Focus moves in, so Escape has something to fire on and a keyboard user is
  // not left tabbing from the top of the document to reach what they opened.
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>('input, button, a[href]')?.focus()
  }, [open])

  if (!active) return null

  const state = assistState(inlineOn, health.degraded, snoozed)
  const stateWord = t(`editor.ai.state.${state.key}` as MessageKey)

  return (
    <div
      className="ai-assist-bar"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.stopPropagation()
        close(true)
      }}
      // Tab used to walk straight out of the panel and leave it hanging open. It
      // is a disclosure, not a dialog: nothing traps focus, so losing focus
      // closes it. A null relatedTarget is the window going away, not the user.
      onBlur={(e) => {
        if (!open) return
        const next = e.relatedTarget
        if (!(next instanceof Node) || rootRef.current?.contains(next)) return
        setOpen(false)
      }}
    >
      <button
        type="button"
        className="ai-assist-bar-btn"
        ref={buttonRef}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={t('editor.ai.helpAria', { state: stateWord })}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {/* No "AI" badge beside the words "AI help": the token was printed twice
            inside seven characters and took half the control's width. The badge
            still marks generated text, where it means something. */}
        <span>{t('editor.ai.help')}</span>
        <span className={`ai-assist-pill is-${state.key}`}>
          <span aria-hidden="true">{state.glyph}</span> {stateWord}
        </span>
        <span className="ai-assist-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="ai-assist-popover" id={panelId} ref={panelRef}>
          <label className="ai-assist-switch">
            <input
              type="checkbox"
              role="switch"
              checked={inlineOn}
              onChange={(e) => setInlineOn(e.target.checked)}
            />
            <span>{t('editor.ai.inlineSwitch')}</span>
          </label>
          <p className="ai-assist-popover-state sm">
            {t(`editor.ai.stateDesc.${state.key}` as MessageKey)}
          </p>
          {!chosen && (
            // The one and only offer. Turning a provider on is a different
            // decision, made on a different screen, and it used to switch this
            // on by itself.
            <p className="ai-assist-popover-hint muted sm">{t('editor.ai.inlineOffHint')}</p>
          )}
          {/* Only when there is something to pause for: with the switch off, the
              panel promised a continuation one line after saying nothing is sent
              until you select text. */}
          {inlineOn && (
            <p className="ai-assist-popover-hint muted sm">
              {t('editor.ai.inlineHint', { key: ACCEPT_KEY })}
            </p>
          )}
          <p className="ai-assist-popover-hint muted sm">
            {t('editor.ai.selectHint', { key: ACCEPT_KEY })}
          </p>
          {snoozed && (
            // Both of these buttons remove themselves — the state they undo is
            // what renders them — so each hands focus back before it goes, or it
            // would fall to <body> and take Escape and the tab order with it.
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                resumeGhostSuggestions()
                buttonRef.current?.focus()
              }}
            >
              {t('editor.ai.resumeAll')}
            </button>
          )}
          {health.degraded && (
            <>
              <p className="ai-assist-popover-note sm">
                {t('editor.ai.pausedNote')}
                {health.reason ? ` ${health.reason}` : ''} {t('editor.ai.pausedResumeNote')}
              </p>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  resumeGhostNow()
                  buttonRef.current?.focus()
                }}
              >
                {t('editor.ai.resumeNow')}
              </button>
            </>
          )}
          <Link className="btn ghost sm" to="/settings/ai">
            {active.name} · {active.model || t('editor.ai.firstListedModel')}
          </Link>
        </div>
      )}
    </div>
  )
}
