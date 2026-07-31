using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class ChapterTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_list_chapters", Title = "List chapters"),
     Description("List chapters for a book.")]
    public Task<string> ListChapters(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListChaptersAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_create_chapter", Title = "Create chapter (folder)"),
     Description("Create a chapter/folder inside a book for grouping pages. Same as UI “New folder”.")]
    public Task<string> CreateChapter(
        string bookId,
        string title,
        string? slug = null,
        int? sortOrder = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CreateChapterAsync(bookId, new { title, slug, sortOrder }, ct)));

    [McpServerTool(Name = "beedocs_update_chapter", Title = "Update chapter (folder)"),
     Description("Rename a folder/chapter or change its sort order.")]
    public Task<string> UpdateChapter(
        string chapterId,
        string title,
        string? slug = null,
        int? sortOrder = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.UpdateChapterAsync(chapterId, new { title, slug, sortOrder }, ct)));

    [McpServerTool(Name = "beedocs_delete_chapter", Title = "Delete chapter (folder)", Destructive = true),
     Description("Delete a folder/chapter. Pages inside are unlinked (moved to book root), not deleted.")]
    public Task<string> DeleteChapter(string chapterId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteChapterAsync(chapterId, ct);
            return ToolHelpers.Json(new { deleted = true, chapterId });
        });
}
