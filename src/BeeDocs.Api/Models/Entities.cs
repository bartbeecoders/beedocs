namespace BeeDocs.Api.Models;

/// <summary>Top-level collection of related chapters/pages (BookStack-style book).</summary>
public sealed class Book
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string Slug { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Optional grouping within a book (chapter).</summary>
public sealed class Chapter
{
    public string Id { get; set; } = string.Empty;
    public string BookId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Documentation page with Markdown body and optional Mermaid/C4 content.</summary>
public sealed class Page
{
    public string Id { get; set; } = string.Empty;
    public string BookId { get; set; } = string.Empty;
    public string? ChapterId { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
    /// <summary>Markdown source (supports fenced mermaid blocks).</summary>
    public string Content { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    public int Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Immutable snapshot of a page for version history (MVP stub).</summary>
public sealed class PageRevision
{
    public string Id { get; set; } = string.Empty;
    public string PageId { get; set; } = string.Empty;
    public int Version { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>Custom or text-based architecture diagram (BeeDiagram canvas, Mermaid, …).</summary>
public sealed class Diagram
{
    public string Id { get; set; } = string.Empty;
    /// <summary>Owning book (required for library listing).</summary>
    public string BookId { get; set; } = string.Empty;
    /// <summary>Optional page this diagram is primarily attached to.</summary>
    public string? PageId { get; set; }
    public string Title { get; set; } = string.Empty;
    /// <summary>beediagram | mermaid | plantuml | c4</summary>
    public string Kind { get; set; } = "beediagram";
    /// <summary>
    /// Payload: for <c>beediagram</c>, JSON document (nodes/edges/viewport);
    /// for mermaid/c4/plantuml, the text source.
    /// </summary>
    public string Source { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A reusable multi-shape snippet for the Studio palette.
/// When <see cref="BookId"/> is null/empty the collection is app-wide;
/// otherwise it belongs to that book only.
/// </summary>
public sealed class ShapeCollection
{
    public string Id { get; set; } = string.Empty;
    /// <summary>Owning book id, or null/empty for the app-wide library.</summary>
    public string? BookId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    /// <summary>
    /// JSON fragment: <c>{"version":1,"nodes":[…],"edges":[…]}</c>
    /// (BeeDiagram nodes/edges, normalised to origin).
    /// </summary>
    public string Source { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
