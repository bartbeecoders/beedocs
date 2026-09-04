using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// An upstream provider call that failed, with a message already phrased for the
/// person who has to fix it. Endpoints return <see cref="Message"/> verbatim.
/// </summary>
public sealed class LlmException(string message, Exception? inner = null) : Exception(message, inner);

public interface ILlmClient
{
    /// <summary>Models the provider advertises. Unsorted upstream, sorted by id here.</summary>
    Task<IReadOnlyList<LlmModelDto>> ListModelsAsync(string providerId, CancellationToken ct = default);

    /// <summary>Proves reachability and credentials without spending anything. Never throws.</summary>
    Task<LlmTestResultDto> TestAsync(string providerId, CancellationToken ct = default);

    Task<LlmCompleteResponse> CompleteAsync(LlmCompleteRequest request, CancellationToken ct = default);
}

/// <summary>
/// One OpenAI-compatible chat client for the HTTP providers — they differ
/// only in base URL and whether a key is required, so the wire format is shared.
/// The two CLI kinds branch to <see cref="LlmCli"/> instead, which runs the
/// locally installed `claude`/`grok` command with the same prompts.
/// Keys are read from <see cref="ILlmProviderService.ResolveAsync"/> at call time
/// and never held anywhere else.
/// </summary>
public sealed class LlmClient(
    IHttpClientFactory httpClientFactory,
    ILlmProviderService providers,
    ILogger<LlmClient> logger
) : ILlmClient
{
    public const string HttpClientName = "llm";

    // The HttpClient timeout is only a backstop; these are the real budgets.
    private static readonly TimeSpan ModelsTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan TestTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan CompleteTimeout = TimeSpan.FromSeconds(90);

    /// <summary>DocDraft writes a whole document — an editing budget would cut it off.</summary>
    private static readonly TimeSpan DocDraftTimeout = TimeSpan.FromSeconds(240);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        // OpenAI's request fields are snake_case (max_tokens, …).
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public async Task<IReadOnlyList<LlmModelDto>> ListModelsAsync(string providerId, CancellationToken ct = default)
    {
        var provider = await providers.ResolveAsync(providerId, ct)
            ?? throw new KeyNotFoundException($"Provider '{providerId}' not found.");

        if (LlmProviderKinds.IsCli(provider.Kind))
            return LlmCli.Models(provider.Kind);

        return await FetchModelsAsync(provider, ct);
    }

    public async Task<LlmTestResultDto> TestAsync(string providerId, CancellationToken ct = default)
    {
        var provider = await providers.ResolveAsync(providerId, ct)
            ?? throw new KeyNotFoundException($"Provider '{providerId}' not found.");

        var started = Stopwatch.GetTimestamp();

        if (LlmProviderKinds.RequiresKey(provider.Kind) && string.IsNullOrEmpty(provider.ApiKey))
            return new LlmTestResultDto(false, $"No API key stored for {provider.Name}.", null, Elapsed(started));

        if (LlmProviderKinds.IsCli(provider.Kind))
        {
            // There is no endpoint to reach — the test is "does the command exist
            // and start". A model call would spend the user's plan for nothing.
            try
            {
                var message = await LlmCli.ProbeAsync(provider.Kind, ct);
                return new LlmTestResultDto(true, message, null, Elapsed(started));
            }
            catch (LlmException ex)
            {
                return new LlmTestResultDto(false, ex.Message, null, Elapsed(started));
            }
        }

        try
        {
            var models = await FetchModelsAsync(provider, ct, TestTimeout);

            // OpenRouter's /models is public, so listing it proves reachability but
            // says nothing about the key. /key is free and does prove it.
            var suffix = provider.Kind == LlmProviderKinds.OpenRouter
                ? await DescribeOpenRouterKeyAsync(provider, ct)
                : null;

            var message = $"Connected to {provider.Name}. {models.Count} model{(models.Count == 1 ? "" : "s")} available.";
            if (!string.IsNullOrEmpty(suffix))
                message += " " + suffix;

            return new LlmTestResultDto(true, message, models.Count, Elapsed(started));
        }
        catch (LlmException ex)
        {
            return new LlmTestResultDto(false, ex.Message, null, Elapsed(started));
        }
    }

    public async Task<LlmCompleteResponse> CompleteAsync(LlmCompleteRequest request, CancellationToken ct = default)
    {
        var task = LlmPrompts.NormalizeTask(request.Task)
            ?? throw new ArgumentException(
                $"Unknown task '{request.Task}'. Use one of: {string.Join(", ", LlmPrompts.Tasks)}.");

        var provider = await providers.ResolveAsync(request.ProviderId, ct)
            ?? throw new KeyNotFoundException(string.IsNullOrWhiteSpace(request.ProviderId)
                ? "No enabled LLM provider is configured."
                : $"Provider '{request.ProviderId}' not found.");

        if (LlmProviderKinds.RequiresKey(provider.Kind) && string.IsNullOrEmpty(provider.ApiKey))
            throw new LlmException($"No API key stored for {provider.Name}.");

        var model = await ResolveModelAsync(provider, request.Model, ct);
        var started = Stopwatch.GetTimestamp();
        var budget = request.MaxTokens ?? LlmPrompts.MaxTokens(task, request);
        var timeout = task is LlmPrompts.DocDraft or LlmPrompts.Logo ? DocDraftTimeout : CompleteTimeout;

        var (text, promptTokens, completionTokens) =
            await AttemptAsync(provider, model, task, request, budget, timeout, ct);

        // A reasoning model spends max_tokens on hidden reasoning before it writes
        // anything, and it does so unpredictably: the same list prompt answered in
        // 2 tokens twice and consumed a whole 512-token budget on the third try,
        // returning nothing. So an empty answer that used the entire budget means
        // "cut off mid-reasoning", not "nothing to say" — the one case worth paying
        // for a second attempt, with room to get past the reasoning. Anything that
        // stopped early genuinely had nothing to add and is left alone. A CLI
        // kind never gets the retry: it ignores max_tokens, so the second run
        // would be the same call at the same settings, paid for twice.
        if (text.Length == 0 && completionTokens >= budget && budget < RetryBudget
            && !LlmProviderKinds.IsCli(provider.Kind))
        {
            (text, promptTokens, completionTokens) =
                await AttemptAsync(provider, model, task, request, RetryBudget, timeout, ct);
        }

        return new LlmCompleteResponse(
            Text: LlmPrompts.Clean(task, text, request.Prompt),
            ProviderId: provider.Id,
            ProviderName: provider.Name,
            Kind: provider.Kind,
            Model: model,
            PromptTokens: promptTokens,
            CompletionTokens: completionTokens,
            ElapsedMs: Elapsed(started));
    }

    /// <summary>Budget for the one retry after a completion was truncated mid-reasoning.</summary>
    private const int RetryBudget = 2048;

    private async Task<(string Text, int? PromptTokens, int? CompletionTokens)> AttemptAsync(
        LlmProviderSecret provider,
        string model,
        string task,
        LlmCompleteRequest request,
        int maxTokens,
        TimeSpan timeout,
        CancellationToken ct)
    {
        // The CLI kinds are a different transport entirely: the same prompts, but
        // handed to the local `claude`/`grok` process instead of an HTTP endpoint.
        // maxTokens and temperature have no CLI equivalent and are ignored.
        if (LlmProviderKinds.IsCli(provider.Kind))
        {
            return await LlmCli.CompleteAsync(
                provider,
                model,
                LlmPrompts.SystemMessage(task),
                LlmPrompts.UserMessage(task, request),
                timeout,
                ct);
        }

        // Anonymous objects cannot omit a property conditionally without building a
        // dictionary: LM Studio (and strict local servers) 400 on unknown fields, so
        // reasoning controls are only sent to cloud providers that understand them.
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model,
            ["messages"] = new object[]
            {
                new { role = "system", content = LlmPrompts.SystemMessage(task) },
                new { role = "user", content = LlmPrompts.UserMessage(task, request) },
            },
            ["temperature"] = request.Temperature ?? LlmPrompts.Temperature(task),
            ["max_tokens"] = maxTokens,
            ["stream"] = false,
        };

        ApplyReasoningControl(payload, provider.Kind, task, model);
        ApplyJsonResponseFormat(payload, provider.Kind, task);

        using var content = new StringContent(
            JsonSerializer.Serialize(payload, JsonOptions), Encoding.UTF8, "application/json");

        using var document = await SendAsync(
            provider, HttpMethod.Post, "chat/completions", content, timeout, ct);
        var root = document.RootElement;

        // Empty is a normal outcome for `continue`, not a fault — surfacing it as
        // a provider error makes the editor decide the provider is broken and stop
        // asking for minutes. DocDraft treats empty as a failure further up.
        var text = ReadChoiceText(root) ?? string.Empty;
        var (promptTokens, completionTokens) = ReadUsage(root);
        if (text.Length == 0 && task == LlmPrompts.BookOutline)
        {
            // qwen-3.8-27b on Cerebras puts the reply in message.reasoning and
            // leaves content empty. That is chain-of-thought for a document, but
            // for an outline we only need a JSON object — salvage it rather than
            // fail the whole book job.
            var reasoning = ReadReasoningText(root);
            if (!string.IsNullOrWhiteSpace(reasoning) && reasoning.IndexOf('{') >= 0)
            {
                logger.LogWarning(
                    "{Provider} {Model} book outline had empty content; using JSON from message.reasoning ({Chars} chars)",
                    provider.Name, model, reasoning.Length);
                text = reasoning;
            }
        }
        if (text.Length == 0)
        {
            logger.LogWarning(
                "{Provider} {Model} returned empty content (finish_reason={Finish}, completion_tokens={Tokens}, max_tokens={Budget})",
                provider.Name, model, ReadFinishReason(root) ?? "?", completionTokens, maxTokens);
        }
        return (text, promptTokens, completionTokens);
    }

    /// <summary>
    /// Inline autocomplete and light edits are ruined by reasoning models that
    /// spend hundreds of tokens thinking before a short phrase — measured on
    /// qwen via OpenRouter at the default effort. Non-reasoning models ignore
    /// the field. Local servers 400 on unknown keys, so LM Studio is skipped.
    /// </summary>
    private static void ApplyReasoningControl(
        Dictionary<string, object?> payload, string kind, string task, string model)
    {
        var effort = LlmPrompts.ReasoningEffort(task);
        if (kind is LlmProviderKinds.OpenRouter or LlmProviderKinds.XAi or LlmProviderKinds.OpenAi)
        {
            payload["reasoning"] = new { effort };
            return;
        }

        if (kind == LlmProviderKinds.Cerebras)
        {
            // OpenAI-style field, not OpenRouter's `reasoning` object.
            // qwen-3.8-27b defaults to high, accepts "none" (which actually
            // disables thinking), and returns thinking in message.reasoning —
            // without this, max_tokens is spent on thinking and content is
            // empty. gpt-oss-120b rejects "none", so that model alone is
            // remapped to "low".
            payload["reasoning_effort"] = effort == "none" && CerebrasRejectsReasoningNone(model)
                ? "low"
                : effort;
        }
    }

    /// <summary>
    /// gpt-oss-120b is the one Cerebras model that 400s on <c>reasoning_effort: none</c>.
    /// Qwen treats none as "do not think", which is what BookOutline needs.
    /// </summary>
    private static bool CerebrasRejectsReasoningNone(string model)
    {
        var id = model.Trim().ToLowerInvariant();
        return id.Contains("gpt-oss") || id.Contains("gptoss");
    }

    /// <summary>
    /// A book outline is parsed as JSON; without a response format the model
    /// (especially Qwen) answers in prose or puts the object in a fence.
    /// LM Studio and the CLI kinds 400 or ignore the field, so they stay text.
    /// </summary>
    private static void ApplyJsonResponseFormat(Dictionary<string, object?> payload, string kind, string task)
    {
        if (task != LlmPrompts.BookOutline) return;
        if (kind is not (LlmProviderKinds.OpenRouter or LlmProviderKinds.XAi
            or LlmProviderKinds.OpenAi or LlmProviderKinds.Cerebras))
        {
            return;
        }

        payload["response_format"] = new { type = "json_object" };
    }

    /// <summary>
    /// The configured model, or the provider's first — LM Studio serves whatever is
    /// loaded, so a blank model is the normal case there rather than a mistake.
    /// </summary>
    private async Task<string> ResolveModelAsync(LlmProviderSecret provider, string? requested, CancellationToken ct)
    {
        var model = (requested ?? "").Trim();
        if (model.Length > 0) return model;

        model = (provider.Model ?? "").Trim();
        if (model.Length > 0) return model;

        // For a CLI kind a blank model is the point, not a gap to fill from a
        // listing: no --model flag means the CLI's own default model answers.
        if (LlmProviderKinds.IsCli(provider.Kind)) return string.Empty;

        var models = await FetchModelsAsync(provider, ct);
        if (models.Count == 0)
            throw new LlmException($"{provider.Name} has no model configured and lists none at {provider.BaseUrl}.");

        return models[0].Id;
    }

    private async Task<IReadOnlyList<LlmModelDto>> FetchModelsAsync(
        LlmProviderSecret provider,
        CancellationToken ct,
        TimeSpan? timeout = null)
    {
        using var document = await SendAsync(
            provider, HttpMethod.Get, "models", content: null, timeout ?? ModelsTimeout, ct);

        if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return [];

        var models = new List<LlmModelDto>();
        foreach (var item in data.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) continue;
            if (!item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) continue;

            var name = item.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String
                ? n.GetString()
                : null;

            int? contextLength = item.TryGetProperty("context_length", out var c) && c.TryGetInt32(out var len)
                ? len
                : null;

            models.Add(new LlmModelDto(id.GetString()!, name, contextLength));
        }

        models.Sort(static (a, b) => string.CompareOrdinal(a.Id, b.Id));
        return models;
    }

    private async Task<string?> DescribeOpenRouterKeyAsync(LlmProviderSecret provider, CancellationToken ct)
    {
        using var document = await SendAsync(provider, HttpMethod.Get, "key", content: null, TestTimeout, ct);
        if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return null;

        var label = data.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String
            ? l.GetString()
            : null;

        return string.IsNullOrWhiteSpace(label) ? "Key accepted." : $"Key accepted ({label}).";
    }

    /// <summary>
    /// One request, with every failure mode turned into an <see cref="LlmException"/>
    /// whose message names the provider and says what to do about it.
    /// </summary>
    private async Task<JsonDocument> SendAsync(
        LlmProviderSecret provider,
        HttpMethod method,
        string path,
        HttpContent? content,
        TimeSpan timeout,
        CancellationToken ct)
    {
        var url = $"{provider.BaseUrl.TrimEnd('/')}/{path}";
        using var request = new HttpRequestMessage(method, url) { Content = content };

        // LM Studio is normally open; everywhere else a bearer token is mandatory.
        if (!string.IsNullOrEmpty(provider.ApiKey))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", provider.ApiKey);

        // OpenRouter attributes usage to the calling app when it is told who that is.
        if (provider.Kind == LlmProviderKinds.OpenRouter)
            request.Headers.TryAddWithoutValidation("X-Title", "BeeDocs");

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        HttpResponseMessage response;
        try
        {
            var http = httpClientFactory.CreateClient(HttpClientName);
            response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new LlmException(
                $"{provider.Name} did not respond within {timeout.TotalSeconds:0}s ({provider.BaseUrl}).");
        }
        catch (HttpRequestException ex)
        {
            throw new LlmException(UnreachableMessage(provider, ex), ex);
        }

        using (response)
        {
            string payload;
            try
            {
                payload = await response.Content.ReadAsStringAsync(timeoutCts.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new LlmException(
                    $"{provider.Name} did not respond within {timeout.TotalSeconds:0}s ({provider.BaseUrl}).");
            }

            if (!response.IsSuccessStatusCode)
                throw new LlmException(FailureMessage(provider, response.StatusCode, payload));

            try
            {
                return JsonDocument.Parse(payload);
            }
            catch (JsonException ex)
            {
                logger.LogWarning(ex, "Unparseable response from {Provider} at {Url}", provider.Name, url);
                throw new LlmException($"{provider.Name} returned a response that is not JSON.", ex);
            }
        }
    }

    private static string UnreachableMessage(LlmProviderSecret provider, HttpRequestException ex)
    {
        // A refused connection on the local provider means one thing, and telling the
        // user to start LM Studio is more useful than any transport detail.
        var refused = ex.HttpRequestError is HttpRequestError.ConnectionError
            || ex.InnerException is System.Net.Sockets.SocketException;

        if (refused && provider.Kind == LlmProviderKinds.LmStudio)
            return $"LM Studio is not running on {provider.BaseUrl}.";

        return refused
            ? $"Cannot reach {provider.Name} at {provider.BaseUrl}."
            : $"Request to {provider.Name} failed: {ex.Message}";
    }

    private static string FailureMessage(LlmProviderSecret provider, HttpStatusCode status, string payload)
    {
        var reason = status switch
        {
            HttpStatusCode.Unauthorized => $"{provider.Name} rejected the API key",
            HttpStatusCode.Forbidden => $"{provider.Name} rejected the API key (no access to this resource)",
            HttpStatusCode.NotFound =>
                $"{provider.Name} returned 404 for {provider.BaseUrl} — check the base URL and the model id",
            HttpStatusCode.TooManyRequests => $"{provider.Name} is rate limiting this key",
            HttpStatusCode.PaymentRequired => $"{provider.Name} reports no remaining credit",
            >= HttpStatusCode.InternalServerError => $"{provider.Name} is failing ({(int)status})",
            _ => $"{provider.Name} returned {(int)status}",
        };

        var detail = ExtractError(payload);
        return string.IsNullOrEmpty(detail) ? reason + "." : $"{reason}: {detail}";
    }

    /// <summary>Pull the human part out of an error body, whatever shape it came in.</summary>
    private static string? ExtractError(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload)) return null;

        try
        {
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;

            if (root.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String)
                    return Truncate(error.GetString());
                if (error.ValueKind == JsonValueKind.Object
                    && error.TryGetProperty("message", out var nested)
                    && nested.ValueKind == JsonValueKind.String)
                {
                    return Truncate(nested.GetString());
                }
            }

            if (root.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.String)
                return Truncate(message.GetString());
        }
        catch (JsonException)
        {
            // HTML error pages and proxy banners land here.
            return Truncate(payload);
        }

        return null;
    }

    private static string? Truncate(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        return text.Length <= 300 ? text : text[..300] + "…";
    }

    private static string? ReadChoiceText(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            return null;
        }

        var first = choices[0];
        if (first.TryGetProperty("message", out var message)
            && message.TryGetProperty("content", out var content))
        {
            // Some providers return content as an array of parts rather than a string.
            // Null content is normal for a reasoning model that never left the
            // thinking phase — do not fall back to message.reasoning; that is
            // chain-of-thought, not the document.
            if (content.ValueKind == JsonValueKind.String)
                return content.GetString();

            if (content.ValueKind == JsonValueKind.Array)
            {
                var builder = new StringBuilder();
                foreach (var part in content.EnumerateArray())
                {
                    if (part.ValueKind == JsonValueKind.Object
                        && part.TryGetProperty("text", out var partText)
                        && partText.ValueKind == JsonValueKind.String)
                    {
                        builder.Append(partText.GetString());
                    }
                }
                return builder.Length == 0 ? null : builder.ToString();
            }
        }

        // Completion-style fallback for the odd local server.
        if (first.TryGetProperty("text", out var legacy) && legacy.ValueKind == JsonValueKind.String)
            return legacy.GetString();

        return null;
    }

    /// <summary>
    /// Cerebras Qwen puts thinking (and sometimes the whole reply) in
    /// <c>message.reasoning</c>. Only BookOutline reads this, and only when
    /// <c>content</c> was empty — see AttemptAsync.
    /// </summary>
    private static string? ReadReasoningText(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            return null;
        }

        var first = choices[0];
        if (first.TryGetProperty("message", out var message)
            && message.TryGetProperty("reasoning", out var reasoning)
            && reasoning.ValueKind == JsonValueKind.String)
        {
            return reasoning.GetString();
        }

        return null;
    }

    private static string? ReadFinishReason(JsonElement root)
    {
        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0)
        {
            return null;
        }

        var first = choices[0];
        return first.TryGetProperty("finish_reason", out var reason) && reason.ValueKind == JsonValueKind.String
            ? reason.GetString()
            : null;
    }

    private static (int? Prompt, int? Completion) ReadUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
            return (null, null);

        int? prompt = usage.TryGetProperty("prompt_tokens", out var p) && p.TryGetInt32(out var pv) ? pv : null;
        int? completion = usage.TryGetProperty("completion_tokens", out var c) && c.TryGetInt32(out var cv) ? cv : null;
        return (prompt, completion);
    }

    private static int Elapsed(long startedAt) => (int)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
}

