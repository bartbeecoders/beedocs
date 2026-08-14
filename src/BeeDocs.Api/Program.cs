using System.Reflection;
using BeeDocs.Api.Models;
using BeeDocs.Api.Services;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Options;

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
builder.Services.Configure<AuthOptions>(builder.Configuration.GetSection(AuthOptions.SectionName));
builder.Services.AddSingleton<ApiKeySettingsService>();
builder.Services.AddSingleton<ApiKeyEndpointFilter>();
builder.Services.AddSingleton<RequestAuthenticator>();

// Ownership and page history record who acted. The filter above resolves that
// once per request; this is how the singleton services reach it.
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<ICurrentUserAccessor, HttpCurrentUserAccessor>();
builder.Services.AddSingleton<AuthEndpointFilter>();

// The session lifetime is configuration, but it is also the number the session
// table stores and slides against — handing it to the service once keeps the
// cookie and the row from ever disagreeing about when a login ends.
builder.Services.AddSingleton<IUserService>(sp =>
{
    var auth = sp.GetRequiredService<IOptions<AuthOptions>>().Value;
    return new UserService(
        sp.GetRequiredService<SqliteConnectionFactory>(),
        sp.GetRequiredService<ILogger<UserService>>())
    {
        SessionLifetime = auth.SessionLifetime,
    };
});
builder.Services.AddSingleton<IDocumentService, DocumentService>();
builder.Services.AddSingleton<IDiagramService, DiagramService>();
builder.Services.AddSingleton<ISlideDeckService, SlideDeckService>();
builder.Services.AddSingleton<ISlideTemplateService, SlideTemplateService>();
builder.Services.AddSingleton<SlideDeckPptxExporter>();
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

// The public reverse proxy strips prefixes like /beedocs and /beedocs-api before
// forwarding, so the app serves at root. Stripping the same prefixes here lets one
// deployment also answer direct (un-proxied) requests that still carry them.
// Inert unless BeeDocs:PublicPathBases is configured.
var publicPathBases = (app.Configuration.GetSection("BeeDocs:PublicPathBases").Get<string[]>() ?? [])
    .Select(p => "/" + (p ?? "").Trim().Trim('/'))
    .Where(p => p.Length > 1)
    .ToArray();
if (publicPathBases.Length > 0)
{
    app.Use((ctx, next) =>
    {
        foreach (var basePath in publicPathBases)
        {
            if (ctx.Request.Path.StartsWithSegments(basePath, out var rest))
            {
                ctx.Request.Path = rest.HasValue ? rest : "/";
                break;
            }
        }
        return next(ctx);
    });
}

// Explicit so endpoint matching sees the rewritten path (the implicit UseRouting
// would otherwise run before the middleware above).
app.UseRouting();

app.UseCors();

var wwwroot = Path.Combine(app.Environment.ContentRootPath, "wwwroot");
if (Directory.Exists(wwwroot))
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
}

// Gate /uploads behind the same sign-in as /api. Static file middleware answers
// before any endpoint filter runs, so without this an instance with auth enabled
// still hands every uploaded screenshot to anyone who knows the URL — and those
// URLs are in the Markdown of pages the same instance is busy protecting.
// Inert while BeeDocs:Auth:Enabled is off.
app.UseWhen(
    ctx => ctx.Request.Path.StartsWithSegments("/uploads"),
    branch => branch.Use(async (ctx, next) =>
    {
        var authenticator = ctx.RequestServices.GetRequiredService<RequestAuthenticator>();
        if (!authenticator.Enabled)
        {
            await next(ctx);
            return;
        }

        var caller = await authenticator.ResolveAsync(ctx);
        if (caller is not null)
        {
            ctx.SetCurrentUser(caller);
            await next(ctx);
            return;
        }

        // A published bookshelf website embeds /uploads URLs in its Markdown.
        // Gating every file while that site is world-readable would leave it
        // full of broken images. Only GET/HEAD are opened, and only while at
        // least one shelf is published — turning every shelf off restores the
        // gate. Upload ids are unguessable; this does not list the directory.
        var isRead = HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method);
        if (isRead)
        {
            var docs = ctx.RequestServices.GetRequiredService<IDocumentService>();
            if (await docs.HasPublishedShelfAsync(ctx.RequestAborted))
            {
                await next(ctx);
                return;
            }
        }

        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
    }));

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

    // No account is created here. An instance with an empty account table is
    // "unclaimed": the browser shows a one-time setup screen and whoever fills it
    // in becomes the admin, with a password they chose. The alternative — seeding
    // a random password and printing it — put the only copy of a credential in a
    // log file and asked the operator to go dig it out.
    if (app.Services.GetRequiredService<IOptions<AuthOptions>>().Value.Enabled
        && await scope.ServiceProvider.GetRequiredService<IUserService>().CountAsync() == 0)
    {
        // Worth shouting about: until someone claims it, anyone who can reach
        // this instance can, and they will be its administrator.
        app.Logger.LogWarning(
            "No accounts exist — BeeDocs is waiting for first-run setup. The first visitor to reach " +
            "this instance can claim the admin account, so do not leave it publicly reachable while " +
            "it is unclaimed.");
    }
}

