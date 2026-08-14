using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class SlideTools(BeeDocsApiClient client)
{
    /// <summary>Matches SlideDeckService.DefaultSource so an MCP-created deck opens like a UI-created one.</summary>
    private const string SchemaHint =
        "Deck document: {version:1, size:{w:1280,h:720}, theme:{background,color,accent,fontFamily}, " +
        "slides:[{id, background?, notes?, elements:[{id, kind:text|shape|image, x,y,w,h, rotation?, " +
        "text?, fontSize?, bold?, italic?, underline?, align?, valign?, color?, " +
        "shape?:rect|rounded|ellipse|triangle|diamond|star|arrow|line, fill?, stroke?, strokeWidth?, opacity?, " +
        "imageUrl?}]}]}. Element array order is z-order (later draws on top).";

    [McpServerTool(Name = "beedocs_list_slide_decks", Title = "List slide decks in book"),
     Description("List slide deck summaries for a book (includes slideCount).")]
    public Task<string> ListSlideDecks(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListSlideDecksAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_slide_deck", Title = "Get slide deck"),
     Description("Get a slide deck including its full JSON document. " + SchemaHint)]
    public Task<string> GetSlideDeck(string deckId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetSlideDeckAsync(deckId, ct)));

    [McpServerTool(Name = "beedocs_create_slide_deck", Title = "Create slide deck"),
     Description("Create a slide deck in a book from a raw JSON document. Omit source to start with one blank 16:9 slide. " +
                 "Prefer beedocs_create_slide_deck_with_slides for structured, validated input. " + SchemaHint)]
    public Task<string> CreateSlideDeck(
        string bookId,
        string title,
        [Description("Deck JSON document; omit for a single blank slide")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            return ToolHelpers.Json(await client.CreateSlideDeckAsync(bookId, new { title, source }, ct));
        });

    [McpServerTool(Name = "beedocs_update_slide_deck", Title = "Update slide deck"),
     Description("Update a slide deck's title and/or raw JSON document. Null source keeps the stored document; null title keeps the current one.")]
    public Task<string> UpdateSlideDeck(
        string deckId,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Replacement deck JSON document; leave unset to keep the current one")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            // The API requires a title on every update, so an omitted one is
            // read back from the deck rather than treated as an error.
            var t = title;
            if (string.IsNullOrWhiteSpace(t))
            {
                var existing = await client.GetSlideDeckAsync(deckId, ct);
                t = BeeDocsApiClient.Prop(existing, "title");
            }

            return ToolHelpers.Json(await client.UpdateSlideDeckAsync(deckId, new { title = t, source }, ct));
        });

    [McpServerTool(Name = "beedocs_delete_slide_deck", Title = "Delete slide deck", Destructive = true),
     Description("Permanently delete a slide deck by id.")]
    public Task<string> DeleteSlideDeck(string deckId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteSlideDeckAsync(deckId, ct);
            return ToolHelpers.Json(new { deleted = true, deckId });
        });

    [McpServerTool(Name = "beedocs_create_slide_deck_with_slides", Title = "Create slide deck from slides"),
     Description("Create a slide deck from structured slides (agent-friendly): each slide holds ordered elements " +
                 "(text boxes, shapes, images) positioned on a 1280×720 canvas; element order is z-order. " +
                 "Returns the created deck including its id and workspace URL.")]
    public Task<string> CreateSlideDeckWithSlides(
        string bookId,
        string title,
        [Description("Slides in presentation order")] List<SlideInput> slides,
        [Description("Deck-wide colours and font; defaults to the standard light theme")] SlideThemeInput? theme = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildDeckSource(slides, theme);
            var created = await client.CreateSlideDeckAsync(bookId, new { title, source }, ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                deck = created,
                workspaceUrl = string.IsNullOrEmpty(id) ? null : $"/books/{bookId}/slides/{id}",
            });
        });

    [McpServerTool(Name = "beedocs_update_slide_deck_slides", Title = "Replace slide deck slides"),
     Description("Replace an existing deck's slides with structured slides, using the same model as " +
                 "beedocs_create_slide_deck_with_slides. Title is kept unless given; theme is kept unless given.")]
    public Task<string> UpdateSlideDeckSlides(
        string deckId,
        [Description("Slides in presentation order — replaces the existing ones")] List<SlideInput> slides,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Leave unset to keep the deck's current theme")] SlideThemeInput? theme = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetSlideDeckAsync(deckId, ct);

            // Preserve the stored theme when none is given — replacing slides
            // shouldn't silently reset a deck's colours.
            SlideThemeInput? effectiveTheme = theme;
            if (effectiveTheme is null
                && TryParse(BeeDocsApiClient.Prop(existing, "source")) is { } doc
                && doc.TryGetProperty("theme", out var storedTheme)
                && storedTheme.ValueKind == JsonValueKind.Object)
            {
                effectiveTheme = new SlideThemeInput
                {
                    Background = BeeDocsApiClient.PropStringOrNull(storedTheme, "background"),
                    Color = BeeDocsApiClient.PropStringOrNull(storedTheme, "color"),
                    Accent = BeeDocsApiClient.PropStringOrNull(storedTheme, "accent"),
                    FontFamily = BeeDocsApiClient.PropStringOrNull(storedTheme, "fontFamily"),
                };
            }

            var source = BuildDeckSource(slides, effectiveTheme);
            return ToolHelpers.Json(await client.UpdateSlideDeckAsync(
                deckId,
                new
                {
                    title = string.IsNullOrWhiteSpace(title) ? BeeDocsApiClient.Prop(existing, "title") : title,
                    source,
                },
                ct));
        });

    private static void EnsureParses(string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return;
        try
        {
            using var _ = JsonDocument.Parse(source);
        }
        catch (JsonException ex)
        {
            throw new ModelContextProtocol.McpException(
                $"source is not valid JSON: {ex.Message}. {SchemaHint}");
        }
    }

    private static JsonElement? TryParse(string source)
    {
        if (string.IsNullOrWhiteSpace(source)) return null;
        try
        {
            using var doc = JsonDocument.Parse(source);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static readonly string[] ElementKinds = ["text", "shape", "image"];
    private static readonly string[] ShapeNames = ["rect", "rounded", "ellipse", "triangle", "diamond", "star", "arrow", "line"];

    /// <summary>
    /// Validate and serialise structured slides into the deck document the web
    /// editor writes. Shared by create and update so both accept the same model.
    /// </summary>
    private static string BuildDeckSource(List<SlideInput> slides, SlideThemeInput? theme)
    {
        if (slides.Count == 0)
        {
            throw new ModelContextProtocol.McpException("A deck needs at least one slide.");
        }

        var mappedSlides = slides.Select((s, si) =>
        {
            var slideId = string.IsNullOrWhiteSpace(s.Id) ? $"slide-{si + 1}" : s.Id!;
            var elements = (s.Elements ?? []).Select((e, ei) =>
            {
                var id = string.IsNullOrWhiteSpace(e.Id) ? $"el-{si + 1}-{ei + 1}" : e.Id!;
                var kind = (e.Kind ?? "text").Trim().ToLowerInvariant();
                if (!ElementKinds.Contains(kind))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Slide {slideId}, element {id}: unknown kind \"{e.Kind}\". Use one of: {string.Join(", ", ElementKinds)}.");
                }

                var shape = string.IsNullOrWhiteSpace(e.Shape) ? null : e.Shape.Trim().ToLowerInvariant();
                if (shape is not null && !ShapeNames.Contains(shape))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Slide {slideId}, element {id}: unknown shape \"{e.Shape}\". Use one of: {string.Join(", ", ShapeNames)}.");
                }

                if (kind == "image" && string.IsNullOrWhiteSpace(e.ImageUrl))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Slide {slideId}, element {id}: kind=image needs imageUrl (upload via beedocs_upload_image first).");
                }

                // Unplaced elements stack downwards so nothing lands on top of
                // anything else; the designer is where fine layout happens.
                var map = new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["kind"] = kind,
                    ["x"] = e.X ?? 80,
                    ["y"] = e.Y ?? 80 + ei * 140,
                    ["w"] = e.W ?? (kind == "text" ? 1120 : 320),
                    ["h"] = e.H ?? (kind == "text" ? 120 : 200),
                };
                BeeNodeStyleInput.Add(map, "rotation", e.Rotation);
                BeeNodeStyleInput.Add(map, "text", e.Text);
                BeeNodeStyleInput.Add(map, "fontSize", e.FontSize);
                BeeNodeStyleInput.Add(map, "bold", e.Bold);
                BeeNodeStyleInput.Add(map, "italic", e.Italic);
                BeeNodeStyleInput.Add(map, "underline", e.Underline);
                BeeNodeStyleInput.Add(map, "align", BeeNodeStyleInput.Enum(e.Align, ["left", "center", "right"], "align"));
                BeeNodeStyleInput.Add(map, "valign", BeeNodeStyleInput.Enum(e.Valign, ["top", "middle", "bottom"], "valign"));
                BeeNodeStyleInput.Add(map, "color", e.Color);
                BeeNodeStyleInput.Add(map, "shape", kind == "shape" ? shape ?? "rect" : null);
                BeeNodeStyleInput.Add(map, "fill", e.Fill);
                BeeNodeStyleInput.Add(map, "stroke", e.Stroke);
                BeeNodeStyleInput.Add(map, "strokeWidth", e.StrokeWidth);
                BeeNodeStyleInput.Add(map, "opacity", e.Opacity);
                BeeNodeStyleInput.Add(map, "imageUrl", e.ImageUrl);
                return map;
            }).ToList();

            var slide = new Dictionary<string, object?> { ["id"] = slideId, ["elements"] = elements };
            BeeNodeStyleInput.Add(slide, "background", s.Background);
            BeeNodeStyleInput.Add(slide, "notes", s.Notes);
            return slide;
        }).ToList();

        return JsonSerializer.Serialize(
            new
            {
                version = 1,
                size = new { w = 1280, h = 720 },
                theme = new
                {
                    background = Or(theme?.Background, "#ffffff"),
                    color = Or(theme?.Color, "#1f2430"),
                    accent = Or(theme?.Accent, "#f59e0b"),
                    fontFamily = Or(theme?.FontFamily, "'Segoe UI', system-ui, sans-serif"),
                },
                slides = mappedSlides,
            },
            SourceJson);
    }

    private static string Or(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    /// <summary>Omit unset members so the stored document matches what the editor writes.</summary>
    private static readonly JsonSerializerOptions SourceJson = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed class SlideInput
{
    [Description("Stable slide id; auto-assigned (slide-1, slide-2, …) when omitted")]
    public string? Id { get; set; }

    [Description("Per-slide background colour override, #rrggbb")]
    public string? Background { get; set; }

    [Description("Speaker notes — indexed for search, never rendered on the slide")]
    public string? Notes { get; set; }

    [Description("Elements in z-order (later draws on top)")]
    public List<SlideElementInput>? Elements { get; set; }
}

public sealed class SlideElementInput
{
    [Description("Stable element id; auto-assigned when omitted")]
    public string? Id { get; set; }

    [Description("text (default) | shape | image")]
    public string? Kind { get; set; }

    [Description("Slide coordinates on a 1280×720 canvas; unplaced elements stack downwards")]
    public double? X { get; set; }

    public double? Y { get; set; }
    public double? W { get; set; }
    public double? H { get; set; }

    [Description("Rotation in degrees around the element centre")]
    public double? Rotation { get; set; }

    [Description("Text content; also the label inside a shape")]
    public string? Text { get; set; }

    public double? FontSize { get; set; }
    public bool? Bold { get; set; }
    public bool? Italic { get; set; }
    public bool? Underline { get; set; }

    [Description("left | center | right")]
    public string? Align { get; set; }

    [Description("top | middle | bottom")]
    public string? Valign { get; set; }

    [Description("Text colour, #rrggbb")]
    public string? Color { get; set; }

    [Description("For kind=shape: rect (default) | rounded | ellipse | triangle | diamond | star | arrow | line")]
    public string? Shape { get; set; }

    [Description("Shape fill, #rrggbb or \"none\"")]
    public string? Fill { get; set; }

    [Description("Shape outline, #rrggbb or \"none\"")]
    public string? Stroke { get; set; }

    public double? StrokeWidth { get; set; }

    [Description("0–100")]
    public double? Opacity { get; set; }

    [Description("For kind=image: an /uploads/… URL from beedocs_upload_image")]
    public string? ImageUrl { get; set; }
}

public sealed class SlideThemeInput
{
    [Description("Default slide background, #rrggbb")]
    public string? Background { get; set; }

    [Description("Default text colour, #rrggbb")]
    public string? Color { get; set; }

    [Description("Accent colour, #rrggbb")]
    public string? Accent { get; set; }

    [Description("CSS font-family for the whole deck")]
    public string? FontFamily { get; set; }
}
