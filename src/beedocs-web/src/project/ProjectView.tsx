import { ProjectEditor } from './ProjectEditor'
import '../styles/project.css'

type Props = {
  source: string
  title?: string
  compact?: boolean
}

/** Read-only Gantt (page preview, viewers). */
export function ProjectView({ source, title, compact = false }: Props) {
  return (
    <div className={`project-view${compact ? ' is-compact' : ''}`}>
      {title ? <div className="project-view-title muted sm">{title}</div> : null}
      <ProjectEditor source={source} compact={compact} readOnly />
    </div>
  )
}
