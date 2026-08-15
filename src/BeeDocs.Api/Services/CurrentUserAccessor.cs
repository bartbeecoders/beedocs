namespace BeeDocs.Api.Services;

/// <summary>
/// Who to record against a change. <see cref="Id"/> is null for callers that are
/// not accounts — the shared API key (a machine) and, when sign-in is switched
/// off, everyone — so ownership and history stay honest about not knowing rather
/// than inventing an author.
/// </summary>
/// <param name="Name">Display name captured at the time of the change.</param>
/// <param name="IsAdmin">
/// Whether the caller carries admin authority — a signed-in admin, the API key,
/// or anyone at all when sign-in is off. Owner-gated settings (page change
/// tracking) accept the owner or this.
/// </param>
public sealed record CurrentActor(string? Id, string? Name, bool IsAdmin = false)
{
    /// <summary>Nothing identified the caller — outside a request entirely.</summary>
    public static readonly CurrentActor Unknown = new(null, null);
}

/// <summary>
/// The acting user for the request in flight.
/// <para>
/// This exists because ownership and page history are recorded deep inside
/// <see cref="DocumentService"/>, which is a singleton reached from four
/// directions — the UI routes, <c>/api/v1</c>, imports, and the MCP server — and
/// threading an actor through every method of <see cref="IDocumentService"/>,
/// <see cref="IImportService"/> and their callers would touch far more code than
/// the feature is worth. One clearly named seam is the smaller change.
/// </para>
/// </summary>
public interface ICurrentUserAccessor
{
    CurrentActor Current { get; }
}

/// <summary>
/// Reads the <see cref="CurrentUser"/> that <see cref="AuthEndpointFilter"/> put
/// on the request. Outside a request (startup seeding, a background job) there is
/// no HttpContext and the answer is <see cref="CurrentActor.Unknown"/>.
/// </summary>
public sealed class HttpCurrentUserAccessor(IHttpContextAccessor accessor) : ICurrentUserAccessor
{
    public CurrentActor Current
    {
        get
        {
            var http = accessor.HttpContext;
            if (http is null) return CurrentActor.Unknown;

            var caller = http.GetCurrentUser();
            return caller.Via switch
            {
                // A person. Prefer the display name; the username is what they typed.
                "session" when caller.User is { } user =>
                    new CurrentActor(
                        user.Id,
                        string.IsNullOrWhiteSpace(user.DisplayName) ? user.Username : user.DisplayName,
                        caller.CanManageUsers),
                // A machine holding BeeDocs:ApiKey — real, attributable, but not an account.
                "apiKey" => new CurrentActor(null, "API key", IsAdmin: true),
                // Sign-in is off: unidentified but unrestricted, like everywhere else.
                "open" => new CurrentActor(null, null, IsAdmin: true),
                _ => CurrentActor.Unknown,
            };
        }
    }
}
