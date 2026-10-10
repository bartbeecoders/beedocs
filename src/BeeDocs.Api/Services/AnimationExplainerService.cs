using System.Text.Json;
using System.Text.Json.Nodes;
using BeeDocs.Api.Models;
using BeeDocs.Api.Services.Reorganize;

namespace BeeDocs.Api.Services;

/// <summary>
/// "Turn this page into a moving explanation": hands one page's Markdown to the
/// default LLM provider (<see cref="LlmPrompts.Explainer"/>), validates the JSON
/// animation that comes back, and stores it as a new animation in the book.
/// <para>
/// The reply is model output, so it is checked rather than trusted: fences and
/// prose around the object are stripped, a document without scenes is refused,
/// and missing ids / stage fields are filled in. Anything subtler (an unknown
/// preset, an element off the stage) is left to the web parser, which is
/// tolerant by design — it drops what it does not understand.
/// </para>
/// </summary>
public sealed class AnimationExplainerService(
    IDocumentService documents, IAnimationService animations, ILlmClient llm)
{
    /// <summary>Enough page to explain; fenced blocks become [embedded lang] first.</summary>
    private const int MaxPageChars = 12_000;

    public async Task<AnimationDto> CreateFromPageAsync(
        string bookId, CreateAnimationFromPageRequest request, CancellationToken ct = default)
    {
        // Checked before the (slow, paid) completion rather than after it.
        _ = await documents.GetBookAsync(bookId, ct)
            ?? throw new KeyNotFoundException($"Book '{bookId}' not found.");

        // GetPageAsync applies the privacy filter, so a page the caller cannot
        // see is indistinguishable from one that does not exist.
        var page = await documents.GetPageAsync(request.PageId, ct)
            ?? throw new KeyNotFoundException($"Page '{request.PageId}' not found.");

        var excerpt = ReorgText.Excerpt(page.Content ?? "", MaxPageChars);
        if (string.IsNullOrWhiteSpace(excerpt))
            throw new ArgumentException("The page is empty — there is nothing to explain.", nameof(request.PageId));

        var assignment = new System.Text.StringBuilder();
        assignment.Append("Page title: ").Append(page.Title).Append('\n');
        assignment.Append(request.SceneCount is { } n
            ? $"Make exactly {Math.Clamp(n, 2, 12)} scenes.\n"
            : "Choose between 3 and 8 scenes, as the content needs.\n");
        if (!string.IsNullOrWhiteSpace(request.Instructions))
            assignment.Append("Extra guidance from the author: ").Append(request.Instructions.Trim()).Append('\n');
        assignment.Append("Reply with the animation JSON only.");

        LlmCompleteResponse completion;
        try
        {
            completion = await llm.CompleteAsync(new LlmCompleteRequest(
                Task: LlmPrompts.Explainer,
                Prompt: assignment.ToString(),
                Context: $"# {page.Title}\n\n{excerpt}",
                Selection: null,
                ProviderId: null,
                Model: null,
                MaxTokens: null,
                Temperature: null), ct);
        }
        catch (KeyNotFoundException e)
        {
            // No provider configured — reported like every other LLM failure.
            throw new LlmException(e.Message);
        }

        var source = NormalizeReply(completion.Text);
        var title = string.IsNullOrWhiteSpace(request.Title)
            ? $"{page.Title} — explained"
            : request.Title.Trim();

        return await animations.CreateAsync(bookId, new CreateAnimationRequest(title, source), ct);
    }

    /// <summary>
    /// Model reply → stored animation JSON. Throws <see cref="LlmException"/>
    /// (→ 502) when there is no usable document in it.
    /// </summary>
    internal static string NormalizeReply(string reply)
    {
        var json = ExtractObject(reply)
            ?? throw new LlmException("The model did not return an animation (no JSON object in its reply).");

        JsonObject root;
        try
        {
            root = JsonNode.Parse(json) as JsonObject
                ?? throw new LlmException("The model's animation is not a JSON object.");
        }
        catch (JsonException e)
        {
            throw new LlmException($"The model returned malformed animation JSON: {e.Message}");
        }

        if (root["scenes"] is not JsonArray scenes || scenes.Count == 0)
            throw new LlmException("The model's animation has no scenes.");

        root["version"] = 1;
        EnsureNumber(root, "width", 1280);
        EnsureNumber(root, "height", 720);
        EnsureNumber(root, "fps", 30);
        if (root["background"] is not JsonValue) root["background"] = "#0f172a";
        if (root["accent"] is not JsonValue) root["accent"] = "#f59e0b";
        if (root["captions"] is not JsonValue) root["captions"] = true;

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var sceneIndex = 0;
        foreach (var node in scenes)
        {
            sceneIndex++;
            if (node is not JsonObject scene) continue;
            scene["id"] = UniqueId(scene["id"], $"scene-{sceneIndex}", ids);
            EnsureNumber(scene, "duration", 6);
            if (scene["elements"] is not JsonArray elements)
            {
                scene["elements"] = new JsonArray();
                continue;
            }
            var elementIndex = 0;
            foreach (var el in elements)
            {
                elementIndex++;
                if (el is JsonObject element)
                    element["id"] = UniqueId(element["id"], $"s{sceneIndex}-e{elementIndex}", ids);
            }
        }

        return root.ToJsonString();
    }

    /// <summary>The outermost {...} in the reply, ignoring fences and chatter around it.</summary>
    private static string? ExtractObject(string reply)
    {
        var text = reply.Trim();
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text[start..(end + 1)] : null;
    }

    private static void EnsureNumber(JsonObject o, string key, double fallback)
    {
        if (o[key] is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) && d > 0) return;
        o[key] = fallback;
    }

    private static string UniqueId(JsonNode? current, string fallback, HashSet<string> taken)
    {
        var id = current is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s)
            ? s.Trim()
            : fallback;
        var candidate = id;
        for (var i = 2; !taken.Add(candidate); i++) candidate = $"{id}-{i}";
        return candidate;
    }
}
