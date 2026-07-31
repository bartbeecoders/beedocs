using System.Security.Cryptography;
using System.Text;
using BeeDocs.Mcp;
using ModelContextProtocol.Protocol;

var transport = (Environment.GetEnvironmentVariable("MCP_TRANSPORT") ?? "stdio")
    .Trim()
    .ToLowerInvariant();

if (transport is not ("stdio" or "http"))
{
    Console.Error.WriteLine($"[beedocs-mcp] unknown MCP_TRANSPORT '{transport}' (expected 'stdio' or 'http')");
    return 1;
}

var apiBase = BeeDocsApiClientFactory.ResolveBaseUrl();
var instructions = string.Join(' ',
    "BeeDocs MCP exposes the full documentation API to AI agents.",
    "Create books, Markdown pages, chapters, and diagrams (BeeDiagram JSON or Mermaid/C4).",
    $"API: {apiBase}",
    "Start with beedocs_health and beedocs_get_api_info if unsure.",
    "For architecture diagrams prefer beedocs_create_beediagram_with_nodes then beedocs_embed_diagram_in_page.");

if (transport == "stdio")
{
    var builder = Host.CreateApplicationBuilder(args);
    builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
    BeeDocsApiClientFactory.Configure(builder.Services.AddHttpClient<BeeDocsApiClient>());
    builder.Services
        .AddMcpServer(o =>
        {
            o.ServerInfo = new Implementation { Name = "beedocs", Version = "1.0.0" };
            o.ServerInstructions = instructions;
        })
        .WithStdioServerTransport()
        .WithToolsFromAssembly()
        .WithResourcesFromAssembly()
        .WithPromptsFromAssembly();

    await builder.Build().RunAsync();
    return 0;
}

// --- HTTP (Streamable) ---
var host = Environment.GetEnvironmentVariable("MCP_HTTP_HOST")?.Trim() is { Length: > 0 } h
    ? h
    : "0.0.0.0";
var port = int.TryParse(Environment.GetEnvironmentVariable("MCP_HTTP_PORT"), out var p) ? p : 5090;
var authToken = Environment.GetEnvironmentVariable("MCP_AUTH_TOKEN")?.Trim();
var pathBase = NormalizePathBase(Environment.GetEnvironmentVariable("MCP_PATH_BASE"));

var web = WebApplication.CreateBuilder(args);
web.WebHost.UseUrls($"http://{host}:{port}");
web.Logging.AddConsole();

BeeDocsApiClientFactory.Configure(web.Services.AddHttpClient<BeeDocsApiClient>());
web.Services
    .AddMcpServer(o =>
    {
        o.ServerInfo = new Implementation { Name = "beedocs", Version = "1.0.0" };
        o.ServerInstructions = instructions;
    })
    .WithHttpTransport(o => o.Stateless = true)
    .WithToolsFromAssembly()
    .WithResourcesFromAssembly()
    .WithPromptsFromAssembly();

var app = web.Build();

if (pathBase.Length > 0)
{
    app.UsePathBase(pathBase);
}

if (!string.IsNullOrEmpty(authToken))
{
    app.Use(async (ctx, next) =>
    {
        // Unauthenticated: readiness probes must not depend on a token or the API.
        if (ctx.Request.Path.StartsWithSegments("/healthz"))
        {
            await next();
            return;
        }

        if (!IsAuthorized(ctx.Request.Headers.Authorization, authToken))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            ctx.Response.Headers.WWWAuthenticate = "Bearer realm=\"beedocs-mcp\"";
            await ctx.Response.WriteAsJsonAsync(new
            {
                jsonrpc = "2.0",
                error = new { code = -32001, message = "Unauthorized: missing or invalid bearer token." },
                id = (object?)null,
            });
            return;
        }

        await next();
    });
}
else
{
    app.Logger.LogWarning(
        "MCP_AUTH_TOKEN is not set — every caller that can reach this port has full read/write access to BeeDocs.");
}

app.MapGet("/healthz", (BeeDocsApiClient client) =>
    Results.Json(new { status = "ok", service = "beedocs-mcp", api = client.BaseUrl }));

app.MapMcp("/mcp");

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.Error.WriteLine(
        $"[beedocs-mcp] http transport listening on http://{host}:{port}{pathBase}/mcp " +
        $"(API {apiBase}, auth {(string.IsNullOrEmpty(authToken) ? "DISABLED" : "enabled")})");
});

await app.RunAsync();
return 0;

static string NormalizePathBase(string? value)
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

static bool IsAuthorized(string? authorizationHeader, string expected)
{
    if (string.IsNullOrEmpty(authorizationHeader))
    {
        return false;
    }

    const string prefix = "Bearer ";
    if (!authorizationHeader.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    var provided = authorizationHeader[prefix.Length..].Trim();
    var a = Encoding.UTF8.GetBytes(provided);
    var b = Encoding.UTF8.GetBytes(expected);
    return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
}
