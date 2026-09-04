import { useMemo } from 'react'
import { useUserDirectory } from '../hooks/useUserDirectory'
import { parseBoard, resolveAssigneeName } from './kanbanModel'
import '../styles/kanban.css'

type Props = {
  source: string
  title?: string
  compact?: boolean
}

/** Read-only rendering of a kanban document (page preview, viewers, PDF sibling). */
export function KanbanView({ source, title, compact = false }: Props) {
  const doc = useMemo(() => parseBoard(source), [source])
  const { users } = useUserDirectory()
  return (
    <div className={`kanban is-readonly${compact ? ' is-compact' : ''}`}>
      {title ? <div className="kanban-view-title muted sm">{title}</div> : null}
      <div className="kanban-scroller">
        {doc.columns.map((col) => {
          const over = col.wip != null && col.cards.length > col.wip
          return (
            <section key={col.id} className={`kanban-col${over ? ' is-wip-over' : ''}`}>
              <header className="kanban-col-head">
                <h3 className="kanban-col-title">{col.title || '…'}</h3>
                <span className={`kanban-col-count${over ? ' is-over' : ''}`}>
                  {col.cards.length}
                  {col.wip != null ? `/${col.wip}` : ''}
                </span>
              </header>
              <ol className="kanban-cards">
                {col.cards.map((card) => {
                  const who = resolveAssigneeName(card, users)
                  return (
                    <li key={card.id}>
                      <article className={`kanban-card${card.color ? ` color-${card.color}` : ''}`}>
                        <span className="kanban-card-stripe" aria-hidden />
                        <strong className="kanban-card-title">{card.title || '…'}</strong>
                        {!compact && card.body.trim() ? <p className="kanban-card-body">{card.body}</p> : null}
                        {who ? <span className="kanban-assignee">{who}</span> : null}
                      </article>
                    </li>
                  )
                })}
              </ol>
            </section>
          )
        })}
      </div>
    </div>
  )
}
