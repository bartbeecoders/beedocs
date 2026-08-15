using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class DiagramTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_list_diagrams", Title = "List diagrams in book"),
     Description("List diagram summaries for a book.")]
    public Task<string> ListDiagrams(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListDiagramsAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_list_page_diagrams", Title = "List diagrams linked to page"),
     Description("List diagrams that have pageId set to the given page.")]
    public Task<string> ListPageDiagrams(string pageId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListPageDiagramsAsync(pageId, ct)));

    [McpServerTool(Name = "beedocs_get_diagram", Title = "Get diagram"),
     Description("Get a diagram including full source (JSON for beediagram, text for mermaid/c4).")]
    public Task<string> GetDiagram(string diagramId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetDiagramAsync(diagramId, ct)));

    [McpServerTool(Name = "beedocs_create_diagram", Title = "Create diagram"),
     Description("Create a diagram in a book. kind: beediagram (JSON canvas), isometric (tile-grid JSON — see beedocs_get_api_info), mermaid, c4, or plantuml. For beediagram, source is JSON with nodes/edges; for isometric, JSON with items/connectors/zones/texts.")]
    public Task<string> CreateDiagram(
        string bookId,
        string title,
        [Description("Default beediagram")] string? kind = null,
        [Description("Diagram payload (JSON string for beediagram/isometric, text for mermaid/c4)")] string? source = null,
        [Description("Optional page to attach the diagram to")] string? pageId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var k = string.IsNullOrWhiteSpace(kind) ? "beediagram" : kind;
            var src = source ?? k switch
            {
                "beediagram" => ToolHelpers.EmptyBeeDiagram,
                "isometric" => ToolHelpers.EmptyIsometric,
                "mermaid" or "c4" => "graph TD\n  A[Start] --> B[End]",
                _ => "",
            };
            return ToolHelpers.Json(await client.CreateDiagramAsync(
                bookId,
                new { title, kind = k, source = src, pageId },
                ct));
        });

    [McpServerTool(Name = "beedocs_update_diagram", Title = "Update diagram"),
     Description("Update diagram title, kind, source, or linked pageId.")]
    public Task<string> UpdateDiagram(
        string diagramId,
        string title,
        string? kind = null,
        string? source = null,
        string? pageId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.UpdateDiagramAsync(
                diagramId,
                new { title, kind, source, pageId },
                ct)));

    [McpServerTool(Name = "beedocs_delete_diagram", Title = "Delete diagram", Destructive = true),
     Description("Permanently delete a diagram by id.")]
    public Task<string> DeleteDiagram(string diagramId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteDiagramAsync(diagramId, ct);
            return ToolHelpers.Json(new { deleted = true, diagramId });
        });

    [McpServerTool(Name = "beedocs_list_diagram_shapes", Title = "List BeeDiagram shapes", ReadOnly = true),
     Description("The BeeDiagram shape catalog: every studio shape, the Azure service stencils (AKS, App Service, SQL Database, Table Storage, …), palette groups, connection anchors, edge routes and arrow heads. Call this before building a diagram to see what shape/icon values are valid.")]
    public string ListDiagramShapes(
        [Description("Section to return: all (default), shapes, azure, palette, connections")]
        string? section = null,
        [Description("Azure category filter, e.g. compute, containers, storage, databases, networking, integration, identity, analytics, management")]
        string? azureCategory = null,
        [Description("Free-text filter over Azure stencil id/label/keywords, e.g. \"kubernetes\" or \"sql\"")]
        string? query = null)
    {
        var root = DiagramCatalog.Root;
        const string azureUsage = "Set shape=\"azure\" and icon=\"<id>\" on a node; the label renders under the stencil.";
        var filtering = !string.IsNullOrWhiteSpace(azureCategory) || !string.IsNullOrWhiteSpace(query);

        // Unfiltered, the category list is worth having; once the caller has
        // narrowed it down, repeating all eleven is just noise.
        object azure = filtering
            ? new
            {
                icons = DiagramCatalog.FindAzureIcons(azureCategory, query).ToList(),
                total = DiagramCatalog.AzureIcons.Count,
                usage = azureUsage,
            }
            : new
            {
                categories = root.GetProperty("azure").GetProperty("categories"),
                icons = root.GetProperty("azure").GetProperty("icons"),
                usage = azureUsage,
            };

        return (section?.ToLowerInvariant()) switch
        {
            "shapes" => ToolHelpers.Json(new
            {
                nodeTypes = root.GetProperty("nodeTypes"),
                shapes = root.GetProperty("shapes"),
            }),
            "azure" => ToolHelpers.Json(azure),
            "palette" => ToolHelpers.Json(new { palette = root.GetProperty("palette") }),
            "connections" => ToolHelpers.Json(new
            {
                anchors = root.GetProperty("anchors"),
                edgeRoutes = root.GetProperty("edgeRoutes"),
                arrowHeads = root.GetProperty("arrowHeads"),
            }),
            _ => ToolHelpers.Json(new
            {
                version = root.GetProperty("version"),
                nodeTypes = root.GetProperty("nodeTypes"),
                shapes = root.GetProperty("shapes"),
                azure,
                palette = root.GetProperty("palette"),
                anchors = root.GetProperty("anchors"),
                edgeRoutes = root.GetProperty("edgeRoutes"),
                arrowHeads = root.GetProperty("arrowHeads"),
                notes = new[]
                {
                    "A node uses either shape (studio catalog) or type (classic look). shape wins when both are set.",
                    "shape=azure requires icon; shape=image requires imageUrl.",
                    "Shapes with two fill slots honour style.fill2 (container header/body, cube front/top, cylinder body/top).",
                    "shape=container groups other nodes: set parentId on each child. Children keep absolute x/y.",
                },
            }),
        };
    }

    [McpServerTool(Name = "beedocs_create_beediagram_with_nodes", Title = "Create BeeDiagram from nodes/edges"),
     Description("Create a beediagram with structured nodes and edges (agent-friendly). Supports the full studio model: catalog shapes, Azure stencils (shape=azure + icon), per-node style, rotation and container nesting. Call beedocs_list_diagram_shapes for valid shape/icon values. Returns the created diagram including id for embeds.")]
    public Task<string> CreateBeeDiagramWithNodes(
        string bookId,
        string title,
        [Description("Nodes to place on the canvas")] List<BeeNodeInput> nodes,
        string? pageId = null,
        [Description("Connections between nodes (use node ids)")] List<BeeEdgeInput>? edges = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildBeeDiagramSource(nodes, edges);
            var created = await client.CreateDiagramAsync(
                bookId,
                new { title, kind = "beediagram", source, pageId },
                ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                diagram = created,
                embedMarkdown = string.IsNullOrEmpty(id) ? null : $"```beediagram-ref\n{id}\n```",
            });
        });

    [McpServerTool(Name = "beedocs_update_beediagram_nodes", Title = "Replace BeeDiagram nodes/edges"),
     Description("Replace an existing beediagram's canvas with structured nodes and edges, using the same model as beedocs_create_beediagram_with_nodes. Title and page link are left alone unless given.")]
    public Task<string> UpdateBeeDiagramNodes(
        string diagramId,
        [Description("Nodes to place on the canvas — replaces the existing ones")] List<BeeNodeInput> nodes,
        [Description("Connections between nodes (use node ids)")] List<BeeEdgeInput>? edges = null,
        [Description("Leave unset to keep the current title")] string? title = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetDiagramAsync(diagramId, ct);
            var kind = BeeDocsApiClient.Prop(existing, "kind");
            if (kind != "beediagram")
            {
                throw new ModelContextProtocol.McpException(
                    $"Diagram {diagramId} is kind={kind}; this tool only edits beediagram canvases. Use beedocs_update_diagram for text-based kinds.");
            }

            var source = BuildBeeDiagramSource(nodes, edges);
            return ToolHelpers.Json(await client.UpdateDiagramAsync(
                diagramId,
                new
                {
                    title = string.IsNullOrWhiteSpace(title) ? BeeDocsApiClient.Prop(existing, "title") : title,
                    kind = "beediagram",
                    source,
                    pageId = BeeDocsApiClient.PropStringOrNull(existing, "pageId"),
                },
                ct));
        });

    /// <summary>
    /// Validate and serialise structured nodes/edges into BeeDiagram JSON.
    /// Shared by create and update so both accept exactly the same model.
    /// </summary>
    private static string BuildBeeDiagramSource(List<BeeNodeInput> nodes, List<BeeEdgeInput>? edges)
    {
        var mappedNodes = nodes.Select((n, i) =>
        {
            var id = string.IsNullOrWhiteSpace(n.Id) ? $"n{i + 1}" : n.Id!;
            var shape = Blank(n.Shape);
            var icon = Blank(n.Icon);

            if (shape is not null && !DiagramCatalog.IsShape(shape))
            {
                throw new ModelContextProtocol.McpException(
                    $"Node {id}: unknown shape \"{shape}\". Valid shapes: {DiagramCatalog.Sample(DiagramCatalog.Shapes)}. " +
                    "Call beedocs_list_diagram_shapes for the full catalog.");
            }

            if (icon is not null && !DiagramCatalog.IsAzureIcon(icon))
            {
                throw new ModelContextProtocol.McpException(
                    $"Node {id}: unknown Azure stencil \"{icon}\". " +
                    "Call beedocs_list_diagram_shapes with section=\"azure\" (optionally a query) for valid ids.");
            }

            if (shape == "azure" && icon is null)
            {
                throw new ModelContextProtocol.McpException(
                    $"Node {id}: shape=\"azure\" needs an icon id (e.g. aks, app-service, sql-database, table-storage). " +
                    "Call beedocs_list_diagram_shapes with section=\"azure\".");
            }

            if (icon is not null && shape is null)
            {
                shape = "azure";
            }

            // Classic `type` still drives the look when no catalog shape is given,
            // and stays on the node either way so older editors keep working.
            var type = Blank(n.Type) ?? (shape == "image" ? "image" : "box");
            if (!DiagramCatalog.IsNodeType(type))
            {
                throw new ModelContextProtocol.McpException(
                    $"Node {id}: unknown type \"{type}\". Valid types: {DiagramCatalog.Sample(DiagramCatalog.NodeTypes)}.");
            }

            var (dw, dh) = shape is not null
                ? DiagramCatalog.DefaultSize(shape)
                : DiagramCatalog.DefaultTypeSize(type);

            return new
            {
                id,
                type,
                shape,
                icon,
                label = n.Label,
                x = n.X ?? 40 + (i % 4) * 200,
                y = n.Y ?? 40 + (i / 4) * 140,
                w = n.W ?? dw,
                h = n.H ?? dh,
                color = n.Color,
                imageUrl = n.ImageUrl,
                rotation = n.Rotation,
                parentId = Blank(n.ParentId),
                style = n.Style?.ToJson(),
            };
        }).ToList();

        var idSet = mappedNodes.Select(n => n.id).ToHashSet(StringComparer.Ordinal);

        foreach (var n in mappedNodes)
        {
            if (n.parentId is not null && !idSet.Contains(n.parentId))
            {
                throw new ModelContextProtocol.McpException(
                    $"Node {n.id}: parentId \"{n.parentId}\" is not one of the nodes. Known: {string.Join(", ", idSet)}");
            }
        }

        var mappedEdges = (edges ?? []).Select((e, i) =>
        {
            var id = string.IsNullOrWhiteSpace(e.Id) ? $"e{i + 1}" : e.Id!;
            var route = Blank(e.Route);
            if (route is not null && !DiagramCatalog.IsEdgeRoute(route))
            {
                throw new ModelContextProtocol.McpException(
                    $"Edge {id}: unknown route \"{route}\". Valid: {DiagramCatalog.Sample(DiagramCatalog.EdgeRoutes)}.");
            }

            foreach (var (name, anchor) in new[] { ("fromAnchor", Blank(e.FromAnchor)), ("toAnchor", Blank(e.ToAnchor)) })
            {
                if (anchor is not null && !DiagramCatalog.IsAnchor(anchor))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Edge {id}: unknown {name} \"{anchor}\". Valid: {DiagramCatalog.Sample(DiagramCatalog.Anchors)}.");
                }
            }

            return new
            {
                id,
                from = e.From,
                to = e.To,
                label = e.Label,
                fromAnchor = Blank(e.FromAnchor),
                toAnchor = Blank(e.ToAnchor),
                route,
                waypoints = e.Waypoints,
                style = e.Style?.ToJson(id),
            };
        }).ToList();

        foreach (var e in mappedEdges)
        {
            if (!idSet.Contains(e.from) || !idSet.Contains(e.to))
            {
                throw new ModelContextProtocol.McpException(
                    $"Edge {e.id} references unknown node (from={e.from}, to={e.to}). Known: {string.Join(", ", idSet)}");
            }
        }

        return JsonSerializer.Serialize(
            new
            {
                version = 1,
                nodes = mappedNodes,
                edges = mappedEdges,
                viewport = new { x = 0, y = 0, zoom = 1 },
            },
            SourceJson);
    }

    /// <summary>Omit unset members so the stored canvas matches what the editor writes.</summary>
    private static readonly JsonSerializerOptions SourceJson = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    [McpServerTool(Name = "beedocs_embed_diagram_in_page", Title = "Embed diagram in page"),
     Description("Append a beediagram-ref (or mermaid fence for mermaid/c4 diagrams) to a page so it renders in the UI.")]
    public Task<string> EmbedDiagramInPage(
        string pageId,
        string diagramId,
        [Description("Optional Markdown heading before the embed (e.g. \"## Architecture\")")]
        string? heading = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var diagram = await client.GetDiagramAsync(diagramId, ct);
            var page = await client.GetPageAsync(pageId, ct);
            var kind = BeeDocsApiClient.Prop(diagram, "kind");
            var source = BeeDocsApiClient.Prop(diagram, "source");
            var block = kind switch
            {
                "beediagram" => $"```beediagram-ref\n{diagramId}\n```",
                "isometric" => $"```isometric-ref\n{diagramId}\n```",
                "mermaid" or "c4" => $"```mermaid\n{source}\n```",
                _ => $"```{kind}\n{source}\n```",
            };

            var existing = BeeDocsApiClient.Prop(page, "content").TrimEnd();
            var content = string.Concat(
                string.IsNullOrEmpty(existing) ? "" : existing,
                string.IsNullOrEmpty(heading) ? "\n\n" : $"\n\n{heading}\n\n",
                block,
                "\n");

            return ToolHelpers.Json(await client.UpdatePageAsync(
                pageId,
                BeeDocsApiClient.BuildPageUpdate(
                    BeeDocsApiClient.Prop(page, "title"),
                    content,
                    BeeDocsApiClient.PropStringOrNull(page, "slug"),
                    BeeDocsApiClient.PropStringOrNull(page, "chapterId"),
                    chapterIdSpecified: true),
                ct));
        });
}

