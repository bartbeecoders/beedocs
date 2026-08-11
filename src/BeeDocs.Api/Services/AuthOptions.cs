namespace BeeDocs.Api.Services;

/// <summary>
/// User accounts and sign-in. Off by default: BeeDocs has always served an open
/// port behind whatever the deployment puts in front of it (Cloudflare Access on
/// the hosted instance, nothing at all on localhost), and turning that into a
/// login wall on upgrade would lock out every existing MCP client and reverse
/// proxy at once. Accounts are still seeded and manageable while this is off —
/// only enforcement waits for <see cref="Enabled"/>.
/// </summary>
public sealed class AuthOptions
{
    public const string SectionName = "BeeDocs:Auth";

    /// <summary>
    /// When true every <c>/api</c> route needs a session cookie (or the configured
    /// <see cref="ApiKeyOptions.ApiKey"/>, which authenticates machines as admin).
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Session lifetime. Sliding: a session past its halfway point is extended on
    /// use, so an active editor is never signed out mid-edit.
    /// </summary>
    public int SessionHours { get; set; } = 168;

    public string CookieName { get; set; } = "beedocs_session";

    /// <summary>
    /// Force the <c>Secure</c> cookie flag. Left null the flag follows the request
    /// scheme, which is what a TLS-terminating proxy in front of plain HTTP needs
    /// — set it to true there, or the browser drops the cookie on the way back.
    /// </summary>
    public bool? SecureCookie { get; set; }

    public TimeSpan SessionLifetime =>
        TimeSpan.FromHours(SessionHours <= 0 ? 168 : SessionHours);
}
