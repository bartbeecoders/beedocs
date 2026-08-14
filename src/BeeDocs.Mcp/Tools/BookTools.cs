using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class BookTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_list_books", Title = "List books"),
     Description("List all documentation books in BeeDocs. Each carries shelfId/shelfTitle when it is filed on a shelf; see beedocs_list_shelves for the level above.")]
    public Task<string> ListBooks(CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListBooksAsync(ct)));

    [McpServerTool(Name = "beedocs_get_book", Title = "Get book"),
     Description("Get a single book by id.")]
    public Task<string> GetBook(
        [Description("Book id")] string bookId,
        CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetBookAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_create_book", Title = "Create book"),
     Description("Create a new documentation book.")]
    public Task<string> CreateBook(
        [Description("Book title")] string title,
        [Description("Optional description")] string? description = null,
        [Description("Optional URL slug (auto-generated if omitted)")] string? slug = null,
        [Description("Optional shelf to file the book on. Omit to create it at the library root.")]
        string? shelfId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CreateBookAsync(new { title, description, slug, shelfId }, ct)));

    [McpServerTool(Name = "beedocs_update_book", Title = "Update book"),
     Description("Update an existing book title, description, slug, sort order, or shelf. Omitted fields are left as they are.")]
    public Task<string> UpdateBook(
        string bookId,
        string title,
        string? description = null,
        string? slug = null,
        int? sortOrder = null,
        [Description("Shelf to file the book on. Omit to leave it where it is; pass an empty string to move it to the library root.")]
        string? shelfId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.UpdateBookAsync(
                bookId, new { title, description, slug, sortOrder, shelfId }, ct)));

    [McpServerTool(Name = "beedocs_delete_book", Title = "Delete book", Destructive = true),
     Description("Delete a book and cascade its pages/chapters. Destructive.")]
    public Task<string> DeleteBook(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteBookAsync(bookId, ct);
            return ToolHelpers.Json(new { deleted = true, bookId });
        });

    [McpServerTool(Name = "beedocs_get_book_tree", Title = "Get book tree"),
     Description("Return folders (chapters) and pages grouped for tree navigation (root pages + per-folder pages + diagrams + slide decks).")]
    public Task<string> GetBookTree(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await BuildTreeAsync(client, bookId, ct)));

    [McpServerTool(Name = "beedocs_export_book", Title = "Export book (structured)"),
     Description("Export one book with chapters, full pages, diagrams, and slide decks as JSON. Prefer this before generating PDF/HTML offline.")]
    public Task<string> ExportBook(
        string bookId,
        [Description("Default true")] bool includePageContent = true,
        [Description("Default true")] bool includeDiagramSource = true,
        [Description("Default true")] bool includeSlideSource = true,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var book = await client.GetBookAsync(bookId, ct);
            var chapters = await client.ListChaptersAsync(bookId, ct);
            var pagesSummary = await client.ListPagesAsync(bookId, ct);
            var sorted = pagesSummary.EnumerateArray()
                .OrderBy(p => BeeDocsApiClient.PropInt(p, "sortOrder"))
                .ThenBy(p => BeeDocsApiClient.Prop(p, "title"), StringComparer.Ordinal)
                .ToList();

            var pages = new List<JsonElement>();
            foreach (var p in sorted)
            {
                pages.Add(includePageContent
                    ? await client.GetPageAsync(BeeDocsApiClient.Prop(p, "id"), ct)
                    : p);
            }

            var diagramsSummary = await client.ListDiagramsAsync(bookId, ct);
            var diagrams = new List<JsonElement>();
            foreach (var d in diagramsSummary.EnumerateArray())
            {
                diagrams.Add(includeDiagramSource
                    ? await client.GetDiagramAsync(BeeDocsApiClient.Prop(d, "id"), ct)
                    : d);
            }

            var slideDecksSummary = await client.ListSlideDecksAsync(bookId, ct);
            var slideDecks = new List<JsonElement>();
            foreach (var s in slideDecksSummary.EnumerateArray())
            {
                slideDecks.Add(includeSlideSource
                    ? await client.GetSlideDeckAsync(BeeDocsApiClient.Prop(s, "id"), ct)
                    : s);
            }

            return ToolHelpers.Json(new
            {
                exportedAt = DateTimeOffset.UtcNow.ToString("O"),
                book,
                chapters,
                pages,
                diagrams,
                slideDecks,
                note = "Open the book in the BeeDocs UI and use Export PDF for a browser print-to-PDF. This tool returns structured content for agents.",
            });
        });

    internal static async Task<object> BuildTreeAsync(BeeDocsApiClient client, string bookId, CancellationToken ct)
    {
        var bookTask = client.GetBookAsync(bookId, ct);
        var chaptersTask = client.ListChaptersAsync(bookId, ct);
        var pagesTask = client.ListPagesAsync(bookId, ct);
        var diagramsTask = client.ListDiagramsAsync(bookId, ct);
        var slideDecksTask = client.ListSlideDecksAsync(bookId, ct);
        await Task.WhenAll(bookTask, chaptersTask, pagesTask, diagramsTask, slideDecksTask);

        var book = await bookTask;
        var chapters = (await chaptersTask).EnumerateArray()
            .OrderBy(c => BeeDocsApiClient.PropInt(c, "sortOrder"))
            .ThenBy(c => BeeDocsApiClient.Prop(c, "title"), StringComparer.Ordinal)
            .ToList();
        var sortedPages = (await pagesTask).EnumerateArray()
            .OrderBy(p => BeeDocsApiClient.PropInt(p, "sortOrder"))
            .ThenBy(p => BeeDocsApiClient.Prop(p, "title"), StringComparer.Ordinal)
            .ToList();

        var folders = chapters.Select(c =>
        {
            var id = BeeDocsApiClient.Prop(c, "id");
            return new Dictionary<string, object?>
            {
                ["id"] = id,
                ["title"] = BeeDocsApiClient.Prop(c, "title"),
                ["sortOrder"] = BeeDocsApiClient.PropInt(c, "sortOrder"),
                ["pages"] = sortedPages.Where(p => BeeDocsApiClient.PropStringOrNull(p, "chapterId") == id).ToList(),
            };
        }).ToList();

        return new
        {
            book,
            folders,
            rootPages = sortedPages.Where(p => string.IsNullOrEmpty(BeeDocsApiClient.PropStringOrNull(p, "chapterId"))).ToList(),
            diagrams = await diagramsTask,
            slideDecks = await slideDecksTask,
        };
    }
}
