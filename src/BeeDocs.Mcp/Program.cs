using System.Security.Cryptography;
using System.Text;
using BeeDocs.Mcp;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

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
    AddBeeDocsMcpServer(builder.Services, instructions)
        .WithStdioServerTransport();

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
AddBeeDocsMcpServer(web.Services, instructions)
    // 2026-07-28 dropped protocol-level sessions outright; Stateless also keeps
    // pre-2026 clients from pinning themselves to one pod (see Docs/MCP-HOSTING.md).
    .WithHttpTransport(o => o.Stateless = true);

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

static IMcpServerBuilder AddBeeDocsMcpServer(IServiceCollection services, string instructions)
{
    // SEP-2549 (protocol 2026-07-28) requires ttlMs/cacheScope on every listing and
    // resource read. The SDK defaults them to "immediately stale, private"; BeeDocs'
    // tools, prompts and resource templates are compiled into the assembly, so they are
    // identical for every caller and cannot change until the process restarts.
    var staticTtl = TimeSpan.FromMinutes(5);

    var builder = services
        .AddMcpServer(o =>
        {
            o.ServerInfo = new Implementation { Name = "beedocs", Version = "1.0.0" };
            o.ServerInstructions = instructions;
        })
        .WithToolsFromAssembly()
        .WithResourcesFromAssembly()
        .WithPromptsFromAssembly()
        .WithRequestFilters(f => f
            .AddListToolsFilter(next => async (ctx, ct) =>
            {
                var result = await next(ctx, ct);
                // Tools are collected by reflection, so their order is not stable across
                // builds; 2026-07-28 asks for a deterministic order so clients can cache
                // the listing and keep LLM prompt-cache hits.
                result.Tools = [.. result.Tools.OrderBy(t => t.Name, StringComparer.Ordinal)];
                return Cacheable(result);
            })
            .AddListPromptsFilter(next => async (ctx, ct) =>
            {
                var result = await next(ctx, ct);
                result.Prompts = [.. result.Prompts.OrderBy(p => p.Name, StringComparer.Ordinal)];
                return Cacheable(result);
            })
            .AddListResourcesFilter(next => async (ctx, ct) =>
            {
                var result = await next(ctx, ct);
                result.Resources = [.. result.Resources.OrderBy(r => r.Uri, StringComparer.Ordinal)];
                return Cacheable(result);
            })
            .AddListResourceTemplatesFilter(next => async (ctx, ct) =>
            {
                var result = await next(ctx, ct);
                result.ResourceTemplates =
                    [.. result.ResourceTemplates.OrderBy(r => r.UriTemplate, StringComparer.Ordinal)];
                return Cacheable(result);
            })
            .AddReadResourceFilter(next => async (ctx, ct) =>
            {
                var result = await next(ctx, ct);
                // Only the shape catalog is static; every other resource reads live
                // BeeDocs content and keeps the SDK's "do not cache" default.
                return ctx.Params?.Uri == "beedocs://diagram/catalog" ? Cacheable(result) : result;
            }));

    // Roots, Sampling and Logging are all Deprecated as of 2026-07-28 and BeeDocs uses
    // none of them: our logs go to stderr (stdio) or the ASP.NET logger (HTTP), never to
    // the client. The SDK still advertises the logging capability on its own; that is
    // harmless because nothing here ever emits notifications/message.
    return builder;

    T Cacheable<T>(T result) where T : ICacheableResult
    {
        result.TimeToLive = staticTtl;
        result.CacheScope = CacheScope.Public;
        return result;
    }
}

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