public sealed class BeeNodeInput
{
    [Description("Stable id used by edges and parentId; auto-assigned (n1, n2, …) when omitted")]
    public string? Id { get; set; }

    [Description("Classic look when no shape is given: box | person | system | database | note | image")]
    public string? Type { get; set; }

    [Description("Studio catalog shape (rectangle, cylinder, hexagon, container, azure, …). Wins over type. See beedocs_list_diagram_shapes.")]
    public string? Shape { get; set; }

    [Description("Azure stencil id for shape=azure, e.g. aks, app-service, sql-database, table-storage. Setting it implies shape=azure.")]
    public string? Icon { get; set; }

    public string Label { get; set; } = "";
    public double? X { get; set; }
    public double? Y { get; set; }

    [Description("Defaults to the shape's natural size")]
    public double? W { get; set; }

    [Description("Defaults to the shape's natural size")]
    public double? H { get; set; }

    [Description("Classic fill colour; prefer style.fill for catalog shapes")]
    public string? Color { get; set; }

    [Description("For type/shape=image")]
    public string? ImageUrl { get; set; }

    [Description("Rotation in degrees around the shape centre")]
    public double? Rotation { get; set; }

    [Description("Id of the shape=container node this node sits in. Coordinates stay absolute.")]
    public string? ParentId { get; set; }

