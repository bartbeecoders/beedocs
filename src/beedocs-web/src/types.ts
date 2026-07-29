export type Book = {
  id: string
  title: string
  description?: string | null
  slug: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type Chapter = {
  id: string
  bookId: string
  title: string
  slug: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type PageSummary = {
  id: string
  bookId: string
  chapterId?: string | null
  title: string
  slug: string
  sortOrder: number
  version: number
  updatedAt: string
}

export type Page = PageSummary & {
  content: string
  createdAt: string
}

export type DiagramKind = 'beediagram' | 'mermaid' | 'plantuml' | 'c4'

export type DiagramSummary = {
  id: string
  bookId: string
  pageId?: string | null
  title: string
  kind: DiagramKind | string
  updatedAt: string
}

export type Diagram = DiagramSummary & {
  source: string
  createdAt: string
}

export type BeeNodeType = 'box' | 'person' | 'system' | 'database' | 'note' | 'image'

/**
 * Draw.io-style shape catalog (studio mode). When absent the legacy
 * {@link BeeNodeType} drives the rendering, so old documents keep their look.
 */
export type BeeShape =
  | 'rectangle'
  | 'rounded'
  | 'stadium'
  | 'text'
  | 'ellipse'
  | 'circle'
  | 'triangle'
  | 'rhombus'
  | 'parallelogram'
  | 'trapezoid'
  | 'hexagon'
  | 'step'
  | 'process'
  | 'document'
  | 'tape'
  | 'card'
  | 'callout'
  | 'note'
  | 'cube'
  | 'cylinder'
  | 'internalStorage'
  | 'dataStorage'
  | 'cloud'
  | 'actor'
  | 'container'
  | 'image'

export type BeeTextAlign = 'left' | 'center' | 'right'
export type BeeTextVAlign = 'top' | 'middle' | 'bottom'

/** Per-shape appearance overrides (studio mode). All optional. */
export type BeeNodeStyle = {
  fill?: string
  stroke?: string
  strokeWidth?: number
  dashed?: boolean
  /** 0–100 */
  opacity?: number
  shadow?: boolean
  fontSize?: number
  fontColor?: string
  bold?: boolean
  italic?: boolean
  align?: BeeTextAlign
  valign?: BeeTextVAlign
}

export type BeeNode = {
  id: string
  type: BeeNodeType
  label: string
  x: number
  y: number
  w: number
  h: number
  color?: string
  /** For type=image: uploaded or remote image URL */
  imageUrl?: string
  /** Studio-mode shape; falls back to `type` when omitted */
  shape?: BeeShape
  /** Studio-mode appearance overrides */
  style?: BeeNodeStyle
  /** Rotation in degrees around the shape centre */
  rotation?: number
}

/**
 * Connector endpoint on a node boundary: side midpoints, corners and the
 * quarter points of every side (`n1` = 25% along the top, `n2` = 75%, …).
 */
export type BeeAnchor =
  | 'n'
  | 'e'
  | 's'
  | 'w'
  | 'ne'
  | 'se'
  | 'sw'
  | 'nw'
  | 'n1'
  | 'n2'
  | 'e1'
  | 'e2'
  | 's1'
  | 's2'
  | 'w1'
  | 'w2'

/** How the connector is drawn between anchors */
export type BeeEdgeRoute = 'straight' | 'curved' | 'orthogonal'

export type BeePoint = { x: number; y: number }

/** Arrow head at either end of a connection */
export type BeeArrowHead = 'none' | 'arrow' | 'open' | 'diamond' | 'circle'

export type BeeEdgeStyle = {
  stroke?: string
  strokeWidth?: number
  dashed?: boolean
  startArrow?: BeeArrowHead
  endArrow?: BeeArrowHead
  fontSize?: number
  fontColor?: string
}

export type BeeEdge = {
  id: string
  from: string
  to: string
  /** Optional side anchors; when omitted, best sides are inferred */
  fromAnchor?: BeeAnchor
  toAnchor?: BeeAnchor
  /** Line style: straight (default), curved, or 90° orthogonal */
  route?: BeeEdgeRoute
  /**
   * Intermediate bend points for orthogonal routes (world coords, between endpoints).
   * Dragging segment handles updates these.
   */
  waypoints?: BeePoint[]
  label?: string
  /** Studio-mode appearance overrides */
  style?: BeeEdgeStyle
}

export type BeeViewport = {
  x: number
  y: number
  zoom: number
}

export type BeeDiagramDoc = {
  version: 1
  nodes: BeeNode[]
  edges: BeeEdge[]
  viewport: BeeViewport
}
