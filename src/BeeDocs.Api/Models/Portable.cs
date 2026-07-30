using System.Text.Json;
using System.Text.Json.Serialization;

namespace BeeDocs.Api.Models;

/// <summary>
/// Where user content lives on disk. Resolved once in Program.cs so services do
/// not have to re-derive it from configuration (the configured value may be
/// relative to the content root).
/// </summary>
public sealed record StorageOptions(string UploadsRoot);

/// <summary>
/// The BeeDocs portable archive: a zip with <c>beedocs.json</c> at the root and
/// referenced images under <c>assets/</c>.
///
/// Records are linked by *local* refs (<c>p1</c>, <c>ch2</c>, …) rather than
/// database ids, so an archive can be imported into any instance without
/// colliding with existing records. Original ids are kept alongside so that
/// <c>beediagram-ref</c> fences inside page content can be rewritten to the ids
/// assigned on import.
/// </summary>
public sealed class ArchiveManifest
{
    public const int CurrentFormatVersion = 1;

    public int FormatVersion { get; set; } = CurrentFormatVersion;

    /// <summary>"book" when a whole book was exported, "page" for a single document.</summary>
    public string Kind { get; set; } = "book";

    public string Generator { get; set; } = "BeeDocs";
    public DateTimeOffset ExportedAt { get; set; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// The owning book. Present for both kinds — for a page export it carries the
    /// book the page came from, so the importer can recreate it when the user
    /// does not pick an existing target.
    /// </summary>
    public ArchiveBook Book { get; set; } = new();

    public List<ArchiveChapter> Chapters { get; set; } = [];
    public List<ArchivePage> Pages { get; set; } = [];
    public List<ArchiveDiagram> Diagrams { get; set; } = [];
    /// <summary>Book-scoped studio shape collections (multi-shape snippets).</summary>
    public List<ArchiveShapeCollection> Collections { get; set; } = [];
    public List<ArchiveAsset> Assets { get; set; } = [];

    public static JsonSerializerOptions JsonOptions { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed class ArchiveBook
{
    public string? OriginalId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Slug { get; set; }
    public int SortOrder { get; set; }
}

public sealed class ArchiveChapter
{
    public string Ref { get; set; } = string.Empty;
    public string? OriginalId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Slug { get; set; }
    public int SortOrder { get; set; }
}

public sealed class ArchivePage
{
    public string Ref { get; set; } = string.Empty;
    public string? OriginalId { get; set; }
    public string? ChapterRef { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Slug { get; set; }
    public string Content { get; set; } = string.Empty;
    public int SortOrder { get; set; }
}

public sealed class ArchiveDiagram
{
    public string Ref { get; set; } = string.Empty;
    public string? OriginalId { get; set; }
    public string? PageRef { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Kind { get; set; } = "beediagram";
    public string Source { get; set; } = string.Empty;
}

/// <summary>Reusable multi-shape snippet from the studio palette.</summary>
public sealed class ArchiveShapeCollection
{
    public string Ref { get; set; } = string.Empty;
    public string? OriginalId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string Source { get; set; } = string.Empty;
}

/// <summary>An uploaded image copied into the archive under <c>assets/</c>.</summary>
public sealed class ArchiveAsset
{
    /// <summary>Path inside the zip, e.g. <c>assets/9f2c….png</c>.</summary>
    public string Path { get; set; } = string.Empty;
    /// <summary>The URL it was referenced by, e.g. <c>/uploads/9f2c….png</c>.</summary>
    public string Url { get; set; } = string.Empty;
}

// --- Import ---

/// <summary>How to handle a title that already exists in the target.</summary>
public enum ImportNameMode
{
    /// <summary>Give the imported item a free title/slug ("Handbook (2)").</summary>
    Rename = 0,
    /// <summary>Keep the original title even if it duplicates an existing one.</summary>
    Keep = 1,
}

/// <summary>What a file contains, reported before the user commits to importing.</summary>
public sealed record ImportPreviewDto(
    string Source,
    string Kind,
    string BookTitle,
    int ChapterCount,
    int PageCount,
    int DiagramCount,
    int CollectionCount,
    int AssetCount,
    IReadOnlyList<string> PageTitles,
    bool BookTitleExists,
    string? SuggestedTitle,
    IReadOnlyList<string> Warnings
);

public sealed record ImportResultDto(
    string Kind,
    string BookId,
    string BookTitle,
    bool BookCreated,
    int ChaptersCreated,
    int PagesCreated,
    int DiagramsCreated,
    int CollectionsCreated,
    int AssetsCreated,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<ImportedPageDto> Pages
);

public sealed record ImportedPageDto(string Id, string Title, string Slug);
