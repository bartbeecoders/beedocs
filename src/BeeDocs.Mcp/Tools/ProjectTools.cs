using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

[McpServerToolType]
public sealed class ProjectTools(BeeDocsApiClient client)
{
    /// <summary>Matches the web editor schema in src/beedocs-web/src/project/projectModel.ts.</summary>
    private const string SchemaHint =
        "Plan document: {version:1, tasks:[{id, title, kind, start, duration, progress, parentId, predecessors, assigneeId, assigneeName}]}. " +
        "kind is task|milestone; start is YYYY-MM-DD or null; duration is calendar days (0 for a milestone); " +
        "progress is 0–100; parentId nests a task under another (WBS); predecessors are finish-to-start task ids; " +
        "assigneeId is an account id from the user directory (assigneeName is a display snapshot). " +
        "Pages embed a stored plan with ```project-ref\\nPLAN_ID\\n```, or an inline copy with ```project\\n{json}\\n```.";

    [McpServerTool(Name = "beedocs_list_project_plans", Title = "List project plans in book", ReadOnly = true),
     Description("List project plan summaries for a book (includes taskCount).")]
    public Task<string> ListProjectPlans(string bookId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListProjectPlansAsync(bookId, ct)));

    [McpServerTool(Name = "beedocs_get_project_plan", Title = "Get project plan", ReadOnly = true),
     Description("Get a project plan including its full JSON document. " + SchemaHint)]
    public Task<string> GetProjectPlan(string planId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetProjectPlanAsync(planId, ct)));

    [McpServerTool(Name = "beedocs_create_project_plan", Title = "Create project plan"),
     Description("Create a project plan in a book from a raw JSON document. Omit source for a single empty task. " +
                 "Prefer beedocs_create_project_plan_with_tasks for structured, validated input. " + SchemaHint)]
    public Task<string> CreateProjectPlan(
        string bookId,
        string title,
        [Description("Plan JSON document; omit for a single empty task")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            return ToolHelpers.Json(await client.CreateProjectPlanAsync(bookId, new { title, source }, ct));
        });

    [McpServerTool(Name = "beedocs_update_project_plan", Title = "Update project plan"),
     Description("Update a project plan's title and/or raw JSON document. Null source keeps the stored document; null title keeps the current one.")]
    public Task<string> UpdateProjectPlan(
        string planId,
        [Description("Leave unset to keep the current title")] string? title = null,
        [Description("Replacement plan JSON document; leave unset to keep the current one")] string? source = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            EnsureParses(source);
            var t = title;
            if (string.IsNullOrWhiteSpace(t))
            {
                var existing = await client.GetProjectPlanAsync(planId, ct);
                t = BeeDocsApiClient.Prop(existing, "title");
            }

            return ToolHelpers.Json(await client.UpdateProjectPlanAsync(planId, new { title = t, source }, ct));
        });

    [McpServerTool(Name = "beedocs_delete_project_plan", Title = "Delete project plan", Destructive = true),
     Description("Permanently delete a project plan by id.")]
    public Task<string> DeleteProjectPlan(string planId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteProjectPlanAsync(planId, ct);
            return ToolHelpers.Json(new { deleted = true, planId });
        });

    [McpServerTool(Name = "beedocs_create_project_plan_with_tasks", Title = "Create project plan from tasks"),
     Description("Create a project plan from structured tasks (agent-friendly). " +
                 "Omit tasks to start with one empty task. Returns the created plan including its id and workspace URL.")]
    public Task<string> CreateProjectPlanWithTasks(
        string bookId,
        string title,
        [Description("Tasks in WBS order; omit for a single empty task")] List<ProjectTaskInput>? tasks = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var source = BuildPlanSource(tasks);
            var created = await client.CreateProjectPlanAsync(bookId, new { title, source }, ct);
            var id = BeeDocsApiClient.Prop(created, "id");
            return ToolHelpers.Json(new
            {
                plan = created,
                workspaceUrl = string.IsNullOrEmpty(id) ? null : $"/books/{bookId}/project/{id}",
                embedFence = string.IsNullOrEmpty(id) ? null : $"```project-ref\n{id}\n```",
            });
        });

    [McpServerTool(Name = "beedocs_update_project_plan_tasks", Title = "Replace project plan tasks"),
     Description("Replace an existing plan's tasks with structured tasks, using the same model as " +
                 "beedocs_create_project_plan_with_tasks. Title is kept unless given.")]
    public Task<string> UpdateProjectPlanTasks(
        string planId,
        [Description("Tasks in WBS order — replaces the existing ones")] List<ProjectTaskInput> tasks,
        [Description("Leave unset to keep the current title")] string? title = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            var existing = await client.GetProjectPlanAsync(planId, ct);
            var source = BuildPlanSource(tasks);
            return ToolHelpers.Json(await client.UpdateProjectPlanAsync(
                planId,
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

    private static string BuildPlanSource(List<ProjectTaskInput>? tasks)
    {
        IReadOnlyList<ProjectTaskInput> input = tasks is { Count: > 0 }
            ? tasks
            : [new() { Title = "New task", Kind = "task", Duration = 1 }];

        var mapped = input.Select((t, i) =>
        {
            var id = string.IsNullOrWhiteSpace(t.Id) ? $"task-{i + 1}" : t.Id!;
            var kind = string.Equals(t.Kind, "milestone", StringComparison.OrdinalIgnoreCase) ? "milestone" : "task";
            int duration = kind == "milestone" ? 0 : t.Duration is > 0 ? t.Duration.Value : 1;
            int progress = t.Progress is >= 0 and <= 100 ? t.Progress.Value : 0;
            var preds = (t.Predecessors ?? [])
                .Where(p => !string.IsNullOrWhiteSpace(p) && p != id)
                .Distinct()
                .ToList();

            return new Dictionary<string, object?>
            {
                ["id"] = id,
                ["title"] = t.Title?.Trim() ?? "",
                ["kind"] = kind,
                ["start"] = string.IsNullOrWhiteSpace(t.Start) ? null : t.Start.Trim(),
                ["duration"] = duration,
                ["progress"] = progress,
                ["parentId"] = string.IsNullOrWhiteSpace(t.ParentId) ? null : t.ParentId.Trim(),
                ["predecessors"] = preds,
                ["assigneeId"] = string.IsNullOrWhiteSpace(t.AssigneeId) ? null : t.AssigneeId.Trim(),
                ["assigneeName"] = string.IsNullOrWhiteSpace(t.AssigneeName) ? null : t.AssigneeName.Trim(),
            };
        }).ToList();

        return JsonSerializer.Serialize(new { version = 1, tasks = mapped }, SourceJson);
    }

    private static readonly JsonSerializerOptions SourceJson = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}

public sealed class ProjectTaskInput
{
    [Description("Stable task id; auto-assigned (task-1, task-2, …) when omitted")]
    public string? Id { get; set; }

    [Description("Task name")]
    public string? Title { get; set; }

    [Description("task | milestone")]
    public string? Kind { get; set; }

    [Description("Inclusive start date YYYY-MM-DD; omit for unscheduled")]
    public string? Start { get; set; }

    [Description("Calendar days; 0 / omit for a milestone, default 1 for a task")]
    public int? Duration { get; set; }

    [Description("Percent complete 0–100")]
    public int? Progress { get; set; }

    [Description("Parent task id for WBS indent")]
    public string? ParentId { get; set; }

    [Description("Finish-to-start predecessor task ids")]
    public List<string>? Predecessors { get; set; }

    [Description("Account id from the BeeDocs user directory")]
    public string? AssigneeId { get; set; }

    [Description("Display name snapshot for the assignee")]
    public string? AssigneeName { get; set; }
}
