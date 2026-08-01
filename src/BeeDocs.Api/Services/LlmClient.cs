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
/// One OpenAI-compatible chat client for all four providers — they differ only in
/// base URL and whether a key is required, so the wire format is shared.
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

        return await FetchModelsAsync(provider, ct);
    }

    public async Task<LlmTestResultDto> TestAsync(string providerId, CancellationToken ct = default)
    {
        var provider = await providers.ResolveAsync(providerId, ct)
            ?? throw new KeyNotFoundException($"Provider '{providerId}' not found.");

        var started = Stopwatch.GetTimestamp();

        if (LlmProviderKinds.RequiresKey(provider.Kind) && string.IsNullOrEmpty(provider.ApiKey))
            return new LlmTestResultDto(false, $"No API key stored for {provider.Name}.", null, Elapsed(started));

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

        var (text, promptTokens, completionTokens) = await AttemptAsync(provider, model, task, request, budget, ct);

        // A reasoning model spends max_tokens on hidden reasoning before it writes
        // anything, and it does so unpredictably: the same list prompt answered in
        // 2 tokens twice and consumed a whole 512-token budget on the third try,
        // returning nothing. So an empty answer that used the entire budget means
        // "cut off mid-reasoning", not "nothing to say" — the one case worth paying
        // for a second attempt, with room to get past the reasoning. Anything that
        // stopped early genuinely had nothing to add and is left alone.
        if (text.Length == 0 && completionTokens >= budget && budget < RetryBudget)
        {
            (text, promptTokens, completionTokens) =
                await AttemptAsync(provider, model, task, request, RetryBudget, ct);
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
        CancellationToken ct)
    {
        // Anonymous objects cannot omit a property conditionally without building a
        // dictionary: LM Studio (and strict local servers) 400 on unknown fields, so
        // `reasoning` is only sent to cloud providers that understand it.
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

        // Inline autocomplete and light edits are ruined by reasoning models that
        // spend 800–1000 tokens thinking and 7–10s before emitting a sentence —
        // measured on qwen3.7-flash via OpenRouter at the default effort. `none`
        // drops that to ~25 tokens and sub-second answers; non-reasoning models
        // ignore the field. Rewrite/summarize keep a little thinking room.
        if (SupportsReasoningControl(provider.Kind))
        {
            payload["reasoning"] = new { effort = LlmPrompts.ReasoningEffort(task) };
        }

        using var content = new StringContent(
            JsonSerializer.Serialize(payload, JsonOptions), Encoding.UTF8, "application/json");

        using var document = await SendAsync(
            provider, HttpMethod.Post, "chat/completions", content, CompleteTimeout, ct);
        var root = document.RootElement;

        // Empty is a normal outcome, not a fault — surfacing it as a provider error
        // makes the editor decide the provider is broken and stop asking for minutes.
        var text = ReadChoiceText(root) ?? string.Empty;
        var (promptTokens, completionTokens) = ReadUsage(root);
        return (text, promptTokens, completionTokens);
    }

    /// <summary>
    /// Cloud OpenAI-compatible gateways accept OpenRouter's unified <c>reasoning</c>
    /// object. Local servers usually do not, and a 400 on every continue is worse
    /// than a slow reasoning model.
    /// </summary>
    private static bool SupportsReasoningControl(string kind) =>
        kind is LlmProviderKinds.OpenRouter or LlmProviderKinds.XAi or LlmProviderKinds.OpenAi;

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

    public static readonly IReadOnlyList<string> Tasks = [Continue, Rewrite, Grammar, Format, Summarize];

    /// <summary>Enough context to be grounded, not enough to blow up the bill.</summary>
    private const int MaxContextChars = 6000;
    private const int MaxPromptChars = 4000;
    private const int MaxSelectionChars = 16000;

    public static string? NormalizeTask(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant().Replace(" ", "").Replace("-", "").Replace("_", "") switch
        {
            "continue" or "autocomplete" or "complete" => Continue,
            "rewrite" or "improve" or "polish" => Rewrite,
            "grammar" or "fix" or "fixgrammar" or "spelling" or "proofread" => Grammar,
            "format" or "markdown" or "formatasmarkdown" or "formatmarkdown" => Format,
            "summarize" or "summarise" or "summary" => Summarize,
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

        _ => "You are a concise writing assistant. Reply with only the requested text.",
    };

    public static string UserMessage(string task, LlmCompleteRequest request)
    {
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
        Rewrite => 0.4,
        _ => 0.3,
    };

    /// <summary>
    /// OpenRouter/xAI/OpenAI reasoning control. Continuations and light edits want
    /// zero thinking — otherwise a "flash" model spends ~900 reasoning tokens and
    /// several seconds before a short phrase lands. Rewrite/summarize keep a little.
    /// </summary>
    public static string ReasoningEffort(string task) => task switch
    {
        Rewrite or Summarize => "low",
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
