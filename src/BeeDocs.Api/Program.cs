using System.Reflection;
using BeeDocs.Api.Models;
using BeeDocs.Api.Services;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyHeader()
            .AllowAnyMethod()
            .AllowAnyOrigin());
});

// SQLite: file under BeeDocs:DataPath (default data/sqlite/beedocs.db)
builder.Services.AddSingleton<SqliteConnectionFactory>();

// Uploaded images (drag/drop & paste) live here. Resolved before the container
// is built so export/import can read and write the same directory the static
// file middleware serves. PhysicalFileProvider demands an absolute path, and the
// configured value may be relative ("data/uploads") or absolute ("/data/uploads").
var configuredUploads = builder.Configuration["BeeDocs:UploadsPath"];
var uploadsRoot = string.IsNullOrWhiteSpace(configuredUploads)
    ? Path.Combine(builder.Environment.ContentRootPath, "data", "uploads")
    : Path.GetFullPath(configuredUploads, builder.Environment.ContentRootPath);
Directory.CreateDirectory(uploadsRoot);

builder.Services.AddSingleton(new StorageOptions(uploadsRoot));
builder.Services.Configure<ApiKeyOptions>(builder.Configuration.GetSection(ApiKeyOptions.SectionName));
builder.Services.AddSingleton<ApiKeyEndpointFilter>();
builder.Services.AddSingleton<IDocumentService, DocumentService>();
builder.Services.AddSingleton<IDiagramService, DiagramService>();
builder.Services.AddSingleton<IShapeCollectionService, ShapeCollectionService>();
builder.Services.AddSingleton<IExportService, ExportService>();
builder.Services.AddSingleton<IImportService, ImportService>();
builder.Services.AddSingleton<ISearchIndexService, SearchIndexService>();
builder.Services.AddSingleton<ILlmProviderService, LlmProviderService>();
builder.Services.AddSingleton<ILlmClient, LlmClient>();

// Backstop only — LlmClient gives each call its own budget with a linked token.
builder.Services.AddHttpClient(LlmClient.HttpClientName,
    client => client.Timeout = TimeSpan.FromMinutes(2));

// Imported archives carry their images, so the 30 MB Kestrel default is too
// tight for a book of screenshots. Individual uploads are capped by type in
// the /api/uploads handler (8 MB images, 50 MB PDF/3D).
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 256L * 1024 * 1024);

var app = builder.Build();

app.UseCors();

var wwwroot = Path.Combine(app.Environment.ContentRootPath, "wwwroot");
if (Directory.Exists(wwwroot))
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
}

// Serve the uploads directory resolved above.
// Map 3D formats that the default content-type provider omits (otherwise 404).
var uploadContentTypes = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
uploadContentTypes.Mappings[".glb"] = "model/gltf-binary";
uploadContentTypes.Mappings[".gltf"] = "model/gltf+json";
uploadContentTypes.Mappings[".obj"] = "model/obj";
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadsRoot),
    RequestPath = "/uploads",
    ContentTypeProvider = uploadContentTypes,
});

// Ensure SQLite schema (CREATE TABLE IF NOT EXISTS + WAL)
using (var scope = app.Services.CreateScope())
{
    var factory = scope.ServiceProvider.GetRequiredService<SqliteConnectionFactory>();
    await DatabaseInitializer.EnsureSchemaAsync(factory);

    // Builds the full-text index on first run after upgrading, and repairs any
    // drift on later starts. Search must not take the process down with it.
    var search = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
    try
    {
        await search.InitializeAsync();
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Search index could not be initialized — search may return nothing until POST /api/search/reindex.");
    }
}

var api = app.MapGroup("/api");

// Build version, sourced from <Version> in BeeDocs.Api.csproj. The deploy script
// bumps the last digit (the build number) on every deploy, so this is what the
// UI shows to identify which build is live. SourceLink appends "+<sha>" to the
// informational version when it is enabled — trim it for display.
var appVersion = (Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "0.0.0")
    .Split('+')[0];