/// <summary>
/// The instructions sent with every completion, and the tidying applied to what
/// comes back. Kept next to the client because the two are one contract: the
/// system message promises bare text, and <see cref="Clean"/> enforces it when a
/// model ignores the promise.
/// </summary>
public static class LlmPrompts
{
    public const string Continue = "continue";
    public const string Rewrite = "rewrite";
    public const string Grammar = "grammar";
    public const string Format = "format";
    public const string Summarize = "summarize";

    /// <summary>
    /// Whole-document generation (the git integration's AI actions): the
    /// context is a repository bundle, the prompt is the assignment, and the
    /// answer is a complete Markdown document rather than an edit.
    /// </summary>
    public const string DocDraft = "docdraft";

    /// <summary>
    /// The outline step of a multi-page documentation book: same repository
    /// bundle as DocDraft, but the answer is JSON listing pages to write, not
    /// the pages themselves.
    /// </summary>
    public const string BookOutline = "bookoutline";

    /// <summary>
    /// A standalone SVG logo mark (the branding settings' "generate with AI").
    /// The context is the instance title, the prompt is the description, and the
    /// answer is a lone &lt;svg&gt; element — which BrandingService then
    /// sanitizes before anything is stored or served.
    /// </summary>
    public const string Logo = "logo";

    public static readonly IReadOnlyList<string> Tasks =
        [Continue, Rewrite, Grammar, Format, Summarize, DocDraft, BookOutline, Logo];

