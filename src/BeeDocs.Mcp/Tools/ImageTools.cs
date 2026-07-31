using System.ComponentModel;
using System.Text.RegularExpressions;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class ImageTools(BeeDocsApiClient client)
{
    private static readonly Regex DataUrlPrefix = new(@"^data:[^;]+;base64,", RegexOptions.Compiled);

    [McpServerTool(Name = "beedocs_upload_image", Title = "Upload image"),
     Description("Upload an image to BeeDocs (/uploads/…). Pass base64 file bytes. Returns { url, fileName } for Markdown ![alt](url) or diagram image nodes.")]
    public Task<string> UploadImage(
        [Description("Base64-encoded image bytes (no data: URL prefix)")] string base64,
        [Description("e.g. diagram.png")] string fileName,
        [Description("MIME type, e.g. image/png (guessed from fileName if omitted)")] string? contentType = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var cleaned = DataUrlPrefix.Replace(base64, "");
            return ToolHelpers.Json(await client.UploadImageAsync(cleaned, fileName, contentType, ct));
        });

    [McpServerTool(Name = "beedocs_embed_image_in_page", Title = "Embed image in page"),
     Description("Append a Markdown image to a page. Provide either a public/uploads URL or base64 to upload first.")]
    public Task<string> EmbedImageInPage(
        string pageId,
        [Description("Existing image URL (e.g. /uploads/abc.png)")] string? url = null,
        [Description("If set, upload first then embed")] string? base64 = null,
        [Description("Required with base64")] string? fileName = null,
        [Description("Alt text (default file name or image)")] string? alt = null,
        string? heading = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var imageUrl = url;
            var name = fileName ?? "image";
            if (string.IsNullOrEmpty(imageUrl))
            {
                if (string.IsNullOrEmpty(base64) || string.IsNullOrEmpty(fileName))
                {
                    throw new ModelContextProtocol.McpException("Provide url, or base64 + fileName");
                }

                var cleaned = DataUrlPrefix.Replace(base64, "");
                var up = await client.UploadImageAsync(cleaned, fileName, ct: ct);
                imageUrl = BeeDocsApiClient.Prop(up, "url");
                name = BeeDocsApiClient.Prop(up, "fileName");
                if (string.IsNullOrEmpty(name))
                {
                    name = fileName;
                }
            }

            var page = await client.GetPageAsync(pageId, ct);
            var safeAlt = (alt ?? name).Replace("[", "").Replace("]", "");
            var block = $"![{safeAlt}]({imageUrl})";
            var existing = BeeDocsApiClient.Prop(page, "content").TrimEnd();
            var content = string.Concat(
                string.IsNullOrEmpty(existing) ? "" : existing,
                string.IsNullOrEmpty(heading) ? "\n\n" : $"\n\n{heading}\n\n",
                block,
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

            return ToolHelpers.Json(new { page = updated, imageUrl, markdown = block });
        });
}