var configuredApiKey = app.Configuration["BeeDocs:ApiKey"];
if (string.IsNullOrWhiteSpace(configuredApiKey))
{
    app.Logger.LogWarning(
        "BeeDocs:ApiKey is not set — /api/v1 is open without authentication. " +
        "Set BeeDocs__ApiKey (or BeeDocs:ApiKey) before exposing the API to other apps.");
}
else
{
    app.Logger.LogInformation("BeeDocs:ApiKey is configured — /api/v1 requires Bearer or X-Api-Key.");
}

// A stored provider key turns /api/llm into something that spends real money.
// Without BeeDocs:ApiKey, anyone who can reach this port can spend it.
if (string.IsNullOrWhiteSpace(configuredApiKey)
    && await app.Services.GetRequiredService<ILlmProviderService>().AnyKeyStoredAsync())
{
    app.Logger.LogWarning(
        "An LLM provider has a stored API key but BeeDocs:ApiKey is not set — /api/llm is unauthenticated, " +
        "so anyone who can reach this port can spend that key. Set BeeDocs__ApiKey (or BeeDocs:ApiKey).");
}

api.MapGet("/health", () => Results.Ok(new { status = "ok", service = "BeeDocs.Api", version = appVersion }));

api.MapGet("/version", () => Results.Ok(new { version = appVersion }));

// --- Search ---
// Full-text over book, folder, page and diagram text. `kinds` is a comma-separated
// filter; `prefix=false` turns off as-you-type matching on the final term.
api.MapGet("/search", async (
    string? q,
    int? limit,
    int? offset,
    string? bookId,
    string? kinds,
    bool? prefix,
    ISearchIndexService search,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var query = new SearchQuery(
        Text: q,
        Limit: limit ?? 20,
        Offset: offset ?? 0,
        BookId: string.IsNullOrWhiteSpace(bookId) ? null : bookId,
        Kinds: ParseKinds(kinds),
        Prefix: prefix ?? true);

    return Results.Ok(await search.SearchAsync(query, ct));
});

api.MapGet("/search/status", async (ISearchIndexService search, CancellationToken ct) =>
    Results.Ok(await search.StatusAsync(ct)));

api.MapPost("/search/reindex", async (ISearchIndexService search, CancellationToken ct) =>
    Results.Ok(await search.RebuildAsync(ct)));

static string[]? ParseKinds(string? raw) =>
    string.IsNullOrWhiteSpace(raw)
        ? null
        : raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

// --- Books ---
api.MapGet("/books", async (IDocumentService docs, CancellationToken ct) =>
    Results.Ok(await docs.ListBooksAsync(ct)));

api.MapGet("/books/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookAsync(id, ct);
    return book is null ? Results.NotFound() : Results.Ok(book);
});

api.MapPost("/books", async (CreateBookRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var created = await docs.CreateBookAsync(body, ct);
    return Results.Created($"/api/books/{created.Id}", created);
});