    /// <summary>Enough context to be grounded, not enough to blow up the bill.</summary>
    private const int MaxContextChars = 6000;
    private const int MaxPromptChars = 4000;
    private const int MaxSelectionChars = 16000;

    /// <summary>
    /// DocDraft alone reads a whole repository bundle — a backstop over the
    /// budget GitAssistService already enforces while building it.
    /// </summary>
    private const int MaxDocContextChars = 120_000;

    public static string? NormalizeTask(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "") switch
        {
            "continue" or "autocomplete" or "complete" => Continue,
            "rewrite" or "improve" or "polish" => Rewrite,
            "grammar" or "fix" or "fixgrammar" or "spelling" or "proofread" => Grammar,
            "format" or "markdown" or "formatasmarkdown" or "formatmarkdown" => Format,
            "summarize" or "summarise" or "summary" => Summarize,
            "docdraft" or "document" or "docgen" => DocDraft,
            "bookoutline" or "bookplan" => BookOutline,
            "logo" or "icon" => Logo,
            _ => null,
        };

    public static string SystemMessage(string task) => task switch
    {
        Continue => """
            You are an inline autocomplete inside a Markdown documentation editor.
            Continue the user's text from exactly where it stops.

            Rules:
            - Reply with ONLY the continuation. No preamble, no explanation, no quotes, no code fences.
            - Never repeat any part of the text you were given — do not paste the prompt back.
            - Keep it short: finish the current sentence, or add one short sentence. Never more.
            - Match the surrounding voice, tense, and Markdown conventions.
            - If the text stops mid-word, complete that word first with no leading space.
            - If the text stops after a space or punctuation, start your reply with the next word (no leading space if the prompt already ends with one).
            - Prefer plain prose. Do not open a new heading, list, or code fence unless the text clearly started one.
            - If nothing sensible follows, reply with an empty string.
            """,

        Rewrite => """
            You rewrite passages in technical documentation.

            Rules:
            - Keep every fact, number, name, link and code identifier exactly as given.
            - Improve clarity, flow and concision. Prefer plain words and active voice.
            - Preserve the Markdown structure: headings stay headings, lists stay lists,
              code blocks and inline code are copied through untouched.
            - Keep roughly the original length unless the text is clearly padded.
            - Reply with ONLY the rewritten text. No preamble, no commentary, no wrapping code fence.
            """,

        Grammar => """
            You are a proofreader for technical documentation.

            Rules:
            - Fix spelling, grammar, punctuation and capitalisation. Nothing else.
            - Do not reword, reorder, shorten, expand, or change the tone.
            - Leave Markdown syntax, code blocks, inline code, URLs and identifiers exactly as they are.
            - If the text is already correct, return it unchanged.
            - Reply with ONLY the corrected text. No preamble, no list of changes, no wrapping code fence.
            """,

        Format => """
            You format raw text as clean Markdown.

            Rules:
            - Do not add, remove or reword content. Formatting only.
            - Use headings, bullet and numbered lists, tables and emphasis where the
              structure of the text clearly calls for them.
            - Fence real code with a language tag. Use inline code for identifiers,
              paths, commands and values.
            - Never wrap the whole answer in a code fence — fences inside the document are fine.
            - Reply with ONLY the formatted Markdown. No preamble, no commentary.
            """,

        Summarize => """
            You summarize technical documentation.

            Rules:
            - Lead with the single most important point, then the supporting ones.
            - Use a short paragraph, or a bullet list when the source is a list of things.
            - Keep names, numbers and identifiers exact. Invent nothing.
            - Aim for about a fifth of the original length.
            - Reply with ONLY the summary. No preamble, no heading, no wrapping code fence.
            """,

        DocDraft => """
            You are a senior technical writer producing a complete, standalone
            Markdown document about a software project, from its repository.

            Rules:
            - Ground every statement in the source material you are given. Where the
              material does not answer something, say so briefly rather than inventing
              commands, options, URLs or behaviour that may not exist.
            - Structure the document with clear headings, lists and code blocks where
              they help. Start with a single H1 title.
            - Write for the audience the assignment names; keep the tone plain and direct.
            - Reply with ONLY the document. No preamble, no commentary, and never wrap
              the whole answer in a code fence — fences inside the document are fine.
            """,

        BookOutline => """
            You plan a multi-page documentation book about a software project,
            from its repository. Respond in JSON.

            Rules:
            - Ground every page in the source material. Do not invent features,
              commands or audiences the material does not support.
            - Reply with ONLY a JSON object, no preamble, no commentary, no Markdown
              fence. Shape:
              {"bookTitle":"...","bookDescription":"...","pages":[{"title":"...","brief":"..."}]}
            - 5 to 8 pages. Each page is a focused chapter a reader can open alone.
            - Titles are short (2–6 words). Briefs are one sentence of what that
              page must cover — not the page itself.
            - Typical pages: Overview, Getting started, Architecture, Usage,
              Configuration, Development, Operations — include only those the
              source material can actually support.
            """,

        Logo => """
            You design small vector logo marks as standalone SVG.

            Rules:
            - Reply with ONLY a single <svg> element. No preamble, no explanation, no
              code fence, no XML declaration.
            - The root element must carry viewBox="0 0 64 64" and no width or height
              attributes.
            - Use only vector shapes (path, circle, rect, ellipse, polygon, line, g)
              with fill/stroke colors; gradients declared in <defs> are fine.
            - Never use <script>, <foreignObject>, <image>, event handler attributes,
              CSS imports, or references to anything outside the document.
            - Design a simple, bold, geometric mark that stays readable at 20 pixels:
              a handful of shapes, a small palette (2–4 colors), no fine detail.
            - The mark must work on both light and dark backgrounds — no full-canvas
              background rectangle unless it is part of the mark (a rounded tile is fine).
            """,

        _ => "You are a concise writing assistant. Reply with only the requested text.",
    };

