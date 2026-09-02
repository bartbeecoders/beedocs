namespace BeeDocs.Api.Services;

/// <summary>
/// Optional seed of one LLM provider from configuration, so a hosted deploy can
/// set the key without opening Settings (the UI cannot save a key once
/// <c>BeeDocs:ApiKey</c> is set). Applied at startup by
/// <see cref="ILlmProviderService.EnsureFromConfigAsync"/>: a non-empty
/// <see cref="ApiKey"/> upserts an enabled provider of <see cref="Kind"/>.
/// Empty / unset is a no-op, so local installs are unchanged.
/// </summary>
public sealed class LlmOptions
{
    public const string SectionName = "BeeDocs:Llm";

    /// <summary>
    /// <c>openrouter</c> (default), <c>xai</c>, or <c>openai</c>. CLI kinds are
    /// ignored — they do not take a stored key.
    /// </summary>
    public string Kind { get; set; } = LlmProviderKinds.OpenRouter;

    /// <summary>Provider secret. Empty / unset = do not seed.</summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Optional model id. On create, empty takes the kind's default. On update,
    /// empty leaves the stored model alone.
    /// </summary>
    public string? Model { get; set; }

    /// <summary>Optional display name. Empty takes the kind's default on create.</summary>
    public string? Name { get; set; }

    /// <summary>Optional base URL. Empty takes the kind's default on create.</summary>
    public string? BaseUrl { get; set; }
}
