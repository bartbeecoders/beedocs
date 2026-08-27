using System.Text.Json;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>How an RBA login attempt ended. Only <see cref="Success"/> carries a user.</summary>
public enum RbaAuthStatus
{
    Success,

    /// <summary>RBA rejected the credentials (or knows no such user) — a 401 upstream.</summary>
    InvalidCredentials,

    /// <summary>Credentials were fine but no group of this application is assigned to the account.</summary>
    NoAccess,

    /// <summary>RBA could not be reached or answered something unexpected. Not the caller's fault.</summary>
    Unavailable,
}

/// <summary>What BeeDocs keeps from an RBA login: identity plus the mapped local role.</summary>
public sealed record RbaUserInfo(string UserCd, string? DisplayName, string? Email, string Role);

public sealed record RbaAuthResult(RbaAuthStatus Status, RbaUserInfo? User = null);

public interface IRbaAuthService
{
    Task<RbaAuthResult> AuthenticateAsync(string username, string password, CancellationToken ct = default);

    /// <summary>
    /// The client-side login path: the browser exchanged credentials with RBA
    /// directly and hands BeeDocs only the resulting JWT. The token's RS256
    /// signature is verified against RBA's JWKS, identity is read from the
    /// *verified* claims, and the DOC roles are fetched from RBA — the token
    /// itself does not carry them, and the browser is not trusted to say them.
    /// </summary>
    Task<RbaAuthResult> AuthenticateWithTokenAsync(string token, CancellationToken ct = default);

    /// <summary>
    /// Settings-page probe. Without credentials it only answers "is something
    /// RBA-shaped at that URL"; with credentials it runs the real login path and
    /// reports the role the account would get — no session, no provisioning.
    /// </summary>
    Task<RbaTestResultDto> TestConnectionAsync(string? username, string? password, CancellationToken ct = default);
}

