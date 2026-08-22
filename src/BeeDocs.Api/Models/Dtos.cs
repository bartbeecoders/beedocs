using System.ComponentModel.DataAnnotations;

namespace BeeDocs.Api.Models;

/// <param name="OwnerId">Account responsible for the shelf, or null when nobody was identified.</param>
/// <param name="BookCount">Books currently on the shelf.</param>
/// <param name="Published">True when <c>/bookshelf-serve/{slug}</c> is a public website.</param>
/// <param name="StorageProviderId">Where content bodies live, or null for local SQLite.</param>
/// <param name="StorageProviderName">That provider's name, resolved for the client.</param>
public sealed record ShelfDto(
    string Id,
    string Title,
    string? Description,
    string Slug,
    int SortOrder,
    bool Published,
    string? OwnerId,
    string? OwnerName,
    int BookCount,
    string? StorageProviderId,
    string? StorageProviderName,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="OwnerId">Omit to take the caller as owner.</param>
/// <param name="Published">Serve this shelf as a public website. Default false.</param>
public sealed record CreateShelfRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug,
    string? OwnerId = null,
    bool? Published = null
);

/// <param name="Description">null leaves it untouched; "" clears it.</param>
/// <param name="OwnerId">null leaves the owner untouched; "" clears it; anything else replaces it.</param>
/// <param name="Published">null leaves it untouched.</param>
public sealed record UpdateShelfRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug,
    int? SortOrder,
    string? OwnerId = null,
    bool? Published = null
);

/// <param name="ShelfId">The shelf this book sits on, or null when it sits at the library root.</param>
/// <param name="ShelfTitle">That shelf's title, resolved for the client.</param>
/// <param name="OwnerId">Account responsible for the book, or null when nobody was identified.</param>
/// <param name="OwnerName">That account's display name, resolved for the client. Null when the account is gone.</param>
public sealed record BookDto(
    string Id,
    string Title,
    string? Description,
    string Slug,
    int SortOrder,
    string? ShelfId,
    string? ShelfTitle,
    string? OwnerId,
    string? OwnerName,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="ShelfId">Omit or leave blank to create the book at the library root.</param>
/// <param name="OwnerId">Omit to take the caller as owner.</param>
public sealed record CreateBookRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug,
    string? OwnerId = null,
    string? ShelfId = null
);

/// <param name="Description">null leaves it untouched; "" clears it. A partial update must not delete text it never mentioned.</param>
/// <param name="ShelfId">null leaves the shelf untouched; "" moves the book to the library root; anything else shelves it there.</param>
/// <param name="OwnerId">null leaves the owner untouched; "" clears it; anything else replaces it.</param>
public sealed record UpdateBookRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug,
    int? SortOrder,
    string? OwnerId = null,
    string? ShelfId = null
);

public sealed record ChapterDto(
    string Id,
    string BookId,
    string Title,
    string Slug,
    int SortOrder,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public sealed record CreateChapterRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    int? SortOrder
);

/// <param name="Title">Omit to leave the name alone (needed only when renaming).</param>
/// <param name="BookId">
/// Null/omit leaves the folder where it is; a different id moves the folder
/// and every page inside it (page-linked diagrams follow).
/// </param>
public sealed record UpdateChapterRequest(
    string? Title,
    string? Slug,
    int? SortOrder,
    string? BookId = null
);

public sealed record PageSummaryDto(
    string Id,
    string BookId,
    string? ChapterId,
    string Title,
    string Slug,
    int SortOrder,
    int Version,
    string? OwnerId,
    string? OwnerName,
    DateTimeOffset UpdatedAt
);

/// <param name="OwnerId">Account responsible for the page. Inherited from the book on create.</param>
/// <param name="UpdatedById">Who made the most recent change. Null on pages last changed before history was recorded.</param>
/// <param name="TrackChanges">Owner-controlled: while true, old versions can be pulled back up in full.</param>
/// <param name="MaxRevisions">Stored copies to keep while tracking. 0 = unlimited.</param>
public sealed record PageDto(
    string Id,
    string BookId,
    string? ChapterId,
    string Title,
    string Slug,
    string Content,
    int SortOrder,
    int Version,
    string? OwnerId,
    string? OwnerName,
    string? UpdatedById,
    string? UpdatedByName,
    bool TrackChanges,
    int MaxRevisions,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="OwnerId">Omit to inherit the book's owner, falling back to the caller.</param>
public sealed record CreatePageRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    string? Content,
    string? ChapterId,
    int? SortOrder,
    string? OwnerId = null
);

