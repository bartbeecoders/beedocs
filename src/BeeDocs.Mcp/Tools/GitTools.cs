using System.ComponentModel;
using ModelContextProtocol.Server;

namespace BeeDocs.Mcp.Tools;

/// <summary>
/// The git integration: repos an admin put on the shelf, their trees, files
/// (current or at any ref), status, branches, history, diffs — and the write
/// verbs: save, delete, rename, commit, pull, push, branch, checkout.
///
/// The working copy behind these tools is shared instance state — one checkout
/// per repo, used by people through the UI at the same time. The server
/// enforces the honesty rules (stale saves 409, checkout refuses while dirty,
/// push never forces, a conflicted pull is backed out), and the tool
/// descriptions teach the safe flow: branch first, save, commit, push.
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

    // --- Write verbs. The working copy is shared with people using the UI:
    //     prefer a branch of your own, keep commits small, never leave the
    //     tree dirty at the end of a task. ---

    [McpServerTool(Name = "beedocs_git_write_file", Title = "Save a repo file"),
     Description("Write one file to the repo's working tree (UTF-8 text). To EDIT: first beedocs_git_read_file and pass its blobSha as baseBlobSha — a stale sha means someone changed the file since (409): re-read and reapply. To CREATE: omit baseBlobSha. The save stays uncommitted until beedocs_git_commit. The working copy is shared with people — do not leave half-finished edits sitting dirty.")]
    public Task<string> WriteFile(
        string repoId,
        [Description("File path inside the repo, e.g. docs/setup.md. Missing folders are created.")] string path,
        [Description("The full new file content")] string content,
        [Description("blobSha from beedocs_git_read_file when editing; omit when creating a new file.")] string? baseBlobSha = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.WriteGitFileAsync(repoId, path, content, baseBlobSha, ct)));

    [McpServerTool(Name = "beedocs_git_delete_file", Title = "Delete a repo file", Destructive = true),
     Description("Delete one file from the working tree. Uncommitted until beedocs_git_commit — committing nothing restores it, so this is recoverable until then.")]
    public Task<string> DeleteFile(
        string repoId,
        [Description("File path inside the repo")] string path,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.DeleteGitFileAsync(repoId, path, ct);
            return ToolHelpers.Json(new { deleted = path, note = "Uncommitted — commit to make it history." });
        });

    [McpServerTool(Name = "beedocs_git_rename_file", Title = "Rename/move a repo file"),
     Description("Move or rename a working-tree file or folder (full repo paths for both sides). Uncommitted until beedocs_git_commit; git records it as a rename in history.")]
    public Task<string> RenameFile(
        string repoId,
        [Description("Current path, e.g. docs/old.md")] string from,
        [Description("New path, e.g. docs/adr/new.md")] string to,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
        {
            await client.RenameGitFileAsync(repoId, from, to, ct);
            return ToolHelpers.Json(new { from, to, note = "Uncommitted — commit to make it history." });
        });

    [McpServerTool(Name = "beedocs_git_commit", Title = "Commit changes"),
     Description("Stage and commit working-tree changes: the listed paths, or everything when paths is omitted. The commit is authored 'BeeDocs' unless authorName/authorEmail say who this run acts on behalf of; the committer is always BeeDocs. Commit only what your task changed — the tree may hold other people's work in progress. Then beedocs_git_push to publish.")]
    public Task<string> Commit(
        string repoId,
        [Description("What changed and why — becomes the commit message")] string message,
        [Description("Only these paths; omit to commit every change (including other people's!)")] string[]? paths = null,
        [Description("Who this agent commits on behalf of, e.g. their display name")] string? authorName = null,
        [Description("That person's git email")] string? authorEmail = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CommitGitAsync(repoId, message, paths, authorName, authorEmail, ct)));

    [McpServerTool(Name = "beedocs_git_pull", Title = "Pull from the remote"),
     Description("Merge the remote into the shared working copy. A conflicted merge is backed out and answers 409 naming the files; retry with strategy 'ours' (keep this server's lines) or 'theirs' (take the remote's) only when the task clearly says which side wins — otherwise report the conflict.")]
    public Task<string> Pull(
        string repoId,
        [Description("ours | theirs — conflict resolution for a retry after a conflict 409. Omit for a plain merge.")] string? strategy = null,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.PullGitAsync(repoId, strategy, ct)));

    [McpServerTool(Name = "beedocs_git_push", Title = "Push to the remote"),
     Description("Push the current branch (never force). Behind-the-remote answers 409 'pull first'. A push publishes commits to the real remote under the connection's stored credential — be sure the commit is what the task asked for.")]
    public Task<string> Push(string repoId, CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.PushGitAsync(repoId, ct)));

    [McpServerTool(Name = "beedocs_git_create_branch", Title = "Create a branch"),
     Description("Create a branch from the current one and (by default) switch the shared working copy to it. The safe start of any multi-file agent change: branch, edit, commit, push — a person then reviews it as a PR instead of finding main rewritten.")]
    public Task<string> CreateBranch(
        string repoId,
        [Description("Branch name, e.g. docs/agent-update")] string name,
        [Description("Also switch to it (default true). Uncommitted edits ride along.")] bool checkout = true,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () =>
            ToolHelpers.Json(await client.CreateGitBranchAsync(repoId, name, checkout, ct)));

    [McpServerTool(Name = "beedocs_git_checkout", Title = "Switch branches"),
     Description("Switch the shared working copy to another branch (remote-only branches are materialized). Refused (409) while anything is uncommitted — and it changes what every person on this server sees, so switch back when your task is done.")]
    public Task<string> Checkout(
        string repoId,
        [Description("Branch name from beedocs_git_branches")] string branch,
        CancellationToken ct = default) =>
        ToolHelpers.RunAsync(async () => ToolHelpers.Json(await client.CheckoutGitAsync(repoId, branch, ct)));
}