api.MapPut("/books/{id}", async (string id, UpdateBookRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await docs.UpdateBookAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/books/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var ok = await docs.DeleteBookAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- Chapters ---
api.MapGet("/books/{bookId}/chapters", async (string bookId, IDocumentService docs, CancellationToken ct) =>
    Results.Ok(await docs.ListChaptersAsync(bookId, ct)));

api.MapPost("/books/{bookId}/chapters", async (string bookId, CreateChapterRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    try
    {
        var created = await docs.CreateChapterAsync(bookId, body, ct);
        return Results.Created($"/api/books/{bookId}/chapters/{created.Id}", created);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

api.MapPut("/chapters/{id}", async (string id, UpdateChapterRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await docs.UpdateChapterAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/chapters/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var ok = await docs.DeleteChapterAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- Pages ---
api.MapGet("/books/{bookId}/pages", async (string bookId, IDocumentService docs, CancellationToken ct) =>
    Results.Ok(await docs.ListPagesAsync(bookId, ct)));

api.MapPost("/books/{bookId}/pages", async (string bookId, CreatePageRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    try
    {
        var created = await docs.CreatePageAsync(bookId, body, ct);
        return Results.Created($"/api/pages/{created.Id}", created);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

api.MapGet("/pages/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var page = await docs.GetPageAsync(id, ct);
    return page is null ? Results.NotFound() : Results.Ok(page);
});

api.MapPut("/pages/{id}", async (string id, UpdatePageRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await docs.UpdatePageAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/pages/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var ok = await docs.DeletePageAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- Diagrams ---
api.MapGet("/books/{bookId}/diagrams", async (string bookId, IDiagramService diagrams, CancellationToken ct) =>
    Results.Ok(await diagrams.ListByBookAsync(bookId, ct)));

api.MapPost("/books/{bookId}/diagrams", async (string bookId, CreateDiagramRequest body, IDiagramService diagrams, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    try
    {
        var created = await diagrams.CreateAsync(bookId, body, ct);
        return Results.Created($"/api/diagrams/{created.Id}", created);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

api.MapGet("/pages/{pageId}/diagrams", async (string pageId, IDiagramService diagrams, CancellationToken ct) =>
    Results.Ok(await diagrams.ListByPageAsync(pageId, ct)));

api.MapGet("/diagrams/{id}", async (string id, IDiagramService diagrams, CancellationToken ct) =>
{
    var diagram = await diagrams.GetAsync(id, ct);
    return diagram is null ? Results.NotFound() : Results.Ok(diagram);
});

api.MapPut("/diagrams/{id}", async (string id, UpdateDiagramRequest body, IDiagramService diagrams, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await diagrams.UpdateAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/diagrams/{id}", async (string id, IDiagramService diagrams, CancellationToken ct) =>
{
    var ok = await diagrams.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- Shape collections (book-scoped or app-wide studio snippets) ---
api.MapGet("/books/{bookId}/collections", async (string bookId, IShapeCollectionService collections, CancellationToken ct) =>
    Results.Ok(await collections.ListByBookAsync(bookId, ct)));

api.MapPost("/books/{bookId}/collections", async (string bookId, CreateShapeCollectionRequest body, IShapeCollectionService collections, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Name))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required."] });
    if (string.IsNullOrWhiteSpace(body.Source))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["source"] = ["Source is required."] });

    try
    {
        var created = await collections.CreateAsync(bookId, body, ct);
        return Results.Created($"/api/collections/{created.Id}", created);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

// App-wide library (available in every book's Studio palette).
api.MapGet("/collections", async (IShapeCollectionService collections, CancellationToken ct) =>
    Results.Ok(await collections.ListAppAsync(ct)));

api.MapPost("/collections", async (CreateShapeCollectionRequest body, IShapeCollectionService collections, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Name))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required."] });
    if (string.IsNullOrWhiteSpace(body.Source))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["source"] = ["Source is required."] });

    var created = await collections.CreateAsync(null, body, ct);
    return Results.Created($"/api/collections/{created.Id}", created);
});

api.MapGet("/collections/{id}", async (string id, IShapeCollectionService collections, CancellationToken ct) =>
{
    var row = await collections.GetAsync(id, ct);
    return row is null ? Results.NotFound() : Results.Ok(row);
});

api.MapPut("/collections/{id}", async (string id, UpdateShapeCollectionRequest body, IShapeCollectionService collections, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Name))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required."] });

    var updated = await collections.UpdateAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/collections/{id}", async (string id, IShapeCollectionService collections, CancellationToken ct) =>
{
    var ok = await collections.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- LLM providers & completion ---
// Behind the same key as /api/v1, and not optional: a completion spends the user's
// money, so an unauthenticated /api/llm on a reachable port is a bill waiting to
// happen. Provider keys are stored server-side and never returned.
var llm = api.MapGroup("/llm")
    .AddEndpointFilter<ApiKeyEndpointFilter>()
    .WithTags("LLM");

static IResult LlmFailure(LlmException ex) =>
    Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status502BadGateway);

llm.MapGet("/providers", async (ILlmProviderService providers, CancellationToken ct) =>
    Results.Ok(await providers.ListAsync(ct)));

llm.MapPost("/providers", async (CreateLlmProviderRequest body, ILlmProviderService providers, CancellationToken ct) =>
{
    try
    {
        var created = await providers.CreateAsync(body, ct);
        return Results.Created($"/api/llm/providers/{created.Id}", created);
    }
    catch (ArgumentException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["provider"] = [ex.Message] });
    }
});

llm.MapGet("/providers/{id}", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var provider = await providers.GetAsync(id, ct);
    return provider is null ? Results.NotFound() : Results.Ok(provider);
});

llm.MapPut("/providers/{id}", async (string id, UpdateLlmProviderRequest body, ILlmProviderService providers, CancellationToken ct) =>
{
    try
    {
        var updated = await providers.UpdateAsync(id, body, ct);
        return updated is null ? Results.NotFound() : Results.Ok(updated);
    }
    catch (ArgumentException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["provider"] = [ex.Message] });
    }
});

llm.MapDelete("/providers/{id}", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var ok = await providers.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// Promote to default: first in sort order, and enabled, in one transaction.
// Doing it client-side meant one PUT per provider with no way to undo a failure
// halfway through the renumber.
llm.MapPost("/providers/{id}/default", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var promoted = await providers.MakeDefaultAsync(id, ct);
    return promoted is null ? Results.NotFound() : Results.Ok(promoted);
});

// Reachability + credentials. Reports failure in the payload rather than as an
// error status, because the settings UI shows the message either way.
llm.MapPost("/providers/{id}/test", async (string id, ILlmClient client, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await client.TestAsync(id, ct));
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

llm.MapGet("/providers/{id}/models", async (string id, ILlmClient client, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await client.ListModelsAsync(id, ct));
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
    catch (LlmException ex)
    {
        return LlmFailure(ex);
    }
});

llm.MapPost("/complete", async (LlmCompleteRequest body, ILlmClient client, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await client.CompleteAsync(body, ct));
    }
    catch (ArgumentException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["task"] = [ex.Message] });
    }
    catch (KeyNotFoundException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
    catch (LlmException ex)
    {
        return LlmFailure(ex);
    }
});

// --- Export ---
// PDF is produced in the browser (Print → Save as PDF) because rendering
// Mermaid/BeeDiagram content needs a DOM; everything else is built here.
static IResult ExportResult(ExportPayload? payload) =>
    payload is null
        ? Results.NotFound()
        : Results.File(payload.Content, payload.ContentType, payload.FileName);

static bool TryParseFormat(string? value, out ExportFormat format)
{
    format = ExportFormat.Archive;
    switch ((value ?? "archive").Trim().ToLowerInvariant())
    {
        case "archive" or "beedocs" or "bundle": format = ExportFormat.Archive; return true;
        case "markdown" or "md": format = ExportFormat.Markdown; return true;
        case "docx" or "word": format = ExportFormat.Docx; return true;
        default: return false;
    }
}

api.MapGet("/books/{id}/export", async (string id, string? format, IExportService export, CancellationToken ct) =>
{
    if (!TryParseFormat(format, out var parsed))
        return Results.BadRequest(new { error = "Unknown format. Use archive, markdown, or docx." });

    return ExportResult(await export.ExportBookAsync(id, parsed, ct));
});

api.MapGet("/pages/{id}/export", async (string id, string? format, IExportService export, CancellationToken ct) =>
{
    if (!TryParseFormat(format, out var parsed))
        return Results.BadRequest(new { error = "Unknown format. Use archive, markdown, or docx." });

    return ExportResult(await export.ExportPageAsync(id, parsed, ct));
});

// --- Import ---
// The form is read straight off HttpRequest (rather than via IFormFile binding)
// to match /api/uploads and to stay clear of the minimal-API antiforgery filter.
static async Task<(IFormFile? File, IFormCollection Form)> ReadUploadAsync(HttpRequest request, CancellationToken ct)
{
    var form = await request.ReadFormAsync(ct);
    return (form.Files.GetFile("file") ?? form.Files.FirstOrDefault(), form);
}

api.MapPost("/import/inspect", async (HttpRequest request, IImportService import, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart form data with a file field." });

    var (file, _) = await ReadUploadAsync(request, ct);
    if (file is null || file.Length == 0)
        return Results.BadRequest(new { error = "No file uploaded." });

    try
    {
        await using var stream = file.OpenReadStream();
        return Results.Ok(await import.InspectAsync(stream, file.FileName, ct));
    }
    catch (InvalidImportException e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

api.MapPost("/import", async (HttpRequest request, IImportService import, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart form data with a file field." });

    var (file, form) = await ReadUploadAsync(request, ct);
    if (file is null || file.Length == 0)
        return Results.BadRequest(new { error = "No file uploaded." });

    var mode = (form["mode"].ToString() ?? "rename").Trim().ToLowerInvariant() switch
    {
        "keep" or "same" or "keep-name" => ImportNameMode.Keep,
        _ => ImportNameMode.Rename,
    };

    var targetBookId = form["targetBookId"].ToString();
    var title = form["title"].ToString();

    try
    {
        await using var stream = file.OpenReadStream();
        var result = await import.ImportAsync(
            stream,
            file.FileName,
            mode,
            string.IsNullOrWhiteSpace(targetBookId) ? null : targetBookId,
            string.IsNullOrWhiteSpace(title) ? null : title,
            ct);
        return Results.Ok(result);
    }
    catch (InvalidImportException e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
});

// --- Uploads (images, PDF, 3D models) ---
const long MaxImageUploadBytes = 8 * 1024 * 1024;
const long MaxDocumentUploadBytes = 50 * 1024 * 1024;
var allowedImageExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
};
var allowedDocumentExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    ".pdf", ".glb", ".gltf", ".obj",
};
var allowedUploadExt = new HashSet<string>(allowedImageExt, StringComparer.OrdinalIgnoreCase);
foreach (var e in allowedDocumentExt) allowedUploadExt.Add(e);

static bool IsAllowedUploadContentType(string contentType) =>
    contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
    || contentType.Equals("application/pdf", StringComparison.OrdinalIgnoreCase)
    || contentType.Equals("model/gltf-binary", StringComparison.OrdinalIgnoreCase)
    || contentType.Equals("model/gltf+json", StringComparison.OrdinalIgnoreCase)
    || contentType.Equals("model/obj", StringComparison.OrdinalIgnoreCase)
    // Browsers often label .obj as text/plain; extension check still gates the type.
    || contentType.Equals("text/plain", StringComparison.OrdinalIgnoreCase)
    || contentType is "application/octet-stream" or "";

static string InferExtFromContentType(string contentType) =>
    contentType.ToLowerInvariant() switch
    {
        "image/png" => ".png",
        "image/jpeg" or "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        "application/pdf" => ".pdf",
        "model/gltf-binary" => ".glb",
        "model/gltf+json" => ".gltf",
        "model/obj" => ".obj",
        _ => "",
    };

static string DefaultContentTypeForExt(string ext) =>
    ext.ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".pdf" => "application/pdf",
        ".glb" => "model/gltf-binary",
        ".gltf" => "model/gltf+json",
        ".obj" => "model/obj",
        _ => "application/octet-stream",
    };

api.MapPost("/uploads", async (HttpRequest request, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart form data with a file field." });

    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault();
    if (file is null || file.Length == 0)
        return Results.BadRequest(new { error = "No file uploaded." });

    var contentType = file.ContentType ?? "";
    if (!IsAllowedUploadContentType(contentType))
    {
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = ["Only image, PDF, and 3D model files are allowed."],
        });
    }

    var ext = Path.GetExtension(file.FileName);
    if (string.IsNullOrWhiteSpace(ext) || !allowedUploadExt.Contains(ext))
        ext = InferExtFromContentType(contentType);

    if (string.IsNullOrEmpty(ext) || !allowedUploadExt.Contains(ext))
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = ["Unsupported file type. Use PNG, JPEG, GIF, WebP, SVG, PDF, GLB, GLTF, or OBJ."],
        });

    ext = ext.ToLowerInvariant();
    var isImage = allowedImageExt.Contains(ext);
    var maxBytes = isImage ? MaxImageUploadBytes : MaxDocumentUploadBytes;
    if (file.Length > maxBytes)
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = [$"File exceeds maximum size of {maxBytes / (1024 * 1024)} MB."],
        });

    var id = Guid.NewGuid().ToString("N")[..16];
    var storedName = id + ext;
    var path = Path.Combine(uploadsRoot, storedName);
    await using (var stream = System.IO.File.Create(path))
    {
        await file.CopyToAsync(stream, ct);
    }

    // Prefer a real media type over browser placeholders (empty / octet-stream / text/plain).
    var resolvedContentType = string.IsNullOrWhiteSpace(contentType)
        || contentType.Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase)
        || contentType.Equals("text/plain", StringComparison.OrdinalIgnoreCase)
        ? DefaultContentTypeForExt(ext)
        : contentType;

    var url = $"/uploads/{storedName}";
    return Results.Created(url, new
    {
        id,
        fileName = Path.GetFileName(file.FileName),
        url,
        contentType = resolvedContentType,
        size = file.Length,
    });
});

