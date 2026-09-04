using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class KanbanTools(BeeDocsApiClient client)
{
    /// <summary>Matches the web editor schema in src/beedocs-web/src/kanban/kanbanModel.ts.</summary>
    private const string SchemaHint =
        "Board document: {version:1, columns:[{id, title, wip?, cards:[{id, title, body?, color?, assigneeId?, assigneeName?}]}]}. " +
        "color is accent|info|ok|warn|danger|muted; wip is an optional per-column card limit; " +
        "assigneeId is an account id from the user directory (assigneeName is a display snapshot). " +
        "Pages embed a stored board with ```kanban-ref\\nBOARD_ID\\n```, or an inline copy with ```kanban\\n{json}\\n```.";

    private static readonly string[] Colors = ["accent", "info", "ok", "warn", "danger", "muted"];

    [McpServerTool(Name = "beedocs_list_kanban_boards", Title = "List kanban boards in book", ReadOnly = true),
     Description("List kanban board summaries for a book (includes cardCount).")]
    public Task<string> ListKanbanBoards(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListKanbanBoardsAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_kanban_board", Title = "Get kanban board", ReadOnly = true),
     Description("Get a kanban board including its full JSON document. " + SchemaHint)]
    public Task<string> GetKanbanBoard(string boardId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetKanbanBoardAsync(boardId, ct)));

    [McpServerTool(Name = "beedocs_create_kanban_board", Title = "Create kanban board"),
     Description("Create a kanban board in a book from a raw JSON document. Omit source for three empty columns (To do / In progress / Done). " +
                 "Prefer beedocs_create_kanban_board_with_columns for structured, validated input. " + SchemaHint)]
    public Task<string> CreateKanbanBoard(
        string bookId,
        string title,
        [Description("Board JSON document; omit for three empty columns")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            return ToolHelpers.Json(await client.CreateKanbanBoardAsync(bookId, new { title, source }, ct));
        });

    [McpServerTool(Name = "beedocs_update_kanban_board", Title = "Update kanban board"),
     Description("Update a kanban board's title and/or raw JSON document. Null source keeps the stored document; null title keeps the current one.")]
    public Task<string> UpdateKanbanBoard(
        string boardId,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Replacement board JSON document; leave unset to keep the current one")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            var t = title;
            if (string.IsNullOrWhiteSpace(t))
            {
                var existing = await client.GetKanbanBoardAsync(boardId, ct);
                t = BeeDocsApiClient.Prop(existing, "title");
            }

            return ToolHelpers.Json(await client.UpdateKanbanBoardAsync(boardId, new { title = t, source }, ct));
        });

    [McpServerTool(Name = "beedocs_delete_kanban_board", Title = "Delete kanban board", Destructive = true),
     Description("Permanently delete a kanban board by id.")]
    public Task<string> DeleteKanbanBoard(string boardId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteKanbanBoardAsync(boardId, ct);
            return ToolHelpers.Json(new { deleted = true, boardId });
        });

    [McpServerTool(Name = "beedocs_create_kanban_board_with_columns", Title = "Create kanban board from columns"),
     Description("Create a kanban board from structured columns and cards (agent-friendly). " +
                 "Omit columns to start with To do / In progress / Done. Returns the created board including its id and workspace URL.")]
    public Task<string> CreateKanbanBoardWithColumns(
        string bookId,
        string title,
        [Description("Columns left-to-right; omit for the three empty starter columns")] List<KanbanColumnInput>? columns = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildBoardSource(columns);
            var created = await client.CreateKanbanBoardAsync(bookId, new { title, source }, ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                board = created,
                workspaceUrl = string.IsNullOrEmpty(id) ? null : $"/books/{bookId}/kanban/{id}",
                embedFence = string.IsNullOrEmpty(id) ? null : $"```kanban-ref\n{id}\n```",
            });
        });

    [McpServerTool(Name = "beedocs_update_kanban_board_columns", Title = "Replace kanban board columns"),
     Description("Replace an existing board's columns with structured columns, using the same model as " +
                 "beedocs_create_kanban_board_with_columns. Title is kept unless given.")]
    public Task<string> UpdateKanbanBoardColumns(
        string boardId,
        [Description("Columns left-to-right — replaces the existing ones")] List<KanbanColumnInput> columns,
        [Description("Leave unset to keep the current title")] string? title = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetKanbanBoardAsync(boardId, ct);
            var source = BuildBoardSource(columns);
            return ToolHelpers.Json(await client.UpdateKanbanBoardAsync(
                boardId,
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

    /// <summary>
    /// Validate and serialise structured columns into the board document the web
    /// editor writes. Empty / omitted columns become the three empty starter columns.
    /// </summary>
    private static string BuildBoardSource(List<KanbanColumnInput>? columns)
    {
        IReadOnlyList<KanbanColumnInput> input = columns is { Count: > 0 }
            ? columns
            : [
                new() { Title = "To do" },
                new() { Title = "In progress", Wip = 3 },
                new() { Title = "Done" },
            ];

        var mapped = input.Select((c, ci) =>
        {
            var colId = string.IsNullOrWhiteSpace(c.Id) ? $"col-{ci + 1}" : c.Id!;
            var title = string.IsNullOrWhiteSpace(c.Title) ? $"Column {ci + 1}" : c.Title.Trim();
            int? wip = c.Wip is > 0 ? c.Wip : null;
            var cards = (c.Cards ?? []).Select((card, ki) =>
            {
                var id = string.IsNullOrWhiteSpace(card.Id) ? $"card-{ci + 1}-{ki + 1}" : card.Id!;
                var color = string.IsNullOrWhiteSpace(card.Color) ? null : card.Color.Trim().ToLowerInvariant();
                if (color is not null && !Colors.Contains(color))
                {
                    throw new ModelContextProtocol.McpException(
                        $"Column {colId}, card {id}: unknown color \"{card.Color}\". Use one of: {string.Join(", ", Colors)}.");
                }

                var map = new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["title"] = card.Title?.Trim() ?? "",
                    ["body"] = card.Body?.Trim() ?? "",
                    ["color"] = color,
                    ["assigneeId"] = string.IsNullOrWhiteSpace(card.AssigneeId) ? null : card.AssigneeId.Trim(),
                    ["assigneeName"] = string.IsNullOrWhiteSpace(card.AssigneeName) ? null : card.AssigneeName.Trim(),
                };
                return map;
            }).ToList();

            return new Dictionary<string, object?>
            {
                ["id"] = colId,
                ["title"] = title,
                ["wip"] = wip,
                ["cards"] = cards,
            };
        }).ToList();

        return JsonSerializer.Serialize(new { version = 1, columns = mapped }, SourceJson);
    }

    private static readonly JsonSerializerOptions SourceJson = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed class KanbanColumnInput
{
    [Description("Stable column id; auto-assigned (col-1, col-2, …) when omitted")]
    public string? Id { get; set; }

    [Description("Column heading")]
    public string? Title { get; set; }

    [Description("Work-in-progress limit; omit or 0 for unlimited")]
    public int? Wip { get; set; }

    [Description("Cards top-to-bottom")]
    public List<KanbanCardInput>? Cards { get; set; }
}

public sealed class KanbanCardInput
{
    [Description("Stable card id; auto-assigned when omitted")]
    public string? Id { get; set; }

    [Description("Card title")]
    public string? Title { get; set; }

    [Description("Optional details shown under the title")]
    public string? Body { get; set; }

    [Description("accent | info | ok | warn | danger | muted")]
    public string? Color { get; set; }

    [Description("Account id from the BeeDocs user directory")]
    public string? AssigneeId { get; set; }

    [Description("Display name snapshot for the assignee (used if the account is later deleted)")]
    public string? AssigneeName { get; set; }
}