var api = app.MapGroup("/api");

// Sign-in and role checks for everything under /api. Added to the group, so the
// /api/v1 and /api/llm subgroups inherit it. Endpoints that must stay reachable
// without a session (health, version, sign-in itself) carry AllowAnonymousEndpoint.
api.AddEndpointFilter<AuthEndpointFilter>();

// Build version, sourced from <Version> in BeeDocs.Api.csproj. The deploy script
// bumps the last digit (the build number) on every deploy, so this is what the
// UI shows to identify which build is live. SourceLink appends "+<sha>" to the
// informational version when it is enabled — trim it for display.
var appVersion = (Assembly.GetExecutingAssembly()
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "0.0.0")
    .Split('+')[0];

// The effective key is the one saved on the Settings page, else BeeDocs:ApiKey
// from configuration — see ApiKeySettingsService. The schema is ensured above,
// so the stored value is readable here.
var apiKeyStatus = await app.Services.GetRequiredService<ApiKeySettingsService>().GetStatusAsync();
if (!apiKeyStatus.HasKey)
{
    app.Logger.LogWarning(
        "No API key is configured — /api/v1 is open without authentication. " +
        "Set one in Settings → API access, or via BeeDocs__ApiKey (or BeeDocs:ApiKey).");
}
else
{
    app.Logger.LogInformation(
        "An API key is configured (from {Source}) — /api/v1 requires Bearer or X-Api-Key.",
        apiKeyStatus.Source);
}

// A stored provider key turns /api/llm into something that spends real money.
// Without an API key, anyone who can reach this port can spend it.
if (!apiKeyStatus.HasKey
    && await app.Services.GetRequiredService<ILlmProviderService>().AnyKeyStoredAsync())
{
    app.Logger.LogWarning(
        "An LLM provider has a stored API key but no publish API key is configured — /api/llm is " +
        "unauthenticated, so anyone who can reach this port can spend that key. " +
        "Set one in Settings → API access, or via BeeDocs__ApiKey (or BeeDocs:ApiKey).");
}

var authOptions = app.Services.GetRequiredService<IOptions<AuthOptions>>().Value;
if (authOptions.Enabled)
{
    app.Logger.LogInformation(
        "BeeDocs:Auth:Enabled is on — /api and /uploads require a signed-in account (sessions last {Hours}h).",
        authOptions.SessionLifetime.TotalHours);

    // MCP and every publishing app reach /api with no cookie. With sign-in on and
    // no key configured they get a 401 on the next request they make, which reads
    // as "the server broke" rather than "the server now wants credentials".
    if (!apiKeyStatus.HasKey)
    {
        app.Logger.LogWarning(
            "Sign-in is enabled but no API key is configured — non-browser clients (the MCP server, " +
            "publishing apps) cannot authenticate and will receive 401. Set one in Settings → API access " +
            "(or via BeeDocs__ApiKey) and pass it as BEEDOCS_API_KEY to BeeDocs.Mcp.");
    }
}

