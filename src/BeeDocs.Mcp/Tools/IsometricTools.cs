using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// The isometric shape ids, mirroring src/beedocs-web/src/isometric/isoShapes.ts.
/// Keep the two lists in sync when a shape is added to the web editor.
/// </summary>
internal static class IsometricCatalog
{
    public static readonly string[] Shapes =
    [
        "block", "platform", "server", "server-rack", "vm", "lambda",
        "database", "storage", "queue", "cache",
        "cloud", "globe", "router", "switch", "firewall", "load-balancer",
        "user", "users", "building", "laptop", "desktop", "mobile", "lock", "gear",
    ];

    private static readonly HashSet<string> ShapeSet = new(Shapes, StringComparer.Ordinal);

    public static bool IsShape(string id) => ShapeSet.Contains(id);
}

[McpServerToolType]
public sealed class IsometricTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_create_isometric_with_items", Title = "Create isometric diagram from items"),
     Description("Create an isometric (2:1 dimetric tile-grid) diagram with structured items, connectors, zones and texts — the agent-friendly way to build kind=isometric. Items sit one per integer tile (x to the lower-right, y to the lower-left); omit x/y to auto-place on a spread grid. Returns the created diagram including id for embeds.")]
    public Task<string> CreateIsometricWithItems(
        string bookId,
        string title,
        [Description("Items to place, one per tile")] List<IsoItemInput> items,
        [Description("Arrows between items (use item ids)")] List<IsoConnectorInput>? connectors = null,
        [Description("Coloured floor rectangles behind the items")] List<IsoZoneInput>? zones = null,
        [Description("Free-standing text labels")] List<IsoTextInput>? texts = null,
        [Description("Optional page to attach the diagram to")] string? pageId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildIsometricSource(items, connectors, zones, texts);
            var created = await client.CreateDiagramAsync(
                bookId,
                new { title, kind = "isometric", source, pageId },
                ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                diagram = created,
                embedMarkdown = string.IsNullOrEmpty(id) ? null : $"```isometric-ref\n{id}\n```",
            });
        });

    [McpServerTool(Name = "beedocs_update_isometric_items", Title = "Replace isometric diagram items"),
     Description("Replace an existing isometric diagram's content with structured items/connectors/zones/texts, using the same model as beedocs_create_isometric_with_items. Title and page link are left alone unless given.")]
    public Task<string> UpdateIsometricItems(
        string diagramId,
        [Description("Items to place — replaces the existing ones")] List<IsoItemInput> items,
        [Description("Arrows between items (use item ids)")] List<IsoConnectorInput>? connectors = null,
        [Description("Coloured floor rectangles behind the items")] List<IsoZoneInput>? zones = null,
        [Description("Free-standing text labels")] List<IsoTextInput>? texts = null,
        [Description("Leave unset to keep the current title")] string? title = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetDiagramAsync(diagramId, ct);
            var kind = BeeDocsApiClient.Prop(existing, "kind");
            if (kind != "isometric")
            {
                throw new McpException(
                    $"Diagram {diagramId} is kind={kind}; this tool only edits isometric diagrams. " +
                    "Use beedocs_update_beediagram_nodes for beediagram, beedocs_update_diagram otherwise.");
            }

            var source = BuildIsometricSource(items, connectors, zones, texts);
            return ToolHelpers.Json(await client.UpdateDiagramAsync(
                diagramId,
                new
                {
                    title = string.IsNullOrWhiteSpace(title) ? BeeDocsApiClient.Prop(existing, "title") : title,
                    kind = "isometric",
                    source,
                    pageId = BeeDocsApiClient.PropStringOrNull(existing, "pageId"),
                },
                ct));
        });

    /// <summary>
    /// Validate and serialise the structured inputs into the isometric JSON
    /// document. Shared by create and update so both accept the same model.
    /// </summary>
    private static string BuildIsometricSource(
        List<IsoItemInput> items,
        List<IsoConnectorInput>? connectors,
        List<IsoZoneInput>? zones,
        List<IsoTextInput>? texts)
    {
        var mappedItems = items.Select((n, i) =>
        {
            var id = string.IsNullOrWhiteSpace(n.Id) ? $"i{i + 1}" : n.Id!.Trim();
            var shape = (n.Shape ?? "").Trim();
            if (!IsometricCatalog.IsShape(shape))
            {
                throw new McpException(
                    $"Item {id}: unknown shape \"{n.Shape}\". Valid shapes: {string.Join(", ", IsometricCatalog.Shapes)}.");
            }

            return new
            {
                id,
                // Auto-placement spreads omitted coordinates on a 3-tile grid
                // so a quick sketch never stacks everything on one tile.
                x = n.X ?? (i % 4) * 3,
                y = n.Y ?? (i / 4) * 3,
                shape,
                label = Blank(n.Label),
                color = Blank(n.Color),
            };
        }).ToList();

        var idSet = mappedItems.Select(x => x.id).ToHashSet(StringComparer.Ordinal);
        if (idSet.Count != mappedItems.Count)
        {
            throw new McpException("Item ids must be unique.");
        }

        var mappedConnectors = (connectors ?? []).Select((c, i) =>
        {
            var id = string.IsNullOrWhiteSpace(c.Id) ? $"c{i + 1}" : c.Id!.Trim();
            if (!idSet.Contains(c.From) || !idSet.Contains(c.To))
            {
                throw new McpException(
                    $"Connector {id} references unknown item (from={c.From}, to={c.To}). Known: {string.Join(", ", idSet)}");
            }

            return new
            {
                id,
                from = c.From,
                to = c.To,
                label = Blank(c.Label),
                color = Blank(c.Color),
                dashed = c.Dashed == true ? (bool?)true : null,
            };
        }).ToList();

        var mappedZones = (zones ?? []).Select((z, i) => new
        {
            id = string.IsNullOrWhiteSpace(z.Id) ? $"z{i + 1}" : z.Id!.Trim(),
            x1 = Math.Min(z.X1, z.X2),
            y1 = Math.Min(z.Y1, z.Y2),
            x2 = Math.Max(z.X1, z.X2),
            y2 = Math.Max(z.Y1, z.Y2),
            label = Blank(z.Label),
            color = Blank(z.Color),
        }).ToList();

        var mappedTexts = (texts ?? []).Select((t, i) => new
        {
            id = string.IsNullOrWhiteSpace(t.Id) ? $"t{i + 1}" : t.Id!.Trim(),
            x = t.X,
            y = t.Y,
            text = t.Text ?? "",
        }).ToList();

        return JsonSerializer.Serialize(
            new
            {
                version = 1,
                items = mappedItems,
                connectors = mappedConnectors,
                zones = mappedZones,
                texts = mappedTexts,
                viewport = new { x = 0, y = 0, zoom = 1 },
            },
            SourceJson);
    }

    /// <summary>Omit unset members so the stored document matches what the editor writes.</summary>
    private static readonly JsonSerializerOptions SourceJson = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed class IsoItemInput
{
    [Description("Stable id used by connectors; auto-assigned (i1, i2, …) when omitted")]
    public string? Id { get; set; }

    [Description("Shape id — see beedocs_get_api_info → isometric.shapes (server, database, cloud, user, …)")]
    public string Shape { get; set; } = "block";

    [Description("Tile column (x runs to the lower-right on screen). Omit both x and y to auto-place.")]
    public int? X { get; set; }

    [Description("Tile row (y runs to the lower-left on screen)")]
    public int? Y { get; set; }

    [Description("Label rendered under the shape")]
    public string? Label { get; set; }

    [Description("Base #hex colour; the three face shades are derived from it")]
    public string? Color { get; set; }
}

public sealed class IsoConnectorInput
{
    public string? Id { get; set; }

    [Description("Source item id")]
    public string From { get; set; } = "";

    [Description("Target item id (the arrow head ends here)")]
    public string To { get; set; } = "";

    [Description("Label rendered on the line")]
    public string? Label { get; set; }

    [Description("#hex line colour")]
    public string? Color { get; set; }

    public bool? Dashed { get; set; }
}

public sealed class IsoZoneInput
{
    public string? Id { get; set; }

    [Description("First corner tile, inclusive")]
    public int X1 { get; set; }

    public int Y1 { get; set; }

    [Description("Opposite corner tile, inclusive")]
    public int X2 { get; set; }

    public int Y2 { get; set; }

    [Description("Zone name rendered at the top corner")]
    public string? Label { get; set; }

    [Description("#hex tint and outline colour")]
    public string? Color { get; set; }
}

public sealed class IsoTextInput
{
    public string? Id { get; set; }

    [Description("Tile column the text is centred on")]
    public int X { get; set; }

    public int Y { get; set; }

    public string Text { get; set; } = "";
}
