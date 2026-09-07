namespace BeeDocs.Api.Services;

/// <summary>
/// Optional shared secret for the external REST publish API (<c>/api/v1</c>).
/// When empty, <c>/api/v1</c> is closed unless an admin has opted into
/// anonymous publishing. When set, callers must send
/// <c>Authorization: Bearer &lt;key&gt;</c> or <c>X-Api-Key: &lt;key&gt;</c>.
/// </summary>
public sealed class ApiKeyOptions
{
    public const string SectionName = "BeeDocs";

    /// <summary>Shared secret. Empty / unset = key required, unless anonymous publish is opted in.</summary>
    public string? ApiKey { get; set; }
}