// =============================================================================
// External REST API (v1) — slug-based books & pages for apps that publish docs.
// Protected by BeeDocs:ApiKey when configured (Bearer or X-Api-Key).
// The UI continues to use the id-based /api/* routes above.
// =============================================================================
var v1 = api.MapGroup("/v1")
    .AddEndpointFilter<ApiKeyEndpointFilter>()
    .WithTags("Publish API v1");

v1.MapGet("/", () => Results.Ok(new
{
    service = "BeeDocs.Api",
    version = appVersion,
    api = "v1",
    description = "Slug-based REST API for publishing books and Markdown pages from external apps.",
    docs = "/api/v1 (see Docs/REST-API.md)",
    resources = new
    {
        books = "/api/v1/books",
        book = "/api/v1/books/{bookSlug}",
        pages = "/api/v1/books/{bookSlug}/pages",
        page = "/api/v1/books/{bookSlug}/pages/{pageSlug}",
        publish = "PUT /api/v1/publish",
        search = "/api/v1/search?q=",
    },
}));

// --- Search ---
// Same index as /api/search, but scoped by book slug rather than id so callers
// that publish by slug can query back without holding onto ids.
v1.MapGet("/search", async (
    string? q,
    int? limit,
    int? offset,
    string? bookSlug,
    string? kinds,
    bool? prefix,
    IDocumentService docs,
    ISearchIndexService search,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    string? bookId = null;
    if (!string.IsNullOrWhiteSpace(bookSlug))
    {
        var book = await docs.GetBookBySlugAsync(bookSlug, ct);
        if (book is null)
            return Results.NotFound(new { error = $"Book '{bookSlug}' not found." });
        bookId = book.Id;
    }

    var query = new SearchQuery(
        Text: q,
        Limit: limit ?? 20,
        Offset: offset ?? 0,
        BookId: bookId,
        Kinds: ParseKinds(kinds),
        Prefix: prefix ?? true);

    return Results.Ok(await search.SearchAsync(query, ct));
});

