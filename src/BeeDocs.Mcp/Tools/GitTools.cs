using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// The git integration, read-only: repos an admin put on the shelf, their
/// trees, files (current or at any ref), status, branches, history and diffs.
///
/// Deliberately no write verbs yet. The working copy behind these tools is
/// shared instance state — one checkout per repo, used by people through the
/// UI at the same time — and the plan (Vibecoding/git-information-integration.md
/// §12) says agents get commit/push only after the concurrency guards have
/// soaked with human use. An agent that wants to change repo content should
/// say so and let a person drive the phase-2 UI for now.
/// </summary>
[McpServerToolType]
public sealed class GitTools(BeeDocsApiClient client)
{
    [McpServerTool(Name = "beedocs_git_list_repos", Title = "List git repos", ReadOnly = true),
     Description("List the git repositories on the shelf: id, name, connection, clone URL, checked-out branch, status (cloning|ready|error), last sync time. Repo ids feed every other beedocs_git_* tool.")]
    public Task<string> ListRepos(CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.ListGitReposAsync(ct)));

    [McpServerTool(Name = "beedocs_git_tree", Title = "List a repo folder", ReadOnly = true),
     Description("One directory level of a repo's working tree: name, path, file|dir, size. Omit path for the repo root; recurse by calling again with a dir's path.")]
    public Task<string> Tree(
        string repoId,
        [Description("Folder path inside the repo, e.g. docs/adr. Omit for the root.")] string? path = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitTreeAsync(repoId, path, ct)));

    [McpServerTool(Name = "beedocs_git_read_file", Title = "Read a repo file", ReadOnly = true),
     Description("Read one file from a repo. Text arrives inline (≤2 MB) with its blobSha; binaries and oversize files answer metadata only. Pass ref (a branch, sha, or spec like HEAD~2) to read a historical version instead of the working tree.")]
    public Task<string> ReadFile(
        string repoId,
        [Description("File path inside the repo, e.g. docs/setup.md")] string path,
        [Description("Branch, commit sha, or spec like HEAD~2. Omit for the working tree.")] string? @ref = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitFileAsync(repoId, path, @ref, ct)));

    [McpServerTool(Name = "beedocs_git_status", Title = "Repo status", ReadOnly = true),
     Description("The repo's live state: checked-out branch, commits ahead/behind the remote, and the uncommitted (dirty) files in the shared working copy.")]
    public Task<string> Status(string repoId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitStatusAsync(repoId, ct)));

    [McpServerTool(Name = "beedocs_git_branches", Title = "List branches", ReadOnly = true),
     Description("Local and remote-only branches of a repo, with the current one marked.")]
    public Task<string> Branches(string repoId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitBranchesAsync(repoId, ct)));

    [McpServerTool(Name = "beedocs_git_log", Title = "Commit history", ReadOnly = true),
     Description("Commit history, newest first: sha, author, date, subject. Pass path to follow one file's history (renames included). Use beedocs_git_show_commit for a commit's patch.")]
    public Task<string> Log(
        string repoId,
        [Description("Narrow to one file/folder's history. Omit for the whole branch.")] string? path = null,
        [Description("Max commits, default 30, cap 200.")] int? limit = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitLogAsync(repoId, path, limit, ct)));

    [McpServerTool(Name = "beedocs_git_show_commit", Title = "Show a commit", ReadOnly = true),
     Description("One commit in full: author, date, message, and its unified-diff patch (capped at 256 KB; pass path to narrow the patch to one file).")]
    public Task<string> ShowCommit(
        string repoId,
        [Description("Commit sha (or a spec like HEAD~1) from beedocs_git_log.")] string sha,
        [Description("Narrow the patch to this path.")] string? path = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitCommitAsync(repoId, sha, path, ct)));

    [McpServerTool(Name = "beedocs_git_diff", Title = "Uncommitted changes", ReadOnly = true),
     Description("Unified diff of the working copy's uncommitted changes against HEAD — the whole repo, or one path (untracked files show as all-added per path). Empty patch = clean.")]
    public Task<string> Diff(
        string repoId,
        [Description("Narrow to one file/folder. Omit for everything.")] string? path = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.GetGitDiffAsync(repoId, path, ct)));
}
