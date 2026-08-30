using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// Repo discovery against the provider REST APIs — the one thing the three
/// connection kinds do differently. GitHub and Azure DevOps list what the token
/// can see; the generic kind lists nothing (clone URLs are pasted by hand) and
/// is tested with <c>git ls-remote</c> instead. Never persisted: the listing is
/// asked for when the admin opens the picker, and only explicitly added repos
/// get a row and a clone.
/// </summary>
public sealed class GitProviderCatalog(IHttpClientFactory httpClientFactory, GitCli git, GitOptions options)
{
    public const string HttpClientName = "git-catalog";

    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Caps the org walk: nobody adds page four of a repo picker.</summary>
    private const int MaxRepos = 300;
    private const int MaxDevOpsProjects = 50;

    public async Task<IReadOnlyList<GitAvailableRepoDto>> ListAsync(
        GitConnectionSecret connection, CancellationToken ct)
    {
        return connection.Kind switch
        {
            GitConnectionKinds.GitHub => await ListGitHubAsync(connection, ct),
            GitConnectionKinds.AzureDevOps => await ListDevOpsAsync(connection, ct),
            _ => throw new ArgumentException(
                "This connection lists no repositories — add one by pasting its clone URL."),
        };
    }

    /// <summary>
    /// Reachability + credential, without cloning anything. For the generic kind
    /// the given clone URL (or nothing) is probed with ls-remote.
    /// </summary>
    public async Task<GitConnectionTestResultDto> TestAsync(
        GitConnectionSecret connection, string? cloneUrl, CancellationToken ct)
    {
        try
        {
            if (connection.Kind == GitConnectionKinds.Git)
            {
                if (string.IsNullOrWhiteSpace(cloneUrl))
                {
                    return new GitConnectionTestResultDto(true,
                        "Nothing to test yet — paste a clone URL when adding a repository.", null);
                }

                await git.RunOkAsync(
                    options.Root, ["ls-remote", "--heads", cloneUrl.Trim()],
                    connection.BasicAuth, ListTimeout, ct);
                return new GitConnectionTestResultDto(true, "The repository answered ls-remote.", null);
            }

            var repos = await ListAsync(connection, ct);
            return new GitConnectionTestResultDto(
                true,
                $"Connected to {connection.Name}. {repos.Count} repositor{(repos.Count == 1 ? "y" : "ies")} visible.",
                repos.Count);
        }
        catch (GitException ex)
        {
            return new GitConnectionTestResultDto(false, ex.Message, null);
        }
    }

    private async Task<IReadOnlyList<GitAvailableRepoDto>> ListGitHubAsync(
        GitConnectionSecret connection, CancellationToken ct)
    {
        // Blank base URL = everything the token's user can access; a name = that
        // org's (falling back to that user's) repositories.
        var paths = string.IsNullOrEmpty(connection.BaseUrl)
            ? new[] { "user/repos?affiliation=owner,collaborator,organization_member" }
            : new[]
            {
                $"orgs/{Uri.EscapeDataString(connection.BaseUrl)}/repos",
                $"users/{Uri.EscapeDataString(connection.BaseUrl)}/repos",
            };

        List<GitAvailableRepoDto>? repos = null;
        GitException? last = null;
        foreach (var path in paths)
        {
            try
            {
                repos = await ListGitHubPagedAsync(connection, path, ct);
                break;
            }
            catch (GitException ex)
            {
                last = ex;
            }
        }

        if (repos is null) throw last ?? new GitException("GitHub returned nothing.");
        return repos;
    }

    private async Task<List<GitAvailableRepoDto>> ListGitHubPagedAsync(
        GitConnectionSecret connection, string path, CancellationToken ct)
    {
        var repos = new List<GitAvailableRepoDto>();
        for (var page = 1; repos.Count < MaxRepos && page <= MaxRepos / 100; page++)
        {
            var sep = path.Contains('?') ? '&' : '?';
            using var doc = await GetJsonAsync(
                connection,
                $"https://api.github.com/{path}{sep}per_page=100&page={page}&sort=full_name",
                github: true, ct);

            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                throw new GitException("GitHub answered with something that is not a repository list.");

            var before = repos.Count;
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                var name = ReadString(item, "full_name") ?? ReadString(item, "name");
                var cloneUrl = ReadString(item, "clone_url");
                if (name is null || cloneUrl is null) continue;
                repos.Add(new GitAvailableRepoDto(
                    name, cloneUrl,
                    ReadString(item, "default_branch"),
                    ReadString(item, "description"),
                    Added: false));
            }

            if (repos.Count == before || repos.Count - before < 100) break;
        }