// Health and version answer before any credential check: a readiness probe that
// needs a session is a readiness probe that reports the wrong thing.
api.MapGet("/health", () => Results.Ok(new { status = "ok", service = "BeeDocs.Api", version = appVersion }))
    .WithMetadata(new AllowAnonymousEndpoint());

api.MapGet("/version", () => Results.Ok(new { version = appVersion }))
    .WithMetadata(new AllowAnonymousEndpoint());

// --- Sign-in & accounts ---
// /api/auth/* is anonymous by necessity: it is how a browser with no cookie
// finds out whether it needs one and gets one. Each handler does its own check.
var auth = api.MapGroup("/auth")
    .WithMetadata(new AllowAnonymousEndpoint())
    .WithTags("Auth");

// Cookie flags in one place. HttpOnly so a script cannot read the token, Lax so
// it survives ordinary navigation without riding along on cross-site POSTs, and
// Secure whenever the request arrived over TLS (or SecureCookie forces it, which
// is what a TLS-terminating proxy in front of plain HTTP needs).
CookieOptions SessionCookie(HttpContext http, DateTimeOffset? expires) => new()
{
    HttpOnly = true,
    IsEssential = true,
    SameSite = SameSiteMode.Lax,
    Secure = authOptions.SecureCookie ?? http.Request.IsHttps,
    Path = "/",
    Expires = expires,
};

static AuthStateDto AuthState(bool enabled, CurrentUser? caller, bool setupRequired = false) =>
    new(
        AuthEnabled: enabled,
        Authenticated: caller is not null,
        Via: caller?.Via ?? "none",
        User: caller?.User,
        Permissions: new AuthPermissionsDto(
            CanRead: caller is not null,
            CanWrite: caller?.CanWrite ?? false,
            CanManageUsers: caller?.CanManageUsers ?? false),
        SetupRequired: setupRequired);

// The SPA's first call: is sign-in switched on, and who am I? Never 401s —
// "nobody" is a valid answer and the one that renders the login screen.
auth.MapGet("/me", async (HttpContext http, RequestAuthenticator authenticator, IUserService users, CancellationToken ct) =>
{
    // One COUNT per page load, on a table with a handful of rows. Cheap enough
    // not to cache, and caching it would mean a stale "already set up" the first
    // time someone claims the instance.
    var unclaimed = await users.CountAsync(ct) == 0;

    if (!authenticator.Enabled)
        return Results.Ok(AuthState(false, CurrentUser.Open, unclaimed));

    var caller = await authenticator.ResolveAsync(http);
    return Results.Ok(AuthState(true, caller, unclaimed));
});

// First-run claim. Open only while the account table is empty; the emptiness
// check lives inside the INSERT, so this cannot be raced into two admins.
auth.MapPost("/setup", async (
    SetupRequest body,
    HttpContext http,
    RequestAuthenticator authenticator,
    IUserService users,
    CancellationToken ct) =>
{
    try
    {
        var admin = await users.CreateFirstAdminAsync(body.Username, body.Password, body.DisplayName, ct);

        // Signed straight in: making someone type the password they chose ten
        // seconds ago into a login form proves nothing.
        var ticket = await users.CreateSessionAsync(admin.Id, ct);
        http.Response.Cookies.Append(authenticator.CookieName, ticket.Token, SessionCookie(http, ticket.ExpiresAt));

        return Results.Ok(AuthState(authenticator.Enabled, RequestAuthenticator.ToCurrentUser(admin)));
    }
    catch (AlreadySetUpException e)
    {
        return Results.Json(new { error = e.Message }, statusCode: StatusCodes.Status409Conflict);
    }
    catch (ArgumentException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["setup"] = [e.Message] });
    }
});

