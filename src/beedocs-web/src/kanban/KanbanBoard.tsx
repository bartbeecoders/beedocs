import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUserDirectory, userLabel } from '../hooks/useUserDirectory'
import { useI18n, type MessageKey } from '../i18n'
import type { UserSummary } from '../types'
import {
  KANBAN_COLORS,
  addCard,
  addColumn,
  moveCard,
  moveColumn,
  parseBoard,
  removeCard,
  removeColumn,
  renameColumn,
  resolveAssigneeName,
  serializeBoard,
  setColumnWip,
  updateCard,
  type KanbanCard,
  type KanbanColor,
  type KanbanColumn,
  type KanbanDoc,
} from './kanbanModel'
import '../styles/kanban.css'

const CARD_MIME = 'application/x-beedocs-kanban-card'
const COL_MIME = 'application/x-beedocs-kanban-column'

const COLOR_KEYS: Record<KanbanColor, MessageKey> = {
  accent: 'kanban.color.accent',
  info: 'kanban.color.info',
  ok: 'kanban.color.ok',
  warn: 'kanban.color.warn',
  danger: 'kanban.color.danger',
  muted: 'kanban.color.muted',
}

type CardDrag = { cardId: string; fromColumnId: string }
type ColDrag = { columnId: string }

type Props = {
  source: string
  onChange: (source: string) => void
  /** Smaller chrome for page embeds. */
  compact?: boolean
  readOnly?: boolean
}

/** Inputs and selects must not start an HTML5 drag of the parent card/column. */
function isTextSelectTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION' || target.isContentEditable
}

