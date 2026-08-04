using System.ComponentModel.DataAnnotations;

namespace BeeDocs.Api.Models;

public sealed record BookDto(
    string Id,
    string Title,
    string? Description,
    string Slug,
    int SortOrder,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public sealed record CreateBookRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug
);

public sealed record UpdateBookRequest(
    [property: Required, MinLength(1)] string Title,
    string? Description,
    string? Slug,
    int? SortOrder
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

public sealed record UpdateChapterRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    int? SortOrder
);

public sealed record PageSummaryDto(
    string Id,
    string BookId,
    string? ChapterId,
    string Title,
    string Slug,
    int SortOrder,
    int Version,
    DateTimeOffset UpdatedAt
);

public sealed record PageDto(
    string Id,
    string BookId,
    string? ChapterId,
    string Title,
    string Slug,
    string Content,
    int SortOrder,
    int Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public sealed record CreatePageRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    string? Content,
    string? ChapterId,
    int? SortOrder
);

public sealed record UpdatePageRequest(
    [property: Required, MinLength(1)] string Title,
    string? Slug,
    string? Content,
    string? ChapterId,
    int? SortOrder
);

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
/// optionally inside a folder (chapter) of the book.
/// Ideal for apps that push generated configuration docs.
/// </summary>
public sealed record PublishDocumentRequest(
    [property: Required] PublishBookPart Book,
    [property: Required] PublishPagePart Page,
    /// <summary>Optional folder inside the book the page is placed in (created when missing).</summary>
    PublishFolderPart? Folder = null
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

public sealed record PublishDocumentResult(
    BookDto Book,
    PageDto Page,
    bool BookCreated,
    bool PageCreated,
    /// <summary>The folder the page was placed in, when the request specified one.</summary>
    ChapterDto? Folder = null,
    bool FolderCreated = false
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

/// <param name="Kind">book, folder, page or diagram.</param>
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
    int Books,
    int Folders,
    DateTimeOffset? LastIndexedAt
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
