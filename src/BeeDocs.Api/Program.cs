using System.Reflection;
using BeeDocs.Api.Models;
using BeeDocs.Api.Services;
using Microsoft.Extensions.FileProviders;
using SurrealDb.Net;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyHeader()
            .AllowAnyMethod()
            .AllowAnyOrigin());
});

// SurrealDB: embedded RocksDB by default (file under data/), mem:// for tests
var dataDir = builder.Configuration["BeeDocs:DataPath"]
    ?? Path.Combine(builder.Environment.ContentRootPath, "data", "surreal");
Directory.CreateDirectory(dataDir);

var surrealEndpoint = builder.Configuration.GetConnectionString("SurrealDB")
    ?? $"Endpoint=rocksdb://{dataDir}";

var surrealBuilder = builder.Services.AddSurreal(surrealEndpoint, ServiceLifetime.Singleton);

if (surrealEndpoint.Contains("mem://", StringComparison.OrdinalIgnoreCase)
    || surrealEndpoint.Contains("Endpoint=mem", StringComparison.OrdinalIgnoreCase))
{
    surrealBuilder.AddInMemoryProvider();
}
else
{
    surrealBuilder.AddRocksDbProvider();
}

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
builder.Services.AddSingleton<IDocumentService, DocumentService>();
builder.Services.AddSingleton<IDiagramService, DiagramService>();
builder.Services.AddSingleton<IExportService, ExportService>();
builder.Services.AddSingleton<IImportService, ImportService>();

// Imported archives carry their images, so the 30 MB Kestrel default is too
// tight for a book of screenshots. Individual uploads stay capped at 8 MB by
// the /api/uploads handler below.
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
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(uploadsRoot),
    RequestPath = "/uploads",
});

// Ensure NS/DB selected + schema for embedded engine
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ISurrealDbClient>();
    var ns = builder.Configuration["BeeDocs:Namespace"] ?? "beedocs";
    var database = builder.Configuration["BeeDocs:Database"] ?? "main";
    await db.Use(ns, database);
    await DatabaseInitializer.EnsureSchemaAsync(db);
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

api.MapGet("/health", () => Results.Ok(new { status = "ok", service = "BeeDocs.Api", version = appVersion }));

api.MapGet("/version", () => Results.Ok(new { version = appVersion }));

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

// --- Uploads (images) ---
const long MaxUploadBytes = 8 * 1024 * 1024;
var allowedImageExt = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
};

api.MapPost("/uploads", async (HttpRequest request, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "Expected multipart form data with a file field." });

    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file") ?? form.Files.FirstOrDefault();
    if (file is null || file.Length == 0)
        return Results.BadRequest(new { error = "No file uploaded." });

    if (file.Length > MaxUploadBytes)
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = [$"File exceeds maximum size of {MaxUploadBytes / (1024 * 1024)} MB."],
        });

    var contentType = file.ContentType ?? "";
    if (!contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
        && contentType is not ("application/octet-stream" or ""))
    {
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = ["Only image files are allowed."],
        });
    }

    var ext = Path.GetExtension(file.FileName);
    if (string.IsNullOrWhiteSpace(ext) || !allowedImageExt.Contains(ext))
    {
        ext = contentType.ToLowerInvariant() switch
        {
            "image/png" => ".png",
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/gif" => ".gif",
            "image/webp" => ".webp",
            "image/svg+xml" => ".svg",
            _ => "",
        };
    }

    if (string.IsNullOrEmpty(ext) || !allowedImageExt.Contains(ext))
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["file"] = ["Unsupported image type. Use PNG, JPEG, GIF, WebP, or SVG."],
        });

    var id = Guid.NewGuid().ToString("N")[..16];
    var storedName = id + ext.ToLowerInvariant();
    var path = Path.Combine(uploadsRoot, storedName);
    await using (var stream = System.IO.File.Create(path))
    {
        await file.CopyToAsync(stream, ct);
    }

    var url = $"/uploads/{storedName}";
    return Results.Created(url, new
    {
        id,
        fileName = Path.GetFileName(file.FileName),
        url,
        contentType = string.IsNullOrWhiteSpace(contentType) ? $"image/{ext.TrimStart('.')}" : contentType,
        size = file.Length,
    });
});

// SPA fallback (production container with wwwroot)
if (Directory.Exists(wwwroot))
{
    app.MapFallbackToFile("index.html");
}

app.Run();

public partial class Program;