    [Description("Appearance overrides (fill, stroke, font, alignment)")]
    public BeeNodeStyleInput? Style { get; set; }
}

public sealed class BeeNodeStyleInput
{
    [Description("Primary fill, #rrggbb or \"none\"")]
    public string? Fill { get; set; }

    [Description("Secondary fill for two-part shapes: container body, cube top/side, cylinder top, note fold")]
    public string? Fill2 { get; set; }

    public string? Stroke { get; set; }
    public double? StrokeWidth { get; set; }
    public bool? Dashed { get; set; }

    [Description("0–100")]
    public double? Opacity { get; set; }

    public bool? Shadow { get; set; }
    public double? FontSize { get; set; }
    public string? FontColor { get; set; }
    public bool? Bold { get; set; }
    public bool? Italic { get; set; }

    [Description("left | center | right")]
    public string? Align { get; set; }

    [Description("top | middle | bottom")]
    public string? Valign { get; set; }

    /// <summary>Drop unset members so the renderer keeps its per-shape defaults.</summary>
    internal object? ToJson()
    {
        var map = new Dictionary<string, object?>();
        Add(map, "fill", Fill);
        Add(map, "fill2", Fill2);
        Add(map, "stroke", Stroke);
        Add(map, "strokeWidth", StrokeWidth);
        Add(map, "dashed", Dashed);
        Add(map, "opacity", Opacity);
        Add(map, "shadow", Shadow);
        Add(map, "fontSize", FontSize);
        Add(map, "fontColor", FontColor);
        Add(map, "bold", Bold);
        Add(map, "italic", Italic);
        Add(map, "align", Enum(Align, ["left", "center", "right"], "align"));
        Add(map, "valign", Enum(Valign, ["top", "middle", "bottom"], "valign"));
        return map.Count == 0 ? null : map;
    }

