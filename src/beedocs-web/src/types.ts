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
  /**
   * When true, `/bookshelf-serve/{slug}` is a public website even if sign-in
   * is on. Unpublished shelves are still previewable by anyone who can already
   * read the workspace.
   */
  published: boolean
  /** Account responsible for the shelf. Null when nobody was identified. */
  ownerId?: string | null
  ownerName?: string | null
  /** Books currently on the shelf. */
  bookCount: number
  /** Where this shelf's content bodies live. Null = Local (SQLite), the default. */
  storageProviderId?: string | null
  /** That provider's name, resolved server-side. */
  storageProviderName?: string | null
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

/** What a favorite can point at. `slides` names a slide deck, as in search. */
export type FavoriteKind = 'book' | 'page' | 'diagram' | 'slides' | 'attachment'

/**
 * One starred item as GET /api/favorites returns it: the target, its live
 * title, and — for anything inside a book — which book, so the panel can
 * build the route. Scoped server-side to the calling account (or one shared
 * list when sign-in is off).
 */
export type Favorite = {
  kind: FavoriteKind
  entityId: string
  title: string
  /** Owning book; null for a favorited book itself. */
  bookId?: string | null
  /** When it was starred — the list's newest-first order. */
  createdAt: string
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
  /** Owner-controlled: while true, old versions can be pulled back up in full. */
  trackChanges: boolean
  /** Stored copies to keep while tracking. 0 = unlimited. */
  maxRevisions: number
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
  /** While true, each entry's full document can be fetched and viewed. */
  trackChanges: boolean
  /** Stored copies kept while tracking. 0 = unlimited. */
  maxRevisions: number
  /** Newest first. */
  entries: PageHistoryEntry[]
}

/** One kept copy of a page, in full — served only while tracking is on. */
export type PageRevision = {
  id: string
  pageId: string
  version: number
  title: string
  content: string
  changeKind: PageChangeKind
  changedById: string | null
  changedByName: string | null
  changedAt: string
  /** True when this copy matches the page's live version. */
  isCurrent: boolean
}

/** Server-rendered export formats. PDF is produced in the browser instead. */
export type ExportFormat = 'archive' | 'markdown' | 'docx'

export type SearchKind =
  | 'page'
  | 'diagram'
  | 'slides'
  | 'attachment'
  | 'book'
  | 'folder'
  | 'shelf'
  | 'gitfile'

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

/** One shelf served as a standalone website. Page bodies are fetched separately. */
export type BookshelfSite = {
  shelf: BookshelfSiteShelf
  books: BookshelfSiteBook[]
}

export type BookshelfSiteShelf = {
  id: string
  title: string
  description?: string | null
  slug: string
  published: boolean
  bookCount: number
}

export type BookshelfSiteBook = {
  id: string
  title: string
  description?: string | null
  slug: string
  sortOrder: number
  chapters: BookshelfSiteChapter[]
  /** Pages sitting on the book root (not in a folder). */
  pages: BookshelfSitePageSummary[]
}

export type BookshelfSiteChapter = {
  id: string
  title: string
  slug: string
  sortOrder: number
  pages: BookshelfSitePageSummary[]
}

export type BookshelfSitePageSummary = {
  id: string
  title: string
  slug: string
  sortOrder: number
  updatedAt: string
}

export type BookshelfSitePage = {
  id: string
  title: string
  slug: string
  content: string
  bookId: string
  bookSlug: string
  bookTitle: string
  chapterId?: string | null
  chapterSlug?: string | null
  chapterTitle?: string | null
  updatedAt: string
}

