/**
 * Cross-document links: turn an item dragged from the library tree (NavTree)
 * into a Markdown link pointing at that document's route. The tree stamps its
 * drags with TREE_DRAG_MIME, so the page editor can tell "link this page here"
 * apart from file drops and block reorders, which carry other types.
 */

/** MIME type the library tree stamps on its drags. */
export const TREE_DRAG_MIME = 'application/x-beedocs-tree'

export type TreeDragPayload =
  | { type: 'page'; pageId: string; bookId: string; chapterId?: string | null; title?: string }
  | { type: 'folder'; chapterId: string; bookId: string; title?: string }
  | { type: 'book'; bookId: string; shelfId?: string | null; title?: string }

/** True when this drag started on a library-tree row (types are readable pre-drop). */
export function isTreeDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types || []).includes(TREE_DRAG_MIME)
}

export function parseTreeDrag(dt: DataTransfer | null): TreeDragPayload | null {
  if (!dt) return null
  try {
    const raw = dt.getData(TREE_DRAG_MIME)
    if (!raw) return null
    const p = JSON.parse(raw) as TreeDragPayload
    return p && (p.type === 'page' || p.type === 'book' || p.type === 'folder') ? p : null
  } catch {
    return null
  }
}

/** App-route href for a dragged tree item, or null when it has no page of its own. */
export function hrefForTreePayload(p: TreeDragPayload): string | null {
  if (p.type === 'page') return `/books/${p.bookId}/pages/${p.pageId}`
  if (p.type === 'book') return `/books/${p.bookId}`
  return null // a folder is tree structure, not a document
}

/** `[Title](/books/…)` markdown for a dragged tree item. */
export function markdownLinkForTreePayload(p: TreeDragPayload): string | null {
  const href = hrefForTreePayload(p)
  if (!href) return null
  const label = (p.title ?? '').replace(/[[\]]/g, '').trim()
  return `[${label || (p.type === 'page' ? 'Untitled page' : 'Untitled book')}](${href})`
}

/** Hrefs the SPA router owns — rendered as client-side navigation, not a reload. */
export function isInternalDocHref(href: string | undefined): href is string {
  return !!href && /^\/(books|shelves|bookshelf-serve)\//.test(href)
}

/** Path of a published (or preview) bookshelf website. */
export function bookshelfSitePath(shelfSlug: string, bookSlug?: string, pageSlug?: string): string {
  let path = `/bookshelf-serve/${encodeURIComponent(shelfSlug)}`
  if (bookSlug) path += `/${encodeURIComponent(bookSlug)}`
  if (pageSlug) path += `/${encodeURIComponent(pageSlug)}`
  return path
}

/**
 * Insert an inline snippet (a link) at a character offset, padding with single
 * spaces where it would otherwise glue onto a word. Unlike images, a link is
 * inline content — blank-line padding would tear the sentence it lands in.
 */
export function insertInlineMarkdownAt(text: string, offset: number, snippet: string): string {
  const o = Math.max(0, Math.min(text.length, offset))
  const before = text.slice(0, o)
  const after = text.slice(o)
  const padBefore = before !== '' && !/\s$/.test(before) ? ' ' : ''
  const padAfter = after !== '' && !/^\s/.test(after) ? ' ' : ''
  return before + padBefore + snippet + padAfter + after
}