export function KanbanBoard({ source, onChange, compact = false, readOnly = false }: Props) {
  const { t } = useI18n()
  const { users, loading } = useUserDirectory()
  const doc = useMemo(() => parseBoard(source), [source])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dropCol, setDropCol] = useState<string | null>(null)
  const [dropCard, setDropCard] = useState<{ colId: string; index: number } | null>(null)
  const [dropColIndex, setDropColIndex] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const emit = useCallback(
    (next: KanbanDoc) => {
      onChange(serializeBoard(next))
    },
    [onChange],
  )

  useEffect(() => {
    if (!selectedId) return
    const onDoc = (e: MouseEvent) => {
      const root = rootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) setSelectedId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [selectedId])

  const onCardDragStart = (e: React.DragEvent, card: KanbanCard, fromColumnId: string) => {
    if (readOnly) return
    if (isTextSelectTarget(e.target)) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(CARD_MIME, JSON.stringify({ cardId: card.id, fromColumnId } satisfies CardDrag))
    e.dataTransfer.setData('text/plain', card.title)
  }

  const onColDragStart = (e: React.DragEvent, columnId: string) => {
    if (readOnly) return
    if (isTextSelectTarget(e.target)) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(COL_MIME, JSON.stringify({ columnId } satisfies ColDrag))
  }

  const parseCardDrag = (e: React.DragEvent): CardDrag | null => {
    const raw = e.dataTransfer.getData(CARD_MIME)
    if (!raw) return null
    try {
      return JSON.parse(raw) as CardDrag
    } catch {
      return null
    }
  }

  const parseColDrag = (e: React.DragEvent): ColDrag | null => {
    const raw = e.dataTransfer.getData(COL_MIME)
    if (!raw) return null
    try {
      return JSON.parse(raw) as ColDrag
    } catch {
      return null
    }
  }

  const dropOnColumn = (e: React.DragEvent, col: KanbanColumn, index?: number) => {
    e.preventDefault()
    setDropCol(null)
    setDropCard(null)
    const card = parseCardDrag(e)
    if (card) {
      emit(moveCard(doc, card.cardId, col.id, index))
      return
    }
  }

  const dropColumnAt = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault()
    setDropColIndex(null)
    const col = parseColDrag(e)
    if (!col) return
    emit(moveColumn(doc, col.columnId, toIndex))
  }

  return (
    <div
      ref={rootRef}
      className={`kanban${compact ? ' is-compact' : ''}${readOnly ? ' is-readonly' : ''}`}
    >
      <div className="kanban-scroller">
        {doc.columns.map((col, colIndex) => {
          const over = col.wip != null && col.cards.length > col.wip
          return (
            <div key={col.id} className="kanban-col-wrap">
              {!readOnly && (
                <div
                  className={`kanban-col-drop${dropColIndex === colIndex ? ' is-over' : ''}`}
                  onDragOver={(e) => {
                    if (![...e.dataTransfer.types].includes(COL_MIME)) return
                    e.preventDefault()
                    setDropColIndex(colIndex)
                  }}
                  onDragLeave={() => setDropColIndex((v) => (v === colIndex ? null : v))}
                  onDrop={(e) => dropColumnAt(e, colIndex)}
                />
              )}
              <section
                className={`kanban-col${dropCol === col.id ? ' is-drop' : ''}${over ? ' is-wip-over' : ''}`}
                onDragOver={(e) => {
                  if (![...e.dataTransfer.types].includes(CARD_MIME)) return
                  e.preventDefault()
                  setDropCol(col.id)
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node)) return
                  setDropCol((v) => (v === col.id ? null : v))
                }}
                onDrop={(e) => dropOnColumn(e, col)}
              >
                <header
                  className="kanban-col-head"
                  draggable={!readOnly}
                  onDragStart={(e) => onColDragStart(e, col.id)}
                  title={readOnly ? undefined : t('kanban.dragColumn')}
                >
                  {readOnly ? (
                    <h3 className="kanban-col-title">{col.title || t('kanban.columnPlaceholder')}</h3>
                  ) : (
                    <input
                      className="kanban-col-title"
                      value={col.title}
                      onChange={(e) => emit(renameColumn(doc, col.id, e.target.value))}
                      placeholder={t('kanban.columnPlaceholder')}
                      aria-label={t('kanban.columnTitle')}
                      draggable={false}
                    />
                  )}
                  <span className={`kanban-col-count${over ? ' is-over' : ''}`} title={over ? t('kanban.wipExceeded') : t('kanban.wipHint')}>
                    {col.cards.length}
                    {col.wip != null ? `/${col.wip}` : ''}
                  </span>
                  {!readOnly && (
                    <>
                      <label className="kanban-wip">
                        <span className="visually-hidden">{t('kanban.wip')}</span>
                        <input
                          type="number"
                          min={0}
                          placeholder={t('kanban.wip')}
                          value={col.wip ?? ''}
                          onChange={(e) => {
                            const v = e.target.value.trim()
                            emit(setColumnWip(doc, col.id, v === '' ? null : Math.max(1, Number(v) || 0)))
                          }}
                          title={t('kanban.wipHint')}
                          draggable={false}
                        />
                      </label>
                      <button
                        type="button"
                        className="kanban-icon-btn"
                        title={t('kanban.deleteColumn')}
                        onClick={() => {
                          if (doc.columns.length <= 1) return
                          if (col.cards.length > 0 && !confirm(t('kanban.confirmDeleteColumn', { title: col.title })))
                            return
                          emit(removeColumn(doc, col.id))
                        }}
                      >
                        ×
                      </button>
                    </>
                  )}
                </header>
                <ol className="kanban-cards">
                  {col.cards.map((card, cardIndex) => {
                    const selected = selectedId === card.id
                    const who = resolveAssigneeName(card, users)
                    return (
                      <li key={card.id}>
                        {!readOnly && (
                          <div
                            className={`kanban-card-drop${
                              dropCard?.colId === col.id && dropCard.index === cardIndex ? ' is-over' : ''
                            }`}
                            onDragOver={(e) => {
                              if (![...e.dataTransfer.types].includes(CARD_MIME)) return
                              e.preventDefault()
                              e.stopPropagation()
                              setDropCard({ colId: col.id, index: cardIndex })
                            }}
                            onDrop={(e) => {
                              e.stopPropagation()
                              dropOnColumn(e, col, cardIndex)
                            }}
                          />
                        )}
                        <article
                          className={`kanban-card${selected ? ' is-selected' : ''}${card.color ? ` color-${card.color}` : ''}`}
                          draggable={!readOnly && !selected}
                          onDragStart={(e) => onCardDragStart(e, card, col.id)}
                          onClick={() => {
                            if (!readOnly) setSelectedId(card.id)
                          }}
                        >
                          <span className="kanban-card-stripe" aria-hidden />
                          {readOnly || !selected ? (
                            <>
                              <strong className="kanban-card-title">{card.title || t('kanban.cardPlaceholder')}</strong>
                              {!compact && card.body.trim() ? (
                                <p className="kanban-card-body">{card.body}</p>
                              ) : null}
                              {who ? <span className="kanban-assignee">{who}</span> : null}
                            </>
                          ) : (
                            <CardEditor
                              card={card}
                              users={users}
                              usersReady={!loading}
                              onPatch={(patch) => emit(updateCard(doc, card.id, patch))}
                              onDelete={() => {
                                setSelectedId(null)
                                emit(removeCard(doc, card.id))
                              }}
                              onDragStart={(e) => onCardDragStart(e, card, col.id)}
                            />
                          )}
                        </article>
                      </li>
                    )
                  })}
                </ol>
                {!readOnly && (
                  <button
                    type="button"
                    className="kanban-add-card"
                    onClick={() => emit(addCard(doc, col.id, t('kanban.newCard')))}
                  >
                    + {t('kanban.addCard')}
                  </button>
                )}
              </section>
            </div>
          )
        })}
        {!readOnly && (
          <button
            type="button"
            className="kanban-add-col"
            onClick={() => emit(addColumn(doc, t('kanban.newColumn')))}
          >
            + {t('kanban.addColumn')}
          </button>
        )}
      </div>
    </div>
  )
}

