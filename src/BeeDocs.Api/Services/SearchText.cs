using System.Text;
using System.Text.Json;

namespace BeeDocs.Api.Services;

/// <summary>
/// Turns stored content into the plain text the search index actually holds.
///
/// Pages are Markdown with embedded fences, and indexing that raw would match on
/// syntax rather than prose — a search for "rect" would hit every page carrying an
/// inline BeeDiagram, whose body is a JSON document full of shape keywords. So
/// fences are handled by kind: diagram JSON contributes only its shape labels,
/// excelgrid JSON only its cell values, media fences only their title, and
/// ordinary code blocks are kept as-is because finding a config snippet or a
/// type name is exactly what these docs are for.
/// </summary>
public static class SearchText
{
    /// <summary>Fence languages whose body is a diagram JSON document (or a ref id).</summary>
    private static readonly HashSet<string> DiagramFences =
        new(StringComparer.OrdinalIgnoreCase) { "beediagram", "beediagram-ref", "isometric", "isometric-ref" };

    /// <summary>Fence languages whose body is an embed descriptor, not prose.</summary>
    private static readonly HashSet<string> MediaFences =
        new(StringComparer.OrdinalIgnoreCase) { "pdf", "glb", "gltf", "obj", "model" };

    /// <summary>Fence languages whose body is an Excel-grid JSON document.</summary>
    private static readonly HashSet<string> GridFences =
        new(StringComparer.OrdinalIgnoreCase) { "excelgrid", "spreadsheet", "grid" };

    /// <summary>Plain text for a Markdown page body.</summary>
    public static string FromMarkdown(string? markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return "";

        var sb = new StringBuilder();
        foreach (var block in MarkdownDoc.Parse(markdown))
        {
            switch (block)
            {
                case MarkdownDoc.HeadingBlock h:
                    Append(sb, MarkdownDoc.ToPlainText(h.Inlines));
                    break;
                case MarkdownDoc.ParagraphBlock p:
                    Append(sb, MarkdownDoc.ToPlainText(p.Inlines));
                    break;
                case MarkdownDoc.QuoteBlock q:
                    Append(sb, MarkdownDoc.ToPlainText(q.Inlines));
                    break;
                case MarkdownDoc.ListBlock l:
                    foreach (var item in l.Items)
                        Append(sb, MarkdownDoc.ToPlainText(item.Inlines));
                    break;
                case MarkdownDoc.TableBlock t:
                    foreach (var cell in t.Header)
                        Append(sb, MarkdownDoc.ToPlainText(cell));
                    foreach (var row in t.Rows)
                        foreach (var cell in row)
                            Append(sb, MarkdownDoc.ToPlainText(cell));
                    break;
                case MarkdownDoc.CodeBlock c:
                    Append(sb, FromFence(c.Language, c.Text));
                    break;
            }
        }

        return Normalize(sb.ToString());
    }

    /// <summary>Plain text for a stored diagram's source document.</summary>
    public static string FromDiagramSource(string? kind, string? source)
    {
        if (string.IsNullOrWhiteSpace(source)) return "";
        // Mermaid and other text formats are already prose-ish; only BeeDiagram
        // documents are JSON that needs label extraction.
        return Normalize(LooksLikeJson(source) ? DiagramLabels(source) : source);
    }

    /// <summary>
    /// Plain text for a stored slide deck document: the text every element shows
    /// plus each slide's speaker notes. Geometry and styling stay out — matching
    /// on "#ffffff" or "fontSize" would be noise, not search.
    /// </summary>
    public static string FromSlideDeckSource(string? source)
    {
        if (string.IsNullOrWhiteSpace(source) || !LooksLikeJson(source)) return "";
        try
        {
            using var doc = JsonDocument.Parse(source);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return "";
            if (!doc.RootElement.TryGetProperty("slides", out var slides)
                || slides.ValueKind != JsonValueKind.Array)
            {
                return "";
            }

            var sb = new StringBuilder();
            foreach (var slide in slides.EnumerateArray())
            {
                if (slide.ValueKind != JsonValueKind.Object) continue;
                if (slide.TryGetProperty("elements", out var elements)
                    && elements.ValueKind == JsonValueKind.Array)
                {
                    foreach (var element in elements.EnumerateArray())
                    {
                        if (element.ValueKind == JsonValueKind.Object
                            && element.TryGetProperty("text", out var text)
                            && text.ValueKind == JsonValueKind.String)
                        {
                            Append(sb, text.GetString());
                        }
                    }
                }
                if (slide.TryGetProperty("notes", out var notes)
                    && notes.ValueKind == JsonValueKind.String)
                {
                    Append(sb, notes.GetString());
                }
            }
            return Normalize(sb.ToString());
        }
        catch (JsonException)
        {
            return "";
        }
    }

    private static string FromFence(string language, string body)
    {
        var lang = (language ?? "").Trim();

        if (DiagramFences.Contains(lang))
            return LooksLikeJson(body) ? DiagramLabels(body) : "";

        if (MediaFences.Contains(lang))
        {
            // `title: Spec sheet` on the first line is the only human-readable part.
            foreach (var line in body.Split('\n'))
            {
                var trimmed = line.Trim();
                if (trimmed.StartsWith("title:", StringComparison.OrdinalIgnoreCase))
                    return trimmed[6..].Trim();
            }
            return "";
        }

        if (GridFences.Contains(lang))
            return LooksLikeJson(body) ? GridValues(body) : "";

        return body;
    }

    /// <summary>
    /// Pull labels out of a diagram JSON document: node/edge labels for
    /// BeeDiagram; item/connector/zone labels and text blocks for isometric.
    /// </summary>
    private static string DiagramLabels(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return "";

            var sb = new StringBuilder();
            foreach (var collection in new[] { "nodes", "edges", "items", "connectors", "zones", "texts" })
            {
                if (!doc.RootElement.TryGetProperty(collection, out var items)) continue;
                if (items.ValueKind != JsonValueKind.Array) continue;

                foreach (var item in items.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    foreach (var field in new[] { "label", "text", "title" })
                    {
                        if (item.TryGetProperty(field, out var value)
                            && value.ValueKind == JsonValueKind.String)
                        {
                            Append(sb, value.GetString());
                        }
                    }
                }
            }
            return sb.ToString();
        }
        catch (JsonException)
        {
            // A half-typed diagram is not worth failing an index write over.
            return "";
        }
    }

    /// <summary>Pull cell values out of an excelgrid JSON document.</summary>
    private static string GridValues(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return "";
            if (!doc.RootElement.TryGetProperty("cells", out var cells)
                || cells.ValueKind != JsonValueKind.Array)
            {
                return "";
            }

            var sb = new StringBuilder();
            foreach (var cell in cells.EnumerateArray())
            {
                if (cell.ValueKind != JsonValueKind.Object) continue;
                if (cell.TryGetProperty("v", out var value) && value.ValueKind == JsonValueKind.String)
                    Append(sb, value.GetString());
            }
            return sb.ToString();
        }
        catch (JsonException)
        {
            return "";
        }
    }

    private static bool LooksLikeJson(string value)
    {
        var trimmed = value.AsSpan().TrimStart();
        return trimmed.Length > 0 && trimmed[0] == '{';
    }

    private static void Append(StringBuilder sb, string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (sb.Length > 0) sb.Append('\n');
        sb.Append(text.Trim());
    }

    /// <summary>Collapse runs of blank lines and trailing whitespace.</summary>
    private static string Normalize(string text)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var sb = new StringBuilder(text.Length);
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            if (sb.Length > 0) sb.Append('\n');
            sb.Append(trimmed);
        }
        return sb.ToString();
    }
}