        repos.Sort(static (a, b) => string.CompareOrdinal(a.Name, b.Name));
        return repos;
    }

    private async Task<IReadOnlyList<GitAvailableRepoDto>> ListDevOpsAsync(
        GitConnectionSecret connection, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(connection.BaseUrl))
            throw new GitException("Set the organization URL first, e.g. https://dev.azure.com/my-org.");

        // Per Bart: one connection per organization. Repos live per project, so
        // walk the projects and gather each one's repositories.
        var repos = new List<GitAvailableRepoDto>();
        using (var projects = await GetJsonAsync(
            connection, $"{connection.BaseUrl}/_apis/projects?api-version=7.1&$top={MaxDevOpsProjects}",
            github: false, ct))
        {
            if (!projects.RootElement.TryGetProperty("value", out var list)
                || list.ValueKind != JsonValueKind.Array)
            {
                throw new GitException(
                    "Azure DevOps answered without a project list — check the organization URL.");
            }

            foreach (var project in list.EnumerateArray())
            {
                var projectName = ReadString(project, "name");
                if (projectName is null) continue;

                using var page = await GetJsonAsync(
                    connection,
                    $"{connection.BaseUrl}/{Uri.EscapeDataString(projectName)}/_apis/git/repositories?api-version=7.1",
                    github: false, ct);
                if (!page.RootElement.TryGetProperty("value", out var repoList)
                    || repoList.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var item in repoList.EnumerateArray())
                {
                    var name = ReadString(item, "name");
                    var cloneUrl = ReadString(item, "remoteUrl");
                    if (name is null || cloneUrl is null) continue;
                    if (item.TryGetProperty("isDisabled", out var disabled)
                        && disabled.ValueKind == JsonValueKind.True)
                    {
                        continue;
                    }

                    var branch = ReadString(item, "defaultBranch");
                    if (branch is not null && branch.StartsWith("refs/heads/", StringComparison.Ordinal))
                        branch = branch["refs/heads/".Length..];

                    repos.Add(new GitAvailableRepoDto(
                        $"{projectName}/{name}", cloneUrl, branch, null, Added: false));
                    if (repos.Count >= MaxRepos) break;
                }

                if (repos.Count >= MaxRepos) break;
            }
        }

        repos.Sort(static (a, b) => string.CompareOrdinal(a.Name, b.Name));
        return repos;
    }

    private async Task<JsonDocument> GetJsonAsync(
        GitConnectionSecret connection, string url, bool github, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (github)
        {
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            request.Headers.UserAgent.ParseAdd("BeeDocs");
            if (!string.IsNullOrEmpty(connection.Token))
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
        }
        else if (!string.IsNullOrEmpty(connection.Token))
        {
            // DevOps PATs ride Basic with an empty username.
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(":" + connection.Token)));
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(ListTimeout);

        HttpResponseMessage response;
        try
        {
            var http = httpClientFactory.CreateClient(HttpClientName);
            response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new GitException($"{connection.Name} did not respond within {ListTimeout.TotalSeconds:0}s.");
        }
        catch (HttpRequestException ex)
        {
            throw new GitException($"Cannot reach {connection.Name}: {ex.Message}", ex);
        }

        using (response)
        {
            var payload = await response.Content.ReadAsStringAsync(timeoutCts.Token);
            if (!response.IsSuccessStatusCode)
            {
                var reason = (int)response.StatusCode switch
                {
                    401 => $"{connection.Name} rejected the token",
                    403 => $"{connection.Name} refused access — check the token's scopes",
                    404 => $"{connection.Name} answered 404 — check the organization name/URL",
                    _ => $"{connection.Name} returned {(int)response.StatusCode}",
                };
                throw new GitException($"{reason}.");
            }

            try
            {
                return JsonDocument.Parse(payload);
            }
            catch (JsonException ex)
            {
                // DevOps answers HTML (a sign-in page) for a bad org URL.
                throw new GitException(
                    $"{connection.Name} returned a response that is not JSON — check the URL.", ex);
            }
        }
    }

    private static string? ReadString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