function CardEditor({
  card,
  users,
  usersReady,
  onPatch,
  onDelete,
  onDragStart,
}: {
  card: KanbanCard
  users: UserSummary[]
  usersReady: boolean
  onPatch: (patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'color' | 'assigneeId' | 'assigneeName'>>) => void
  onDelete: () => void
  onDragStart: (e: React.DragEvent) => void
}) {
  const { t } = useI18n()
  const known = users.some((u) => u.id === card.assigneeId)

  return (
    <div className="kanban-card-editor" onClick={(e) => e.stopPropagation()}>
      <div className="kanban-card-editor-bar">
        <button
          type="button"
          className="kanban-drag-handle"
          draggable
          title={t('kanban.dragCard')}
          aria-label={t('kanban.dragCard')}
          onDragStart={(e) => {
            e.stopPropagation()
            onDragStart(e)
          }}
        >
          ⋮⋮
        </button>
        <input
          className="kanban-card-title"
          value={card.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder={t('kanban.cardPlaceholder')}
          aria-label={t('kanban.cardTitle')}
          autoFocus
          draggable={false}
        />
      </div>
      <textarea
        className="kanban-card-body-input"
        value={card.body}
        onChange={(e) => onPatch({ body: e.target.value })}
        placeholder={t('kanban.bodyPlaceholder')}
        aria-label={t('kanban.cardBody')}
        rows={3}
        draggable={false}
      />
      {(users.length > 0 || card.assigneeId || !usersReady) && (
        <label className="kanban-assignee-field">
          <span className="visually-hidden">{t('kanban.assignee')}</span>
          <select
            value={card.assigneeId ?? ''}
            aria-label={t('kanban.assignee')}
            draggable={false}
            onChange={(e) => {
              const id = e.target.value
              if (!id) {
                onPatch({ assigneeId: null, assigneeName: null })
                return
              }
              const u = users.find((x) => x.id === id)
              onPatch({
                assigneeId: id,
                assigneeName: u ? userLabel(u) : card.assigneeName,
              })
            }}
          >
            <option value="">{t('props.unassigned')}</option>
            {card.assigneeId && !known && (
              <option value={card.assigneeId}>{card.assigneeName || t('props.unknownAccount')}</option>
            )}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {userLabel(u)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="kanban-colors" role="group" aria-label={t('kanban.color')}>
        <button
          type="button"
          className={`kanban-swatch none${!card.color ? ' is-on' : ''}`}
          title={t('kanban.colorNone')}
          onClick={() => onPatch({ color: null })}
        />
        {KANBAN_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`kanban-swatch color-${c}${card.color === c ? ' is-on' : ''}`}
            title={t(COLOR_KEYS[c])}
            onClick={() => onPatch({ color: c as KanbanColor })}
          />
        ))}
      </div>
      <button type="button" className="btn ghost sm danger" onClick={onDelete}>
        {t('common.delete')}
      </button>
    </div>
  )
}
