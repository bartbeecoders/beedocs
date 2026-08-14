/**
 * The level above books: a named grouping of related books. A shelf holds no
 * content of its own — deleting one returns its books to the library root.
 */
export type Shelf = {
  id: string
  title: string
  description?: string | null
  slug: string
  sortOrder: number
  /** Account responsible for the shelf. Null when nobody was identified. */
  ownerId?: string | null
  ownerName?: string | null
  /** Books currently on the shelf. */
  bookCount: number
  createdAt: string
  updatedAt: string
}

export type Book = {
  id: string
  title: string
  description?: string | null
  slug: string
  sortOrder: number
  /** Shelf this book sits on. Null/undefined means the library root. */
  shelfId?: string | null
  /** That shelf's title, resolved server-side. */
  shelfTitle?: string | null
  /** Account responsible for the book. Null when nobody was identified. */
  ownerId?: string | null
  /** The owner's display name, resolved server-side. Null once the account is gone. */
  ownerName?: string | null
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
  /** Inherited from the book when the page is created; reassignable afterwards. */
  ownerId?: string | null
  ownerName?: string | null
  updatedAt: string
}

export type Page = PageSummary & {
  content: string
  /** Who made the most recent change. Null on pages last written before history existed. */
  updatedById?: string | null
  updatedByName?: string | null
  createdAt: string
}

/**
 * `created` and `updated` are real log entries. `legacy` marks a revision from
 * before the change log existed: its content is right, but its timestamp marks
 * when that version *ended* and nobody recorded an author.
 */
export type PageChangeKind = 'created' | 'updated' | 'legacy'

/** One change to a page: the version it produced, when, and who made it. */
export type PageHistoryEntry = {
  id: string
  version: number
  title: string
  changeKind: PageChangeKind
  changedById: string | null
  changedByName: string | null
  changedAt: string
  /** True for the entry matching the page's live version. */
  isCurrent: boolean
}

export type PageHistory = {
  pageId: string
  title: string
  version: number
  /** Newest first. */
  entries: PageHistoryEntry[]
}

/** Server-rendered export formats. PDF is produced in the browser instead. */
export type ExportFormat = 'archive' | 'markdown' | 'docx'

export type SearchKind = 'page' | 'diagram' | 'slides' | 'book' | 'folder' | 'shelf'

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
  slideDecks: number
  books: number
  folders: number
  shelves: number
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

/**
 * A PowerPoint-style presentation stored in a book next to pages and diagrams.
 * `source` is a JSON slide document — see slides/slideModel.ts for the schema.
 */
export type SlideDeckSummary = {
  id: string
  bookId: string
  title: string
  /** Slides in the deck, counted server-side from the stored document. */
  slideCount: number
  updatedAt: string
}

/** The full deck. No `slideCount` — the client holding `source` can count for itself. */
export type SlideDeck = {
  id: string
  bookId: string
  title: string
  source: string
  createdAt: string
  updatedAt: string
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

/**
 * admin — everything, plus account management
 * editor — create/edit/delete content
 * viewer — read, search and export only
 */
export type UserRole = 'admin' | 'editor' | 'viewer'

/** An account. Passwords never travel in this direction — there is no hash field. */
export type User = {
  id: string
  /** Normalised (lower-case) login name. */
  username: string
  displayName: string | null
  email: string | null
  role: UserRole
  enabled: boolean
  /** Set on the seeded admin and after an admin reset. Advisory: nothing is blocked. */
  mustChangePassword: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/** Resolved server-side, so the UI never re-derives the role rules. */
export type AuthPermissions = {
  canRead: boolean
  canWrite: boolean
  canManageUsers: boolean
}

/**
 * `authEnabled: false` means BeeDocs:Auth:Enabled is off — nothing is gated and
 * `permissions` is wide open. `via` says how the caller was recognised:
 * `session` (cookie), `apiKey` (a machine), `open` (auth off), `none`.
 */
export type AuthState = {
  authEnabled: boolean
  authenticated: boolean
  via: 'session' | 'apiKey' | 'open' | 'none'
  user: User | null
  permissions: AuthPermissions
  /**
   * No account exists yet, so the instance is unclaimed and `/api/auth/setup` is
   * open. Reported whether or not sign-in is enabled — an open instance has
   * simply never needed an account — so the setup screen requires both this and
   * {@link AuthState.authEnabled}.
   */
  setupRequired: boolean
}

/**
 * Enough to name an account, for owner pickers. Readable by every signed-in
 * role, unlike the full {@link User} list which is admin-only.
 */
export type UserSummary = {
  id: string
  username: string
  displayName: string | null
  role: UserRole
}

export type CreateUserRequest = {
  username: string
  password: string
  displayName?: string
  email?: string
  role?: UserRole
  enabled?: boolean
  mustChangePassword?: boolean
}

/** Every field optional: omitted means "leave as it is". */
export type UpdateUserRequest = {
  username?: string
  displayName?: string
  email?: string
  role?: UserRole
  enabled?: boolean
}

/** `password` is non-null only when the server generated it — the one time it is ever returned. */
export type SetUserPasswordResult = {
  user: User
  password: string | null
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

/**
 * Status of the shared publish API key (/api/v1, /api/llm, non-browser sign-in).
 * The key itself is never returned — only whether one exists, where it comes
 * from ("settings" = stored via the Settings page, "config" = BeeDocs__ApiKey
 * fallback), and its last four characters.
 */
export type ApiKeyStatus = {
  hasKey: boolean
  source: 'settings' | 'config' | null
  keyHint: string | null
}