// --- Books ---
v1.MapGet("/books", async (IDocumentService docs, CancellationToken ct) =>
    Results.Ok(await docs.ListBooksAsync(ct)));

v1.MapGet("/books/{bookSlug}", async (string bookSlug, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    return book is null ? Results.NotFound(new { error = $"Book '{bookSlug}' not found." }) : Results.Ok(book);
});

v1.MapPut("/books/{bookSlug}", async (string bookSlug, UpsertBookRequest? body, IDocumentService docs, CancellationToken ct) =>
{
    body ??= new UpsertBookRequest(null, null, null);
    var result = await docs.UpsertBookBySlugAsync(bookSlug, body, ct);
    return result.Created
        ? Results.Created($"/api/v1/books/{result.Item.Slug}", result)
        : Results.Ok(result);
});

v1.MapDelete("/books/{bookSlug}", async (string bookSlug, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    if (book is null) return Results.NotFound(new { error = $"Book '{bookSlug}' not found." });
    await docs.DeleteBookAsync(book.Id, ct);
    return Results.NoContent();
});

// --- Pages ---
v1.MapGet("/books/{bookSlug}/pages", async (string bookSlug, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    if (book is null) return Results.NotFound(new { error = $"Book '{bookSlug}' not found." });
    return Results.Ok(await docs.ListPagesAsync(book.Id, ct));
});

