namespace BeeDocs.Host;

public sealed class BeeDocsHostOptions
{
    public const string SectionName = "BeeDocsHost";

    /// <summary>
    /// Listen port for the SPA (and API if <see cref="ApiPort"/> equals this).
    /// ReverseProxy: https://server/beedocs → http://localhost:{UiPort}
    /// </summary>
    public int UiPort { get; set; } = 8080;

    /// <summary>
    /// Listen port for the REST API + uploads.
    /// ReverseProxy: https://server/beedocs-api → http://localhost:{ApiPort}
    /// Same BeeDocs.Api process; when different from <see cref="UiPort"/> the process
    /// binds both ports. Set equal to <see cref="UiPort"/> for a single upstream.
    /// </summary>
    public int ApiPort { get; set; } = 8081;

    public int McpPort { get; set; } = 5090;

    public string McpAuthToken { get; set; } = "change-me";

    /// <summary>HTTP bind address for the MCP server (passed to MCP_HTTP_HOST).</summary>
    public string McpBindHost { get; set; } = "0.0.0.0";

    /// <summary>
    /// Public path prefix on the reverse proxy for the SPA
    /// (e.g. "/beedocs"). The backend still listens at root; this is baked into
    /// the web build so the browser requests /beedocs/... which the proxy strips.
    /// </summary>
    public string UiPathBase { get; set; } = "";

    /// <summary>
    /// Public path prefix on the reverse proxy for the REST API + uploads
    /// (e.g. "/beedocs-api"). Empty = same as <see cref="UiPathBase"/>.
    /// Backend still serves /api and /uploads at root on <see cref="ApiPort"/>.
    /// </summary>
    public string ApiPathBase { get; set; } = "";

    /// <summary>
    /// Public path prefix on the reverse proxy for MCP
    /// (e.g. "/beedocs-mcp" → upstream http://localhost:{McpPort}/mcp).
    /// Backend still listens at /mcp; this is documentation / logging only.
    /// </summary>
    public string McpPathBase { get; set; } = "";

    /// <summary>Folder containing BeeDocs.Api.dll (relative to the host content root).</summary>
    public string ApiDirectory { get; set; } = "api";

    /// <summary>Folder containing the built MCP server (relative to the host content root).</summary>
    public string McpDirectory { get; set; } = "mcp";

    /// <summary>Node executable name or full path.</summary>
    public string NodeExecutable { get; set; } = "node";

    /// <summary>Persistent data root (SurrealDB + uploads), relative to the host content root.</summary>
    public string DataDirectory { get; set; } = "data";

    public string LogsDirectory { get; set; } = "logs";

    public int HealthTimeoutSeconds { get; set; } = 120;

    /// <summary>ASPNETCORE_URLS value — one or both of UI/API ports.</summary>
    public string BuildAspNetCoreUrls()
    {
        if (UiPort == ApiPort)
        {
            return $"http://0.0.0.0:{ApiPort}";
        }

        return $"http://0.0.0.0:{UiPort};http://0.0.0.0:{ApiPort}";
    }

    /// <summary>Normalize a path base to "/foo" or empty (no trailing slash).</summary>
    public static string NormalizePathBase(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Trim() == "/")
        {
            return "";
        }

        var path = value.Trim();
        if (!path.StartsWith('/'))
        {
            path = "/" + path;
        }

        return path.TrimEnd('/');
    }
}