auth.MapPost("/login", async (
    LoginRequest body,
    HttpContext http,
    RequestAuthenticator authenticator,
    IUserService users,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Username) || string.IsNullOrWhiteSpace(body.Password))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["username"] = ["Username and password are required."] });

    var user = await users.AuthenticateAsync(body.Username, body.Password, ct);
    if (user is null)
    {
        // One message for a wrong username, a wrong password and a disabled
        // account. Which of the three it was is exactly what an attacker wants.
        // The sentence goes in `error` because that is the field the whole API
        // puts a readable message in — and the login form shows it verbatim.
        return Results.Json(
            new { error = "Incorrect username or password." },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    var ticket = await users.CreateSessionAsync(user.Id, ct);
    http.Response.Cookies.Append(authenticator.CookieName, ticket.Token, SessionCookie(http, ticket.ExpiresAt));

    return Results.Ok(AuthState(authenticator.Enabled, RequestAuthenticator.ToCurrentUser(user)));
});

auth.MapPost("/logout", async (HttpContext http, RequestAuthenticator authenticator, IUserService users, CancellationToken ct) =>
{
    if (http.Request.Cookies[authenticator.CookieName] is { Length: > 0 } token)
        await users.RevokeSessionAsync(token, ct);

    // Same flags as the cookie being replaced — a Delete that differs in Path or
    // Secure leaves the original in place and the browser still signed in.
    http.Response.Cookies.Append(authenticator.CookieName, "", SessionCookie(http, DateTimeOffset.UnixEpoch));
    return Results.NoContent();
});

// Change your own password. Signing in is the only requirement, so this stays in
// the anonymous group and does the check itself — a viewer may change theirs too.
auth.MapPost("/password", async (
    ChangePasswordRequest body,
    HttpContext http,
    RequestAuthenticator authenticator,
    IUserService users,
    CancellationToken ct) =>
{
    var caller = authenticator.Enabled ? await authenticator.ResolveAsync(http) : http.GetCurrentUser();
    if (caller?.User is null)
    {
        return Results.Json(
            new { error = "Unauthorized", message = "Sign in to change your password." },
            statusCode: StatusCodes.Status401Unauthorized);
    }

    try
    {
        var updated = await users.ChangePasswordAsync(caller.User.Id, body.CurrentPassword, body.NewPassword, ct);
        if (updated is null) return Results.NotFound();

        // Changing a password drops every session for the account, including this
        // one — so issue a fresh cookie rather than signing the user out of the
        // browser they just proved themselves in.
        var ticket = await users.CreateSessionAsync(updated.Id, ct);
        http.Response.Cookies.Append(authenticator.CookieName, ticket.Token, SessionCookie(http, ticket.ExpiresAt));

        return Results.Ok(AuthState(authenticator.Enabled, RequestAuthenticator.ToCurrentUser(updated)));
    }
    catch (InvalidPasswordException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["currentPassword"] = [e.Message] });
    }
    catch (ArgumentException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["newPassword"] = [e.Message] });
    }
});

// --- User management (admin only) ---
// Admin for reads as well as writes: the list is who can reach this instance and
// with what authority, which is not something an editor needs to enumerate.
// Naming an account is not managing one: an editor has to be able to see who
// they are handing a book to. Deliberately outside the admin group below, and
// deliberately thinner than UserDto — id, name and role, enabled accounts only.
// A literal path segment outranks "/users/{id}", so the two do not collide.
api.MapGet("/users/directory", async (IUserService users, CancellationToken ct) =>
    (await users.ListAsync(ct))
        .Where(u => u.Enabled)
        .Select(u => new UserSummaryDto(u.Id, u.Username, u.DisplayName, u.Role))
        .ToList());

var userAdmin = api.MapGroup("/users")
    .WithMetadata(RequireRole.Admin)
    .WithTags("Users");

static IResult UserConflict(Exception e) =>
    Results.Json(new { error = "Conflict", message = e.Message }, statusCode: StatusCodes.Status409Conflict);

userAdmin.MapGet("/", async (IUserService users, CancellationToken ct) =>
    Results.Ok(await users.ListAsync(ct)));

userAdmin.MapGet("/roles", () => Results.Ok(UserRoles.All.Select(role => new
{
    id = role,
    canWrite = UserRoles.CanWrite(role),
    canManageUsers = UserRoles.CanManageUsers(role),
})));

