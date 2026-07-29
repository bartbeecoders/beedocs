import type { BeeNode, BeeNodeType, BeeShape } from '../types'
import { createNode } from './beeModel'
import { createShapeNode, defaultShapeSize } from './shapes'

/**
 * The shape palette for studio mode — grouped like the draw.io left sidebar.
 */

export type ShapeLibraryItem = {
  id: string
  label: string
  /** Catalog shape (studio) */
  shape?: BeeShape
  /** Legacy BeeDocs node type (keeps the classic look) */
  legacyType?: BeeNodeType
  /** Text placed on the new shape */
  preset?: string
  w?: number
  h?: number
  keywords?: string
}

export type ShapeLibraryGroup = {
  id: string
  title: string
  items: ShapeLibraryItem[]
}

export const SHAPE_LIBRARY: ShapeLibraryGroup[] = [
  {
    id: 'general',
    title: 'General',
    items: [
      { id: 'rectangle', label: 'Rectangle', shape: 'rectangle', keywords: 'box rect square' },
      { id: 'rounded', label: 'Rounded rectangle', shape: 'rounded', keywords: 'box rect' },
      { id: 'text', label: 'Text', shape: 'text', preset: 'Text', keywords: 'label caption' },
      { id: 'ellipse', label: 'Ellipse', shape: 'ellipse', keywords: 'oval round' },
      { id: 'square', label: 'Square', shape: 'rectangle', w: 100, h: 100, keywords: 'box' },
      { id: 'circle', label: 'Circle', shape: 'circle', keywords: 'round dot' },
      { id: 'process', label: 'Process', shape: 'process', keywords: 'subroutine predefined' },
      { id: 'rhombus', label: 'Diamond', shape: 'rhombus', keywords: 'decision if' },
      { id: 'parallelogram', label: 'Parallelogram', shape: 'parallelogram', keywords: 'data io' },
      { id: 'hexagon', label: 'Hexagon', shape: 'hexagon', keywords: 'preparation' },
      { id: 'triangle', label: 'Triangle', shape: 'triangle', keywords: 'arrow play' },
      { id: 'cylinder', label: 'Cylinder', shape: 'cylinder', keywords: 'database storage disk' },
      { id: 'cloud', label: 'Cloud', shape: 'cloud', keywords: 'internet network' },
      { id: 'document', label: 'Document', shape: 'document', keywords: 'file report' },
      { id: 'internalStorage', label: 'Internal storage', shape: 'internalStorage', keywords: 'memory' },
      { id: 'cube', label: 'Cube', shape: 'cube', keywords: '3d box block' },
      { id: 'step', label: 'Step', shape: 'step', keywords: 'chevron arrow' },
      { id: 'trapezoid', label: 'Trapezoid', shape: 'trapezoid', keywords: 'manual operation' },
      { id: 'tape', label: 'Tape', shape: 'tape', keywords: 'paper wave' },
      { id: 'note', label: 'Note', shape: 'note', keywords: 'comment annotation' },
      { id: 'card', label: 'Card', shape: 'card', keywords: 'punched' },
      { id: 'callout', label: 'Callout', shape: 'callout', keywords: 'speech bubble comment' },
      { id: 'actor', label: 'Actor', shape: 'actor', preset: 'Actor', keywords: 'person user stick figure' },
      { id: 'dataStorage', label: 'Data storage', shape: 'dataStorage', keywords: 'disk' },
      { id: 'stadium', label: 'Terminator', shape: 'stadium', keywords: 'start end pill' },
      { id: 'container', label: 'Container', shape: 'container', preset: 'Group', keywords: 'group boundary frame' },
    ],
  },
  {
    id: 'flowchart',
    title: 'Flowchart',
    items: [
      { id: 'fc-start', label: 'Start / End', shape: 'stadium', preset: 'Start', keywords: 'terminator' },
      { id: 'fc-process', label: 'Process', shape: 'rectangle', preset: 'Process', keywords: 'action step' },
      { id: 'fc-decision', label: 'Decision', shape: 'rhombus', preset: 'Decision', keywords: 'if branch' },
      { id: 'fc-data', label: 'Data', shape: 'parallelogram', preset: 'Data', keywords: 'input output' },
      { id: 'fc-predefined', label: 'Predefined process', shape: 'process', preset: 'Subprocess' },
      { id: 'fc-document', label: 'Document', shape: 'document', preset: 'Document' },
      { id: 'fc-database', label: 'Database', shape: 'cylinder', preset: 'Database', keywords: 'store' },
      { id: 'fc-manual', label: 'Manual input', shape: 'trapezoid', preset: 'Manual input' },
      { id: 'fc-prepare', label: 'Preparation', shape: 'hexagon', preset: 'Preparation' },
      { id: 'fc-connector', label: 'Connector', shape: 'circle', preset: 'A', w: 60, h: 60, keywords: 'on page reference' },
    ],
  },
  {
    id: 'beedocs',
    title: 'BeeDocs (classic)',
    items: [
      { id: 'bee-person', label: 'Person', legacyType: 'person', keywords: 'actor user' },
      { id: 'bee-system', label: 'System', legacyType: 'system', keywords: 'c4 software' },
      { id: 'bee-database', label: 'Database', legacyType: 'database', keywords: 'store db' },
      { id: 'bee-note', label: 'Note', legacyType: 'note', keywords: 'annotation' },
      { id: 'bee-box', label: 'Component', legacyType: 'box', keywords: 'container box' },
      { id: 'bee-image', label: 'Image', legacyType: 'image', keywords: 'picture photo' },
    ],
  },
]

export function findLibraryItem(id: string): ShapeLibraryItem | undefined {
  for (const group of SHAPE_LIBRARY) {
    const hit = group.items.find((i) => i.id === id)
    if (hit) return hit
  }
  return undefined
}

export function libraryItemSize(item: ShapeLibraryItem): { w: number; h: number } {
  if (item.w && item.h) return { w: item.w, h: item.h }
  if (item.shape) {
    const s = defaultShapeSize(item.shape)
    return { w: item.w ?? s.w, h: item.h ?? s.h }
  }
  const n = createNode(item.legacyType ?? 'box', 0, 0)
  return { w: item.w ?? n.w, h: item.h ?? n.h }
}

/** Build a node for a palette item, positioned at its top-left corner. */
export function nodeFromLibraryItem(item: ShapeLibraryItem, x: number, y: number): BeeNode {
  const size = libraryItemSize(item)
  if (item.shape) {
    return createShapeNode(item.shape, x, y, {
      label: item.preset ?? '',
      w: size.w,
      h: size.h,
    })
  }
  const node = createNode(item.legacyType ?? 'box', x, y)
  node.w = size.w
  node.h = size.h
  return node
}

/** A preview node used to render the palette thumbnails. */
export function previewNodeFromItem(item: ShapeLibraryItem, w: number, h: number): BeeNode {
  const node = nodeFromLibraryItem(item, 0, 0)
  return { ...node, label: '', w, h }
}

export function searchLibrary(query: string): ShapeLibraryGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return SHAPE_LIBRARY
  const terms = q.split(/\s+/)
  return SHAPE_LIBRARY.map((g) => ({
    ...g,
    items: g.items.filter((i) => {
      const hay = `${i.label} ${i.shape ?? ''} ${i.legacyType ?? ''} ${i.keywords ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    }),
  })).filter((g) => g.items.length > 0)
}
