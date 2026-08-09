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

/** Server-rendered export formats. PDF is produced in the browser instead. */
export type ExportFormat = 'archive' | 'markdown' | 'docx'

export type SearchKind = 'page' | 'diagram' | 'book' | 'folder'

/** Sentinels the API wraps matched terms in. Never present in stored content. */
export const HIGHLIGHT_OPEN = '\ue000'
export const HIGHLIGHT_CLOSE = '\ue001'

export type SearchHit = {
  kind: SearchKind
  id: string
  title: string
  /** Matching excerpt, with matched terms wrapped in HIGHLIGHT_OPEN/CLOSE. */
  snippet: string | null
  bookId: string | null
  bookTitle: string | null
  chapterId: string | null
  /** Workspace route for this hit. */
  url: string
  /** bm25 rank — lower is a better match. */
  score: number
  updatedAt: string
}

export type SearchResponse = {
  query: string
  /** Matches across the library, not just the returned page of hits. */
  total: number
  limit: number
  offset: number
  engine: 'fts5' | 'like'
  hits: SearchHit[]
}

export type SearchStatus = {
  engine: 'fts5' | 'like'
  documents: number
  pending: number
  pages: number
  diagrams: number
  books: number
  folders: number
  lastIndexedAt: string | null
}

/** What to do when an imported title already exists. */
export type ImportNameMode = 'rename' | 'keep'

export type ImportPreview = {
  /** How the file was recognised: archive | markdown-zip | markdown */
  source: string
  /** book | page */
  kind: string
  bookTitle: string
  chapterCount: number
  pageCount: number
  diagramCount: number
  /** Studio multi-shape snippets saved on the book */
  collectionCount: number
  assetCount: number
  pageTitles: string[]
  bookTitleExists: boolean
  suggestedTitle?: string | null
  warnings: string[]
}

export type ImportResult = {
  kind: string
  bookId: string
  bookTitle: string
  bookCreated: boolean
  chaptersCreated: number
  pagesCreated: number
  diagramsCreated: number
  collectionsCreated: number
  assetsCreated: number
  warnings: string[]
  pages: { id: string; title: string; slug: string }[]
}

/** Scope when saving a multi-shape snippet from Studio. */
export type ShapeCollectionScope = 'book' | 'app'

/**
 * Reusable multi-shape snippet for the studio palette.
 * `bookId` is set for book-scoped items; null/undefined for the app-wide library.
 */
export type ShapeCollection = {
  id: string
  bookId?: string | null
  name: string
  description?: string | null
  /** JSON fragment: `{ version, nodes, edges }` */
  source: string
  createdAt: string
  updatedAt: string
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
  /** Azure service icon — the glyph is picked by {@link BeeNode.icon}. */
  | 'azure'

export type BeeTextAlign = 'left' | 'center' | 'right'
export type BeeTextVAlign = 'top' | 'middle' | 'bottom'

/** Per-shape appearance overrides (studio mode). All optional. */
export type BeeNodeStyle = {
  /** Primary fill (whole shape, or the first part of a multi-part shape). */
  fill?: string
  /**
   * Secondary fill for multi-part shapes:
   * container body, cube top/side, note fold, cylinder top, …
   * When omitted the renderer falls back to a shape-specific default
   * (usually the same as `fill`, so single-colour docs keep their look).
   */
  fill2?: string
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
  /**
   * For shape=azure: the icon id from the Azure stencil registry
   * (`diagram/azureIcons.ts`), e.g. `aks`, `sql-database`, `table-storage`.
   */
  icon?: string
  /** Studio-mode appearance overrides */
  style?: BeeNodeStyle
  /** Rotation in degrees around the shape centre */
  rotation?: number
  /**
   * Id of the `container` shape this node sits in, when it has been dropped
   * into one. Children keep absolute coordinates — the parent link only drives
   * grouped moves, grouped delete/copy, and z-order.
   */
  parentId?: string
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

/** All four speak the OpenAI chat-completions API; only base URL and auth differ. */
export type LlmKind = 'openrouter' | 'xai' | 'openai' | 'lmstudio'

/** Canonical task names. The API also accepts aliases, but send these. */
export type LlmTask = 'continue' | 'rewrite' | 'grammar' | 'format' | 'summarize'

/**
 * A configured provider. The API key stays server-side and is never returned —
 * only {@link LlmProvider.hasKey} and the last four characters.
 */
export type LlmProvider = {
  id: string
  kind: LlmKind
  name: string
  baseUrl: string
  /** "" means "use the provider's first listed model" — normal for LM Studio. */
  model: string
  enabled: boolean
  hasKey: boolean
  /** Last 4 characters of the stored key; null when there is none. */
  keyHint: string | null
  /** false for lmstudio, which is unauthenticated. */
  requiresKey: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** Only `kind` is required — name, baseUrl and a starter model are filled server-side. */
export type CreateLlmProviderRequest = {
  kind: LlmKind
  name?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  enabled?: boolean
  sortOrder?: number
}

export type UpdateLlmProviderRequest = {
  name?: string
  baseUrl?: string
  /** Omit or null leaves the stored key alone; "" clears it. */
  apiKey?: string | null
  model?: string
  enabled?: boolean
  sortOrder?: number
}

export type LlmModel = {
  id: string
  /** Often null on LM Studio and OpenAI. */
  name: string | null
  contextLength: number | null
}

/** Never fails with an error status — a broken provider comes back as ok:false. */
export type LlmTestResult = {
  ok: boolean
  message: string
  modelCount: number | null
  elapsedMs: number
}

export type LlmCompleteRequest = {
  task: LlmTask
  /** continue: the text before the caret. Other tasks: an extra instruction. */
  prompt?: string
  /** Surrounding document, for grounding only. Server keeps the tail. */
  context?: string
  /** The text the action applies to (rewrite/grammar/format/summarize). */
  selection?: string
  /** Omit to use the first enabled provider by sortOrder. */
  providerId?: string
  /** Omit to use the provider's configured model. */
  model?: string
  maxTokens?: number
  temperature?: number
}

export type LlmCompleteResponse = {
  /**
   * Insert verbatim. For `continue` a leading space is deliberate and
   * load-bearing — trimming it glues the suggestion onto the previous word.
   */
  text: string
  providerId: string
  providerName: string
  kind: LlmKind
  model: string
  promptTokens: number | null
  completionTokens: number | null
  elapsedMs: number
}