v1.MapGet("/books/{bookSlug}/pages/{pageSlug}", async (string bookSlug, string pageSlug, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    if (book is null) return Results.NotFound(new { error = $"Book '{bookSlug}' not found." });
    var page = await docs.GetPageBySlugAsync(book.Id, pageSlug, ct);
    return page is null
        ? Results.NotFound(new { error = $"Page '{pageSlug}' not found in book '{bookSlug}'." })
        : Results.Ok(page);
});

v1.MapPut("/books/{bookSlug}/pages/{pageSlug}", async (
    string bookSlug,
    string pageSlug,
    UpsertPageRequest body,
    IDocumentService docs,
    CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    if (book is null)
    {
        // Auto-create the book so publishers can write pages without a prior step.
        var createdBook = await docs.UpsertBookBySlugAsync(
            bookSlug,
            new UpsertBookRequest(Title: bookSlug, Description: null, SortOrder: null),
            ct);
        book = createdBook.Item;
    }

    try
    {
        var result = await docs.UpsertPageBySlugAsync(book.Id, pageSlug, body, ct);
        return result.Created
            ? Results.Created($"/api/v1/books/{book.Slug}/pages/{result.Item.Slug}", result)
            : Results.Ok(result);
    }
    catch (ArgumentException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["content"] = [ex.Message],
        });
    }
});

