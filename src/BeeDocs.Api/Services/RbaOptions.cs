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
    /// sign-in undoing it. Forced off in <see cref="Offline"/> mode — there is no
    /// server-side lookup to sync from.
    /// </summary>
    public bool SyncRoles { get; set; } = true;

    /// <summary>
    /// The BeeDocs server cannot reach RBA (cloud-hosted API, on-prem RBA) but
    /// the users' browsers can. Sign-in stays client-side; tokens are verified
    /// against <see cref="Jwks"/> instead of a live JWKS fetch, the role lookup
    /// is skipped (new accounts start as viewer, roles are managed on the Users
    /// page), and the server never dials the base URL.
    /// </summary>
    public bool Offline { get; set; }

    /// <summary>
    /// RBA's public signing keys, pasted as the JWKS JSON from
    /// <c>{BaseUrl}/.well-known/jwks.json</c>. Required in <see cref="Offline"/>
    /// mode; when set in online mode it is tried first, with the live JWKS as
    /// fallback. Public material, not a secret.
    /// </summary>
    public string Jwks { get; set; } = "";

    public int TimeoutSeconds { get; set; } = 15;
}
