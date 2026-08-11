using BeeDocs.Api.Models;
using Microsoft.Extensions.Options;

namespace BeeDocs.Api.Services;

/// <summary>Marks an endpoint reachable without a session — health, version, and sign-in itself.</summary>
public sealed record AllowAnonymousEndpoint;

/// <summary>
/// Raises the bar for one endpoint above the default (read = any role, write =
/// editor or admin). Used for account management and the LLM provider settings,
/// where a GET is as sensitive as a PUT.
/// </summary>
public sealed record RequireRole(string Role)
{
    public static readonly RequireRole Admin = new(UserRoles.Admin);
}

public static class AuthHttpContextExtensions
{
    private const string ItemKey = "BeeDocs.CurrentUser";

    public static void SetCurrentUser(this HttpContext context, CurrentUser user) =>
        context.Items[ItemKey] = user;

    /// <summary>
    /// The caller behind this request. Falls back to <see cref="CurrentUser.Open"/>
    /// so a handler reading it never has to care whether auth is switched on.
    /// </summary>
    public static CurrentUser GetCurrentUser(this HttpContext context) =>
        context.Items.TryGetValue(ItemKey, out var value) && value is CurrentUser user
            ? user
            : CurrentUser.Open;
}

/// <summary>
/// Turns a request into a <see cref="CurrentUser"/>: a session cookie, the shared
/// API key, or nobody. Shared by the <c>/api</c> endpoint filter and the
/// <c>/uploads</c> middleware so both agree on who is calling — an instance that
/// gates its pages but serves every uploaded screenshot to anyone with the URL
/// is not actually gated.
/// </summary>
public sealed class RequestAuthenticator(
    IOptions<AuthOptions> authOptions,
    IOptions<ApiKeyOptions> apiKeyOptions,
    IUserService users)
{
    public bool Enabled => authOptions.Value.Enabled;

    public string CookieName => authOptions.Value.CookieName;

    public async Task<CurrentUser?> ResolveAsync(HttpContext http)
    {
        // The API key first: it is how MCP and publishing apps reach an instance
        // that has sign-in switched on, and it authenticates a machine, not a
        // person — so it gets admin authority and no profile.
        var expected = apiKeyOptions.Value.ApiKey?.Trim();
        if (!string.IsNullOrEmpty(expected) && TryGetApiKey(http.Request, out var provided)
            && FixedTimeEquals(provided, expected))
        {
            return CurrentUser.ApiKey;
        }

        var token = http.Request.Cookies[authOptions.Value.CookieName];
        if (string.IsNullOrEmpty(token)) return null;

        var user = await users.ResolveSessionAsync(token, http.RequestAborted);
        return user is null ? null : ToCurrentUser(user);
    }

    public static CurrentUser ToCurrentUser(UserDto user) => new("session", user.Role, user);

    private static bool TryGetApiKey(HttpRequest request, out string key)
    {
        key = string.Empty;

        if (request.Headers.TryGetValue("X-Api-Key", out var headerKey)
            && headerKey.ToString().Trim() is { Length: > 0 } raw)
        {
            key = raw;
            return true;
        }

        var auth = request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            key = auth["Bearer ".Length..].Trim();
            return key.Length > 0;
        }

        return false;
    }

    /// <summary>Returns false for a length mismatch rather than throwing, so it is safe on attacker-chosen input.</summary>
    private static bool FixedTimeEquals(string a, string b) =>
        System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(a),
            System.Text.Encoding.UTF8.GetBytes(b));
}

/// <summary>
/// The one gate in front of <c>/api</c>. It resolves who is calling and checks
/// that role against what the endpoint asks for.
///
/// Two things it deliberately does not do:
/// <list type="bullet">
/// <item>Nothing when <see cref="AuthOptions.Enabled"/> is off. Accounts still
/// exist and are manageable; enforcement is the only part behind the switch, so
/// upgrading an existing deployment changes nothing until someone opts in.</item>
/// <item>Re-derive permissions per handler. The default rule is read-for-everyone,
/// write-for-editors, which covers every content route in Program.cs; only the
/// exceptions carry <see cref="RequireRole"/> metadata.</item>
/// </list>
/// </summary>
public sealed class AuthEndpointFilter(RequestAuthenticator authenticator) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var endpoint = http.GetEndpoint();

        if (endpoint?.Metadata.GetMetadata<AllowAnonymousEndpoint>() is not null)
            return await next(context);

        if (!authenticator.Enabled)
        {
            http.SetCurrentUser(CurrentUser.Open);
            return await next(context);
        }

        var caller = await authenticator.ResolveAsync(http);
        if (caller is null)
        {
            http.Response.Headers.WWWAuthenticate = "Cookie realm=\"beedocs\"";
            return Results.Json(
                new
                {
                    error = "Unauthorized",
                    message = "Sign in to use this API, or send the configured API key.",
                },
                statusCode: StatusCodes.Status401Unauthorized);
        }

        http.SetCurrentUser(caller);

        var required = endpoint?.Metadata.GetMetadata<RequireRole>()?.Role
            ?? (IsRead(http.Request.Method) ? UserRoles.Viewer : UserRoles.Editor);

        if (!UserRoles.Satisfies(caller.Role, required))
        {
            return Results.Json(
                new
                {
                    error = "Forbidden",
                    message = required == UserRoles.Admin
                        ? "This action needs an admin account."
                        : "Your account has read-only access.",
                },
                statusCode: StatusCodes.Status403Forbidden);
        }

        return await next(context);
    }

    /// <summary>
    /// GET/HEAD/OPTIONS are the reads. Everything else writes — including the few
    /// POSTs that are not obviously edits (reindex, import), which is the safe way
    /// round: a viewer who cannot rebuild the search index loses nothing.
    /// </summary>
    private static bool IsRead(string method) =>
        HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method);
}
