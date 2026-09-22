import type { SearchKind } from './types'

/** Icon per search/document kind — shared by the search palette and the link picker. */
export const KIND_ICON: Record<SearchKind, string> = {
  page: '\u{1F4C4}',
  diagram: '\u2B21',
  slides: '\u{1F39E}\uFE0F',
  kanban: '\u{1F4CB}',
  project: '\u{1F4CA}',
  note: '\u{1F4DD}',
  attachment: '\u{1F4CE}',
  book: '\u{1F4D8}',
  folder: '\u{1F4C1}',
  shelf: '\u{1F4DA}',
  gitfile: '\u{1F4E6}',
}