    public static string UserMessage(string task, LlmCompleteRequest request)
    {
        if (task is DocDraft or BookOutline)
        {
            // Head, not Tail: the bundle is ordered most-important-first
            // (README, manifests, docs, then source), so the start must survive
            // any truncation.
            var builder0 = new StringBuilder();
            var material = Head(request.Context, MaxDocContextChars);
            if (material.Length > 0)
            {
                builder0.Append("Source material — the repository's file tree and file excerpts:\n\n")
                    .Append(material)
                    .Append("\n\n");
            }

            builder0.Append("Assignment:\n").Append(Head(request.Prompt, MaxPromptChars));
            return builder0.ToString();
        }

        if (task == Logo)
        {
            var logoBuilder = new StringBuilder("Design a logo icon.\n");
            var product = Head(request.Context, 200);
            if (product.Length > 0)
                logoBuilder.Append("Product name: ").Append(product).Append('\n');
            logoBuilder.Append("Description of the desired logo:\n").Append(Head(request.Prompt, MaxPromptChars));
            return logoBuilder.ToString();
        }

        var context = Tail(request.Context, MaxContextChars);
        var builder = new StringBuilder();

        if (task == Continue)
        {
            if (context.Length > 0)
            {
                builder.Append("Earlier in the document (background only, do not continue from here):\n")
                    .Append(context)
                    .Append("\n\n");
            }

            builder.Append("Continue this text. Reply with the continuation only:\n")
                .Append(Tail(request.Prompt, MaxPromptChars));
            return builder.ToString();
        }

        if (context.Length > 0)
        {
            builder.Append("Surrounding document, for context only — do not include it in your answer:\n")
                .Append(context)
                .Append("\n\n");
        }

        var instruction = Head(request.Prompt, MaxPromptChars);
        if (instruction.Length > 0)
            builder.Append("Additional instruction from the user: ").Append(instruction).Append("\n\n");

        var target = Head(request.Selection, MaxSelectionChars);
        if (target.Length == 0)
            target = Head(request.Prompt, MaxSelectionChars);

        builder.Append("Text:\n").Append(target);
        return builder.ToString();
    }

