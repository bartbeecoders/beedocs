namespace BeeDocs.Api.Models;

/// <summary>Top-level collection of related chapters/pages (BookStack-style book).</summary>
public sealed class Book
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string Slug { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    /// <summary>
    /// <see cref="User.Id"/> of the account responsible for this book, or null
    /// when nobody was identified. Pages created in the book inherit it.
    /// </summary>
    public string? OwnerId { get; set; }
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
    /// <summary>
    /// <see cref="User.Id"/> of the account responsible for this page. Defaults
    /// to the owning book's owner when the page is created.
    /// </summary>
    public string? OwnerId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// One entry in a page's change log: the state the page was left in by a change,
/// and who made it. The newest entry mirrors the live page.
/// </summary>
public sealed class PageRevision
{
    public string Id { get; set; } = string.Empty;
    public string PageId { get; set; } = string.Empty;
    /// <summary>The page version this change produced.</summary>
    public int Version { get; set; }
    public string Title { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    /// <summary><see cref="User.Id"/> of whoever made the change, or null when nobody was identified.</summary>
    public string? ChangedBy { get; set; }
    /// <summary>
    /// Their display name captured at the time, so the log still reads correctly
    /// once the account has been renamed or deleted.
    /// </summary>
    public string? ChangedByName { get; set; }
    /// <summary>created | updated</summary>
    public string ChangeKind { get; set; } = PageChangeKinds.Updated;
    /// <summary>When the change happened.</summary>
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>What produced a <see cref="PageRevision"/>.</summary>
public static class PageChangeKinds
{
    public const string Created = "created";
    public const string Updated = "updated";

    /// <summary>
    /// A row that predates the change log. It holds the state a page was moved
    /// away from, so its timestamp marks the end of that version rather than its
    /// start, and nobody recorded the author. Never written — only migrated.
    /// </summary>
    public const string Legacy = "legacy";
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
/// A configured OpenAI-compatible chat endpoint. Every supported provider speaks
/// the same wire format, so only the base URL and the auth differ.
/// </summary>
public sealed class LlmProvider
{
    public string Id { get; set; } = string.Empty;
    /// <summary>openrouter | xai | openai | lmstudio</summary>
    public string Kind { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    /// <summary>Root of the OpenAI-compatible API, without a trailing slash.</summary>
    public string BaseUrl { get; set; } = string.Empty;
    /// <summary>
    /// Never serialized to a client. <see cref="Models.LlmProviderDto"/> exposes
    /// only whether a key is set and its last four characters.
    /// </summary>
    public string? ApiKey { get; set; }
    /// <summary>Preferred model id. Empty means "use the first one the provider lists".</summary>
    public string Model { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public int SortOrder { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// A sign-in account. <see cref="Username"/> is stored already normalised
/// (trimmed, lower-cased) because it is the unique key users type; the name they
/// see is <see cref="DisplayName"/>.
/// </summary>
public sealed class User
{
    public string Id { get; set; } = string.Empty;
    /// <summary>Normalised (lower-case) login name. Unique.</summary>
    public string Username { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Email { get; set; }
    /// <summary>admin | editor | viewer — see <see cref="Services.UserRoles"/>.</summary>
    public string Role { get; set; } = Services.UserRoles.Viewer;
    /// <summary>
    /// PBKDF2 hash with its parameters attached. Never serialized: no DTO carries
    /// it and <see cref="Services.UserService"/> selects it only to verify a login.
    /// </summary>
    public string PasswordHash { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    /// <summary>Set on the seeded admin and after an admin reset. Advisory — the UI nags, the API does not block.</summary>
    public bool MustChangePassword { get; set; }
    public DateTimeOffset? LastLoginAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// One signed-in browser. Only the SHA-256 of the token is stored, so a stolen
/// database cannot be replayed as a live session.
/// </summary>
public sealed class UserSession
{
    public string TokenHash { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; } = DateTimeOffset.UtcNow;
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
