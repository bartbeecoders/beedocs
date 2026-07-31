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
/// media fences only their title, and ordinary code blocks are kept as-is because
/// finding a config snippet or a type name is exactly what these docs are for.
/// </summary>
public static class SearchText
{
    /// <summary>Fence languages whose body is a BeeDiagram JSON document.</summary>
    private static readonly HashSet<string> DiagramFences =
        new(StringComparer.OrdinalIgnoreCase) { "beediagram", "beediagram-ref" };

    /// <summary>Fence languages whose body is an embed descriptor, not prose.</summary>
    private static readonly HashSet<string> MediaFences =
        new(StringComparer.OrdinalIgnoreCase) { "pdf", "glb", "gltf", "obj", "model" };

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

        return body;
    }

    /// <summary>Pull node/edge labels out of a BeeDiagram JSON document.</summary>
    private static string DiagramLabels(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return "";

            var sb = new StringBuilder();
            foreach (var collection in new[] { "nodes", "edges" })
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
