import { NoteEditor } from './NoteEditor'
import '../styles/notes.css'

type Props = {
  source: string
  title?: string
  compact?: boolean
}

/** Read-only note (page preview, viewers). Same renderer as the editor, no chrome. */
export function NoteView({ source, title, compact = false }: Props) {
  return (
    <div className={`note-view${compact ? ' is-compact' : ''}`}>
      {title ? <div className="note-view-title muted sm">{title}</div> : null}
      <NoteEditor source={source} compact={compact} readOnly />
    </div>
  )
}