userAdmin.MapPost("/", async (CreateUserRequest body, IUserService users, CancellationToken ct) =>
{
    try
    {
        var created = await users.CreateAsync(body, ct);
        return Results.Created($"/api/users/{created.Id}", created);
    }
    catch (DuplicateUserException e)
    {
        return UserConflict(e);
    }
    catch (ArgumentException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["user"] = [e.Message] });
    }
});

userAdmin.MapGet("/{id}", async (string id, IUserService users, CancellationToken ct) =>
{
    var user = await users.GetAsync(id, ct);
    return user is null ? Results.NotFound() : Results.Ok(user);
});

userAdmin.MapPut("/{id}", async (string id, UpdateUserRequest body, IUserService users, CancellationToken ct) =>
{
    try
    {
        var updated = await users.UpdateAsync(id, body, ct);
        return updated is null ? Results.NotFound() : Results.Ok(updated);
    }
    catch (DuplicateUserException e)
    {
        return UserConflict(e);
    }
    catch (LastAdminException e)
    {
        return UserConflict(e);
    }
    catch (ArgumentException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["user"] = [e.Message] });
    }
});

userAdmin.MapDelete("/{id}", async (string id, IUserService users, CancellationToken ct) =>
{
    try
    {
        return await users.DeleteAsync(id, ct) ? Results.NoContent() : Results.NotFound();
    }
    catch (LastAdminException e)
    {
        return UserConflict(e);
    }
});

// Admin reset. With no password in the body the server generates one and returns
// it once — the only response in the API that carries a password, and the reason
// an admin can hand someone a working login without inventing one themselves.
userAdmin.MapPost("/{id}/password", async (
    string id,
    SetUserPasswordRequest? body,
    IUserService users,
    CancellationToken ct) =>
{
    try
    {
        var result = await users.SetPasswordAsync(id, body?.Password, body?.MustChangePassword ?? true, ct);
        return result is null ? Results.NotFound() : Results.Ok(result);
    }
    catch (ArgumentException e)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["password"] = [e.Message] });
    }
});

// --- Search ---
// Full-text over shelf, book, folder, page and diagram text. `kinds` is a comma-separated
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

// --- Shelves ---
// The level above books. A shelf holds no content, so deleting one unshelves its
// books instead of cascading; there is deliberately no "delete the books too".
api.MapGet("/shelves", async (IDocumentService docs, CancellationToken ct) =>
    Results.Ok(await docs.ListShelvesAsync(ct)));

api.MapGet("/shelves/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var shelf = await docs.GetShelfAsync(id, ct);
    return shelf is null ? Results.NotFound() : Results.Ok(shelf);
});

api.MapGet("/shelves/{id}/books", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    if (await docs.GetShelfAsync(id, ct) is null) return Results.NotFound();
    return Results.Ok(await docs.ListShelfBooksAsync(id, ct));
});

api.MapPost("/shelves", async (CreateShelfRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var created = await docs.CreateShelfAsync(body, ct);
    return Results.Created($"/api/shelves/{created.Id}", created);
});

