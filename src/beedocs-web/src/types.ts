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
}

/** Connector endpoint on a node boundary */
export type BeeAnchor = 'n' | 'e' | 's' | 'w'

/** How the connector is drawn between anchors */
export type BeeEdgeRoute = 'straight' | 'curved' | 'orthogonal'

export type BeePoint = { x: number; y: number }

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