    public static double Temperature(string task) => task switch
    {
        Grammar or Format => 0.1,
        Rewrite or DocDraft => 0.4,
        BookOutline => 0.2,
        // Creative work — identical retries of a rejected logo would be useless.
        Logo => 0.8,
        _ => 0.3,
    };

    /// <summary>
    /// Reasoning control for OpenRouter/xAI/OpenAI (<c>reasoning.effort</c>) and
    /// Cerebras (<c>reasoning_effort</c>). Continuations and light edits want
    /// zero thinking — otherwise a "flash" model spends ~900 reasoning tokens and
    /// several seconds before a short phrase lands. Rewrite/summarize keep a little.
    /// A book outline is a small JSON object: thinking eats the token budget and
    /// leaves <c>content</c> empty (Cerebras qwen-3.8-27b). Cerebras gpt-oss-120b
    /// still remaps <c>none</c> to <c>low</c> on the wire.
    /// </summary>
    public static string ReasoningEffort(string task) => task switch
    {
        Rewrite or Summarize or DocDraft or Logo => "low",
        _ => "none",
    };

    public static int MaxTokens(string task, LlmCompleteRequest request) => task switch
    {
        // A continuation is a sentence, not an essay. Reasoning is disabled for
        // this task (see ReasoningEffort), so the budget only has to cover the
        // visible text — 128 tokens is roughly two short sentences with room to
        // spare. The empty-and-exhausted retry path still bumps to 2048 if a
        // model ignores effort:none and burns the budget on hidden reasoning.
        Continue => 128,
        Summarize => 512,
        // A whole README or manual, not an edit — room to finish a long
        // document without inviting padding.
        DocDraft => 4096,
        // A JSON outline of ≤ 8 pages. Reasoning is off for this task; 2048
        // still leaves room if a model ignores that and thinks a little.
        BookOutline => 2048,
        // SVG path data is token-hungry; a modest mark still runs long.
        Logo => 4096,
        // Roughly two tokens of headroom per token of input, since these tasks
        // return the whole passage back.
        _ => Math.Clamp(((request.Selection?.Length ?? 0) / 2) + 256, 256, 4096),
    };