api.MapPut("/shelves/{id}", async (string id, UpdateShelfRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await docs.UpdateShelfAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/shelves/{id}", async (string id, IDocumentService docs, CancellationToken ct) =>
{
    var ok = await docs.DeleteShelfAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// --- Bookshelf websites ---
// A published shelf is served at /bookshelf-serve/{slug} as a reader-only site.
// These endpoints are AllowAnonymous so a visitor with no cookie can load a
// published shelf; unpublished shelves 404 for anonymous callers (and still
// work as a preview for anyone already allowed to read the workspace).
var bookshelfServe = api.MapGroup("/bookshelf-serve")
    .WithMetadata(new AllowAnonymousEndpoint())
    .WithTags("BookshelfSite");

bookshelfServe.MapGet("/{name}", async (
    string name,
    IDocumentService docs,
    RequestAuthenticator authenticator,
    HttpContext http,
    CancellationToken ct) =>
{
    var (site, error) = await OpenBookshelfSiteAsync(name, docs, authenticator, http, ct);
    return error ?? Results.Ok(site);
});

bookshelfServe.MapGet("/{name}/pages/{bookSlug}/{pageSlug}", async (
    string name,
    string bookSlug,
    string pageSlug,
    IDocumentService docs,
    RequestAuthenticator authenticator,
    HttpContext http,
    CancellationToken ct) =>
{
    var (site, error) = await OpenBookshelfSiteAsync(name, docs, authenticator, http, ct);
    if (error is not null) return error;

    var page = await docs.GetBookshelfSitePageAsync(name, bookSlug, pageSlug, ct);
    return page is null ? Results.NotFound() : Results.Ok(page);
});

bookshelfServe.MapGet("/{name}/diagrams/{id}", async (
    string name,
    string id,
    IDocumentService docs,
    IDiagramService diagrams,
    RequestAuthenticator authenticator,
    HttpContext http,
    CancellationToken ct) =>
{
    var (site, error) = await OpenBookshelfSiteAsync(name, docs, authenticator, http, ct);
    if (error is not null) return error;

    var diagram = await diagrams.GetAsync(id, ct);
    if (diagram is null) return Results.NotFound();

    var book = site!.Books.FirstOrDefault(b => b.Id == diagram.BookId);
    return book is null ? Results.NotFound() : Results.Ok(diagram);
});

bookshelfServe.MapGet("/{name}/search", async (
    string name,
    string? q,
    int? limit,
    int? offset,
    string? kinds,
    bool? prefix,
    IDocumentService docs,
    ISearchIndexService search,
    RequestAuthenticator authenticator,
    HttpContext http,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(q))
        return Results.BadRequest(new { error = "Query parameter 'q' is required." });

    var (site, error) = await OpenBookshelfSiteAsync(name, docs, authenticator, http, ct);
    if (error is not null) return error;

    var result = await search.SearchAsync(new SearchQuery(
        Text: q,
        Limit: limit ?? 20,
        Offset: offset ?? 0,
        ShelfId: site!.Shelf.Id,
        Kinds: ParseKinds(kinds) ?? ["page", "book", "folder"],
        Prefix: prefix ?? true), ct);

    return Results.Ok(RewriteSiteSearch(site, result));
});

static async Task<(BookshelfSiteDto? Site, IResult? Error)> OpenBookshelfSiteAsync(
    string name,
    IDocumentService docs,
    RequestAuthenticator authenticator,
    HttpContext http,
    CancellationToken ct)
{
    var site = await docs.GetBookshelfSiteAsync(name, ct);
    if (site is null) return (null, Results.NotFound());

    if (!authenticator.Enabled)
    {
        http.SetCurrentUser(CurrentUser.Open);
        return (site, null);
    }

    var caller = await authenticator.ResolveAsync(http);
    if (caller is not null)
    {
        http.SetCurrentUser(caller);
        return (site, null);
    }

    // Anonymous: only a published shelf is a website. 404 rather than 401 so
    // we do not leak that the slug exists, and so the SPA's global 401 handler
    // does not yank a visitor toward the login screen.
    if (!site.Shelf.Published)
        return (null, Results.NotFound());

    return (site, null);
}

static SearchResponseDto RewriteSiteSearch(BookshelfSiteDto site, SearchResponseDto raw)
{
    var pageUrls = new Dictionary<string, string>(StringComparer.Ordinal);
    var bookUrls = new Dictionary<string, string>(StringComparer.Ordinal);
    var home = $"/bookshelf-serve/{site.Shelf.Slug}";

    foreach (var book in site.Books)
    {
        var bookUrl = $"{home}/{book.Slug}";
        bookUrls[book.Id] = bookUrl;
        foreach (var page in book.Pages)
            pageUrls[page.Id] = $"{bookUrl}/{page.Slug}";
        foreach (var chapter in book.Chapters)
        {
            foreach (var page in chapter.Pages)
                pageUrls[page.Id] = $"{bookUrl}/{page.Slug}";
        }
    }

    var hits = raw.Hits.Select(h => h with
    {
        Url = h.Kind switch
        {
            "page" when pageUrls.TryGetValue(h.Id, out var pageUrl) => pageUrl,
            "book" when bookUrls.TryGetValue(h.Id, out var bookUrl) => bookUrl,
            "folder" when h.BookId is not null && bookUrls.TryGetValue(h.BookId, out var bookUrl) => bookUrl,
            "shelf" => home,
            _ => h.Url,
        },
    }).ToList();

    return raw with { Hits = hits };
}

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

    // A shelfId naming nothing is the caller's mistake, not a missing book —
    // 404 here would read as "POST /api/books does not exist".
    try
    {
        var created = await docs.CreateBookAsync(body, ct);
        return Results.Created($"/api/books/{created.Id}", created);
    }
    catch (KeyNotFoundException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["shelfId"] = [ex.Message] });
    }
});

