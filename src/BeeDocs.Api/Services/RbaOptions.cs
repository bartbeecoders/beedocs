namespace BeeDocs.Api.Services;

/// <summary>
/// Delegate sign-in to the central RBA service (role-based access, backed by
/// ADFS/Entra). Off by default and layered *on top of* <see cref="AuthOptions"/>:
/// RBA replaces only how a password is checked and where a role comes from —
/// sessions, cookies, the endpoint filter and the API key all keep working
/// exactly as they do for local accounts, because a successful RBA login is
/// turned into an ordinary <c>app_user</c> row plus an ordinary session.
/// </summary>
public sealed class RbaOptions
{
    public const string SectionName = "BeeDocs:Rba";

    /// <summary>
    /// When true (and <see cref="AuthOptions.Enabled"/> is on), /api/auth/login
    /// verifies credentials against RBA instead of the local password column,
    /// and local password management is switched off.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>Base URL of the RBA API, e.g. <c>https://rba.example.com</c>. The login call goes to <c>{BaseUrl}/v1/auth/token/basic</c>.</summary>
    public string BaseUrl { get; set; } = "";

    /// <summary>The RBA application this instance is registered as. Groups/actions of other applications in the token are ignored.</summary>
    public string ApplicationCd { get; set; } = "DOC";

    /// <summary>
    /// Restrict to one plant's security entries. Empty (the default) accepts a
    /// DOC role granted at any plant — BeeDocs itself is not plant-scoped.
    /// </summary>
    public string PlantCd { get; set; } = "";

    /// <summary>
    /// Re-derive the BeeDocs role from RBA groups on every login (default). Turn
    /// off to let a local admin override roles in the Users page without the next
    /// sign-in undoing it.
    /// </summary>
    public bool SyncRoles { get; set; } = true;

    public int TimeoutSeconds { get; set; } = 15;
}