export type SearchStatus = {
  engine: 'fts5' | 'like'
  documents: number
  pending: number
  pages: number
  diagrams: number
  slideDecks: number
  attachments: number
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

export type DiagramKind = 'beediagram' | 'isometric' | 'mermaid' | 'plantuml' | 'c4'

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

/**
 * A file filed against a book — a PDF, a Word/PowerPoint/Excel document, an
 * archive. The bytes never travel as JSON: `downloadUrl` is the API route that
 * serves them, and uploads go up as multipart form data.
 */
export type AttachmentSummary = {
  id: string
  bookId: string
  title: string
  /** Original name as uploaded — what a download is saved as. */
  fileName: string
  contentType: string
  sizeBytes: number
  ownerId?: string | null
  /** Display name the server resolved for {@link ownerId}. */
  ownerName?: string | null
  /** API route for the bytes. Pass through `withApiBase` before using it. */
  downloadUrl: string
  updatedAt: string
}

export type Attachment = AttachmentSummary & {
  description?: string | null
  createdAt: string
}

/** App-wide reusable deck layout, listed when creating a new deck. */
export type SlideTemplateSummary = {
  id: string
  name: string
  slideCount: number
  updatedAt: string
}

export type SlideTemplate = {
  id: string
  name: string
  /** Deck JSON document, same schema as {@link SlideDeck.source}. */
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

/**
 * The HTTP kinds speak the OpenAI chat-completions API; only base URL and auth
 * differ. The `-cli` kinds run the locally installed `claude`/`grok` command on
 * the machine the API runs on instead — no base URL, no key.
 */
export type LlmKind = 'openrouter' | 'xai' | 'openai' | 'lmstudio' | 'claude-cli' | 'grok-cli'

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
  /** false for lmstudio and the CLI kinds, which authenticate on their own. */
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

export type StorageProviderKind = 'azure-blob' | 'google-drive'

/**
 * A configured backend that shelf content bodies can be offloaded to. Secrets
 * (Azure connection string, Google client secret) stay server-side — only
 * has/hint fields return. There is no enabled flag: a provider that content
 * already points at must always answer, so the only states are "ready"
 * (Azure: connection string stored; Google: consent completed) and "not yet".
 */
export type StorageProvider = {
  id: string
  kind: StorageProviderKind
  name: string
  /** azure-blob: the blob container name. Null for other kinds. */
  container: string | null
  hasConnectionString: boolean
  /** Last 4 characters of the stored connection string; null when there is none. */
  connectionStringHint: string | null
  /** OAuth client id — public in OAuth terms, so it round-trips. */
  googleClientId: string | null
  hasGoogleClientSecret: boolean
  /** google-drive: the consent flow has stored a refresh token. */
  googleConnected: boolean
  /** Shelves currently assigned to this provider. */
  shelfCount: number
  createdAt: string
  updatedAt: string
}

/** Only `kind` is required — the server names the row after its kind. */
export type CreateStorageProviderRequest = {
  kind: StorageProviderKind
  name?: string
  container?: string
  connectionString?: string
  clientId?: string
  clientSecret?: string
}

export type UpdateStorageProviderRequest = {
  name?: string
  container?: string
  /** Omit leaves the stored value alone; "" clears it. */
  connectionString?: string
  /** Changing or clearing either OAuth credential also drops the refresh token. */
  clientId?: string
  clientSecret?: string
}

/** Never fails with an error status — a broken provider comes back as ok:false. */
export type StorageTestResult = {
  ok: boolean
  message: string
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
  /** Author email for git-integration commits. Null until the user sets one. */
  gitEmail: string | null
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
  /**
   * Sign-in is delegated to the central RBA service: credentials are the user's
   * corporate ones, accounts are provisioned on first login, and there is no
   * local password to change or reset. Absent from servers that predate the
   * field, hence optional.
   */
  rbaEnabled?: boolean
  /**
   * Where the browser sends credentials for the client-side RBA login
   * (`POST {rbaBaseUrl}/v1/auth/token/basic`). Only set while RBA is enabled.
   */
  rbaBaseUrl?: string | null
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

/**
 * The RBA login-provider settings (admin-only, GET/PUT/DELETE /api/settings/rba).
 * Nothing here is a secret, so unlike the API key the values come back in full.
 * `source` says where the effective settings live: "settings" = stored via the
 * Settings page (editable at runtime), "config" = the BeeDocs__Rba fallback.
 */
export type RbaSettings = {
  enabled: boolean
  baseUrl: string
  applicationCd: string
  plantCd: string
  syncRoles: boolean
  /**
   * The API server has no route to RBA (cloud API, on-prem RBA): tokens are
   * verified against the pasted `jwks` and roles are managed locally — new
   * accounts start as viewer. The browser-side login is unchanged.
   */
  offline: boolean
  /** Pasted JWKS JSON from {baseUrl}/.well-known/jwks.json. Public keys, not a secret. */
  jwks: string
  timeoutSeconds: number
  source: 'settings' | 'config'
}

/** Result of POST /api/settings/rba/test — with credentials it also reports the mapped role. */
export type RbaTestResult = {
  reachable: boolean
  status: 'success' | 'reachable' | 'invalidCredentials' | 'noAccess' | 'unavailable'
  role: UserRole | null
  userCd: string | null
  message: string
}

/** Instance-wide numbers for the Statistics page (GET /api/stats). */
export type DocumentCounts = {
  shelves: number
  books: number
  chapters: number
  pages: number
  diagrams: number
  slideDecks: number
  attachments: number
  /** Content documents only: pages + diagrams + slide decks + attachments. */
  total: number
}

export type StorageStats = {
  /** Live document text: page Markdown plus diagram and slide-deck JSON. */
  contentBytes: number
  /** The page change log — every kept copy, the price of history. */
  revisionBytes: number
  /** The SQLite files on disk (main + WAL). */
  databaseBytes: number
  /** Uploaded images and other files under /uploads. */
  uploadsBytes: number
  /** Book attachments on disk — the PDFs and Office documents themselves. */
  attachmentBytes: number
  /** Bodies offloaded to storage providers, measured at upload time. */
  externalBytes: number
}

export type DailyActivity = {
  /** UTC calendar date, yyyy-MM-dd. */
  day: string
  created: number
  updated: number
}

export type UserActivity = {
  /** Null for changes made anonymously or with the API key. */
  userId: string | null
  name: string
  /** Change-log entries, all time — sittings, not keystrokes (auto-saves coalesce). */
  changes: number
  pagesTouched: number
  /** Entries inside the stats window — the "active lately" number. */
  changesInWindow: number
  lastActiveAt: string
}

export type InstanceStats = {
  documents: DocumentCounts
  storage: StorageStats
  windowDays: number
  activity: DailyActivity[]
  users: UserActivity[]
  generatedAt: string
}

// --- Git integration ---

/** github and azure-devops can list repos; git means "paste a clone URL". */
export type GitConnectionKind = 'github' | 'azure-devops' | 'git'

/** A connection ("the bookshelf"). The token stays server-side, hasToken/hint only. */
export type GitConnection = {
  id: string
  kind: GitConnectionKind
  name: string
  /** github: org/user name (may be blank = the token's user); azure-devops: org URL; git: ''. */
  baseUrl: string
  username: string
  hasToken: boolean
  tokenHint: string | null
  repoCount: number
  createdAt: string
  updatedAt: string
}

export type CreateGitConnectionRequest = {
  kind: GitConnectionKind
  name?: string
  baseUrl?: string
  username?: string
  token?: string
}

/** token: undefined keeps the stored token, '' deletes it, anything else replaces it. */
export type UpdateGitConnectionRequest = {
  name?: string
  baseUrl?: string
  username?: string
  token?: string
}

export type GitConnectionTestResult = {
  ok: boolean
  message: string
  repoCount: number | null
}

/** A repo the provider lists that could be added. Never persisted server-side. */
export type GitAvailableRepo = {
  name: string
  cloneUrl: string
  defaultBranch: string | null
  description: string | null
  added: boolean
}

export type GitRepoStatusKind = 'cloning' | 'ready' | 'error'

/** A repo on the shelf: a server-side clone plus this management row. */
export type GitRepo = {
  id: string
  connectionId: string
  connectionName: string
  connectionKind: GitConnectionKind
  name: string
  cloneUrl: string
  defaultBranch: string
  status: GitRepoStatusKind
  lastError: string | null
  indexed: boolean
  fetchedAt: string | null
  createdAt: string
  updatedAt: string
}

export type GitTreeEntry = {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number | null
}

/** One working-tree file. Text arrives inline; binaries render via the raw route. */
export type GitFile = {
  path: string
  name: string
  binary: boolean
  size: number
  /** Git blob id of the served bytes — the future save-conflict handle. */
  blobSha: string
  content: string | null
  contentBase64: string | null
  tooLarge: boolean
}

export type GitDirtyEntry = { path: string; state: string }

export type GitStatus = {
  branch: string
  ahead: number
  behind: number
  dirty: GitDirtyEntry[]
}

export type GitBranch = {
  name: string
  current: boolean
  /** Exists only on the remote — checking it out creates the local branch. */
  isRemote: boolean
}

export type GitLogEntry = {
  sha: string
  shortSha: string
  author: string
  authorEmail: string
  date: string
  subject: string
}

export type GitCommitDetail = GitLogEntry & {
  body: string
  /** Unified diff, capped at 256 KB. */
  patch: string
  patchTruncated: boolean
}

export type GitDiff = {
  /** Null when the diff covers the whole working tree. */
  path: string | null
  /** Unified diff against HEAD. Empty = nothing changed. */
  patch: string
  truncated: boolean
}

/** The AI actions on a repo's context menu. */
export type GitAssistKind = 'readme' | 'documentation' | 'manual' | 'summary'

export type GitAssistResult = {
  kind: GitAssistKind
  /** Where a draft of this kind conventionally lives in the repo. */
  suggestedPath: string | null
  markdown: string
  providerName: string
  model: string
  promptTokens: number | null
  completionTokens: number | null
  elapsedMs: number
  /** The files whose excerpts grounded the draft — what the model actually saw. */
  contextFiles: string[]
}

export type GitAssistJobStatus = 'queued' | 'running' | 'completed' | 'failed'

/**
 * One background AI-drafting run against a repo. Lists omit `markdown`; the
 * single-job GET carries it. `bookId`/`pageId` are set once the result was
 * published into the library — a re-run updates that same page in place.
 */
export type GitAssistJob = {
  id: string
  repoId: string
  repoName: string
  kind: GitAssistKind
  status: GitAssistJobStatus
  error: string | null
  instructions: string | null
  providerName: string | null
  model: string | null
  completionTokens: number | null
  elapsedMs: number | null
  contextFiles: string[]
  publishBook: boolean
  shelfId: string | null
  bookId: string | null
  pageId: string | null
  createdByName: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  markdown: string | null
}

export type GitCommitResult = {
  commitSha: string
  /** "Name <email>" as recorded in the commit. */
  author: string
  status: GitStatus
}

/**
 * Raw palette of the active Omarchy desktop theme, reported by /api/branding
 * when the API runs on an Omarchy machine. Only colors the theme actually
 * declared are present — omarchyTheme.ts derives the full token set.
 */
export type OmarchyTheme = {
  name: string
  scheme: 'light' | 'dark'
  background: string
  foreground: string
  accent?: string | null
  muted?: string | null
  bgLighter?: string | null
  bgDarker?: string | null
  selection?: string | null
  red?: string | null
  green?: string | null
  yellow?: string | null
  blue?: string | null
  magenta?: string | null
  cyan?: string | null
}

/** Instance branding — anonymous read, the login screen renders it pre-session. */
export type Branding = {
  title: string
  /** True when an admin stored a title (the settings form shows "reset"). */
  customTitle: boolean
  /** Cache-busted logo URL, or null for the default 🐝 mark. */
  logoUrl: string | null
  omarchy: OmarchyTheme | null
}

export type GenerateLogoResult = {
  /** Sanitized server-side — safe to preview inline. Stored only on apply. */
  svg: string
  providerName: string
  model: string
  elapsedMs: number
}