/// <param name="OwnerId">null leaves the owner untouched; "" clears it; anything else replaces it.</param>
/// <param name="TrackChanges">null leaves it untouched. Changing it needs the page's owner or an admin.</param>
/// <param name="MaxRevisions">null leaves it untouched; 0 = unlimited. Changing it needs the page's owner or an admin.</param>
/// <param name="BookId">
/// Null/omit leaves the page in its book; a different id moves it (and any
/// diagrams linked to it). A folder id must belong to that destination book.
/// </param>
public sealed record UpdatePageRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    string? Content,
    string? ChapterId,
    int? SortOrder,
    string? OwnerId = null,
    bool? TrackChanges = null,
    int? MaxRevisions = null,
    string? BookId = null
);

/// <summary>
/// One change to a page: what version it produced, when, and who made it.
/// </summary>
/// <param name="Version">The page version this change produced.</param>
/// <param name="Title">The page's title after the change.</param>
/// <param name="ChangeKind">created | updated.</param>
/// <param name="ChangedById">Null for an API-key caller, for changes made while sign-in was off, and for history recorded before this feature existed.</param>
/// <param name="ChangedByName">Display name captured at the time of the change.</param>
/// <param name="IsCurrent">True for the entry matching the page's live version.</param>
public sealed record PageHistoryEntryDto(
    string Id,
    int Version,
    string Title,
    string ChangeKind,
    string? ChangedById,
    string? ChangedByName,
    DateTimeOffset ChangedAt,
    bool IsCurrent
);

/// <param name="TrackChanges">While true, each entry's full document can be fetched via /pages/{id}/revisions/{revisionId}.</param>
/// <param name="MaxRevisions">Stored copies kept while tracking. 0 = unlimited.</param>
public sealed record PageHistoryDto(
    string PageId,
    string Title,
    int Version,
    bool TrackChanges,
    int MaxRevisions,
    IReadOnlyList<PageHistoryEntryDto> Entries
);

/// <summary>
/// One kept copy of a page, in full — what "pull up an old version" returns.
/// Served only while the page has change tracking switched on.
/// </summary>
/// <param name="IsCurrent">True when this copy matches the page's live version.</param>
public sealed record PageRevisionDto(
    string Id,
    string PageId,
    int Version,
    string Title,
    string Content,
    string ChangeKind,
    string? ChangedById,
    string? ChangedByName,
    DateTimeOffset ChangedAt,
    bool IsCurrent
);

// --- Instance settings (/api/settings) ---

/// <summary>
/// Status of the shared publish API key. The key itself is never returned —
/// only whether one exists, where it comes from, and its last four characters.
/// </summary>
/// <param name="Source"><c>settings</c> (stored, editable at runtime), <c>config</c>
/// (BeeDocs:ApiKey fallback), or null when no key is configured.</param>
public sealed record ApiKeyStatusDto(bool HasKey, string? Source, string? KeyHint);

/// <summary>Null or empty clears the stored key (a configured fallback then applies again).</summary>
public sealed record UpdateApiKeyRequest(string? ApiKey);

// --- External publish API (slug-based, /api/v1) ---

/// <summary>Create or update a book addressed by slug.</summary>
public sealed record UpsertBookRequest(
    /// <summary>Display title. Defaults to the slug when omitted on create.</summary>
    string? Title,
    string? Description,
    int? SortOrder
);

/// <summary>Create or update a page addressed by book slug + page slug.</summary>
public sealed record UpsertPageRequest(
    /// <summary>Display title. Defaults to the page slug when omitted on create.</summary>
    string? Title,
    /// <summary>Markdown body. Required on create; omit on update to leave content unchanged.</summary>
    string? Content,
    int? SortOrder
);

