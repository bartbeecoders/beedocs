namespace BeeDocs.Api.Services;

/// <summary>
/// Protects the external <c>/api/v1</c> surface when an API key is configured —
/// stored via the Settings page or <see cref="ApiKeyOptions.ApiKey"/> as fallback.
/// </summary>
public sealed class ApiKeyEndpointFilter(ApiKeySettingsService apiKeys) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var expected = await apiKeys.GetEffectiveKeyAsync(http.RequestAborted);
        if (string.IsNullOrEmpty(expected))
            return await next(context);

        if (TryGetProvidedKey(http.Request, out var provided)
            && ApiKeySettingsService.FixedTimeEquals(provided, expected))
        {
            return await next(context);
        }

        http.Response.Headers.WWWAuthenticate = "Bearer realm=\"beedocs-api\"";
        return Results.Json(
            new
            {
                error = "Unauthorized",
                message = "Provide a valid API key via Authorization: Bearer <key> or X-Api-Key: <key>.",
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
