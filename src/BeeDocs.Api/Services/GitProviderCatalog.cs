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
    private const int MaxRedirects = 5;

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
            using var pageJson = await GetJsonAsync(
                connection,
                $"https://api.github.com/{path}{sep}per_page=100&page={page}&sort=full_name",
                github: true, ct);

            if (pageJson.Document.RootElement.ValueKind != JsonValueKind.Array)
                throw new GitException("GitHub answered with something that is not a repository list.");

            var before = repos.Count;
            foreach (var item in pageJson.Document.RootElement.EnumerateArray())
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
        if (string.IsNullOrEmpty(connection.Token))
        {
            throw new GitException(
                "Azure DevOps needs a personal access token with Code (Read) saved on this connection.");
        }

        // Org-level list: one call, Code (Read) is enough. Walking /_apis/projects
        // first required Project (Read) and failed the PAT the settings UI asks for.
        var root = DevOpsApiRoot(connection.BaseUrl);
        var repos = new List<GitAvailableRepoDto>();
        string? continuation = null;
        do
        {
            // $top is a literal OData parameter — keep it out of interpolated strings.
            var url = root + "/_apis/git/repositories?api-version=7.1&$top=100";
            if (continuation is not null)
                url += "&continuationToken=" + Uri.EscapeDataString(continuation);

            using var page = await GetJsonAsync(connection, url, github: false, ct);
            if (!page.Document.RootElement.TryGetProperty("value", out var repoList)
                || repoList.ValueKind != JsonValueKind.Array)
            {
                throw new GitException(
                    "Azure DevOps answered without a repository list — check the organization URL.");
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

                var projectName = item.TryGetProperty("project", out var project)
                    ? ReadString(project, "name")
                    : null;
                var branch = ReadString(item, "defaultBranch");
                if (branch is not null && branch.StartsWith("refs/heads/", StringComparison.Ordinal))
                    branch = branch["refs/heads/".Length..];

                repos.Add(new GitAvailableRepoDto(
                    projectName is null ? name : $"{projectName}/{name}",
                    cloneUrl, branch, null, Added: false));
                if (repos.Count >= MaxRepos) break;
            }

            continuation = repos.Count >= MaxRepos ? null : page.ContinuationToken;
        } while (!string.IsNullOrEmpty(continuation));

        repos.Sort(static (a, b) => string.CompareOrdinal(a.Name, b.Name));
        return repos;
    }

    /// <summary>
    /// Org REST root. A saved URL that still has a project (or _apis) path must
    /// not be used as-is — those hang off the organization, not the extra segment.
    /// </summary>
    internal static string DevOpsApiRoot(string baseUrl)
    {
        var value = baseUrl.Trim().TrimEnd('/');
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
            return value;

        if (uri.Host.EndsWith(".visualstudio.com", StringComparison.OrdinalIgnoreCase))
        {
            var org = uri.Host[..^".visualstudio.com".Length];
            return string.IsNullOrEmpty(org) || org.Contains('.')
                ? value
                : "https://dev.azure.com/" + org;
        }

        if (!uri.Host.Equals("dev.azure.com", StringComparison.OrdinalIgnoreCase)
            && !uri.Host.Equals("www.dev.azure.com", StringComparison.OrdinalIgnoreCase))
        {
            return value;
        }

        var orgName = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        return string.IsNullOrEmpty(orgName) || orgName.StartsWith('_')
            ? value
            : "https://dev.azure.com/" + orgName;
    }

    private async Task<CatalogJson> GetJsonAsync(
        GitConnectionSecret connection, string url, bool github, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(ListTimeout);

        var currentUrl = url;
        HttpResponseMessage? response = null;
        try
        {
            for (var hop = 0; hop <= MaxRedirects; hop++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, currentUrl);
                ApplyCatalogHeaders(request, connection, github);

                try
                {
                    var http = httpClientFactory.CreateClient(HttpClientName);
                    response = await http.SendAsync(
                        request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw new GitException(
                        $"{connection.Name} did not respond within {ListTimeout.TotalSeconds:0}s.");
                }
                catch (HttpRequestException ex)
                {
                    throw new GitException($"Cannot reach {connection.Name}: {ex.Message}", ex);
                }

                var code = (int)response.StatusCode;
                if (code is not (301 or 302 or 303 or 307 or 308))
                    break;

                var location = response.Headers.Location;
                response.Dispose();
                response = null;
                if (location is null)
                {
                    throw new GitException(
                        $"{connection.Name} redirected without a Location header.");
                }

                var resolved = location.IsAbsoluteUri ? location : new Uri(new Uri(currentUrl), location);
                if (!IsTrustedCatalogHost(resolved))
                {
                    throw new GitException(
                        $"{connection.Name} redirected to {resolved.Host}, which is not a trusted git host.");
                }

                currentUrl = resolved.AbsoluteUri;
            }

            if (response is null)
            {
                throw new GitException(
                    $"{connection.Name} redirected too many times — check the organization URL.");
            }

            var payload = await response.Content.ReadAsStringAsync(timeoutCts.Token);
            var continuation = TryGetContinuation(response);
            var status = (int)response.StatusCode;
            var html = LooksLikeHtml(payload, response);

            // 203 is a 2xx, so IsSuccessStatusCode would accept an HTML sign-in page.
            if (status == 203 || (html && github == false))
            {
                throw new GitException(
                    $"{connection.Name} rejected the token — Azure DevOps returned a sign-in page instead of the API. " +
                    "Check the PAT (Code Read), that it belongs to this organization, and that PATs are allowed in the org policy.");
            }

            if (!response.IsSuccessStatusCode)
            {
                var azure = ReadAzureMessage(payload);
                var reason = status switch
                {
                    401 => $"{connection.Name} rejected the token",
                    403 => $"{connection.Name} refused access — check the token's scopes (Code Read)",
                    404 => $"{connection.Name} answered 404 — check the organization name/URL",
                    _ => $"{connection.Name} returned {status}",
                };
                throw new GitException(azure is null ? reason + "." : $"{reason}: {azure}");
            }

            try
            {
                return new CatalogJson(JsonDocument.Parse(payload), continuation);
            }
            catch (JsonException ex)
            {
                throw new GitException(
                    $"{connection.Name} returned a response that is not JSON — check the URL.", ex);
            }
        }
        finally
        {
            response?.Dispose();
        }
    }

    private static void ApplyCatalogHeaders(
        HttpRequestMessage request, GitConnectionSecret connection, bool github)
    {
        if (github)
        {
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            if (!string.IsNullOrEmpty(connection.Token))
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", connection.Token);
            return;
        }

        request.Headers.Accept.ParseAdd("application/json");
        // Without this, Azure DevOps 302s to a login HTML page instead of 401.
        request.Headers.TryAddWithoutValidation("X-TFS-FedAuthRedirect", "Suppress");
        if (connection.BasicAuth is not null)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(connection.BasicAuth)));
        }
    }

    /// <summary>
    /// Same-cloud aliases only. HttpClient would otherwise follow
    /// dev.azure.com → {org}.visualstudio.com and drop Authorization (different host).
    /// </summary>
    internal static bool IsTrustedCatalogHost(Uri uri)
    {
        var host = uri.Host;
        return host.Equals("api.github.com", StringComparison.OrdinalIgnoreCase)
            || host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            || host.Equals("dev.azure.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".dev.azure.com", StringComparison.OrdinalIgnoreCase)
            || host.Equals("visualstudio.com", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".visualstudio.com", StringComparison.OrdinalIgnoreCase);
    }

    private static string? TryGetContinuation(HttpResponseMessage response) =>
        response.Headers.TryGetValues("x-ms-continuationtoken", out var values)
            ? values.FirstOrDefault()
            : null;

    private static bool LooksLikeHtml(string payload, HttpResponseMessage response)
    {
        var media = response.Content.Headers.ContentType?.MediaType;
        if (media is not null && media.Contains("html", StringComparison.OrdinalIgnoreCase))
            return true;
        var trim = payload.AsSpan().TrimStart();
        return trim.StartsWith("<", StringComparison.Ordinal);
    }

    private static string? ReadAzureMessage(string payload)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            return ReadString(doc.RootElement, "message");
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? ReadString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private sealed class CatalogJson(JsonDocument document, string? continuationToken) : IDisposable
    {
        public JsonDocument Document { get; } = document;
        public string? ContinuationToken { get; } = continuationToken;
        public void Dispose() => Document.Dispose();
    }
}