/// <summary>
/// One-shot publish: ensure a book exists and write a Markdown page into it,
/// optionally inside a folder (chapter) of the book, and optionally place the
/// book on a shelf. Ideal for apps that push generated configuration docs.
/// </summary>
public sealed record PublishDocumentRequest(
    [property: Required] PublishBookPart Book,
    [property: Required] PublishPagePart Page,
    /// <summary>Optional folder inside the book the page is placed in (created when missing).</summary>
    PublishFolderPart? Folder = null,
    /// <summary>Optional shelf the book is placed on (created when missing).</summary>
    PublishShelfPart? Shelf = null
);

public sealed record PublishBookPart(
    [property: Required, MinLength(1)] string Title,
    /// <summary>Stable id for re-publishes. Defaults to a slug of <see cref="Title"/>.</summary>
    string? Slug,
    string? Description
);

public sealed record PublishPagePart(
    [property: Required, MinLength(1)] string Title,
    /// <summary>Stable id within the book. Defaults to a slug of <see cref="Title"/>.</summary>
    string? Slug,
    /// <summary>Markdown document body.</summary>
    [property: Required] string Content,
    int? SortOrder
);

/// <summary>Folder (chapter) inside the book, matched by slug and created when missing.</summary>
public sealed record PublishFolderPart(
    [property: Required, MinLength(1)] string Title,
    /// <summary>Stable id within the book. Defaults to a slug of <see cref="Title"/>.</summary>
    string? Slug
);

/// <summary>Shelf the book sits on, matched by slug and created when missing.</summary>
public sealed record PublishShelfPart(
    [property: Required, MinLength(1)] string Title,
    /// <summary>Stable id. Defaults to a slug of <see cref="Title"/>.</summary>
    string? Slug
);

public sealed record PublishDocumentResult(
    BookDto Book,
    PageDto Page,
    bool BookCreated,
    bool PageCreated,
    /// <summary>The folder the page was placed in, when the request specified one.</summary>
    ChapterDto? Folder = null,
    bool FolderCreated = false,
    /// <summary>The shelf the book was placed on, when the request specified one.</summary>
    ShelfDto? Shelf = null,
    bool ShelfCreated = false
);

public sealed record UpsertResult<T>(T Item, bool Created);

