import { useMemo, useState } from 'react'
import { useI18n, type MessageKey, type TFunction } from '../i18n'
import { ISO_SHAPE_MIME } from './IsoCanvas'
import { DEFAULT_ITEM_COLOR } from './isoModel'
import { isoShape, searchIsoLibrary, type IsoLibraryGroup, type IsoPrimitive } from './isoShapes'

/** Palette entries that are not item shapes. */
export const ISO_SPECIALS = [
  { id: 'zone', label: 'Zone' },
  { id: 'text', label: 'Text' },
] as const

/**
 * Translated display name for a shape id. The ids (and their English labels)
 * live in isoShapes.ts, which is mirrored by the MCP catalog and must not
 * change — so translation is a keyed lookup here, falling back to the library's
 * English label for any id without a message (t() echoes an unknown key).
 */
export function isoShapeName(t: TFunction, id: string): string {
  const key = `isometric.shape.${id}` as MessageKey
  const name = t(key)
  return name === key ? isoShape(id).label : name
}

/** Same keyed-lookup-with-fallback for a palette group's title. */
function isoGroupTitle(t: TFunction, group: IsoLibraryGroup): string {
  const key = `isometric.group.${group.id}` as MessageKey
  const title = t(key)
  return title === key ? group.title : title
}

type Props = {
  onPlace: (shapeId: string) => void
  disabled?: boolean
}

function primToSvg(p: IsoPrimitive, key: number) {
  if (p.kind === 'path') {
    return (
      <path
        key={key}
        d={p.d}
        fill={p.fill ?? 'none'}
        stroke={p.stroke}
        strokeWidth={p.strokeWidth}
        strokeLinejoin="round"
        opacity={p.opacity}
        fillRule={p.evenOdd ? 'evenodd' : undefined}
      />
    )
  }
  if (p.kind === 'ellipse') {
    return (
      <ellipse
        key={key}
        cx={p.cx}
        cy={p.cy}
        rx={p.rx}
        ry={p.ry}
        fill={p.fill ?? 'none'}
        stroke={p.stroke}
        strokeWidth={p.strokeWidth}
        opacity={p.opacity}
      />
    )
  }
  return (
    <text key={key} x={p.x} y={p.y} fontSize={p.size} fill={p.fill} textAnchor="middle" dominantBaseline="middle">
      {p.text}
    </text>
  )
}

/** Small preview of one isometric shape for palette buttons. */
export function IsoShapeThumb({ shapeId, size = 30 }: { shapeId: string; size?: number }) {
  const prims = useMemo(() => isoShape(shapeId).draw(DEFAULT_ITEM_COLOR), [shapeId])
  // Local shape space spans roughly x −55…55, y −85…30
  return (
    <svg width={size} height={size} viewBox="-58 -92 116 128" aria-hidden focusable="false">
      {prims.map((p, i) => primToSvg(p, i))}
    </svg>
  )
}

function SpecialThumb({ id, size = 30 }: { id: string; size?: number }) {
  if (id === 'zone') {
    return (
      <svg width={size} height={size} viewBox="-58 -92 116 128" aria-hidden focusable="false">
        <path
          d="M0 -55L55 -27L0 1L-55 -27Z"
          fill="#82b366"
          fillOpacity={0.2}
          stroke="#82b366"
          strokeWidth={3}
        />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="-58 -92 116 128" aria-hidden focusable="false">
      <text x="0" y="-16" fontSize="64" textAnchor="middle" fill="currentColor">
        A
      </text>
    </svg>
  )
}

/** Left sidebar shape library — drag onto the canvas or click to drop in view. */
export function IsoPalette({ onPlace, disabled }: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => searchIsoLibrary(query), [query])
  const q = query.trim().toLowerCase()
  const showSpecials =
    !q ||
    ISO_SPECIALS.some(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.id.includes(q) ||
        isoShapeName(t, s.id).toLowerCase().includes(q),
    )

  const entryButton = (id: string, label: string, thumb: React.ReactNode) => (
    <button
      key={id}
      type="button"
      className="studio-palette-item"
      title={t('isometric.palette.dragHint', { label })}
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(ISO_SHAPE_MIME, id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => !disabled && onPlace(id)}
      disabled={disabled}
    >
      {thumb}
      <span className="studio-palette-label">{label}</span>
    </button>
  )

  return (
    <aside className="studio-palette" aria-label={t('isometric.toolbar.shapes')}>
      <div className="studio-palette-search">
        <input
          type="search"
          value={query}
          placeholder={t('isometric.palette.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('isometric.palette.searchPlaceholder')}
        />
      </div>
      <div className="studio-palette-scroll">
        {groups.length === 0 && !showSpecials && (
          <p className="muted sm studio-palette-empty">{t('isometric.palette.noMatch', { query })}</p>
        )}
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
                {isoGroupTitle(t, group)}
              </button>
              {!isCollapsed && (
                <div className="studio-palette-grid">
                  {group.shapes.map((id) =>
                    entryButton(id, isoShapeName(t, id), <IsoShapeThumb shapeId={id} />),
                  )}
                </div>
              )}
            </section>
          )
        })}
        {showSpecials && (
          <section className="studio-palette-group">
            <button
              type="button"
              className="studio-palette-group-head"
              onClick={() => setCollapsed((c) => ({ ...c, annotations: !c.annotations }))}
              aria-expanded={!collapsed.annotations}
            >
              <span
                className={`studio-caret${collapsed.annotations ? ' is-collapsed' : ''}`}
                aria-hidden
              >
                ▾
              </span>
              {t('isometric.group.annotations')}
            </button>
            {!collapsed.annotations && (
              <div className="studio-palette-grid">
                {ISO_SPECIALS.map((s) =>
                  entryButton(s.id, isoShapeName(t, s.id), <SpecialThumb id={s.id} />),
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
