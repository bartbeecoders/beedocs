namespace BeeDocs.Api.Services;

/// <summary>
/// Protects the external <c>/api/v1</c> surface (and <c>/api/llm</c>) when an
/// API key is configured — stored via the Settings page or
/// <see cref="ApiKeyOptions.ApiKey"/> as fallback.
///
/// The key is a machine credential (MCP, publishing apps). A signed-in browser
/// session is a person credential and is accepted either way, so Settings →
/// AI providers and in-editor writing help keep working after an admin sets a
/// publish key. Anonymous callers still need the key (or the anonymous-publish
/// opt-in, when none is configured). Auth-off instances reach <c>/api/llm</c>
/// from the UI only while no key is set — that is the open-port protection
/// for a route that spends money.
/// </summary>
public sealed class ApiKeyEndpointFilter(ApiKeySettingsService apiKeys) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var expected = await apiKeys.GetEffectiveKeyAsync(http.RequestAborted);
        var caller = http.GetCurrentUser();
        var path = http.Request.Path.Value ?? "";
        var isPublishApi = path.Contains("/v1", StringComparison.OrdinalIgnoreCase);

        if (!string.IsNullOrEmpty(expected))
        {
            if (TryGetProvidedKey(http.Request, out var provided)
                && ApiKeySettingsService.FixedTimeEquals(provided, expected))
            {
                return await next(context);
            }

            // The browser never holds the machine key. A signed-in session already
            // passed AuthEndpointFilter; refusing it here is what made Settings →
            // AI providers report "Not available on this deployment" the moment
            // an admin saved a publish key.
            if (caller.Via == "session")
                return await next(context);

            http.Response.Headers.WWWAuthenticate = "Bearer realm=\"beedocs-api\"";
            return Results.Json(
                new
                {
                    error = "Unauthorized",
                    message = "Provide a valid API key via Authorization: Bearer <key> or X-Api-Key: <key>.",
                },
                statusCode: StatusCodes.Status401Unauthorized);
        }

        // No key configured. Anonymous publish is an explicit opt-in; without it
        // only a session (or an ungated /api/llm call while auth is off) proceeds.
        if (await apiKeys.GetAllowAnonymousPublishAsync(http.RequestAborted))
            return await next(context);

        if (caller.Via == "session")
            return await next(context);

        if (!isPublishApi && caller.Via == "open")
            return await next(context);

        http.Response.Headers.WWWAuthenticate = "Bearer realm=\"beedocs-api\"";
        return Results.Json(
            new
            {
                error = "Unauthorized",
                message = isPublishApi
                    ? "Publishing requires an API key, or an admin opt-in to anonymous publish (Settings → Sign-in & API)."
                    : "Provide a valid API key via Authorization: Bearer <key> or X-Api-Key: <key>.",
            },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    private static bool TryGetProvidedKey(HttpRequest request, out string key)
    {
        key = string.Empty;

        if (request.Headers.TryGetValue("X-Api-Key", out var headerKey))
        {
            var raw = headerKey.ToString().Trim();
            if (raw.Length > 0)
            {
                key = raw;
                return true;
            }
        }

        var auth = request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            key = auth["Bearer ".Length..].Trim();
            return key.Length > 0;
        }

        return false;
    }
}
