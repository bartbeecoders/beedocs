namespace BeeDocs.Api.Services;

/// <summary>
/// Optional shared secret for the external REST publish API (<c>/api/v1</c>).
/// When empty, the v1 API is open (local/dev). When set, callers must send
/// <c>Authorization: Bearer &lt;key&gt;</c> or <c>X-Api-Key: &lt;key&gt;</c>.
/// </summary>
public sealed class ApiKeyOptions
{
    public const string SectionName = "BeeDocs";

    /// <summary>Shared secret. Empty / unset = no auth required on /api/v1.</summary>
    public string? ApiKey { get; set; }
}
