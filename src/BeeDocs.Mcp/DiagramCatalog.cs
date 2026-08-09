using System.Collections.Frozen;
using System.Reflection;
using System.Text.Json;

namespace BeeDocs.Mcp;

/// <summary>
/// The studio shape catalog, embedded from <c>diagram-catalog.json</c>.
///
/// That file is generated from the web app's TypeScript
/// (<c>pnpm --dir src/beedocs-web gen:catalog</c>, which also runs on every web
/// build), so the shapes an agent can use here are exactly the ones a human
/// sees in the palette — including every Azure stencil.
/// </summary>
internal static class DiagramCatalog
{
    private const string ResourceName = "BeeDocs.Mcp.diagram-catalog.json";

    private static readonly Lazy<JsonDocument> Document = new(Load, isThreadSafe: true);

    /// <summary>Raw catalog JSON, for tools and resources that pass it straight through.</summary>
    public static JsonElement Root => Document.Value.RootElement;

    // Ordered lists keep error messages readable (palette order); the frozen
    // sets behind them do the lookups.
    public static IReadOnlyList<string> Shapes { get; } = Ids("shapes");

    public static IReadOnlyList<string> NodeTypes { get; } = Strings("nodeTypes");

    public static IReadOnlyList<string> Anchors { get; } = Strings("anchors");

    public static IReadOnlyList<string> EdgeRoutes { get; } = Ids("edgeRoutes");

    public static IReadOnlyList<string> ArrowHeads { get; } = Strings("arrowHeads");

    public static IReadOnlyList<string> AzureIcons { get; } =
        Document.Value.RootElement.GetProperty("azure").GetProperty("icons")
            .EnumerateArray()
            .Select(e => e.GetProperty("id").GetString()!)
            .ToList();

    private static readonly FrozenSet<string> ShapeSet = Shapes.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> NodeTypeSet = NodeTypes.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> AnchorSet = Anchors.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> EdgeRouteSet = EdgeRoutes.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> ArrowHeadSet = ArrowHeads.ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> AzureIconSet = AzureIcons.ToFrozenSet(StringComparer.Ordinal);

    public static bool IsShape(string value) => ShapeSet.Contains(value);

    public static bool IsNodeType(string value) => NodeTypeSet.Contains(value);

    public static bool IsAnchor(string value) => AnchorSet.Contains(value);

    public static bool IsEdgeRoute(string value) => EdgeRouteSet.Contains(value);

    public static bool IsArrowHead(string value) => ArrowHeadSet.Contains(value);

    public static bool IsAzureIcon(string value) => AzureIconSet.Contains(value);

    /// <summary>Default w/h for a shape, or the generic node size when unknown.</summary>
    public static (double W, double H) DefaultSize(string? shape)
    {
        if (!string.IsNullOrWhiteSpace(shape))
        {
            foreach (var s in Root.GetProperty("shapes").EnumerateArray())
            {
                if (s.GetProperty("id").GetString() == shape)
                {
                    return (s.GetProperty("w").GetDouble(), s.GetProperty("h").GetDouble());
                }
            }
        }

        return (140, 72);
    }

    /// <summary>Legacy <c>type</c> sizes, matching <c>defaultSize()</c> in beeModel.ts.</summary>
    public static (double W, double H) DefaultTypeSize(string type) => type switch
    {
        "person" => (120, 100),
        "database" => (120, 90),
        "note" => (160, 100),
        "system" => (160, 80),
        "image" => (220, 160),
        _ => (140, 72),
    };

    /// <summary>Azure stencils, optionally narrowed by category and/or free text.</summary>
    public static IEnumerable<JsonElement> FindAzureIcons(string? category, string? query)
    {
        foreach (var icon in Root.GetProperty("azure").GetProperty("icons").EnumerateArray())
        {
            if (!string.IsNullOrWhiteSpace(category)
                && !string.Equals(icon.GetProperty("category").GetString(), category, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(query))
            {
                var hay = string.Join(
                    ' ',
                    icon.GetProperty("id").GetString(),
                    icon.GetProperty("label").GetString(),
                    icon.TryGetProperty("keywords", out var k) ? k.GetString() : null);
                var terms = query.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (!terms.All(t => hay.Contains(t, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }
            }

            yield return icon;
        }
    }

    /// <summary>"a, b, c" of at most <paramref name="max"/> values, for error messages.</summary>
    public static string Sample(IEnumerable<string> values, int max = 24)
    {
        var list = values.ToList();
        var head = string.Join(", ", list.Take(max));
        return list.Count > max ? $"{head}, … ({list.Count} total)" : head;
    }

    private static JsonDocument Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException(
                $"Embedded resource {ResourceName} is missing. Run `pnpm --dir src/beedocs-web gen:catalog`.");
        return JsonDocument.Parse(stream);
    }

    private static List<string> Strings(string property) =>
        Document.Value.RootElement.GetProperty(property)
            .EnumerateArray()
            .Select(e => e.GetString()!)
            .ToList();

    private static List<string> Ids(string property) =>
        Document.Value.RootElement.GetProperty(property)
            .EnumerateArray()
            .Select(e => e.GetProperty("id").GetString()!)
            .ToList();
}