    /// <summary>
    /// Strip the wrappers models add despite being told not to. The continuation is
    /// trimmed only at the end: its leading space is load-bearing at the caret.
    /// </summary>
    public static string Clean(string task, string raw, string? prompt = null)
    {
        var text = StripThinking(raw.Replace("\r\n", "\n"));
        text = StripWrappingFence(text);

        if (task != Continue)
            return text.Trim();

        text = StripWrappingQuotes(text.Trim('\n'));
        text = StripEchoedPrompt(text, prompt);
        return text.TrimEnd();
    }

    /// <summary>
    /// Models sometimes paste the end of the prompt back as the "continuation".
    /// That glues a second copy of the last words onto the caret when accepted.
    /// </summary>
    private static string StripEchoedPrompt(string text, string? prompt)
    {
        if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(prompt)) return text;

        var source = prompt.Replace("\r\n", "\n");
        // Longest common prefix of the reply and a suffix of the prompt — only
        // worth stripping when it is at least a short word, otherwise a shared
        // "a"/"the" would eat legitimate continuations.
        var max = Math.Min(text.Length, source.Length);
        for (var len = max; len >= 4; len--)
        {
            if (source.AsSpan(source.Length - len).Equals(text.AsSpan(0, len), StringComparison.Ordinal))
                return text[len..];
        }

