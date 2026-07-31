using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class ExportTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_export_library_snapshot", Title = "Export library snapshot"),
     Description("Export a nested snapshot of all books with their pages (full content) and diagrams. Useful for agents to reason about the whole library.")]
    public Task<string> ExportLibrarySnapshot(
        [Description("Include full page Markdown (default true)")] bool includePageContent = true,
        [Description("Include diagram source (default true)")] bool includeDiagramSource = true,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var books = await client.ListBooksAsync(ct);
            var outBooks = new List<object>();
            foreach (var b in books.EnumerateArray())
            {
                var bookId = BeeDocsApiClient.Prop(b, "id");
                var pagesSummary = await client.ListPagesAsync(bookId, ct);
                var diagramsSummary = await client.ListDiagramsAsync(bookId, ct);
                var chapters = await client.ListChaptersAsync(bookId, ct);

                var pages = new List<JsonElement>();
                foreach (var p in pagesSummary.EnumerateArray())
                {
                    pages.Add(includePageContent
                        ? await client.GetPageAsync(BeeDocsApiClient.Prop(p, "id"), ct)
                        : p);
                }

                var diagrams = new List<JsonElement>();
                foreach (var d in diagramsSummary.EnumerateArray())
                {
                    diagrams.Add(includeDiagramSource
                        ? await client.GetDiagramAsync(BeeDocsApiClient.Prop(d, "id"), ct)
                        : d);
                }

                outBooks.Add(new { book = b, chapters, pages, diagrams });
            }

            return ToolHelpers.Json(new
            {
                exportedAt = DateTimeOffset.UtcNow.ToString("O"),
                books = outBooks,
            });
        });
}
