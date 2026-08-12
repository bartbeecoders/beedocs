using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace BeeDocs.Mcp;

public sealed class BeeDocsApiException(string message, int status, string? body = null)
    : Exception(message)
{
    public int Status { get; } = status;
    public string? Body { get; } = body;
}

/// <summary>Thin HTTP client for the BeeDocs REST API.</summary>
public sealed class BeeDocsApiClient(HttpClient http)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public string BaseUrl => http.BaseAddress?.ToString().TrimEnd('/') ?? "";

    public Task<JsonElement> HealthAsync(CancellationToken ct = default)
        => GetAsync("/api/health", ct);

    public Task<JsonElement> ListShelvesAsync(CancellationToken ct = default)
        => GetAsync("/api/shelves", ct);

    public Task<JsonElement> GetShelfAsync(string id, CancellationToken ct = default)
        => GetAsync($"/api/shelves/{Uri.EscapeDataString(id)}", ct);

    public Task<JsonElement> ListShelfBooksAsync(string id, CancellationToken ct = default)
        => GetAsync($"/api/shelves/{Uri.EscapeDataString(id)}/books", ct);

    public Task<JsonElement> CreateShelfAsync(object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, "/api/shelves", body, ct);

    public Task<JsonElement> UpdateShelfAsync(string id, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Put, $"/api/shelves/{Uri.EscapeDataString(id)}", body, ct);

    public Task DeleteShelfAsync(string id, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, $"/api/shelves/{Uri.EscapeDataString(id)}", null, ct);

    public Task<JsonElement> ListBooksAsync(CancellationToken ct = default)
        => GetAsync("/api/books", ct);

    public Task<JsonElement> GetBookAsync(string id, CancellationToken ct = default)
        => GetAsync($"/api/books/{Uri.EscapeDataString(id)}", ct);

    public Task<JsonElement> CreateBookAsync(object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, "/api/books", body, ct);

    public Task<JsonElement> UpdateBookAsync(string id, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Put, $"/api/books/{Uri.EscapeDataString(id)}", body, ct);

    public Task DeleteBookAsync(string id, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, $"/api/books/{Uri.EscapeDataString(id)}", null, ct);

    public Task<JsonElement> ListChaptersAsync(string bookId, CancellationToken ct = default)
        => GetAsync($"/api/books/{Uri.EscapeDataString(bookId)}/chapters", ct);

    public Task<JsonElement> CreateChapterAsync(string bookId, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, $"/api/books/{Uri.EscapeDataString(bookId)}/chapters", body, ct);

    public Task<JsonElement> UpdateChapterAsync(string id, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Put, $"/api/chapters/{Uri.EscapeDataString(id)}", body, ct);

    public Task DeleteChapterAsync(string id, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, $"/api/chapters/{Uri.EscapeDataString(id)}", null, ct);

    public Task<JsonElement> ListPagesAsync(string bookId, CancellationToken ct = default)
        => GetAsync($"/api/books/{Uri.EscapeDataString(bookId)}/pages", ct);

    public Task<JsonElement> GetPageAsync(string id, CancellationToken ct = default)
        => GetAsync($"/api/pages/{Uri.EscapeDataString(id)}", ct);

    public Task<JsonElement> CreatePageAsync(string bookId, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, $"/api/books/{Uri.EscapeDataString(bookId)}/pages", body, ct);

    public Task<JsonElement> UpdatePageAsync(string id, Dictionary<string, object?> body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Put, $"/api/pages/{Uri.EscapeDataString(id)}", body, ct);

    public Task DeletePageAsync(string id, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, $"/api/pages/{Uri.EscapeDataString(id)}", null, ct);

    public Task<JsonElement> ListDiagramsAsync(string bookId, CancellationToken ct = default)
        => GetAsync($"/api/books/{Uri.EscapeDataString(bookId)}/diagrams", ct);

    public Task<JsonElement> ListPageDiagramsAsync(string pageId, CancellationToken ct = default)
        => GetAsync($"/api/pages/{Uri.EscapeDataString(pageId)}/diagrams", ct);

    public Task<JsonElement> GetDiagramAsync(string id, CancellationToken ct = default)
        => GetAsync($"/api/diagrams/{Uri.EscapeDataString(id)}", ct);

    public Task<JsonElement> CreateDiagramAsync(string bookId, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, $"/api/books/{Uri.EscapeDataString(bookId)}/diagrams", body, ct);

    public Task<JsonElement> UpdateDiagramAsync(string id, object body, CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Put, $"/api/diagrams/{Uri.EscapeDataString(id)}", body, ct);

    public Task DeleteDiagramAsync(string id, CancellationToken ct = default)
        => SendAsync(HttpMethod.Delete, $"/api/diagrams/{Uri.EscapeDataString(id)}", null, ct);

    public async Task<JsonElement> UploadImageAsync(
        string base64,
        string fileName,
        string? contentType = null,
        CancellationToken ct = default)
    {
        var bytes = Convert.FromBase64String(base64);
        var type = contentType ?? GuessContentType(fileName);
        using var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(bytes);
        file.Headers.ContentType = new MediaTypeHeaderValue(type);
        form.Add(file, "file", fileName);

        using var response = await http.PostAsync("/api/uploads", form, ct);
        return await ReadResponseAsync(response, "POST", "/api/uploads");
    }

    /// <summary>
    /// Build an update-page payload. <paramref name="chapterId"/> null clears the folder
    /// (sent as ""); omit when <paramref name="chapterIdSpecified"/> is false.
    /// </summary>
    public static Dictionary<string, object?> BuildPageUpdate(
        string title,
        string? content = null,
        string? slug = null,
        string? chapterId = null,
        bool chapterIdSpecified = false,
        int? sortOrder = null)
    {
        var clean = new Dictionary<string, object?> { ["title"] = title };
        if (content is not null) clean["content"] = content;
        if (slug is not null) clean["slug"] = slug;
        if (sortOrder is not null) clean["sortOrder"] = sortOrder.Value;
        if (chapterIdSpecified) clean["chapterId"] = chapterId ?? "";
        return clean;
    }

    public Task<JsonElement> SearchAsync(
        string query,
        int? limit = null,
        int? offset = null,
        string? bookId = null,
        string? kinds = null,
        CancellationToken ct = default)
    {
        var q = new List<string> { $"q={Uri.EscapeDataString(query)}" };
        if (limit is not null) q.Add($"limit={limit}");
        if (offset is not null) q.Add($"offset={offset}");
        if (!string.IsNullOrWhiteSpace(bookId)) q.Add($"bookId={Uri.EscapeDataString(bookId)}");
        if (!string.IsNullOrWhiteSpace(kinds)) q.Add($"kinds={Uri.EscapeDataString(kinds)}");
        // Agents search with whole words, not keystrokes — a trailing prefix match
        // would only widen results without helping.
        q.Add("prefix=false");
        return GetAsync("/api/search?" + string.Join('&', q), ct);
    }

    public Task<JsonElement> SearchStatusAsync(CancellationToken ct = default)
        => GetAsync("/api/search/status", ct);

    public Task<JsonElement> ReindexAsync(CancellationToken ct = default)
        => SendJsonAsync(HttpMethod.Post, "/api/search/reindex", new { }, ct);

    private Task<JsonElement> GetAsync(string path, CancellationToken ct)
        => SendAsync(HttpMethod.Get, path, null, ct);

    private Task<JsonElement> SendJsonAsync(HttpMethod method, string path, object body, CancellationToken ct)
        => SendAsync(method, path, JsonContent.Create(body, options: JsonOptions), ct);

    private async Task<JsonElement> SendAsync(
        HttpMethod method,
        string path,
        HttpContent? content,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path) { Content = content };
        using var response = await http.SendAsync(request, ct);
        return await ReadResponseAsync(response, method.Method, path);
    }

    private static async Task<JsonElement> ReadResponseAsync(
        HttpResponseMessage response,
        string method,
        string path)
    {
        if (!response.IsSuccessStatusCode)
        {
            var text = await response.Content.ReadAsStringAsync();
            var snippet = text.Length > 500 ? text[..500] : text;
            throw new BeeDocsApiException(
                $"BeeDocs API {method} {path} failed: {(int)response.StatusCode} {response.ReasonPhrase}" +
                (string.IsNullOrEmpty(snippet) ? "" : $" — {snippet}"),
                (int)response.StatusCode,
                text);
        }

        if (response.StatusCode == System.Net.HttpStatusCode.NoContent)
        {
            return default;
        }

        var ctHeader = response.Content.Headers.ContentType?.MediaType ?? "";
        if (!ctHeader.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            return default;
        }

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        return doc.RootElement.Clone();
    }

    private static string GuessContentType(string fileName)
    {
        var ext = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
        return ext switch
        {
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
    }

    public static string Pretty(JsonElement element)
        => JsonSerializer.Serialize(element, new JsonSerializerOptions { WriteIndented = true });

    public static string Pretty(object value)
        => JsonSerializer.Serialize(value, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        });

    public static string Prop(JsonElement el, string name)
        => el.TryGetProperty(name, out var p) ? p.GetString() ?? "" : "";

    public static int PropInt(JsonElement el, string name)
        => el.TryGetProperty(name, out var p) && p.TryGetInt32(out var n) ? n : 0;

    public static string? PropStringOrNull(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var p) || p.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return null;
        }

        return p.GetString();
    }
}

