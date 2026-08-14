using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// Shelves: the level above books. A shelf groups related books and holds no
/// pages of its own, so nothing here reaches content — use the book tools for
/// that, passing <c>shelfId</c> to file a new book on a shelf.
/// </summary>
[McpServerToolType]
public sealed class ShelfTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_list_shelves", Title = "List shelves"),
     Description("List all shelves. A shelf is the level above books: it groups related books and holds no pages itself.")]
    public Task<string> ListShelves(CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListShelvesAsync(ct)));

    [McpServerTool(Name = "beedocs_get_shelf", Title = "Get shelf"),
     Description("Get a single shelf by id, including how many books sit on it.")]
    public Task<string> GetShelf(
        [Description("Shelf id")] string shelfId,
        CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetShelfAsync(shelfId, ct)));

    [McpServerTool(Name = "beedocs_list_shelf_books", Title = "List books on a shelf"),
     Description("List the books filed on one shelf.")]
    public Task<string> ListShelfBooks(
        [Description("Shelf id")] string shelfId,
        CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListShelfBooksAsync(shelfId, ct)));

    [McpServerTool(Name = "beedocs_create_shelf", Title = "Create shelf"),
     Description("Create a shelf to group books under. Books are then filed on it with beedocs_move_book_to_shelf or by passing shelfId to beedocs_create_book. Set published to serve it as a website at /bookshelf-serve/{slug}.")]
    public Task<string> CreateShelf(
        [Description("Shelf name")] string title,
        [Description("Optional description")] string? description = null,
        [Description("Optional URL slug (auto-generated if omitted)")] string? slug = null,
        [Description("When true, /bookshelf-serve/{slug} is a public website even if sign-in is on.")]
        bool? published = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CreateShelfAsync(new { title, description, slug, published }, ct)));

    [McpServerTool(Name = "beedocs_update_shelf", Title = "Update shelf"),
     Description("Update a shelf's title, description, slug, sort order, or whether it is served as a public website at /bookshelf-serve/{slug}.")]
    public Task<string> UpdateShelf(
        string shelfId,
        string title,
        string? description = null,
        string? slug = null,
        int? sortOrder = null,
        [Description("When true, /bookshelf-serve/{slug} is a public website even if sign-in is on. Omit to leave as-is.")]
        bool? published = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.UpdateShelfAsync(shelfId, new { title, description, slug, sortOrder, published }, ct)));

    [McpServerTool(Name = "beedocs_delete_shelf", Title = "Delete shelf"),
     Description("Delete a shelf. Its books are kept and return to the library root — no content is lost.")]
    public Task<string> DeleteShelf(string shelfId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteShelfAsync(shelfId, ct);
            return ToolHelpers.Json(new { deleted = true, shelfId, booksKept = true });
        });

    [McpServerTool(Name = "beedocs_move_book_to_shelf", Title = "Move book to shelf"),
     Description("File a book on a shelf, or move it back to the library root by omitting shelfId. A book sits on at most one shelf.")]
    public Task<string> MoveBookToShelf(
        [Description("Book id")] string bookId,
        [Description("Target shelf id. Omit or pass an empty string to move the book to the library root.")]
        string? shelfId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            // The API requires a title on every book update and reads an empty
            // shelfId as "move to the root", so the current title is fetched and
            // sent back unchanged rather than invented here.
            var book = await client.GetBookAsync(bookId, ct);
            var title = BeeDocsApiClient.Prop(book, "title");
            var updated = await client.UpdateBookAsync(
                bookId,
                new { title, shelfId = shelfId ?? "" },
                ct);
            return ToolHelpers.Json(updated);
        });
}
