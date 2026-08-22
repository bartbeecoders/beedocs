using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using BeeDocs.Mcp.Tools;

namespace BeeDocs.Mcp.Resources;

[McpServerResourceType]
public sealed class BeeDocsResources(BeeDocsApiClient client)
{
    [McpServerResource(UriTemplate = "beedocs://library", Name = "beedocs-library", MimeType = "application/json")]
    [Description("JSON list of all books (id, title, slug, description).")]
    public async Task<TextResourceContents> Library(CancellationToken ct = default)
    {
        var books = await client.ListBooksAsync(ct);
        return Text("beedocs://library", books);
    }

    [McpServerResource(UriTemplate = "beedocs://books/{bookId}", Name = "beedocs-book", MimeType = "application/json")]
    [Description("Single book metadata by id.")]
    public async Task<TextResourceContents> Book(string bookId, CancellationToken ct = default)
    {
        var book = await client.GetBookAsync(bookId, ct);
        return Text($"beedocs://books/{bookId}", book);
    }

    [McpServerResource(UriTemplate = "beedocs://books/{bookId}/pages", Name = "beedocs-book-pages", MimeType = "application/json")]
    [Description("Page summaries for a book.")]
    public async Task<TextResourceContents> BookPages(string bookId, CancellationToken ct = default)
    {
        var pages = await client.ListPagesAsync(bookId, ct);
        return Text($"beedocs://books/{bookId}/pages", pages);
    }

    [McpServerResource(UriTemplate = "beedocs://books/{bookId}/chapters", Name = "beedocs-book-chapters", MimeType = "application/json")]
    [Description("Folder/chapter list for a book.")]
    public async Task<TextResourceContents> BookChapters(string bookId, CancellationToken ct = default)
    {
        var chapters = await client.ListChaptersAsync(bookId, ct);
        return Text($"beedocs://books/{bookId}/chapters", chapters);
    }

    [McpServerResource(UriTemplate = "beedocs://books/{bookId}/attachments", Name = "beedocs-book-attachments", MimeType = "application/json")]
    [Description("Attachment metadata for a book — the filed PDFs, Office documents and archives. Contents via beedocs_read_attachment.")]
    public async Task<TextResourceContents> BookAttachments(string bookId, CancellationToken ct = default)
    {
        var attachments = await client.ListAttachmentsAsync(bookId, ct);
        return Text($"beedocs://books/{bookId}/attachments", attachments);
    }

    [McpServerResource(UriTemplate = "beedocs://books/{bookId}/tree", Name = "beedocs-book-tree", MimeType = "application/json")]
    [Description("Folders with nested pages, root pages, diagrams, slide decks, and attachments.")]
    public async Task<TextResourceContents> BookTree(string bookId, CancellationToken ct = default)
    {
        var tree = await BookTools.BuildTreeAsync(client, bookId, ct);
        return new TextResourceContents
        {
            Uri = $"beedocs://books/{bookId}/tree",
            MimeType = "application/json",
            Text = ToolHelpers.Json(tree),
        };
    }

    [McpServerResource(UriTemplate = "beedocs://pages/{pageId}", Name = "beedocs-page", MimeType = "application/json")]
    [Description("Full page including Markdown content.")]
    public async Task<TextResourceContents> Page(string pageId, CancellationToken ct = default)
    {
        var page = await client.GetPageAsync(pageId, ct);
        return Text($"beedocs://pages/{pageId}", page);
    }

    [McpServerResource(UriTemplate = "beedocs://diagram/catalog", Name = "beedocs-diagram-catalog", MimeType = "application/json")]
    [Description("Every BeeDiagram shape, Azure service stencil, palette group, anchor, edge route and arrow head.")]
    public TextResourceContents DiagramCatalogResource() => new()
    {
        Uri = "beedocs://diagram/catalog",
        MimeType = "application/json",
        Text = ToolHelpers.Json(DiagramCatalog.Root),
    };

    [McpServerResource(UriTemplate = "beedocs://diagrams/{diagramId}", Name = "beedocs-diagram", MimeType = "application/json")]
    [Description("Full diagram including source payload.")]
    public async Task<TextResourceContents> Diagram(string diagramId, CancellationToken ct = default)
    {
        var diagram = await client.GetDiagramAsync(diagramId, ct);
        return Text($"beedocs://diagrams/{diagramId}", diagram);
    }

    [McpServerResource(UriTemplate = "beedocs://slides/{deckId}", Name = "beedocs-slide-deck", MimeType = "application/json")]
    [Description("Full slide deck including its JSON document.")]
    public async Task<TextResourceContents> SlideDeck(string deckId, CancellationToken ct = default)
    {
        var deck = await client.GetSlideDeckAsync(deckId, ct);
        return Text($"beedocs://slides/{deckId}", deck);
    }

    private static TextResourceContents Text(string uri, System.Text.Json.JsonElement data) => new()
    {
        Uri = uri,
        MimeType = "application/json",
        Text = ToolHelpers.Json(data),
    };
}
