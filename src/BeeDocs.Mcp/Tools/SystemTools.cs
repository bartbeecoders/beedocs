using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class SystemTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_health", Title = "Health check"),
     Description("Check whether the BeeDocs API is reachable and healthy.")]
    public Task<string> Health(CancellationToken ct) => ToolHelpers.RunAsync(async () =>
    {
        var h = await client.HealthAsync(ct);
        var payload = new Dictionary<string, object?>
        {
            ["ok"] = true,
            ["api"] = client.BaseUrl,
        };
        foreach (var prop in h.EnumerateObject())
        {
            payload[prop.Name] = prop.Value.Clone();
        }

        return ToolHelpers.Json(payload);
    });

    [McpServerTool(Name = "beedocs_get_api_info", Title = "API info"),
     Description("Return the configured BeeDocs API base URL and a summary of available entity types and workflows for agents.")]
    public string GetApiInfo() => ToolHelpers.Json(new
    {
        apiBaseUrl = client.BaseUrl,
        entities = new[] { "book", "chapter (folder)", "page", "diagram", "upload" },
        diagramKinds = new[] { "beediagram", "mermaid", "c4", "plantuml" },
        beediagramNodeTypes = new[] { "box", "person", "system", "database", "note", "image" },
        beediagramEdgeRoutes = new[] { "straight", "curved", "orthogonal" },
        beediagramSourceShape = new
        {
            version = 1,
            nodes = new[]
            {
                new
                {
                    id = "n1",
                    type = "box|person|system|database|note|image",
                    label = "string",
                    x = 0,
                    y = 0,
                    w = 140,
                    h = 72,
                    color = "#hex optional",
                    imageUrl = "optional for type=image",
                },
            },
            edges = new[]
            {
                new
                {
                    id = "e1",
                    from = "n1",
                    to = "n2",
                    label = "optional",
                    fromAnchor = "n|e|s|w",
                    toAnchor = "n|e|s|w",
                    route = "straight|curved|orthogonal",
                    waypoints = "optional [{x,y}] for orthogonal bends",
                },
            },
            viewport = new { x = 0, y = 0, zoom = 1 },
        },
        markdownEmbeds = new
        {
            mermaid = "```mermaid\\n...\\n```",
            beediagramRef = "```beediagram-ref\\nDIAGRAM_ID\\n```",
            beediagramInline = "```beediagram\\n{json}\\n```",
            image = "![alt](/uploads/...)",
        },
        capabilities = new
        {
            folders = "chapters group pages; beedocs_create_chapter / update / delete / move_page",
            images = "beedocs_upload_image then embed Markdown or image nodes",
            export = "beedocs_export_book or beedocs_export_library_snapshot",
        },
        suggestedWorkflow = new[]
        {
            "beedocs_list_books → pick or beedocs_create_book",
            "beedocs_create_chapter for folders, beedocs_create_page with chapterId",
            "beedocs_create_diagram / beedocs_create_beediagram_with_nodes",
            "beedocs_embed_diagram_in_page or beedocs_upload_image + append",
            "beedocs_export_book for structured content / UI Export PDF for print",
        },
    });
}
