using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class PageTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_list_pages", Title = "List pages"),
     Description("List page summaries for a book (no full content).")]
    public Task<string> ListPages(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListPagesAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_page", Title = "Get page"),
     Description("Get a page including full Markdown content.")]
    public Task<string> GetPage(string pageId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetPageAsync(pageId, ct)));

    [McpServerTool(Name = "beedocs_create_page", Title = "Create page"),
     Description("Create a Markdown documentation page in a book. Content supports Mermaid fences and beediagram-ref embeds.")]
    public Task<string> CreatePage(
        string bookId,
        string title,
        [Description("Markdown body (optional; empty page if omitted)")] string? content = null,
        string? slug = null,
        string? chapterId = null,
        int? sortOrder = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CreatePageAsync(
                bookId,
                new { title, content, slug, chapterId, sortOrder },
                ct)));

    [McpServerTool(Name = "beedocs_update_page", Title = "Update page"),
     Description("Update page title and/or Markdown content. Creates a revision snapshot on the server.")]
    public Task<string> UpdatePage(
        string pageId,
        string title,
        [Description("Full Markdown body when updating content")] string? content = null,
        string? slug = null,
        [Description("Chapter id, or null to clear")] string? chapterId = null,
        int? sortOrder = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            // When chapterId is explicitly null in JSON it clears; when omitted, leave unchanged.
            // Attribute binders pass null for both omit and JSON null — clear only when the
            // property appears. For MCP we treat null as clear (matches TS client when null).
            var body = BeeDocsApiClient.BuildPageUpdate(
                title,
                content,
                slug,
                chapterId,
                chapterIdSpecified: true,
                sortOrder);
            // If chapterId was omitted by the client as undefined, TS omitted it. Here optional
            // null means "clear" only when the agent sends null; when they want leave-unchanged
            // they omit. Default binder can't distinguish — keep chapterId in payload only when
            // non-null OR when clearing is intended via empty string.
            if (chapterId is null)
            {
                body.Remove("chapterId");
            }

            return ToolHelpers.Json(await client.UpdatePageAsync(pageId, body, ct));
        });

    [McpServerTool(Name = "beedocs_delete_page", Title = "Delete page", Destructive = true),
     Description("Permanently delete a page by id.")]
    public Task<string> DeletePage(string pageId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeletePageAsync(pageId, ct);
            return ToolHelpers.Json(new { deleted = true, pageId });
        });

    [McpServerTool(Name = "beedocs_append_page_content", Title = "Append to page"),
     Description("Convenience: load a page, append Markdown to its content, and save (bumps version).")]
    public Task<string> AppendPageContent(
        string pageId,
        [Description("Markdown fragment to append")] string markdown,
        [Description("Inserted between existing content and append (default two newlines)")]
        string? separator = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var page = await client.GetPageAsync(pageId, ct);
            var sep = separator ?? "\n\n";
            var existing = BeeDocsApiClient.Prop(page, "content");
            var content = string.IsNullOrEmpty(existing) ? markdown : $"{existing}{sep}{markdown}";
            var body = BeeDocsApiClient.BuildPageUpdate(
                BeeDocsApiClient.Prop(page, "title"),
                content,
                BeeDocsApiClient.PropStringOrNull(page, "slug"),
                BeeDocsApiClient.PropStringOrNull(page, "chapterId"),
                chapterIdSpecified: true);
            return ToolHelpers.Json(await client.UpdatePageAsync(pageId, body, ct));
        });

    [McpServerTool(Name = "beedocs_move_page", Title = "Move page"),
     Description("Move a page into a folder (chapterId) or to book root (chapterId null), and/or set sortOrder among siblings.")]
    public Task<string> MovePage(
        string pageId,
        [Description("Target folder id, or null/omit to leave unchanged; use clearFolder to move to root")]
        string? chapterId = null,
        [Description("If true, move page to book root (clears chapterId)")] bool clearFolder = false,
        int? sortOrder = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var page = await client.GetPageAsync(pageId, ct);
            string? nextChapter = chapterId;
            var chapterSpecified = clearFolder || chapterId is not null;
            if (clearFolder)
            {
                nextChapter = null;
            }
            else if (chapterId is null)
            {
                nextChapter = BeeDocsApiClient.PropStringOrNull(page, "chapterId");
                chapterSpecified = true;
            }

            var body = BeeDocsApiClient.BuildPageUpdate(
                BeeDocsApiClient.Prop(page, "title"),
                BeeDocsApiClient.Prop(page, "content"),
                BeeDocsApiClient.PropStringOrNull(page, "slug"),
                nextChapter,
                chapterSpecified,
                sortOrder ?? (page.TryGetProperty("sortOrder", out var so) && so.TryGetInt32(out var n) ? n : null));
            return ToolHelpers.Json(await client.UpdatePageAsync(pageId, body, ct));
        });
}