/// <summary>
/// The one place BeeDocs talks to RBA: POST <c>/v1/auth/token/basic</c> with the
/// typed credentials, then reduce the multi-plant, multi-application security
/// answer to a single BeeDocs role. The mapping is group-name first
/// (<c>DOC_ADMIN</c> / <c>DOC_EDITOR</c> / <c>DOC_VIEWER</c>, or any group with
/// that suffix), with an action-based fallback so a custom RBA group that only
/// grants actions still lands on the least role that covers them. Settings come
/// from <see cref="RbaSettingsService"/> per call, so a toggle on the Settings
/// page applies to the very next login.
/// </summary>
public sealed class RbaAuthService(
    HttpClient http,
    RbaSettingsService settings,
    ILogger<RbaAuthService> logger) : IRbaAuthService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<RbaAuthResult> AuthenticateAsync(string username, string password, CancellationToken ct = default)
    {
        var opts = await settings.GetEffectiveAsync(ct);
        if (opts.BaseUrl.Length == 0)
        {
            logger.LogError("RBA sign-in is enabled but the base URL is empty — every login will fail.");
            return new RbaAuthResult(RbaAuthStatus.Unavailable);
        }

        return await LoginAsync(new { username, password }, opts, ct);
    }

    public async Task<RbaAuthResult> AuthenticateWithTokenAsync(string token, CancellationToken ct = default)
    {
        var opts = await settings.GetEffectiveAsync(ct);
        if (opts.BaseUrl.Length == 0)
        {
            logger.LogError("RBA sign-in is enabled but the base URL is empty — every login will fail.");
            return new RbaAuthResult(RbaAuthStatus.Unavailable);
        }

        // Signature first. RBA's own token check on the lookup call below does
        // not verify the signature for its self-issued tokens, so this JWKS
        // check is the thing standing between a hand-crafted token and a session.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(opts.TimeoutSeconds));

        using var claims = await RbaTokenValidator.ValidateAsync(http, opts.BaseUrl, token, cts.Token);
        if (claims is null)
            return new RbaAuthResult(RbaAuthStatus.InvalidCredentials);

        var username = ReadClaim(claims, "preferred_username") ?? ReadClaim(claims, "username") ?? ReadClaim(claims, "name");
        if (string.IsNullOrWhiteSpace(username))
            return new RbaAuthResult(RbaAuthStatus.InvalidCredentials);

        // The roles live only in RBA's database; the adfsToken variant of the
        // login endpoint returns the fresh MultiAuthuser without a password.
        return await LoginAsync(new { username, adfsToken = token }, opts, ct);
    }

    private static string? ReadClaim(System.Text.Json.JsonDocument claims, string name) =>
        claims.RootElement.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private async Task<RbaAuthResult> LoginAsync(object payload, RbaSettings opts, CancellationToken ct)
    {
        // The timeout is a setting, and the HttpClient is shared — so the budget
        // is per-call rather than baked into the client at startup.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(opts.TimeoutSeconds));

        HttpResponseMessage response;
        try
        {
            response = await http.PostAsJsonAsync(
                $"{opts.BaseUrl}/v1/auth/token/basic",
                payload,
                Json,
                cts.Token);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            logger.LogWarning(e, "RBA login call to {BaseUrl} failed.", opts.BaseUrl);
            return new RbaAuthResult(RbaAuthStatus.Unavailable);
        }

        using (response)
        {
            // RBA answers 401 for a wrong password, an unknown user and a
            // disabled account alike — exactly the indistinguishability the
            // local login already promises, so it is passed through as-is.
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                return new RbaAuthResult(RbaAuthStatus.InvalidCredentials);

            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("RBA login answered {Status}.", (int)response.StatusCode);
                return new RbaAuthResult(RbaAuthStatus.Unavailable);
            }

            RbaMultiAuthUser? user;
            try
            {
                user = await response.Content.ReadFromJsonAsync<RbaMultiAuthUser>(Json, cts.Token);
            }
            catch (JsonException e)
            {
                logger.LogWarning(e, "RBA login answered 200 with a body that is not a MultiAuthuser.");
                return new RbaAuthResult(RbaAuthStatus.Unavailable);
            }

            if (user is null || string.IsNullOrWhiteSpace(user.UserName))
                return new RbaAuthResult(RbaAuthStatus.Unavailable);

            var role = MapRole(user, opts);
            if (role is null)
                return new RbaAuthResult(RbaAuthStatus.NoAccess);

            var displayName = $"{user.FirstName} {user.LastName}".Trim();
            return new RbaAuthResult(
                RbaAuthStatus.Success,
                new RbaUserInfo(
                    user.UserName.Trim(),
                    displayName.Length > 0 ? displayName : null,
                    string.IsNullOrWhiteSpace(user.Email) ? null : user.Email.Trim(),
                    role));
        }
    }

    public async Task<RbaTestResultDto> TestConnectionAsync(
        string? username,
        string? password,
        CancellationToken ct = default)
    {
        var opts = await settings.GetEffectiveAsync(ct);
        if (opts.BaseUrl.Length == 0)
            return new RbaTestResultDto(false, "unavailable", null, null, "No RBA base URL is set.");

        if (!string.IsNullOrWhiteSpace(username) && !string.IsNullOrEmpty(password))
        {
            var result = await AuthenticateAsync(username, password, ct);
            return result.Status switch
            {
                RbaAuthStatus.Success => new RbaTestResultDto(
                    true, "success", result.User!.Role, result.User.UserCd,
                    $"Signed in as {result.User.UserCd}; this account would get the '{result.User.Role}' role."),
                RbaAuthStatus.InvalidCredentials => new RbaTestResultDto(
                    true, "invalidCredentials", null, null,
                    "RBA is reachable, but it rejected these credentials."),
                RbaAuthStatus.NoAccess => new RbaTestResultDto(
                    true, "noAccess", null, null,
                    $"RBA accepted the credentials, but the account holds no {opts.ApplicationCd} group."),
                _ => new RbaTestResultDto(false, "unavailable", null, null, "RBA could not be reached."),
            };
        }

        // No credentials: probe with ones no directory will accept. A 401 back is
        // the RBA login endpoint working exactly as it should.
        var probe = await AuthenticateAsync(
            "__beedocs_probe__", PasswordHasher.GenerateToken(), ct);
        return probe.Status == RbaAuthStatus.Unavailable
            ? new RbaTestResultDto(false, "unavailable", null, null,
                "RBA could not be reached at that URL.")
            : new RbaTestResultDto(true, "reachable", null, null,
                "RBA answered — the login endpoint is reachable.");
    }

    /// <summary>
    /// Null when the account has no group of this application at all — which is
    /// the RBA way of saying "no access", and is reported as such rather than
    /// silently mapped to viewer.
    /// </summary>
    private static string? MapRole(RbaMultiAuthUser user, RbaSettings opts)
    {
        var groups = new List<string>();
        var actions = new List<string>();

        foreach (var plant in user.PlantSecurity ?? [])
        {
            if (opts.PlantCd.Length > 0
                && !string.Equals(plant.PlantCd, opts.PlantCd, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var app in plant.AppSecurity ?? [])
            {
                if (!string.Equals(app.ApplicationCd, opts.ApplicationCd, StringComparison.OrdinalIgnoreCase))
                    continue;

                groups.AddRange(app.Roles ?? []);
                actions.AddRange((app.Actions ?? []).Select(a => a.Name ?? ""));
            }
        }

        if (groups.Count == 0 && actions.Count == 0) return null;

        var appCd = opts.ApplicationCd.ToUpperInvariant();

        if (HasGroup(groups, "_ADMIN") || Has(actions, $"{appCd}_USER_MANAGE"))
            return UserRoles.Admin;

        // Any writing capability lands on editor: the suffix convention covers
        // the standard groups, the _WRITE scan covers hand-rolled ones.
        if (HasGroup(groups, "_EDITOR")
            || actions.Any(a => a.Contains("_WRITE", StringComparison.OrdinalIgnoreCase)))
        {
            return UserRoles.Editor;
        }

        return UserRoles.Viewer;
    }

    private static bool HasGroup(List<string> groups, string suffix) =>
        groups.Any(g => g.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));

    private static bool Has(List<string> actions, string name) =>
        actions.Any(a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));

    // The subset of RBA's MultiAuthuser this integration reads. RBA serializes
    // with System.Text.Json web defaults (camelCase), matched by Json above.
    private sealed record RbaMultiAuthUser(
        string? UserName,
        string? FirstName,
        string? LastName,
        string? Email,
        List<RbaPlantSecurity>? PlantSecurity);

    private sealed record RbaPlantSecurity(string? PlantCd, List<RbaAppSecurity>? AppSecurity);

    private sealed record RbaAppSecurity(string? ApplicationCd, List<RbaActionInfo>? Actions, List<string>? Roles);

    private sealed record RbaActionInfo(string? Name, bool RequiresEditMode);
}