api.MapPut("/books/{id}", async (string id, UpdateBookRequest body, IDocumentService docs, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    try
    {
        var updated = await docs.UpdateBookAsync(id, body, ct);
        return updated is null ? Results.NotFound() : Results.Ok(updated);
    }
    catch (KeyNotFoundException ex)
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["shelfId"] = [ex.Message] });
    }
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

// Who changed this page, and when. Newest first; the first entry matches the
// page's live version.
api.MapGet("/pages/{id}/history", async (string id, int? limit, IDocumentService docs, CancellationToken ct) =>
{
    var history = await docs.GetPageHistoryAsync(id, limit ?? 100, ct);
    return history is null ? Results.NotFound() : Results.Ok(history);
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

// --- Slide decks (presentations) ---
api.MapGet("/books/{bookId}/slides", async (string bookId, ISlideDeckService slides, CancellationToken ct) =>
    Results.Ok(await slides.ListByBookAsync(bookId, ct)));

api.MapPost("/books/{bookId}/slides", async (string bookId, CreateSlideDeckRequest body, ISlideDeckService slides, ISlideTemplateService templates, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    // A template only seeds a deck that brings no document of its own.
    if (string.IsNullOrWhiteSpace(body.Source) && !string.IsNullOrWhiteSpace(body.TemplateId))
    {
        var template = await templates.GetAsync(body.TemplateId, ct);
        if (template is null)
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["templateId"] = [$"Template '{body.TemplateId}' not found."] });
        body = body with { Source = template.Source };
    }

    try
    {
        var created = await slides.CreateAsync(bookId, body, ct);
        return Results.Created($"/api/slides/{created.Id}", created);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound();
    }
});

api.MapGet("/slides/{id}", async (string id, ISlideDeckService slides, CancellationToken ct) =>
{
    var deck = await slides.GetAsync(id, ct);
    return deck is null ? Results.NotFound() : Results.Ok(deck);
});

api.MapPut("/slides/{id}", async (string id, UpdateSlideDeckRequest body, ISlideDeckService slides, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

    var updated = await slides.UpdateAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/slides/{id}", async (string id, ISlideDeckService slides, CancellationToken ct) =>
{
    var ok = await slides.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
});

// One exporter serves both office targets: Google Slides imports .pptx
// natively, so "export for Google Slides" is this same file.
api.MapGet("/slides/{id}/export/pptx", async (string id, ISlideDeckService slides, SlideDeckPptxExporter exporter, CancellationToken ct) =>
{
    var deck = await slides.GetAsync(id, ct);
    if (deck is null) return Results.NotFound();

    var safeTitle = string.Join("_", deck.Title.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries)).Trim();
    return Results.File(
        exporter.Export(deck),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        (string.IsNullOrEmpty(safeTitle) ? "presentation" : safeTitle) + ".pptx");
});

// --- Slide templates (app-wide reusable deck layouts) ---
api.MapGet("/slide-templates", async (ISlideTemplateService templates, CancellationToken ct) =>
    Results.Ok(await templates.ListAsync(ct)));

api.MapPost("/slide-templates", async (CreateSlideTemplateRequest body, ISlideTemplateService templates, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Name))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required."] });
    if (string.IsNullOrWhiteSpace(body.Source))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["source"] = ["Source is required — save a deck's document as the template."] });

    var created = await templates.CreateAsync(body, ct);
    return Results.Created($"/api/slide-templates/{created.Id}", created);
});