        return text;
    }

    /// <summary>Local reasoning models emit a think block ahead of the answer.</summary>
    private static string StripThinking(string text)
    {
        var end = text.IndexOf("</think>", StringComparison.OrdinalIgnoreCase);
        return end < 0 ? text : text[(end + "</think>".Length)..].TrimStart('\n');
    }

    private static string StripWrappingFence(string text)
    {
        var trimmed = text.Trim();
        if (!trimmed.StartsWith("```", StringComparison.Ordinal)
            || !trimmed.EndsWith("```", StringComparison.Ordinal)
            || trimmed.Length < 7)
        {
            return text;
        }

        var lines = trimmed.Split('\n');
        if (lines.Length < 3) return text;

        // Only unwrap when the fences are the outermost pair; nested fences are content.
        var fenceCount = lines.Count(static l => l.TrimStart().StartsWith("```", StringComparison.Ordinal));
        if (fenceCount != 2) return text;

        return string.Join('\n', lines[1..^1]);
    }

    private static string StripWrappingQuotes(string text)
    {
        if (text.Length < 2 || text[0] != '"' || text[^1] != '"') return text;
        return text.AsSpan(1, text.Length - 2).Contains('"') ? text : text[1..^1];
    }

    private static string Head(string? value, int max)
    {
        var text = (value ?? string.Empty).Trim();
        return text.Length <= max ? text : text[..max];
    }

    /// <summary>Keeps the end of the text — the part nearest the caret is what matters.</summary>
    private static string Tail(string? value, int max)
    {
        var text = value ?? string.Empty;
        if (text.Length <= max) return text;
        return text[^max..];
    }
}