    internal static void Add(Dictionary<string, object?> map, string key, object? value)
    {
        if (value is null) return;
        if (value is string s && string.IsNullOrWhiteSpace(s)) return;
        map[key] = value;
    }

    internal static string? Enum(string? value, string[] allowed, string field)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var v = value.Trim().ToLowerInvariant();
        if (!allowed.Contains(v))
        {
            throw new ModelContextProtocol.McpException(
                $"style.{field}: \"{value}\" is not valid. Use one of: {string.Join(", ", allowed)}.");
        }

        return v;
    }
}

public sealed class BeeEdgeInput
{
    public string? Id { get; set; }
    [Description("Source node id")]
    public string From { get; set; } = "";
    [Description("Target node id")]
    public string To { get; set; } = "";
    public string? Label { get; set; }

    [Description("Fixed connection point: n|e|s|w, corners ne|se|sw|nw, or quarter points n1|n2|e1|e2|s1|s2|w1|w2. Omit to auto-pick.")]
    public string? FromAnchor { get; set; }

    [Description("Fixed connection point on the target; omit to auto-pick")]
    public string? ToAnchor { get; set; }

    [Description("straight | curved | orthogonal")]
    public string? Route { get; set; }

    [Description("Orthogonal bend points")]
    public List<BeePointInput>? Waypoints { get; set; }

