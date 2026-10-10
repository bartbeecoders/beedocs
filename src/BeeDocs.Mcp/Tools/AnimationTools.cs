using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// Animations ("moving explanations"). The document is video-as-code in the
/// fframes sense: every frame is a pure function of time, so an agent can author
/// one directly as JSON — or ask the API's AI explainer to draft one from a page.
/// </summary>
[McpServerToolType]
public sealed class AnimationTools(BeeDocsApiClient client)
{
    /// <summary>Matches the web schema in src/beedocs-web/src/animation/animModel.ts.</summary>
    private const string SchemaHint =
        "Animation document: {version:1, width:1280, height:720, fps:30, background:'#0f172a', accent:'#f59e0b', captions:true, " +
        "scenes:[{id, title, duration (s), narration? (caption text), transition?: none|fade|slide|zoom, background?, elements:[...]}]}. " +
        "Scenes play back to back. Element: {id, type: text|box|circle|line|arrow|icon|image|path, x, y, w, h (stage px, top-left), " +
        "x2,y2 (line/arrow end), text (body / label / one emoji for icon), fontSize, font: sans|serif|mono, bold, align: start|middle|end, " +
        "color (text), fill, stroke, strokeWidth, radius, opacity, dashed, src (image URL), d (SVG path data for path, relative to the element box — 0,0 is its top-left; x/y/w/h position it), " +
        "enter:{preset: none|fade|rise|drop|slide-left|slide-right|pop|zoom|draw|type|wipe, at, duration, easing?}, " +
        "emphasis:{preset: pulse|shake|glow|spin, at, duration}, exit:{preset: none|fade|sink|shrink|slide-left|slide-right, at, duration}, " +
        "keyframes:[{t, x?, y?, opacity?, scale?, rotate?, easing?}]}. " +
        "easing: linear|easeIn|easeOut|easeInOut|easeOutBack|easeOutElastic|easeOutBounce. " +
        "All at/t values are seconds from the start of that scene. Array order is z-order. " +
        "Keep the bottom ~110 px free for captions; stagger enter cues so the picture builds as the narration speaks. " +
        "Pages embed a stored animation with ```animation-ref\\nANIMATION_ID\\n```, or an inline copy with ```animation\\n{json}\\n```.";

    [McpServerTool(Name = "beedocs_list_animations", Title = "List animations in book", ReadOnly = true),
     Description("List animation summaries for a book (includes sceneCount).")]
    public Task<string> ListAnimations(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListAnimationsAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_animation", Title = "Get animation", ReadOnly = true),
     Description("Get an animation including its full JSON document. " + SchemaHint)]
    public Task<string> GetAnimation(string animationId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetAnimationAsync(animationId, ct)));

    [McpServerTool(Name = "beedocs_create_animation", Title = "Create animation"),
     Description("Create an animation (moving explanation) in a book from a JSON document you author — video as code: " +
                 "every frame is computed from the document and the time. Omit source for one empty scene. " +
                 "Returns the animation plus its workspace URL and an embed fence. " + SchemaHint)]
    public Task<string> CreateAnimation(
        string bookId,
        string title,
        [Description("Animation JSON document; omit for one empty scene")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            var created = await client.CreateAnimationAsync(bookId, new { title, source }, ct);
            return ToolHelpers.Json(WithLinks(bookId, created));
        });

    [McpServerTool(Name = "beedocs_create_animation_from_page", Title = "Turn a page into an animated explainer"),
     Description("Ask BeeDocs' default LLM provider to turn a documentation page into an animated explainer " +
                 "(scenes of shapes, arrows and text that build up step by step, with narration captions) and store it as a new animation in the book. " +
                 "Takes up to ~3 minutes. Requires an LLM provider configured in BeeDocs (Settings → AI providers). " +
                 "Review the result with beedocs_get_animation and refine it with beedocs_update_animation.")]
    public Task<string> CreateAnimationFromPage(
        [Description("Book the new animation is created in")] string bookId,
        [Description("Page to explain")] string pageId,
        [Description("Animation title; defaults to \"<page title> — explained\"")] string? title = null,
        [Description("Target scene count (2–12); omit to let the model choose 3–8")] int? sceneCount = null,
        [Description("Extra guidance: audience, tone, what to focus on")] string? instructions = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var created = await client.CreateAnimationFromPageAsync(
                bookId, new { pageId, title, sceneCount, instructions }, ct);
            return ToolHelpers.Json(WithLinks(bookId, created));
        });

    [McpServerTool(Name = "beedocs_update_animation", Title = "Update animation"),
     Description("Update an animation's title and/or JSON document. Null source keeps the stored document; null title keeps the current one. " + SchemaHint)]
    public Task<string> UpdateAnimation(
        string animationId,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Replacement animation JSON document; leave unset to keep the current one")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            var t = title;
            if (string.IsNullOrWhiteSpace(t))
            {
                var existing = await client.GetAnimationAsync(animationId, ct);
                t = BeeDocsApiClient.Prop(existing, "title");
            }

            return ToolHelpers.Json(await client.UpdateAnimationAsync(animationId, new { title = t, source }, ct));
        });

    [McpServerTool(Name = "beedocs_delete_animation", Title = "Delete animation", Destructive = true),
     Description("Permanently delete an animation by id.")]
    public Task<string> DeleteAnimation(string animationId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteAnimationAsync(animationId, ct);
            return ToolHelpers.Json(new { deleted = true, animationId });
        });

    private static object WithLinks(string bookId, JsonElement created)
    {
        var id = BeeDocsApiClient.Prop(created, "id");
        return new
        {
            animation = created,
            workspaceUrl = string.IsNullOrEmpty(id) ? null : $"/books/{bookId}/animations/{id}",
            embedFence = string.IsNullOrEmpty(id) ? null : $"```animation-ref\n{id}\n```",
        };
    }

    /// <summary>Catch a malformed document here, where the error can still teach the schema.</summary>
    private static void EnsureParses(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return;
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("scenes", out var scenes)
                || scenes.ValueKind != JsonValueKind.Array
                || scenes.GetArrayLength() == 0)
            {
                throw new ModelContextProtocol.McpException(
                    $"source must be an object with a non-empty \"scenes\" array. {SchemaHint}");
            }
        }
        catch (JsonException ex)
        {
            throw new ModelContextProtocol.McpException(
                $"source is not valid JSON: {ex.Message}. {SchemaHint}");
        }
    }
}
