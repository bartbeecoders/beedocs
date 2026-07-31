export type PageViewMode = 'edit' | 'source' | 'preview' | 'split'

const KEY = 'beedocs-page-view-modes'

const MODES = new Set<PageViewMode>(['edit', 'source', 'preview', 'split'])

function loadAll(): Record<string, PageViewMode> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, PageViewMode> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && MODES.has(value as PageViewMode)) {
        out[id] = value as PageViewMode
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Saved view mode for a page, or null if the user has not chosen one yet. */
export function loadPageViewMode(pageId: string): PageViewMode | null {
  if (!pageId) return null
  return loadAll()[pageId] ?? null
}

export function savePageViewMode(pageId: string, mode: PageViewMode) {
  if (!pageId || !MODES.has(mode)) return
  const all = loadAll()
  all[pageId] = mode
  localStorage.setItem(KEY, JSON.stringify(all))
}