v1.MapDelete("/books/{bookSlug}/pages/{pageSlug}", async (string bookSlug, string pageSlug, IDocumentService docs, CancellationToken ct) =>
{
    var book = await docs.GetBookBySlugAsync(bookSlug, ct);
    if (book is null) return Results.NotFound(new { error = $"Book '{bookSlug}' not found." });
    var page = await docs.GetPageBySlugAsync(book.Id, pageSlug, ct);
    if (page is null) return Results.NotFound(new { error = $"Page '{pageSlug}' not found in book '{bookSlug}'." });
    await docs.DeletePageAsync(page.Id, ct);
    return Results.NoContent();
});

// --- One-shot publish (book + page) ---
v1.MapPut("/publish", async (PublishDocumentRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (body.Book is null || string.IsNullOrWhiteSpace(body.Book.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["book.title"] = ["Book title is required."] });
    if (body.Page is null || string.IsNullOrWhiteSpace(body.Page.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["page.title"] = ["Page title is required."] });
    if (body.Page.Content is null)
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["page.content"] = ["Page content is required."] });

    try
    {
        var result = await docs.PublishDocumentAsync(body, ct);
        var status = result.BookCreated || result.PageCreated ? StatusCodes.Status201Created : StatusCodes.Status200OK;
        return Results.Json(result, statusCode: status);
    }
    catch (ArgumentException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["request"] = [ex.Message] });
    }
});

// SPA fallback (production container with wwwroot)
if (Directory.Exists(wwwroot))
{
    app.MapFallbackToFile("index.html");
}

app.Run();

public partial class Program;
