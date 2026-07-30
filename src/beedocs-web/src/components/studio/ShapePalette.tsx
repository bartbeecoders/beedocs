import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import {
  fragmentBounds,
  parseFragment,
} from '../../diagram/collectionFragment'
import { SHAPE_LIBRARY, searchLibrary, type ShapeLibraryItem } from '../../diagram/shapeLibrary'
import type { ShapeCollection } from '../../types'
import { BeeShapeNode } from '../BeeShapeNode'
import { COLLECTION_DRAG_MIME, SHAPE_DRAG_MIME, ShapeThumb } from './StudioCanvas'

type Props = {
  onPlace: (item: ShapeLibraryItem) => void
  onPlaceCollection?: (collection: ShapeCollection) => void
  bookId?: string
  /** Bump to reload collections after save/delete. */
  collectionsVersion?: number
  disabled?: boolean
}

type CollectionGroup = {
  id: string
  title: string
  kind: 'collections'
  items: ShapeCollection[]
  emptyHint: string
}

type ShapeGroup = {
  id: string
  title: string
  kind: 'shapes'
  items: ShapeLibraryItem[]
}

type PaletteGroup = CollectionGroup | ShapeGroup

function matchesQuery(c: ShapeCollection, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${c.name} ${c.description ?? ''} collection snippet`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/** Left sidebar shape library — drag onto the canvas or click to drop in view. */
export function ShapePalette({
  onPlace,
  onPlaceCollection,
  bookId,
  collectionsVersion = 0,
  disabled,
}: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [bookCollections, setBookCollections] = useState<ShapeCollection[]>([])
  const [appCollections, setAppCollections] = useState<ShapeCollection[]>([])
  const [collectionsError, setCollectionsError] = useState<string | null>(null)

  const reloadCollections = useCallback(() => {
    void (async () => {
      try {
        const app = await api.listAppShapeCollections()
        setAppCollections(app)
        if (bookId) {
          const book = await api.listShapeCollections(bookId)
          setBookCollections(book)
        } else {
          setBookCollections([])
        }
        setCollectionsError(null)
      } catch (e) {
        setCollectionsError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [bookId])

  useEffect(() => {
    reloadCollections()
  }, [reloadCollections, collectionsVersion])

  const groups = useMemo((): PaletteGroup[] => {
    const builtIn: ShapeGroup[] = (query ? searchLibrary(query) : SHAPE_LIBRARY).map((g) => ({
      ...g,
      kind: 'shapes' as const,
    }))
    const q = query.trim().toLowerCase()
    const terms = q ? q.split(/\s+/) : []
    const filtering = terms.length > 0

    const appItems = appCollections.filter((c) => matchesQuery(c, terms))
    const bookItems = bookCollections.filter((c) => matchesQuery(c, terms))

    const collectionGroups: CollectionGroup[] = []

    // Always show app group when not mid-search with zero hits, or when there are hits.
    if (!filtering || appItems.length > 0) {
      collectionGroups.push({
        id: 'app-collections',
        title: 'App collections',
        kind: 'collections',
        items: appItems,
        emptyHint:
          'Save a selection as an app collection to reuse it in every book.',
      })
    }

    if (bookId && (!filtering || bookItems.length > 0)) {
      collectionGroups.push({
        id: 'book-collections',
        title: 'Book collections',
        kind: 'collections',
        items: bookItems,
        emptyHint:
          'Select shapes and use Save collection → This book to add reusable groups here.',
      })
    }

    if (filtering && collectionGroups.every((g) => g.items.length === 0) && builtIn.length === 0) {
      return []
    }

    return [...collectionGroups, ...builtIn]
  }, [appCollections, bookCollections, bookId, query])

  const deleteCollection = async (c: ShapeCollection) => {
    const scope = c.bookId ? 'book' : 'app'
    if (!confirm(`Delete ${scope} collection “${c.name}”?`)) return
    try {
      await api.deleteShapeCollection(c.id)
      if (c.bookId) {
        setBookCollections((prev) => prev.filter((x) => x.id !== c.id))
      } else {
        setAppCollections((prev) => prev.filter((x) => x.id !== c.id))
      }
    } catch (e) {
      setCollectionsError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="studio-palette" aria-label="Shapes">
      <div className="studio-palette-search">
        <input
          type="search"
          value={query}
          placeholder="Search shapes"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search shapes"
        />
      </div>
      <div className="studio-palette-scroll">
        {groups.length === 0 && (
          <p className="muted sm studio-palette-empty">No shapes match “{query}”.</p>
        )}
        {collectionsError && (
          <p className="muted sm studio-palette-empty" role="alert">
            Collections: {collectionsError}
          </p>
        )}
        {groups.map((group) => {
          const isCollapsed = !query && collapsed[group.id]
          const isCollections = group.kind === 'collections'
          return (
            <section key={group.id} className="studio-palette-group">
              <button
                type="button"
                className="studio-palette-group-head"
                onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
                aria-expanded={!isCollapsed}
              >
                <span className={`studio-caret${isCollapsed ? ' is-collapsed' : ''}`} aria-hidden>
                  ▾
                </span>
                {group.title}
              </button>
              {!isCollapsed && (
                <div className={isCollections ? 'studio-palette-collections' : 'studio-palette-grid'}>
                  {isCollections && group.items.length === 0 && (
                    <p className="muted sm studio-palette-empty">{group.emptyHint}</p>
                  )}
                  {isCollections
                    ? group.items.map((c) => (
                        <div key={c.id} className="studio-palette-collection">
                          <button
                            type="button"
                            className="studio-palette-item studio-palette-item--collection"
                            title={
                              c.description
                                ? `${c.name} — ${c.description}`
                                : `${c.name} — drag onto the canvas`
                            }
                            draggable={!disabled}
                            onDragStart={(e) => {
                              e.dataTransfer.setData(COLLECTION_DRAG_MIME, c.id)
                              e.dataTransfer.setData('text/plain', c.id)
                              e.dataTransfer.effectAllowed = 'copy'
                            }}
                            onClick={() => !disabled && onPlaceCollection?.(c)}
                            disabled={disabled}
                          >
                            <CollectionThumb source={c.source} />
                            <span className="studio-palette-collection-text">
                              <span className="studio-palette-label">{c.name}</span>
                              {c.description && (
                                <span className="studio-palette-desc">{c.description}</span>
                              )}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="studio-palette-collection-del"
                            title={`Delete “${c.name}”`}
                            disabled={disabled}
                            onClick={() => void deleteCollection(c)}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    : group.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="studio-palette-item"
                          title={`${item.label} — drag onto the canvas`}
                          draggable={!disabled}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(SHAPE_DRAG_MIME, item.id)
                            e.dataTransfer.effectAllowed = 'copy'
                          }}
                          onClick={() => !disabled && onPlace(item)}
                          disabled={disabled}
                        >
                          <ShapeThumb itemId={item.id} />
                          <span className="studio-palette-label">{item.label}</span>
                        </button>
                      ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </aside>
  )
}

/** Tiny multi-node preview for a collection. */
function CollectionThumb({ source, size = 40 }: { source: string; size?: number }) {
  const fragment = parseFragment(source)
  if (!fragment || fragment.nodes.length === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden focusable="false">
        <rect x="4" y="8" width="18" height="14" rx="2" fill="#dae8fc" stroke="#6c8ebf" />
        <rect x="16" y="16" width="18" height="14" rx="2" fill="#d5e8d4" stroke="#82b366" />
      </svg>
    )
  }
  const bounds = fragmentBounds(fragment)
  const pad = 2
  const scale = Math.min(
    (size - pad * 2) / Math.max(1, bounds.w),
    (size - pad * 2) / Math.max(1, bounds.h),
    1,
  )
  const ox = (size - bounds.w * scale) / 2
  const oy = (size - bounds.h * scale) / 2
  const nodes = fragment.nodes.slice(0, 12)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
      <g transform={`translate(${ox},${oy}) scale(${scale})`}>
        {nodes.map((n) => (
          <BeeShapeNode key={n.id} node={n} hideLabel />
        ))}
      </g>
    </svg>
  )
}