api.MapGet("/slide-templates/{id}", async (string id, ISlideTemplateService templates, CancellationToken ct) =>
{
    var template = await templates.GetAsync(id, ct);
    return template is null ? Results.NotFound() : Results.Ok(template);
});

api.MapPut("/slide-templates/{id}", async (string id, UpdateSlideTemplateRequest body, ISlideTemplateService templates, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Name))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Name is required."] });

    var updated = await templates.UpdateAsync(id, body, ct);
    return updated is null ? Results.NotFound() : Results.Ok(updated);
});

api.MapDelete("/slide-templates/{id}", async (string id, ISlideTemplateService templates, CancellationToken ct) =>
{
    var ok = await templates.DeleteAsync(id, ct);
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

// --- Instance settings ---
// The publish API key is a credential, so reading its status is as much an admin
// question as changing it — same rule as the LLM provider list. The key itself
// is never returned; SetAsync takes effect immediately (no restart), and an
// empty value clears the stored key so a configured BeeDocs:ApiKey applies again.
var settingsAdmin = api.MapGroup("/settings")
    .WithMetadata(RequireRole.Admin)
    .WithTags("Settings");

settingsAdmin.MapGet("/api-key", async (ApiKeySettingsService apiKeys, CancellationToken ct) =>
    Results.Ok(await apiKeys.GetStatusAsync(ct)));

settingsAdmin.MapPut("/api-key", async (UpdateApiKeyRequest body, ApiKeySettingsService apiKeys, CancellationToken ct) =>
    Results.Ok(await apiKeys.SetAsync(body.ApiKey, ct)));

// --- LLM providers & completion ---
// Behind the same key as /api/v1, and not optional: a completion spends the user's
// money, so an unauthenticated /api/llm on a reachable port is a bill waiting to
// happen. Provider keys are stored server-side and never returned.
var llm = api.MapGroup("/llm")
    .AddEndpointFilter<ApiKeyEndpointFilter>()
    .WithTags("LLM");

// Provider rows are settings that hold a paid credential, so reading the list is
// as much an admin question as editing it — RequireRole.Admin rather than the
// default read/write split. /llm/complete below stays on the default rule: an
// editor writing a page is exactly who the assist feature is for.
var llmAdmin = RequireRole.Admin;

static IResult LlmFailure(LlmException ex) =>
    Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status502BadGateway);

llm.MapGet("/providers", async (ILlmProviderService providers, CancellationToken ct) =>
    Results.Ok(await providers.ListAsync(ct))).WithMetadata(llmAdmin);

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
}).WithMetadata(llmAdmin);

llm.MapGet("/providers/{id}", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var provider = await providers.GetAsync(id, ct);
    return provider is null ? Results.NotFound() : Results.Ok(provider);
}).WithMetadata(llmAdmin);

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
}).WithMetadata(llmAdmin);

llm.MapDelete("/providers/{id}", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var ok = await providers.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound();
}).WithMetadata(llmAdmin);

// Promote to default: first in sort order, and enabled, in one transaction.
// Doing it client-side meant one PUT per provider with no way to undo a failure
// halfway through the renumber.
llm.MapPost("/providers/{id}/default", async (string id, ILlmProviderService providers, CancellationToken ct) =>
{
    var promoted = await providers.MakeDefaultAsync(id, ct);
    return promoted is null ? Results.NotFound() : Results.Ok(promoted);
}).WithMetadata(llmAdmin);

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
}).WithMetadata(llmAdmin);

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
}).WithMetadata(llmAdmin);

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
        var result = await docs.UpsertPageBySlugAsync(book.Id, pageSlug, body, ct: ct);
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
    if (body.Folder is not null && string.IsNullOrWhiteSpace(body.Folder.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["folder.title"] = ["Folder title is required when a folder is specified."] });
    if (body.Shelf is not null && string.IsNullOrWhiteSpace(body.Shelf.Title))
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["shelf.title"] = ["Shelf title is required when a shelf is specified."] });

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