    [Description("Line appearance and arrow heads")]
    public BeeEdgeStyleInput? Style { get; set; }
}

public sealed class BeeEdgeStyleInput
{
    public string? Stroke { get; set; }
    public double? StrokeWidth { get; set; }
    public bool? Dashed { get; set; }

    [Description("none | arrow | open | diamond | circle")]
    public string? StartArrow { get; set; }

    [Description("none | arrow | open | diamond | circle (default arrow)")]
    public string? EndArrow { get; set; }

    public double? FontSize { get; set; }
    public string? FontColor { get; set; }

    internal object? ToJson(string edgeId)
    {
        var map = new Dictionary<string, object?>();
        BeeNodeStyleInput.Add(map, "stroke", Stroke);
        BeeNodeStyleInput.Add(map, "strokeWidth", StrokeWidth);
        BeeNodeStyleInput.Add(map, "dashed", Dashed);
        BeeNodeStyleInput.Add(map, "startArrow", Arrow(StartArrow, edgeId, "startArrow"));
        BeeNodeStyleInput.Add(map, "endArrow", Arrow(EndArrow, edgeId, "endArrow"));
        BeeNodeStyleInput.Add(map, "fontSize", FontSize);
        BeeNodeStyleInput.Add(map, "fontColor", FontColor);
        return map.Count == 0 ? null : map;
    }

    private static string? Arrow(string? value, string edgeId, string field)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var v = value.Trim();
        if (!DiagramCatalog.IsArrowHead(v))
        {
            throw new ModelContextProtocol.McpException(
                $"Edge {edgeId}: unknown style.{field} \"{value}\". Valid: {DiagramCatalog.Sample(DiagramCatalog.ArrowHeads)}.");
        }

        return v;
    }
}

public sealed class BeePointInput
{
    public double X { get; set; }
    public double Y { get; set; }
}
