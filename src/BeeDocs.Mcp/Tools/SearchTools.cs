using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class SearchTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_search", Title = "Search documentation"),
     Description("""
        Full-text search across every book, folder, page and diagram. Prefer this over
        listing books and reading pages one by one — it is the fastest way to locate
        content by what it says rather than where it lives. Each hit carries the entity
        id, its book, a matching excerpt, and the workspace URL. Follow a page hit with
        beedocs_get_page to read the whole document.

        Matching: terms are ANDed, "quoted runs" match as a phrase, and diacritics fold
        (cafe finds café). Diagrams match on their shape labels.
        """)]
    public Task<string> Search(
        [Description("Search terms. Use \"double quotes\" around a phrase.")] string query,
        [Description("Maximum hits to return (default 20, max 100).")] int? limit = null,
        [Description("Offset for paging through hits.")] int? offset = null,
        [Description("Restrict to a single book id.")] string? bookId = null,
        [Description("Comma-separated kinds to include: page, diagram, book, folder.")] string? kinds = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.SearchAsync(query, limit, offset, bookId, kinds, ct)));

    [McpServerTool(Name = "beedocs_search_status", Title = "Search index status"),
     Description("Report the search engine in use, how many documents are indexed by kind, and how many edits are still queued.")]
    public Task<string> Status(CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.SearchStatusAsync(ct)));

    [McpServerTool(Name = "beedocs_reindex", Title = "Rebuild search index"),
     Description("Discard the search index and build it again from the stored documents. The index maintains itself, so this is only for recovering from a corrupted or externally modified database.")]
    public Task<string> Reindex(CancellationToken ct) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ReindexAsync(ct)));
}
