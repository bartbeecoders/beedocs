using System.ComponentModel;
using System.Text;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// Files filed against a book — PDFs, Word/PowerPoint/Excel documents, archives.
///
/// These are the one content type BeeDocs stores rather than authors, so the
/// tools are deliberately shaped around handling a file instead of editing a
/// document: upload, re-upload, describe, fetch. There is no "edit attachment
/// body" tool because there is no format to edit.
/// </summary>
[McpServerToolType]
public sealed class AttachmentTools(BeeDocsApiClient client)
{
    private static readonly Regex DataUrlPrefix = new(@"^data:[^;]+;base64,", RegexOptions.Compiled);

    /// <summary>
    /// How much of a file this server will inline into a tool result.
    ///
    /// The API accepts 100 MB attachments; base64 of one is ~133 MB of text
    /// aimed straight at a model's context. Refusing past this — with the URL to
    /// fetch instead — fails in a way the caller can act on, rather than by
    /// filling the window.
    /// </summary>
    private const int MaxInlineBytes = 8 * 1024 * 1024;

    /// <summary>
    /// Formats returned as readable text rather than base64. An agent asking for
    /// a CSV or a README wants its contents, not 4 KB of base64 to decode.
    /// </summary>
    private static readonly HashSet<string> TextExtensions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".svg",
        };

    [McpServerTool(Name = "beedocs_list_attachments", Title = "List attachments", ReadOnly = true),
     Description("List the files filed against a book (PDF, Word, PowerPoint, Excel, archives, images). Returns metadata only — use beedocs_read_attachment for contents.")]
    public Task<string> ListAttachments(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListAttachmentsAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_attachment", Title = "Get attachment", ReadOnly = true),
     Description("Metadata for one attachment: title, description, owner, file name, type, size, timestamps.")]
    public Task<string> GetAttachment(string attachmentId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetAttachmentAsync(attachmentId, ct)));

    [McpServerTool(Name = "beedocs_upload_attachment", Title = "Upload attachment"),
     Description("File a document against a book. Pass base64 bytes and a file name whose extension the library accepts: PDF, DOC(X), XLS(X), PPT(X), VSD(X), ODT/ODS/ODP, TXT, MD, RTF, CSV, JSON, XML, YAML, ZIP, 7Z, TAR, GZ, PNG, JPG, GIF, WEBP, SVG. Max 100 MB. Use beedocs_upload_image instead for pictures meant to be embedded in a page.")]
    public Task<string> UploadAttachment(
        string bookId,
        [Description("Base64-encoded file bytes (no data: URL prefix)")] string base64,
        [Description("File name with extension, e.g. architecture-review.pdf")] string fileName,
        [Description("Display title. Defaults to the file name without its extension.")] string? title = null,
        [Description("What the document is, and when it applies")] string? description = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var cleaned = DataUrlPrefix.Replace(base64, "");
            var created = await client.UploadAttachmentAsync(bookId, cleaned, fileName, title, description, ct);
            return ToolHelpers.Json(new
            {
                attachment = created,
                workspaceUrl = WorkspaceUrl(
                    BeeDocsApiClient.Prop(created, "bookId"),
                    BeeDocsApiClient.Prop(created, "id")),
            });
        });

    [McpServerTool(Name = "beedocs_update_attachment", Title = "Update attachment properties"),
     Description("Set an attachment's properties. Does not touch the stored bytes — use beedocs_replace_attachment_file for that. Pass \"\" to clear description or owner; omit a field to leave it alone.")]
    public Task<string> UpdateAttachment(
        string attachmentId,
        string title,
        [Description("Omit to leave unchanged; \"\" to clear")] string? description = null,
        [Description("Account id from beedocs_get_attachment/owner. Omit to leave unchanged; \"\" to unassign.")]
        string? ownerId = null,
        [Description("Name the file downloads as. The stored extension is kept whatever you pass.")]
        string? fileName = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(
            await client.UpdateAttachmentAsync(
                attachmentId, new { title, description, ownerId, fileName }, ct)));

    [McpServerTool(Name = "beedocs_replace_attachment_file", Title = "Replace attachment file"),
     Description("Upload a new version of an attachment's bytes. The id, title, description and owner survive, so pages linking to it keep working. Same accepted formats as beedocs_upload_attachment.")]
    public Task<string> ReplaceAttachmentFile(
        string attachmentId,
        [Description("Base64-encoded file bytes (no data: URL prefix)")] string base64,
        [Description("File name with extension, e.g. architecture-review-v2.pdf")] string fileName,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var cleaned = DataUrlPrefix.Replace(base64, "");
            return ToolHelpers.Json(
                await client.ReplaceAttachmentFileAsync(attachmentId, cleaned, fileName, ct));
        });

    [McpServerTool(Name = "beedocs_read_attachment", Title = "Read attachment", ReadOnly = true),
     Description("Fetch an attachment's contents. Text formats (TXT, MD, CSV, JSON, XML, YAML, SVG) come back as readable text in `text`; everything else as `base64`. Files over 8 MB are refused with a URL to fetch instead — decoding a large PDF into a conversation helps nobody.")]
    public Task<string> ReadAttachment(string attachmentId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var meta = await client.GetAttachmentAsync(attachmentId, ct);
            var fileName = BeeDocsApiClient.Prop(meta, "fileName");
            var size = BeeDocsApiClient.PropInt(meta, "sizeBytes");

            // Checked from metadata, before the bytes are pulled over the wire —
            // refusing after downloading 90 MB would defeat the point.
            if (size > MaxInlineBytes)
            {
                throw new McpException(
                    $"'{fileName}' is {size / (1024 * 1024)} MB, over the {MaxInlineBytes / (1024 * 1024)} MB " +
                    "inline limit. Fetch it directly instead: " +
                    $"{client.BaseUrl}/api/attachments/{Uri.EscapeDataString(attachmentId)}/download");
            }

            var (bytes, contentType, servedAs) = await client.DownloadAttachmentAsync(attachmentId, ct);
            var isText = TextExtensions.Contains(Path.GetExtension(fileName))
                || contentType.StartsWith("text/", StringComparison.OrdinalIgnoreCase);

            return ToolHelpers.Json(new
            {
                attachmentId,
                fileName = string.IsNullOrEmpty(servedAs) ? fileName : servedAs,
                contentType,
                sizeBytes = bytes.Length,
                encoding = isText ? "text" : "base64",
                text = isText ? DecodeText(bytes) : null,
                base64 = isText ? null : Convert.ToBase64String(bytes),
            });
        });

    [McpServerTool(Name = "beedocs_link_attachment_in_page", Title = "Link attachment in page"),
     Description("Append a Markdown link to an attachment at the end of a page, so readers can find the document from the docs that discuss it. The link points at the workspace route, which opens the file with its properties rather than downloading it blind.")]
    public Task<string> LinkAttachmentInPage(
        string pageId,
        string attachmentId,
        [Description("Link text. Defaults to the attachment's title.")] string? label = null,
        [Description("Markdown heading to insert above the link, e.g. '## Reference documents'")]
        string? heading = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var attachment = await client.GetAttachmentAsync(attachmentId, ct);
            var page = await client.GetPageAsync(pageId, ct);

            var url = WorkspaceUrl(
                BeeDocsApiClient.Prop(attachment, "bookId"),
                BeeDocsApiClient.Prop(attachment, "id"));
            // Brackets in the label would end the link text early and leave the
            // rest of it loose in the paragraph.
            var text = (label ?? BeeDocsApiClient.Prop(attachment, "title"))
                .Replace("[", "").Replace("]", "");
            var markdown = $"[{text}]({url})";

            // An empty page must not start with the blank line that separates an
            // appended block from what came before it.
            var existing = BeeDocsApiClient.Prop(page, "content").TrimEnd();
            var separator = string.IsNullOrEmpty(existing) ? "" : "\n\n";
            var content = string.Concat(
                existing,
                string.IsNullOrEmpty(heading) ? separator : $"{separator}{heading}\n\n",
                markdown,
                "\n");

            var updated = await client.UpdatePageAsync(
                pageId,
                BeeDocsApiClient.BuildPageUpdate(
                    BeeDocsApiClient.Prop(page, "title"),
                    content,
                    BeeDocsApiClient.PropStringOrNull(page, "slug"),
                    BeeDocsApiClient.PropStringOrNull(page, "chapterId"),
                    chapterIdSpecified: true),
                ct);

            return ToolHelpers.Json(new { page = updated, markdown, url });
        });

    [McpServerTool(Name = "beedocs_delete_attachment", Title = "Delete attachment", Destructive = true),
     Description("Delete an attachment. The stored file is removed from the server; links to it in pages are left behind and will 404.")]
    public Task<string> DeleteAttachment(string attachmentId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteAttachmentAsync(attachmentId, ct);
            return ToolHelpers.Json(new { deleted = true, attachmentId });
        });

    /// <summary>
    /// The route that opens a file in the workspace. Relative on purpose: it is
    /// written into page Markdown, which is served from whatever host the reader
    /// reached, and an absolute URL would pin it to this server's own base.
    /// </summary>
    private static string WorkspaceUrl(string bookId, string attachmentId) =>
        $"/books/{bookId}/files/{attachmentId}";

    /// <summary>
    /// Decode as UTF-8, dropping a BOM. Invalid bytes become replacement
    /// characters rather than throwing: a file with one bad byte is still worth
    /// reading, and the caller can see the damage.
    /// </summary>
    private static string DecodeText(byte[] bytes)
    {
        var text = new UTF8Encoding(false).GetString(bytes);
        return text.Length > 0 && text[0] == '﻿' ? text[1..] : text;
    }
}
