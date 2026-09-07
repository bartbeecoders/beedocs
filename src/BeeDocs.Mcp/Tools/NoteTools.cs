using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class NoteTools(BeeDocsApiClient client)
{
    /// <summary>Matches the web editor schema in src/beedocs-web/src/notes/noteModel.ts.</summary>
    private const string SchemaHint =
        "Note document: {version:1, background, paper, blocks:[…]}. background is plain|ruled|grid|dots; " +
        "paper is white|cream|mint|sky|lavender|rose|graphite. blocks sit at absolute positions (x, y, w, h in CSS px, " +
        "origin top-left; array order is z-order; h null = auto height). Block kinds: " +
        "text {id, kind:'text', x, y, w, h, text (Markdown), tag (important|question|idea|remember|critical|definition|contact|null)}, " +
        "checklist {id, kind:'checklist', x, y, w, h, title, items:[{id, text, done}]}, " +
        "image {id, kind:'image', x, y, w, h, src ('/uploads/…' or URL), alt}, " +
        "ink {id, kind:'ink', x, y, w, h, strokes:[{id, color, width, opacity, points:[x0,y0,x1,y1,…]}]} — ink and images are " +
        "best left to the UI; agents usually create text and checklist blocks. " +
        "Pages embed a stored note with ```note-ref\\nNOTE_ID\\n```, or an inline copy with ```note\\n{json}\\n```.";

    private static readonly HashSet<string> Tags = new(StringComparer.OrdinalIgnoreCase)
    {
        "important", "question", "idea", "remember", "critical", "definition", "contact",
    };

    [McpServerTool(Name = "beedocs_list_notes", Title = "List notes in book", ReadOnly = true),
     Description("List note summaries for a book (includes blockCount).")]
    public Task<string> ListNotes(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListNotesAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_note", Title = "Get note", ReadOnly = true),
     Description("Get a note including its full JSON document. " + SchemaHint)]
    public Task<string> GetNote(string noteId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetNoteAsync(noteId, ct)));

    [McpServerTool(Name = "beedocs_create_note", Title = "Create note"),
     Description("Create a OneNote-style free-form note in a book from a raw JSON document. Omit source for an empty page. " +
                 "Prefer beedocs_create_note_with_blocks for structured, auto-laid-out input. " + SchemaHint)]
    public Task<string> CreateNote(
        string bookId,
        string title,
        [Description("Note JSON document; omit for an empty page")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            return ToolHelpers.Json(await client.CreateNoteAsync(bookId, new { title, source }, ct));
        });

    [McpServerTool(Name = "beedocs_update_note", Title = "Update note"),
     Description("Update a note's title and/or raw JSON document. Null source keeps the stored document; null title keeps the current one.")]
    public Task<string> UpdateNote(
        string noteId,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Replacement note JSON document; leave unset to keep the current one")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            var t = title;
            if (string.IsNullOrWhiteSpace(t))
            {
                var existing = await client.GetNoteAsync(noteId, ct);
                t = BeeDocsApiClient.Prop(existing, "title");
            }

            return ToolHelpers.Json(await client.UpdateNoteAsync(noteId, new { title = t, source }, ct));
        });

    [McpServerTool(Name = "beedocs_delete_note", Title = "Delete note", Destructive = true),
     Description("Permanently delete a note by id.")]
    public Task<string> DeleteNote(string noteId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteNoteAsync(noteId, ct);
            return ToolHelpers.Json(new { deleted = true, noteId });
        });

    [McpServerTool(Name = "beedocs_create_note_with_blocks", Title = "Create note from blocks"),
     Description("Create a note from structured text / checklist / image blocks (agent-friendly). " +
                 "Blocks without x/y are stacked top-to-bottom automatically. Omit blocks for an empty page. " +
                 "Returns the created note including its id, workspace URL and embed fence.")]
    public Task<string> CreateNoteWithBlocks(
        string bookId,
        string title,
        [Description("Blocks in z-order; omit for an empty page")] List<NoteBlockInput>? blocks = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildNoteSource(blocks);
            var created = await client.CreateNoteAsync(bookId, new { title, source }, ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                note = created,
                workspaceUrl = string.IsNullOrEmpty(id) ? null : $"/books/{bookId}/notes/{id}",
                embedFence = string.IsNullOrEmpty(id) ? null : $"```note-ref\n{id}\n```",
            });
        });

    [McpServerTool(Name = "beedocs_update_note_blocks", Title = "Replace note blocks"),
     Description("Replace an existing note's blocks with structured blocks, using the same model as " +
                 "beedocs_create_note_with_blocks. Ink drawn in the UI is dropped, so read the note first " +
                 "if you need to keep it (use beedocs_update_note with the full document instead). Title is kept unless given.")]
    public Task<string> UpdateNoteBlocks(
        string noteId,
        [Description("Blocks in z-order — replaces the existing ones")] List<NoteBlockInput> blocks,
        [Description("Leave unset to keep the current title")] string? title = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetNoteAsync(noteId, ct);
            var source = BuildNoteSource(blocks, existing);
            return ToolHelpers.Json(await client.UpdateNoteAsync(
                noteId,
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

    private const int LayoutX = 48;
    private const int LayoutStartY = 40;
    private const int LayoutGap = 24;

    /// <summary>
    /// Serialize structured blocks into a note document. When <paramref name="existing"/> is given,
    /// its background and paper are preserved so a block replacement does not reset the page look.
    /// </summary>
    private static string BuildNoteSource(List<NoteBlockInput>? blocks, JsonElement? existing = null)
    {
        var background = "plain";
        var paper = "white";
        if (existing is { } e && TryReadDoc(e, out var doc))
        {
            if (doc.TryGetProperty("background", out var bg) && bg.ValueKind == JsonValueKind.String)
                background = bg.GetString() ?? background;
            if (doc.TryGetProperty("paper", out var pp) && pp.ValueKind == JsonValueKind.String)
                paper = pp.GetString() ?? paper;
        }

        var mapped = new List<Dictionary<string, object?>>();
        double nextY = LayoutStartY;
        var i = 0;
        foreach (var b in blocks ?? [])
        {
            i++;
            var id = string.IsNullOrWhiteSpace(b.Id) ? $"blk-{i}" : b.Id!.Trim();
            var kind = (b.Kind ?? "text").Trim().ToLowerInvariant();
            if (kind is not ("text" or "checklist" or "image")) kind = "text";

            double w = b.W is > 0 ? b.W.Value : kind switch
            {
                "checklist" => 280,
                "image" => 320,
                _ => 460,
            };
            double? h = b.H is > 0 ? b.H.Value : null;
            if (kind == "image") h ??= 200;

            var autoY = b.Y is null;
            double x = b.X is >= 0 ? b.X.Value : LayoutX;
            double y = b.Y is >= 0 ? b.Y.Value : nextY;

            var block = new Dictionary<string, object?>
            {
                ["id"] = id,
                ["kind"] = kind,
                ["x"] = x,
                ["y"] = y,
                ["w"] = w,
                ["h"] = h,
            };

            double estimated;
            switch (kind)
            {
                case "checklist":
                {
                    var items = (b.Items ?? [])
                        .Select((text, j) =>
                        {
                            var t = text ?? "";
                            var done = t.StartsWith("[x] ", StringComparison.OrdinalIgnoreCase);
                            if (done) t = t[4..];
                            return new Dictionary<string, object?>
                            {
                                ["id"] = $"{id}-chk-{j + 1}",
                                ["text"] = t.Trim(),
                                ["done"] = done,
                            };
                        })
                        .ToList();
                    block["title"] = b.Title?.Trim() ?? "";
                    block["items"] = items;
                    estimated = h ?? 40 + 26 * items.Count;
                    break;
                }
                case "image":
                {
                    if (string.IsNullOrWhiteSpace(b.Src))
                        throw new ModelContextProtocol.McpException($"blocks[{i - 1}]: an image block needs src.");
                    block["src"] = b.Src.Trim();
                    block["alt"] = b.Alt ?? "";
                    estimated = h ?? 200;
                    break;
                }
                default:
                {
                    var text = b.Text ?? "";
                    var tag = !string.IsNullOrWhiteSpace(b.Tag) && Tags.Contains(b.Tag.Trim())
                        ? b.Tag.Trim().ToLowerInvariant()
                        : null;
                    block["text"] = text;
                    block["tag"] = tag;
                    var lineCount = Math.Max(1, text.Split('\n').Length);
                    estimated = h ?? 24 + 22 * lineCount;
                    break;
                }
            }

            mapped.Add(block);
            // Auto-stacking follows the previous block whether it was placed by hand or not,
            // so a mix of explicit and implicit positions never overlaps.
            var bottom = y + estimated + LayoutGap;
            if (autoY || bottom > nextY) nextY = bottom;
        }

        return JsonSerializer.Serialize(new { version = 1, background, paper, blocks = mapped }, SourceJson);
    }

    private static bool TryReadDoc(JsonElement note, out JsonElement doc)
    {
        doc = default;
        if (!note.TryGetProperty("source", out var src) || src.ValueKind != JsonValueKind.String) return false;
        var s = src.GetString();
        if (string.IsNullOrWhiteSpace(s)) return false;
        try
        {
            using var parsed = JsonDocument.Parse(s);
            doc = parsed.RootElement.Clone();
            return doc.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    // Nulls are kept on purpose: `h: null` and `tag: null` are meaningful in the note schema.
    private static readonly JsonSerializerOptions SourceJson = new();
}

public sealed class NoteBlockInput
{
    [Description("Stable block id; auto-assigned (blk-1, blk-2, …) when omitted")]
    public string? Id { get; set; }

    [Description("text | checklist | image (default text)")]
    public string? Kind { get; set; }

    [Description("Left edge in px; omit to auto-place at x=48")]
    public double? X { get; set; }

    [Description("Top edge in px; omit to stack below the previous block")]
    public double? Y { get; set; }

    [Description("Width in px; defaults: text 460, checklist 280, image 320")]
    public double? W { get; set; }

    [Description("Height in px; omit for auto height (text/checklist) or 200 (image)")]
    public double? H { get; set; }

    [Description("Markdown content (text blocks)")]
    public string? Text { get; set; }

    [Description("Tag for a text block: important | question | idea | remember | critical | definition | contact")]
    public string? Tag { get; set; }

    [Description("Checklist heading (checklist blocks)")]
    public string? Title { get; set; }

    [Description("Checklist item texts; prefix an item with \"[x] \" to mark it done")]
    public List<string>? Items { get; set; }

    [Description("Image URL — '/uploads/…' from beedocs_upload_image, or any URL (image blocks)")]
    public string? Src { get; set; }

    [Description("Image alt text (image blocks)")]
    public string? Alt { get; set; }
}
