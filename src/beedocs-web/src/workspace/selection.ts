/**
 * Lightweight library selection for the contextual workspace toolbar.
 * Route params drive page/diagram/slides/file/book selection; folders only exist
 * in the tree (no route), so they rely on explicit setSelection from NavTree
 * clicks.
 */

export type TreeSelection =
  | { kind: 'none' }
  | { kind: 'shelf'; shelfId: string }
  | { kind: 'book'; bookId: string }
  | { kind: 'folder'; bookId: string; chapterId: string }
  | { kind: 'page'; bookId: string; pageId: string }
  | { kind: 'diagram'; bookId: string; diagramId: string }
  | { kind: 'slides'; bookId: string; deckId: string }
  | { kind: 'kanban'; bookId: string; boardId: string }
  | { kind: 'project'; bookId: string; planId: string }
  | { kind: 'note'; bookId: string; noteId: string }
  | { kind: 'attachment'; bookId: string; attachmentId: string }

export type RouteSelectionParams = {
  shelfId?: string
  bookId?: string
  pageId?: string
  diagramId?: string
  deckId?: string
  boardId?: string
  planId?: string
  noteId?: string
  attachmentId?: string
  /** 'settings' | 'help' | other workspace views — clears structural selection */
  view?: string
}

/** Build selection from the current route. Settings/help → none. */
export function selectionFromRoute(params: RouteSelectionParams): TreeSelection {
  if (params.view === 'settings' || params.view === 'help') {
    return { kind: 'none' }
  }
  if (params.shelfId) {
    return { kind: 'shelf', shelfId: params.shelfId }
  }
  if (params.bookId && params.pageId) {
    return { kind: 'page', bookId: params.bookId, pageId: params.pageId }
  }
  if (params.bookId && params.diagramId) {
    return { kind: 'diagram', bookId: params.bookId, diagramId: params.diagramId }
  }
  if (params.bookId && params.deckId) {
    return { kind: 'slides', bookId: params.bookId, deckId: params.deckId }
  }
  if (params.bookId && params.boardId) {
    return { kind: 'kanban', bookId: params.bookId, boardId: params.boardId }
  }
  if (params.bookId && params.planId) {
    return { kind: 'project', bookId: params.bookId, planId: params.planId }
  }
  if (params.bookId && params.noteId) {
    return { kind: 'note', bookId: params.bookId, noteId: params.noteId }
  }
  if (params.bookId && params.attachmentId) {
    return { kind: 'attachment', bookId: params.bookId, attachmentId: params.attachmentId }
  }
  if (params.bookId) {
    return { kind: 'book', bookId: params.bookId }
  }
  return { kind: 'none' }
}

export function selectionEquals(a: TreeSelection, b: TreeSelection): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'none':
      return true
    case 'shelf':
      return b.kind === 'shelf' && a.shelfId === b.shelfId
    case 'book':
      return b.kind === 'book' && a.bookId === b.bookId
    case 'folder':
      return (
        b.kind === 'folder' && a.bookId === b.bookId && a.chapterId === b.chapterId
      )
    case 'page':
      return b.kind === 'page' && a.bookId === b.bookId && a.pageId === b.pageId
    case 'diagram':
      return (
        b.kind === 'diagram' && a.bookId === b.bookId && a.diagramId === b.diagramId
      )
    case 'slides':
      return b.kind === 'slides' && a.bookId === b.bookId && a.deckId === b.deckId
    case 'kanban':
      return b.kind === 'kanban' && a.bookId === b.bookId && a.boardId === b.boardId
    case 'project':
      return b.kind === 'project' && a.bookId === b.bookId && a.planId === b.planId
    case 'note':
      return b.kind === 'note' && a.bookId === b.bookId && a.noteId === b.noteId
    case 'attachment':
      return (
        b.kind === 'attachment' &&
        a.bookId === b.bookId &&
        a.attachmentId === b.attachmentId
      )
  }
}
