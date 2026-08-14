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
        entities = new[] { "shelf", "book", "chapter (folder)", "page", "diagram", "slide deck", "upload" },
        hierarchy = "shelf → book → chapter (folder) → page. Only the book level is required: "
            + "a book sits on at most one shelf, and an unshelved book sits at the library root.",
        diagramKinds = new[] { "beediagram", "mermaid", "c4", "plantuml" },
        beediagramNodeTypes = DiagramCatalog.NodeTypes,
        beediagramShapes = DiagramCatalog.Shapes,
        beediagramAzureStencils = new
        {
            count = DiagramCatalog.AzureIcons.Count,
            usage = "shape=\"azure\" + icon=\"<id>\", e.g. aks, app-service, sql-database, table-storage",
            catalog = "beedocs_list_diagram_shapes (section=\"azure\") or resource beedocs://diagram/catalog",
        },
        beediagramEdgeRoutes = DiagramCatalog.EdgeRoutes,
        beediagramArrowHeads = DiagramCatalog.ArrowHeads,
        beediagramSourceShape = new
        {
            version = 1,
            nodes = new[]
            {
                new
                {
                    id = "n1",
                    type = "box|person|system|database|note|image (classic look)",
                    shape = "studio catalog shape — wins over type; see beedocs_list_diagram_shapes",
                    icon = "Azure stencil id, required when shape=azure",
                    label = "string",
                    x = 0,
                    y = 0,
                    w = 140,
                    h = 72,
                    color = "#hex optional",
                    imageUrl = "optional for type/shape=image",
                    rotation = "optional degrees",
                    parentId = "optional id of a shape=container node holding this one",
                    style = "optional { fill, fill2, stroke, strokeWidth, dashed, opacity, shadow, fontSize, fontColor, bold, italic, align, valign }",
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
                    fromAnchor = "n|e|s|w, ne|se|sw|nw, or n1|n2|e1|e2|s1|s2|w1|w2",
                    toAnchor = "same set; omit to auto-pick",
                    route = "straight|curved|orthogonal",
                    waypoints = "optional [{x,y}] for orthogonal bends",
                    style = "optional { stroke, strokeWidth, dashed, startArrow, endArrow, fontSize, fontColor }",
                },
            },
            viewport = new { x = 0, y = 0, zoom = 1 },
        },
        markdownEmbeds = new
        {
            mermaid = "```mermaid\\n...\\n```",
            beediagramRef = "```beediagram-ref\\nDIAGRAM_ID\\n```",
            beediagramInline = "```beediagram\\n{json}\\n```",
            excelgrid = "```excelgrid\\n{\"version\":1,\"rowCount\":16,\"colCount\":8,\"cells\":[{\"r\":0,\"c\":0,\"v\":\"Item\"}]}\\n```",
            image = "![alt](/uploads/...)",
        },
        slides = new
        {
            model = "A deck is ordered slides of positioned elements (text/shape/image) on a 1280×720 canvas; element array order is z-order.",
            shapes = new[] { "rect", "rounded", "ellipse", "triangle", "diamond", "star", "arrow", "line" },
            tools = "beedocs_create_slide_deck_with_slides / beedocs_update_slide_deck_slides (structured), or raw JSON via beedocs_create_slide_deck",
            templates = "beedocs_list_slide_templates → templateId on create; beedocs_save_slide_template stores a deck's layout app-wide",
            export = "beedocs_export_slide_deck_pptx returns a base64 .pptx (also the Google Slides import path)",
        },
        capabilities = new
        {
            folders = "chapters group pages; beedocs_create_chapter / update / delete / move_page",
            images = "beedocs_upload_image then embed Markdown or image nodes",
            diagrams = "beedocs_list_diagram_shapes for the shape/Azure-stencil catalog, then beedocs_create_beediagram_with_nodes / beedocs_update_beediagram_nodes",
            slides = "beedocs_create_slide_deck_with_slides for presentations; present from the UI at /books/{bookId}/slides/{deckId}",
            export = "beedocs_export_book or beedocs_export_library_snapshot",
        },
        suggestedWorkflow = new[]
        {
            "beedocs_list_books → pick or beedocs_create_book",
            "beedocs_create_chapter for folders, beedocs_create_page with chapterId",
            "beedocs_list_diagram_shapes → beedocs_create_beediagram_with_nodes (or beedocs_create_diagram for mermaid/c4)",
            "beedocs_embed_diagram_in_page or beedocs_upload_image + append",
            "beedocs_export_book for structured content / UI Export PDF for print",
        },
    });
}