public sealed record DiagramDto(
    string Id,
    string BookId,
    string? PageId,
    string Title,
    string Kind,
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public sealed record DiagramSummaryDto(
    string Id,
    string BookId,
    string? PageId,
    string Title,
    string Kind,
    DateTimeOffset UpdatedAt
);

public sealed record CreateDiagramRequest(
    [property: Required, MinLength(1)] string Title,
    string? Kind,
    string? Source,
    string? PageId
);

public sealed record UpdateDiagramRequest(
    [property: Required, MinLength(1)] string Title,
    string? Kind,
    string? Source,
    string? PageId
);

public sealed record SlideDeckDto(
    string Id,
    string BookId,
    string Title,
    /// <summary>JSON slide document — see src/beedocs-web/src/slides/slideModel.ts.</summary>
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="SlideCount">Slides in the deck, counted from the stored document.</param>
public sealed record SlideDeckSummaryDto(
    string Id,
    string BookId,
    string Title,
    int SlideCount,
    DateTimeOffset UpdatedAt
);

/// <param name="Source">Omit to start with a single blank slide.</param>
/// <param name="TemplateId">Start from a saved template; ignored when <paramref name="Source"/> is given.</param>
public sealed record CreateSlideDeckRequest(
    [property: Required, MinLength(1)] string Title,
    string? Source,
    string? TemplateId = null
);

/// <param name="Source">null leaves the stored document untouched.</param>
public sealed record UpdateSlideDeckRequest(
    [property: Required, MinLength(1)] string Title,
    string? Source
);

public sealed record SlideTemplateDto(
    string Id,
    string Name,
    /// <summary>Deck JSON document — same schema as <see cref="SlideDeckDto.Source"/>.</summary>
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="SlideCount">Slides in the template, counted from the stored document.</param>
public sealed record SlideTemplateSummaryDto(
    string Id,
    string Name,
    int SlideCount,
    DateTimeOffset UpdatedAt
);

public sealed record CreateSlideTemplateRequest(
    [property: Required, MinLength(1)] string Name,
    [property: Required, MinLength(1)] string Source
);

/// <param name="Source">null keeps the stored layout (rename only).</param>
public sealed record UpdateSlideTemplateRequest(
    [property: Required, MinLength(1)] string Name,
    string? Source
);

// --- Attachments (files kept alongside a book's pages) ---

/// <param name="FileName">Original name as uploaded — what a download is served as.</param>
/// <param name="DownloadUrl">Ready-made API route for fetching the bytes.</param>
/// <param name="OwnerName">Display name the server resolved for <paramref name="OwnerId"/>.</param>
public sealed record AttachmentDto(
    string Id,
    string BookId,
    string Title,
    string? Description,
    string FileName,
    string ContentType,
    long SizeBytes,
    string? OwnerId,
    string? OwnerName,
    string DownloadUrl,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <summary>List projection. Same fields minus the description, which only the detail view shows.</summary>
public sealed record AttachmentSummaryDto(
    string Id,
    string BookId,
    string Title,
    string FileName,
    string ContentType,
    long SizeBytes,
    string? OwnerId,
    string? OwnerName,
    string DownloadUrl,
    DateTimeOffset UpdatedAt
);

/// <summary>
/// Properties only — the bytes are replaced through
/// <c>POST /api/attachments/{id}/file</c>, never here.
/// </summary>
/// <param name="Description">null leaves it alone, "" clears it — same convention as <see cref="UpdateBookRequest"/>.</param>
/// <param name="OwnerId">null leaves it alone, "" unassigns.</param>
/// <param name="FileName">null keeps the stored name; otherwise renames the downloaded file.</param>
public sealed record UpdateAttachmentRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? OwnerId,
    string? FileName
);

public sealed record ShapeCollectionDto(
    string Id,
    /// <summary>Owning book, or null when the collection is app-wide.</summary>
    string? BookId,
    string Name,
    string? Description,
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public sealed record ShapeCollectionSummaryDto(
    string Id,
    string? BookId,
    string Name,
    string? Description,
    DateTimeOffset UpdatedAt
);

public sealed record CreateShapeCollectionRequest(
    [property: Required, MinLength(1)] string Name,
    string? Description,
    [property: Required, MinLength(1)] string Source
);

public sealed record UpdateShapeCollectionRequest(
    [property: Required, MinLength(1)] string Name,
    string? Description,
    string? Source
);

/// <param name="Kind">shelf, book, folder, page, diagram, slides or attachment.</param>
/// <param name="Snippet">Matching excerpt. Matched terms are wrapped in U+E000/U+E001.</param>
/// <param name="Url">Workspace route for the hit.</param>
/// <param name="Score">bm25 rank — lower is a better match.</param>
public sealed record SearchHitDto(
    string Kind,
    string Id,
    string Title,
    string? Snippet,
    string? BookId,
    string? BookTitle,
    string? ChapterId,
    string Url,
    double Score,
    DateTimeOffset UpdatedAt
);

/// <param name="Total">Matches across the whole library, not just this page of hits.</param>
/// <param name="Engine">fts5, or like where the SQLite build has no FTS5.</param>
public sealed record SearchResponseDto(
    string Query,
    int Total,
    int Limit,
    int Offset,
    string Engine,
    IReadOnlyList<SearchHitDto> Hits
);

/// <param name="Pending">Changes queued but not yet indexed. Drained on the next search.</param>
public sealed record SearchStatusDto(
    string Engine,
    int Documents,
    int Pending,
    int Pages,
    int Diagrams,
    int SlideDecks,
    int Attachments,
    int Books,
    int Folders,
    int Shelves,
    DateTimeOffset? LastIndexedAt
);

// --- Bookshelf website (GET /api/bookshelf-serve/{name}) ---

/// <summary>
/// One shelf served as a standalone website: the shelf itself plus every book,
/// folder and page on it. Page bodies are fetched separately so the nav tree
/// stays a cheap first paint.
/// </summary>
public sealed record BookshelfSiteDto(
    BookshelfSiteShelfDto Shelf,
    IReadOnlyList<BookshelfSiteBookDto> Books
);

public sealed record BookshelfSiteShelfDto(
    string Id,
    string Title,
    string? Description,
    string Slug,
    bool Published,
    int BookCount
);

public sealed record BookshelfSiteBookDto(
    string Id,
    string Title,
    string? Description,
    string Slug,
    int SortOrder,
    IReadOnlyList<BookshelfSiteChapterDto> Chapters,
    IReadOnlyList<BookshelfSitePageDto> Pages
);

public sealed record BookshelfSiteChapterDto(
    string Id,
    string Title,
    string Slug,
    int SortOrder,
    IReadOnlyList<BookshelfSitePageDto> Pages
);

public sealed record BookshelfSitePageDto(
    string Id,
    string Title,
    string Slug,
    int SortOrder,
    DateTimeOffset UpdatedAt
);

/// <summary>A page as the website reader sees it — body included, no owner fields.</summary>
public sealed record BookshelfSitePageContentDto(
    string Id,
    string Title,
    string Slug,
    string Content,
    string BookId,
    string BookSlug,
    string BookTitle,
    string? ChapterId,
    string? ChapterSlug,
    string? ChapterTitle,
    DateTimeOffset UpdatedAt
);

// --- LLM providers & completion ---

/// <summary>
/// A provider as the client sees it. There is deliberately no key field: the key
/// is write-only, and <paramref name="KeyHint"/> is all a UI needs to tell two
/// keys apart.
/// </summary>
/// <param name="Kind">openrouter | xai | openai | lmstudio.</param>
/// <param name="Model">Preferred model id. Empty = whatever the provider lists first.</param>
/// <param name="KeyHint">Last four characters of the stored key, or null when none is stored.</param>
public sealed record LlmProviderDto(
    string Id,
    string Kind,
    string Name,
    string BaseUrl,
    string Model,
    bool Enabled,
    bool HasKey,
    string? KeyHint,
    /// <summary>False for LM Studio, which is usually unauthenticated.</summary>
    bool RequiresKey,
    int SortOrder,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="BaseUrl">Omit to take the default for <paramref name="Kind"/>.</param>
public sealed record CreateLlmProviderRequest(
    [property: Required, MinLength(1)] string Kind,
    string? Name,
    string? BaseUrl,
    string? ApiKey,
    string? Model,
    bool? Enabled,
    int? SortOrder
);

/// <param name="ApiKey">null = leave the stored key untouched; "" = delete it; anything else = replace it.</param>
public sealed record UpdateLlmProviderRequest(
    string? Name,
    string? BaseUrl,
    string? ApiKey,
    string? Model,
    bool? Enabled,
    int? SortOrder
);

/// <param name="ContextLength">Tokens, when the provider reports it.</param>
public sealed record LlmModelDto(
    string Id,
    string? Name,
    int? ContextLength
);

/// <param name="Task">continue | rewrite | grammar | format | summarize.</param>
/// <param name="Prompt">For continue: the text immediately before the caret. Otherwise an optional extra instruction.</param>
/// <param name="Context">Surrounding document text. Sent for grounding only, never echoed back.</param>
/// <param name="Selection">The text the selection actions operate on.</param>
/// <param name="ProviderId">Omit to use the first enabled provider.</param>
/// <param name="Model">Omit to use the provider's configured model.</param>
public sealed record LlmCompleteRequest(
    [property: Required, MinLength(1)] string Task,
    string? Prompt,
    string? Context,
    string? Selection,
    string? ProviderId,
    string? Model,
    int? MaxTokens,
    double? Temperature
);

/// <param name="Text">The answer, already stripped of preamble and wrapping code fences.</param>
public sealed record LlmCompleteResponse(
    string Text,
    string ProviderId,
    string ProviderName,
    string Kind,
    string Model,
    int? PromptTokens,
    int? CompletionTokens,
    int ElapsedMs
);

/// <param name="Message">Human-readable either way — show it verbatim.</param>
public sealed record LlmTestResultDto(
    bool Ok,
    string Message,
    /// <summary>Model count the provider reported, when the call got that far.</summary>
    int? ModelCount,
    int ElapsedMs
);

// --- Storage providers ---

/// <summary>
/// A storage provider as the client sees it. The Azure connection string, Google
/// client secret and refresh token are write-only — only has/hint fields return.
/// There is no enabled flag: a provider that content already points at must
/// always answer, so the only states are "ready" (Azure: connection string
/// stored; Google: consent completed) and "not yet".
/// </summary>
/// <param name="Kind">azure-blob | google-drive.</param>
/// <param name="Container">azure-blob: the blob container name.</param>
/// <param name="ConnectionStringHint">Last four characters of the stored connection string, or null.</param>
/// <param name="GoogleClientId">Echoed — an OAuth client id is public by design.</param>
/// <param name="GoogleConnected">google-drive: the consent flow has stored a refresh token.</param>
/// <param name="ShelfCount">Shelves currently assigned to this provider.</param>
public sealed record StorageProviderDto(
    string Id,
    string Kind,
    string Name,
    string? Container,
    bool HasConnectionString,
    string? ConnectionStringHint,
    string? GoogleClientId,
    bool HasGoogleClientSecret,
    bool GoogleConnected,
    int ShelfCount,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="Name">Omit to take the default for <paramref name="Kind"/>.</param>
/// <param name="Container">azure-blob: omit for "beedocs".</param>
public sealed record CreateStorageProviderRequest(
    [property: Required, MinLength(1)] string Kind,
    string? Name,
    string? Container,
    string? ConnectionString,
    string? ClientId,
    string? ClientSecret
);

/// <param name="ConnectionString">null = leave the stored value untouched; "" = delete it; anything else = replace it.</param>
/// <param name="ClientId">Same convention. Changing or clearing it also drops the refresh token — a token minted for one client is useless under another.</param>
/// <param name="ClientSecret">Same convention as <paramref name="ConnectionString"/>, and same token-drop rule as <paramref name="ClientId"/>.</param>
public sealed record UpdateStorageProviderRequest(
    string? Name,
    string? Container,
    string? ConnectionString,
    string? ClientId,
    string? ClientSecret
);

/// <param name="Message">Human-readable either way — show it verbatim.</param>
public sealed record StorageTestResultDto(bool Ok, string Message);

/// <param name="Url">Google consent page to open in a browser.</param>
public sealed record StorageConnectResponseDto(string Url);

/// <param name="ProviderId">Target provider, or null to move content back to local SQLite.</param>
public sealed record AssignShelfStorageRequest(string? ProviderId);

// --- Users, roles & sign-in ---

/// <summary>
/// An account as every client sees it. There is deliberately no password field in
/// either direction of this record — the hash is selected in exactly one place
/// (<see cref="Services.UserService"/>'s login path) and never reaches a DTO.
/// </summary>
/// <param name="Role">admin | editor | viewer.</param>
/// <param name="MustChangePassword">Set for the seeded admin and after an admin reset.</param>
/// <summary>
/// The minimum needed to name an account: what an owner picker shows. Available
/// to every signed-in role, unlike <see cref="UserDto"/> — you cannot assign an
/// owner you are not allowed to name.
/// </summary>
public sealed record UserSummaryDto(
    string Id,
    string Username,
    string? DisplayName,
    string Role
);

public sealed record UserDto(
    string Id,
    string Username,
    string? DisplayName,
    string? Email,
    string Role,
    bool Enabled,
    bool MustChangePassword,
    DateTimeOffset? LastLoginAt,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

/// <param name="Role">Defaults to viewer — the role that cannot break anything.</param>
public sealed record CreateUserRequest(
    [property: Required, MinLength(1)] string Username,
    [property: Required, MinLength(1)] string Password,
    string? DisplayName,
    string? Email,
    string? Role,
    bool? Enabled,
    bool? MustChangePassword
);

/// <summary>Every field is optional: omitted means "leave as it is".</summary>
public sealed record UpdateUserRequest(
    string? Username,
    string? DisplayName,
    string? Email,
    string? Role,
    bool? Enabled
);

/// <summary>Admin-initiated reset. Omit <paramref name="Password"/> to have one generated.</summary>
public sealed record SetUserPasswordRequest(
    string? Password,
    bool? MustChangePassword
);

/// <param name="Password">The new password, echoed back only when the server generated it.</param>
public sealed record SetUserPasswordResultDto(
    UserDto User,
    string? Password
);

/// <summary>
/// The first-run claim: the account the person setting the instance up chooses
/// for themselves. Accepted only while no account exists.
/// </summary>
public sealed record SetupRequest(
    [property: Required, MinLength(1)] string Username,
    [property: Required, MinLength(1)] string Password,
    string? DisplayName
);

public sealed record LoginRequest(
    [property: Required, MinLength(1)] string Username,
    [property: Required, MinLength(1)] string Password
);

public sealed record ChangePasswordRequest(
    [property: Required, MinLength(1)] string CurrentPassword,
    [property: Required, MinLength(1)] string NewPassword
);

/// <summary>
/// What the caller may do, resolved server-side. The UI hides affordances from
/// these rather than re-deriving the role rules, so there is one implementation.
/// </summary>
public sealed record AuthPermissionsDto(
    bool CanRead,
    bool CanWrite,
    bool CanManageUsers
);

/// <summary>
/// The answer to "who am I, and is any of this switched on" — the SPA's first
/// call, and the reason it can render a login screen or skip straight past one.
/// </summary>
/// <param name="AuthEnabled">False when BeeDocs:Auth:Enabled is off: nothing is gated.</param>
/// <param name="Via">session | apiKey | open.</param>
/// <param name="User">Null for an API-key caller and when auth is off.</param>
/// <param name="SetupRequired">
/// No account exists yet, so the instance is unclaimed and
/// <c>POST /api/auth/setup</c> is open. Reported whatever
/// <paramref name="AuthEnabled"/> says — an instance running openly has simply
/// never needed one — so a client that wants to show a setup screen should
/// require both.
/// </param>
public sealed record AuthStateDto(
    bool AuthEnabled,
    bool Authenticated,
    string Via,
    UserDto? User,
    AuthPermissionsDto Permissions,
    bool SetupRequired
);

/// <summary>How many of each thing the library holds. Total counts content documents (pages + diagrams + slide decks + attachments), not the containers around them.</summary>
public sealed record DocumentCountsDto(
    int Shelves,
    int Books,
    int Chapters,
    int Pages,
    int Diagrams,
    int SlideDecks,
    int Attachments,
    int Total
);

/// <param name="ContentBytes">Live document text stored locally: page Markdown plus diagram and slide-deck JSON.</param>
/// <param name="RevisionBytes">The page change log — every locally kept copy, the price of history.</param>
/// <param name="DatabaseBytes">The SQLite files on disk (main + WAL), everything included.</param>
/// <param name="UploadsBytes">Uploaded images and other files under /uploads.</param>
/// <param name="AttachmentBytes">Book attachments on disk — the PDFs and Office documents themselves.</param>
/// <param name="ExternalBytes">Bodies offloaded to storage providers, measured at upload time.</param>
public sealed record StorageStatsDto(
    long ContentBytes,
    long RevisionBytes,
    long DatabaseBytes,
    long UploadsBytes,
    long AttachmentBytes,
    long ExternalBytes
);

/// <param name="Day">UTC calendar date, yyyy-MM-dd.</param>
/// <param name="Created">Documents (pages, diagrams, slide decks) created that day.</param>
/// <param name="Updated">Documents changed that day — from the page change log, so one per page per sitting; diagrams and slide decks contribute only their latest update.</param>
public sealed record DailyActivityDto(
    string Day,
    int Created,
    int Updated
);

/// <summary>One author from the page change log, deleted accounts and machine callers included.</summary>
/// <param name="UserId">Null for changes made anonymously or with the API key.</param>
/// <param name="Changes">Change-log entries by this author, all time. Rapid auto-saves coalesce, so this counts sittings, not keystrokes.</param>
/// <param name="ChangesInWindow">Entries inside the stats window — the "active lately" number.</param>
public sealed record UserActivityDto(
    string? UserId,
    string Name,
    int Changes,
    int PagesTouched,
    int ChangesInWindow,
    DateTimeOffset LastActiveAt
);

/// <summary>The Statistics page in one payload: counts, storage, a per-day activity series, and per-author change totals.</summary>
public sealed record InstanceStatsDto(
    DocumentCountsDto Documents,
    StorageStatsDto Storage,
    int WindowDays,
    IReadOnlyList<DailyActivityDto> Activity,
    IReadOnlyList<UserActivityDto> Users,
    DateTimeOffset GeneratedAt
);
