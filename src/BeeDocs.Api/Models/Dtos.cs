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
