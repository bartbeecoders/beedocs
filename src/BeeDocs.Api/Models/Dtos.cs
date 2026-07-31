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
/// One-shot publish: ensure a book exists and write a Markdown page into it.
/// Ideal for apps that push generated configuration docs.
/// </summary>
public sealed record PublishDocumentRequest(
    [property: Required] PublishBookPart Book,
    [property: Required] PublishPagePart Page
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

public sealed record PublishDocumentResult(
    BookDto Book,
    PageDto Page,
    bool BookCreated,
    bool PageCreated
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
