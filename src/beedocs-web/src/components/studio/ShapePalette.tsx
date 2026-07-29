import { useMemo, useState } from 'react'
import { SHAPE_LIBRARY, searchLibrary, type ShapeLibraryItem } from '../../diagram/shapeLibrary'
import { SHAPE_DRAG_MIME, ShapeThumb } from './StudioCanvas'

type Props = {
  onPlace: (item: ShapeLibraryItem) => void
  disabled?: boolean
}

/** Left sidebar shape library — drag onto the canvas or click to drop in view. */
export function ShapePalette({ onPlace, disabled }: Props) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const groups = useMemo(() => (query ? searchLibrary(query) : SHAPE_LIBRARY), [query])

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
        {groups.length === 0 && <p className="muted sm studio-palette-empty">No shapes match “{query}”.</p>}
        {groups.map((group) => {
          const isCollapsed = !query && collapsed[group.id]
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
                <div className="studio-palette-grid">
                  {group.items.map((item) => (
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
