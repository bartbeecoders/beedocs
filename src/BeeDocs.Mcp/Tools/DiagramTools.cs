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
     Description("Create a diagram in a book. kind: beediagram (JSON canvas), mermaid, c4, or plantuml. For beediagram, source is JSON with nodes/edges.")]
    public Task<string> CreateDiagram(
        string bookId,
        string title,
        [Description("Default beediagram")] string? kind = null,
        [Description("Diagram payload (JSON string for beediagram, text for mermaid/c4)")] string? source = null,
        [Description("Optional page to attach the diagram to")] string? pageId = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var k = string.IsNullOrWhiteSpace(kind) ? "beediagram" : kind;
            var src = source ?? k switch
            {
                "beediagram" => ToolHelpers.EmptyBeeDiagram,
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

    [McpServerTool(Name = "beedocs_create_beediagram_with_nodes", Title = "Create BeeDiagram from nodes/edges"),
     Description("Create a beediagram with structured nodes and edges (agent-friendly). Returns the created diagram including id for embeds.")]
    public Task<string> CreateBeeDiagramWithNodes(
        string bookId,
        string title,
        [Description("Nodes to place on the canvas")] List<BeeNodeInput> nodes,
        string? pageId = null,
        [Description("Connections between nodes (use node ids)")] List<BeeEdgeInput>? edges = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var mappedNodes = nodes.Select((n, i) =>
            {
                var id = string.IsNullOrWhiteSpace(n.Id) ? $"n{i + 1}" : n.Id!;
                var type = string.IsNullOrWhiteSpace(n.Type) ? "box" : n.Type!;
                var (dw, dh) = type switch
                {
                    "person" => (120, 100),
                    "database" => (120, 90),
                    "note" => (160, 100),
                    "system" => (160, 80),
                    "image" => (220, 160),
                    _ => (140, 72),
                };
                return new
                {
                    id,
                    type,
                    label = n.Label,
                    x = n.X ?? 40 + (i % 4) * 200,
                    y = n.Y ?? 40 + (i / 4) * 140,
                    w = n.W ?? dw,
                    h = n.H ?? dh,
                    color = n.Color,
                    imageUrl = n.ImageUrl,
                };
            }).ToList();

            var idSet = mappedNodes.Select(n => n.id).ToHashSet(StringComparer.Ordinal);
            var mappedEdges = (edges ?? []).Select((e, i) => new
            {
                id = string.IsNullOrWhiteSpace(e.Id) ? $"e{i + 1}" : e.Id!,
                from = e.From,
                to = e.To,
                label = e.Label,
                fromAnchor = e.FromAnchor,
                toAnchor = e.ToAnchor,
                route = e.Route,
                waypoints = e.Waypoints,
            }).ToList();

            foreach (var e in mappedEdges)
            {
                if (!idSet.Contains(e.from) || !idSet.Contains(e.to))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Edge {e.id} references unknown node (from={e.from}, to={e.to}). Known: {string.Join(", ", idSet)}");
                }
            }

            var source = JsonSerializer.Serialize(new
            {
                version = 1,
                nodes = mappedNodes,
                edges = mappedEdges,
                viewport = new { x = 0, y = 0, zoom = 1 },
            });

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
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string Label { get; set; } = "";
    public double? X { get; set; }
    public double? Y { get; set; }
    public double? W { get; set; }
    public double? H { get; set; }
    public string? Color { get; set; }
    [Description("For type=image")]
    public string? ImageUrl { get; set; }
}

public sealed class BeeEdgeInput
{
    public string? Id { get; set; }
    [Description("Source node id")]
    public string From { get; set; } = "";
    [Description("Target node id")]
    public string To { get; set; } = "";
    public string? Label { get; set; }
    public string? FromAnchor { get; set; }
    public string? ToAnchor { get; set; }
    public string? Route { get; set; }
    [Description("Orthogonal bend points")]
    public List<BeePointInput>? Waypoints { get; set; }
}

public sealed class BeePointInput
{
    public double X { get; set; }
    public double Y { get; set; }
}
