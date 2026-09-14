using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// Word documents: .docx attachments opened through the editor's HTML view.
///
/// <c>beedocs_read_attachment</c> hands a .docx back as base64, which no model
/// can read. These tools go through the API's Word editor route instead: the
/// document body arrives as HTML with paragraph styles named, and HTML written
/// back is converted into the same package — the file stays a real .docx with
/// its styles, headers and footers intact.
/// </summary>
[McpServerToolType]
public sealed class WordTools(BeeDocsApiClient client)
{
    private const string HtmlContract =
        "HTML dialect: <p>, <h1>-<h6>, <ul>/<ol>/<li>, <table>/<tr>/<td> (colspan/rowspan; data-borders=\"0\" for a borderless table), " +
        "<b>/<i>/<u>/<s>/<sub>/<sup>, <span style=\"...\"> with font-weight, font-style, text-decoration, color, background-color, font-size (pt), font-family, " +
        "<a href>, <img src=\"data:image/png;base64,...\" width height>, <hr> (rule), <hr data-break=\"page\"> (page break), " +
        "<p style=\"text-align:center;margin-left:36pt;line-height:1.5\">. A paragraph style is data-style=\"Heading1|Title|Subtitle|Quote|NoSpacing|ListParagraph\" on the block; " +
        "<h1>-<h6> imply Heading1-6. Whitespace is significant (pre-wrap): a newline in text becomes a line break. " +
        "Elements carrying data-docx-raw are fields, footnotes or content controls kept verbatim — pass them back unchanged to keep them, drop them to delete them.";

    [McpServerTool(Name = "beedocs_read_word_document", Title = "Read Word document", ReadOnly = true),
     Description("Open a .docx attachment as HTML: the document body with paragraph styles (data-style), the document's own stylesheet (css), and page size/margins in twips. Use this instead of beedocs_read_attachment for Word files. " + HtmlContract)]
    public Task<string> ReadWordDocument(string attachmentId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetWordDocumentAsync(attachmentId, ct)));

    [McpServerTool(Name = "beedocs_write_word_document", Title = "Write Word document"),
     Description("Replace the body of a .docx attachment with HTML. The file is rewritten in place (same id, title, links; styles, headers, footers and other parts of the original package are preserved). Read the document first and send the full body back with your edits — the HTML given here IS the new document. " + HtmlContract)]
    public Task<string> WriteWordDocument(
        string attachmentId,
        [Description("The complete document body as HTML")] string html,
        [Description("Optional page setup in twips (1440 = 1 inch): {\"width\":11906,\"height\":16838,\"top\":1440,\"right\":1440,\"bottom\":1440,\"left\":1440}. Omit to keep the document's own.")] WordPage? page = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var saved = await client.SaveWordDocumentAsync(attachmentId, new { html, page }, ct);
            return ToolHelpers.Json(new
            {
                attachment = saved,
                workspaceUrl = $"/books/{BeeDocsApiClient.Prop(saved, "bookId")}/files/{BeeDocsApiClient.Prop(saved, "id")}",
            });
        });

    [McpServerTool(Name = "beedocs_create_word_document", Title = "Create Word document"),
     Description("Create a new .docx attachment in a book — blank, or with an HTML body when `html` is given. Returns the attachment; open it in the workspace at workspaceUrl. " + HtmlContract)]
    public Task<string> CreateWordDocument(
        string bookId,
        [Description("Display title; also the file name (title.docx)")] string title,
        [Description("Optional initial body as HTML")] string? html = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var created = await client.CreateWordDocumentAsync(bookId, new { title }, ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            if (!string.IsNullOrWhiteSpace(html))
                created = await client.SaveWordDocumentAsync(id, new { html }, ct);
            return ToolHelpers.Json(new
            {
                attachment = created,
                workspaceUrl = $"/books/{BeeDocsApiClient.Prop(created, "bookId")}/files/{id}",
            });
        });

    /// <summary>Page size and margins in twips, mirroring the API's WordPageSetup.</summary>
    public sealed record WordPage(int Width, int Height, int Top, int Right, int Bottom, int Left);
}