public static class BeeDocsApiClientFactory
{
    public static string ResolveBaseUrl()
    {
        var baseUrl =
            Environment.GetEnvironmentVariable("BEEDOCS_API_URL")?.Trim()
            ?? Environment.GetEnvironmentVariable("BEEDOCS_URL")?.Trim()
            ?? "http://localhost:5080";
        return baseUrl.TrimEnd('/');
    }

    /// <summary>
    /// The API's own shared secret (BeeDocs:ApiKey) — not MCP_AUTH_TOKEN, which
    /// guards this server's HTTP transport. Needed once the API has sign-in
    /// enabled: an agent has no cookie, so the key is how it authenticates.
    /// </summary>
    public static string? ResolveApiKey() =>
        Environment.GetEnvironmentVariable("BEEDOCS_API_KEY")?.Trim() is { Length: > 0 } key ? key : null;

    public static void Configure(IHttpClientBuilder builder)
    {
        builder.ConfigureHttpClient(client =>
        {
            client.BaseAddress = new Uri(ResolveBaseUrl() + "/");
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

            // X-Api-Key rather than Authorization: the HTTP transport already
            // reads Authorization for MCP_AUTH_TOKEN, and reusing the header for
            // two different secrets is how one ends up sent to the wrong place.
            if (ResolveApiKey() is { } apiKey)
                client.DefaultRequestHeaders.Add("X-Api-Key", apiKey);
        });
    }
}
