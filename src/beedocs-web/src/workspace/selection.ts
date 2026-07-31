/**
 * Lightweight library selection for the contextual workspace toolbar.
 * Route params drive page/diagram/book selection; folders only exist in the tree
 * (no route), so they rely on explicit setSelection from NavTree clicks.
 */

export type TreeSelection =
  | { kind: 'none' }
  | { kind: 'book'; bookId: string }
  | { kind: 'folder'; bookId: string; chapterId: string }
  | { kind: 'page'; bookId: string; pageId: string }
  | { kind: 'diagram'; bookId: string; diagramId: string }

export type RouteSelectionParams = {
  bookId?: string
  pageId?: string
  diagramId?: string
  /** 'settings' | 'help' | other workspace views — clears structural selection */
  view?: string
}

/** Build selection from the current route. Settings/help → none. */
export function selectionFromRoute(params: RouteSelectionParams): TreeSelection {
  if (params.view === 'settings' || params.view === 'help') {
    return { kind: 'none' }
  }
  if (params.bookId && params.pageId) {
    return { kind: 'page', bookId: params.bookId, pageId: params.pageId }
  }
  if (params.bookId && params.diagramId) {
    return { kind: 'diagram', bookId: params.bookId, diagramId: params.diagramId }
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
  }
}
