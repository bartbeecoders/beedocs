import { AnimationPlayer } from './AnimationPlayer'

type Props = {
  source: string
  title?: string
  compact?: boolean
}

/** Read-only rendering of an animation document (page preview, viewers). */
export function AnimationView({ source, title, compact = false }: Props) {
  return <AnimationPlayer source={source} title={title} compact={compact} />
}
