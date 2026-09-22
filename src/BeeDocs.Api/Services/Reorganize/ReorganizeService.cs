using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services.Reorganize;

/// <summary>
/// AI reorganisation of a book or a shelf: the configured LLM provider reads
/// every page and proposes a cleaner structure — folders, order, titles, which
/// pages merge, which are duplicates — and a person reviews the proposal before
/// anything changes.
/// <para>
/// Two background runs per job, both on the <see cref="GitAssistJobService"/>
/// pattern (fire-and-forget task, the row is the status, restart-orphaned rows
/// swept to failed): <b>analyze</b> (queued → analyzing → proposed) and
/// <b>apply</b> (proposed → applying → applied). Between them the proposal sits
/// on the row for as long as the person wants to look at it.
/// </para>
/// <para>
/// Applying is built so that nothing is lost:
/// </para>
/// <list type="bullet">
/// <item>No page is deleted. A page merged into another, or proposed as a
/// duplicate, moves to an "Archive" folder with a note on top linking to where
/// its content went — so old bookmarks still lead somewhere useful.</item>
/// <item>A merge or rewrite is an ordinary page update, so the page's history
/// keeps the text it replaced.</item>
/// <item>Embedded blocks (diagrams, boards, code) never reach the model — see
/// <see cref="ReorgText"/> — and a rewrite that comes back far shorter than its
/// sources is refused rather than saved.</item>
/// <item>A page edited after the analysis is skipped: the proposal was made
/// about text that no longer exists.</item>
/// <item>Private pages are never part of it (a merge could copy their text
/// into a page everyone can read); on a shelf, private books are left out too.</item>
/// </list>
/// </summary>
public sealed partial class ReorganizeService(
    SqliteConnectionFactory db,
    IDocumentService documents,
    ILlmClient llm,
    ICurrentUserAccessor currentUser,
    ILogger<ReorganizeService> logger)
{
    public static class Scopes
    {
        public const string Book = "book";
        public const string Shelf = "shelf";
    }

    /// <summary>Beyond this the outline alone crowds out the excerpts; reorganise book by book instead.</summary>
    private const int MaxPages = 300;

    /// <summary>Characters of page excerpts sent with the analysis — under LlmPrompts' 120 k backstop.</summary>
    private const int BundleBudget = 100_000;

    /// <summary>A merge whose sources exceed this is combined without the model rather than truncated.</summary>
    private const int MaxMergeChars = 60_000;

    /// <summary>A rewrite keeping fewer words than this share of its sources has dropped content.</summary>
    private const double MinKeptWords = 0.35;

    /// <summary>Sources shorter than this are not held to <see cref="MinKeptWords"/>.</summary>
    private const int MinGuardedWords = 12;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static readonly JsonSerializerOptions LenientJson = new(JsonSerializerDefaults.Web)
    {
        AllowTrailingCommas = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    // ===== public API =====

    public async Task<ReorgJobDto> StartAsync(StartReorgRequest request, CancellationToken ct = default)
    {
        var scope = (request.Scope ?? "").Trim().ToLowerInvariant();
        var scopeId = (request.ScopeId ?? "").Trim();
        string scopeTitle;
        switch (scope)
        {
            case Scopes.Book:
                scopeTitle = (await documents.GetBookAsync(scopeId, ct))?.Title
                    ?? throw new KeyNotFoundException($"Book '{scopeId}' not found.");
                break;
            case Scopes.Shelf:
                scopeTitle = (await documents.GetShelfAsync(scopeId, ct))?.Title
                    ?? throw new KeyNotFoundException($"Shelf '{scopeId}' not found.");
                break;
            default:
                throw new ArgumentException("Scope must be 'book' or 'shelf'.");
        }

        // Two runs over the same pages would each work from a picture the other
        // is busy invalidating.
        if (await HasActiveJobAsync(scope, scopeId, ct))
            throw new InvalidOperationException(
                $"A reorganisation of {scopeTitle} is already running. Wait for it, or delete it first.");

        var actor = currentUser.Current;
        var now = DateTimeOffset.UtcNow;
        var id = SqliteHelpers.NewId();

        await using (var conn = await db.OpenConnectionAsync(ct))
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                INSERT INTO reorg_job (
                  id, scope, scope_id, scope_title, status, instructions, provider_id, model,
                  created_by, created_by_name, created_by_admin, created_at, updated_at)
                VALUES (
                  $id, $scope, $scope_id, $scope_title, 'queued', $instructions, $provider_id, $model,
                  $created_by, $created_by_name, $created_by_admin, $now, $now)
                """;
            SqliteHelpers.Add(cmd, "$id", id);
            SqliteHelpers.Add(cmd, "$scope", scope);
            SqliteHelpers.Add(cmd, "$scope_id", scopeId);
            SqliteHelpers.Add(cmd, "$scope_title", scopeTitle);
            SqliteHelpers.Add(cmd, "$instructions", Normalize(request.Instructions));
            SqliteHelpers.Add(cmd, "$provider_id", Normalize(request.ProviderId));
            SqliteHelpers.Add(cmd, "$model", Normalize(request.Model));
            SqliteHelpers.Add(cmd, "$created_by", actor.Id);
            SqliteHelpers.Add(cmd, "$created_by_name", actor.Name);
            SqliteHelpers.Add(cmd, "$created_by_admin", actor.IsAdmin ? 1 : 0);
            SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(now));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        Launch(id, AnalyzeAsync);
        return (await GetAsync(id, ct))!;
    }

    public async Task<ReorgJobDto?> ApplyAsync(string jobId, ApplyReorgRequest request, CancellationToken ct = default)
    {
        if (await GetAsync(jobId, ct) is not { } job) return null;
        if (job.Status != "proposed" || job.Proposal is null)
            throw new InvalidOperationException("Only a proposal that has not been applied yet can be applied.");

        var selection = JsonSerializer.Serialize(new Selection(
            request.Items ?? [], request.Removals ?? [], request.RenameBooks ?? []), JsonOptions);

        // The status flip is the lock: a double-click applies once.
        await using (var conn = await db.OpenConnectionAsync(ct))
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE reorg_job
                SET status = 'applying', selection = $selection, progress = NULL, error = NULL,
                    started_at = $now, finished_at = NULL, updated_at = $now
                WHERE id = $id AND status = 'proposed'
                """;
            SqliteHelpers.Add(cmd, "$id", jobId);
            SqliteHelpers.Add(cmd, "$selection", selection);
            SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            if (await cmd.ExecuteNonQueryAsync(ct) == 0)
                throw new InvalidOperationException("This proposal is already being applied.");
        }

        Launch(jobId, ApplyRunAsync);
        return await GetAsync(jobId, ct);
    }

    /// <summary>Jobs for one book/shelf (or all), newest first — only the caller's own unless admin.</summary>
    public async Task<IReadOnlyList<ReorgJobDto>> ListAsync(string? scope, string? scopeId, CancellationToken ct = default)
    {
        var actor = currentUser.Current;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        var where = new List<string>();
        if (!string.IsNullOrWhiteSpace(scope)) where.Add("scope = $scope");
        if (!string.IsNullOrWhiteSpace(scopeId)) where.Add("scope_id = $scope_id");
        if (!actor.IsAdmin) where.Add("created_by IS $me");
        cmd.CommandText = $"""
            {SelectSql}
            {(where.Count == 0 ? "" : "WHERE " + string.Join(" AND ", where))}
            ORDER BY created_at DESC LIMIT 50
            """;
        SqliteHelpers.Add(cmd, "$scope", scope?.Trim().ToLowerInvariant());
        SqliteHelpers.Add(cmd, "$scope_id", scopeId?.Trim());
        SqliteHelpers.Add(cmd, "$me", actor.Id);
        var list = new List<ReorgJobDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(Map(reader, full: false));
        return list;
    }

    /// <summary>
    /// One job with its proposal. Visible to its creator and admins only: the
    /// proposal quotes page titles, and whoever ran it could see pages others cannot.
    /// </summary>
    public async Task<ReorgJobDto?> GetAsync(string jobId, CancellationToken ct = default)
    {
        var actor = currentUser.Current;
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{SelectSql} WHERE id = $id{(actor.IsAdmin ? "" : " AND created_by IS $me")}";
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$me", actor.Id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? Map(reader, full: true) : null;
    }

    /// <summary>Delete the record; a running analysis or apply is cancelled first.</summary>
    public async Task<bool> DeleteAsync(string jobId, CancellationToken ct = default)
    {
        if (await GetAsync(jobId, ct) is null) return false;
        if (_running.TryGetValue(jobId, out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* just finished */ }
        }

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM reorg_job WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", jobId);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    // ===== background plumbing =====

    private void Launch(string jobId, Func<JobRow, CancellationToken, Task> body) =>
        _ = Task.Run(() => RunAsync(jobId, body), CancellationToken.None);

    private async Task RunAsync(string jobId, Func<JobRow, CancellationToken, Task> body)
    {
        var cts = new CancellationTokenSource();
        _running[jobId] = cts;
        try
        {
            var job = await LoadAsync(jobId);
            if (job is null) return;
            // Reads are privacy-filtered and writes land in page history as
            // whoever started the job, minutes after their request ended.
            using var _ = AmbientActor.Use(new CurrentActor(job.CreatedById, job.CreatedByName, job.CreatedByAdmin));
            await body(job, cts.Token);
        }
        catch (OperationCanceledException)
        {
            await FinishAsync(jobId, "failed", "Cancelled.");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Reorganisation job {JobId} failed", jobId);
            await FinishAsync(jobId, "failed", ex.Message);
        }
        finally
        {
            _running.TryRemove(jobId, out _);
            cts.Dispose();
        }
    }

    // ===== analyze =====

    /// <summary>One page as the analysis saw it — alias, placement and full text.</summary>
    private sealed record PageInfo(
        string Alias,
        string Id,
        string BookId,
        string? FolderId,
        string? FolderTitle,
        string Title,
        string Content,
        int Words,
        DateTimeOffset UpdatedAt);

    private sealed record Collected(
        ReorgSnapshotDto Snapshot,
        List<PageInfo> Pages,
        Dictionary<string, string> BookAliases,
        List<BookDto> Books);

    private async Task AnalyzeAsync(JobRow job, CancellationToken ct)
    {
        await SetStatusAsync(job.Id, "analyzing", "Reading the pages", started: true);

        var collected = await CollectAsync(job, ct);
        if (collected.Pages.Count == 0)
            throw new InvalidOperationException("There are no pages to reorganise here.");
        if (collected.Pages.Count > MaxPages)
        {
            throw new InvalidOperationException(
                $"{collected.Pages.Count} pages is more than one analysis can hold ({MaxPages}). " +
                "Reorganise the books on this shelf one at a time.");
        }

        var bundle = BuildBundle(job, collected);
        await SetStatusAsync(job.Id, "analyzing", $"Asking the AI to study {collected.Pages.Count} pages");

        var started = Stopwatch.GetTimestamp();
        PlanJson? plan = null;
        LlmCompleteResponse? response = null;
        int? promptTokens = null, completionTokens = null;
        // One retry: a plan that is not JSON is usually a one-off.
        for (var attempt = 0; attempt < 2 && plan is null; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            response = await CompleteAsync(new LlmCompleteRequest(
                Task: LlmPrompts.ReorgPlan,
                Prompt: PlanAssignment(job),
                Context: bundle,
                Selection: null,
                ProviderId: job.ProviderId,
                Model: job.Model,
                MaxTokens: null,
                Temperature: null), ct);
            promptTokens = Add(promptTokens, response.PromptTokens);
            completionTokens = Add(completionTokens, response.CompletionTokens);
            plan = ParsePlan(response.Text);
        }

        if (plan is null || response is null)
        {
            throw new LlmException(
                $"{response?.ProviderName ?? "The AI provider"} did not return a readable plan" +
                (string.IsNullOrEmpty(response?.Model) ? "" : $" ({response.Model})") +
                ". Try again, or pick a different model.");
        }

        var proposal = BuildProposal(plan, collected);

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE reorg_job
            SET status = 'proposed', progress = NULL, error = NULL,
                snapshot = $snapshot, proposal = $proposal,
                provider_name = $provider_name, model_used = $model_used,
                prompt_tokens = $prompt_tokens, completion_tokens = $completion_tokens,
                elapsed_ms = $elapsed_ms, finished_at = $now, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", job.Id);
        SqliteHelpers.Add(cmd, "$snapshot", JsonSerializer.Serialize(collected.Snapshot, JsonOptions));
        SqliteHelpers.Add(cmd, "$proposal", JsonSerializer.Serialize(proposal, JsonOptions));
        SqliteHelpers.Add(cmd, "$provider_name", response.ProviderName);
        SqliteHelpers.Add(cmd, "$model_used", response.Model);
        SqliteHelpers.Add(cmd, "$prompt_tokens", promptTokens);
        SqliteHelpers.Add(cmd, "$completion_tokens", completionTokens);
        SqliteHelpers.Add(cmd, "$elapsed_ms", (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(CancellationToken.None);
    }

    private async Task<Collected> CollectAsync(JobRow job, CancellationToken ct)
    {
        var books = new List<BookDto>();
        if (job.Scope == Scopes.Book)
        {
            books.Add(await documents.GetBookAsync(job.ScopeId, ct)
                ?? throw new InvalidOperationException("The book no longer exists."));
        }
        else
        {
            if (await documents.GetShelfAsync(job.ScopeId, ct) is null)
                throw new InvalidOperationException("The shelf no longer exists.");
            // A private book's pages could be merged into a public book on the
            // same shelf, so on a shelf they are left out entirely.
            books.AddRange((await documents.ListShelfBooksAsync(job.ScopeId, ct)).Where(b => !b.IsPrivate));
        }

        var snapshotBooks = new List<ReorgSnapshotBookDto>();
        var pages = new List<PageInfo>();
        var bookAliases = new Dictionary<string, string>();
        foreach (var book in books)
        {
            ct.ThrowIfCancellationRequested();
            bookAliases[book.Id] = $"b{bookAliases.Count + 1}";
            var chapters = await documents.ListChaptersAsync(book.Id, ct);
            var folderTitles = chapters.ToDictionary(c => c.Id, c => c.Title);
            var snapPages = new List<ReorgSnapshotPageDto>();
            // Reading order, as the tree shows it: top-level pages, then each
            // folder in turn — the service's list sorts across folders.
            var folderRank = chapters.OrderBy(c => c.SortOrder).Select((c, i) => (c.Id, i)).ToDictionary(x => x.Id, x => x.i);
            var ordered = (await documents.ListPagesAsync(book.Id, ct))
                .OrderBy(p => p.ChapterId is { } cid && folderRank.TryGetValue(cid, out var r) ? r + 1 : 0)
                .ThenBy(p => p.SortOrder);
            foreach (var summary in ordered)
            {
                var page = await documents.GetPageAsync(summary.Id, ct);
                if (page is null) continue;
                var words = ReorgText.WordCount(page.Content);
                // A private page's text must not be merged into a page others read.
                var excluded = page.IsPrivate;
                snapPages.Add(new ReorgSnapshotPageDto(
                    page.Id, page.Title, page.ChapterId, page.SortOrder, words, page.UpdatedAt, excluded));
                if (excluded) continue;
                pages.Add(new PageInfo(
                    Alias: $"p{pages.Count + 1}",
                    Id: page.Id,
                    BookId: book.Id,
                    FolderId: page.ChapterId,
                    FolderTitle: page.ChapterId is { } cid && folderTitles.TryGetValue(cid, out var ft) ? ft : null,
                    Title: page.Title,
                    Content: page.Content,
                    Words: words,
                    UpdatedAt: page.UpdatedAt));
            }

            snapshotBooks.Add(new ReorgSnapshotBookDto(
                book.Id,
                book.Title,
                chapters.Select(c => new ReorgSnapshotFolderDto(c.Id, c.Title, c.SortOrder)).ToList(),
                snapPages));
        }

        return new Collected(new ReorgSnapshotDto(snapshotBooks), pages, bookAliases, books);
    }

    /// <summary>
    /// The library as the model reads it: books, their folders, then every page
    /// with a short alias (p12 is cheaper and harder to garble than a GUID) and
    /// as much of its text as the budget allows, spread evenly.
    /// </summary>
    private static string BuildBundle(JobRow job, Collected c)
    {
        var sb = new StringBuilder();
        sb.Append(job.Scope == Scopes.Book ? "Scope: one book.\n\n" : $"Scope: the shelf \"{job.ScopeTitle}\".\n\n");
        sb.Append("Books:\n");
        foreach (var book in c.Books)
        {
            sb.Append("- ").Append(c.BookAliases[book.Id]).Append(" \"").Append(book.Title).Append('"');
            if (!string.IsNullOrWhiteSpace(book.Description))
                sb.Append(" — ").Append(OneLine(book.Description, 300));
            sb.Append('\n');
            var folders = c.Snapshot.Books.First(b => b.Id == book.Id).Folders;
            foreach (var f in folders.OrderBy(f => f.SortOrder))
                sb.Append("    folder \"").Append(f.Title).Append("\"\n");
        }

        var perPage = Math.Clamp(BundleBudget / Math.Max(1, c.Pages.Count) - 120, 300, 6000);
        sb.Append("\nPages, in their current order:\n");
        foreach (var p in c.Pages)
        {
            sb.Append("\n=== ").Append(p.Alias)
                .Append(" | book ").Append(c.BookAliases[p.BookId])
                .Append(" | folder ").Append(p.FolderTitle is null ? "(top level)" : $"\"{p.FolderTitle}\"")
                .Append(" | \"").Append(p.Title).Append("\" | ").Append(p.Words).Append(" words ===\n")
                .Append(ReorgText.Excerpt(p.Content, perPage)).Append('\n');
        }

        return sb.ToString();
    }

    private static string PlanAssignment(JobRow job)
    {
        var what = job.Scope == Scopes.Book ? $"the book \"{job.ScopeTitle}\"" : $"the shelf \"{job.ScopeTitle}\"";
        var task =
            $"Propose a cleaner, simpler structure for {what}: remove duplicated information, " +
            "merge pages that overlap, group and order pages so they are easy to follow. " +
            "Reply with ONLY the JSON object described in your instructions.";
        var extra = (job.Instructions ?? "").Trim();
        return extra.Length == 0 ? task : $"{task}\n\nAdditional instructions from the user:\n{extra}";
    }

    // ----- the model's plan, as parsed -----

    private sealed class PlanJson
    {
        public string? Summary { get; set; }
        public List<PlanBook>? Books { get; set; }
        public List<PlanRemoval>? Remove { get; set; }
    }

    private sealed class PlanBook
    {
        public string? Book { get; set; }
        public string? Title { get; set; }
        public List<PlanSection>? Sections { get; set; }
    }

    private sealed class PlanSection
    {
        public string? Folder { get; set; }
        public List<PlanPage>? Pages { get; set; }
    }

    private sealed class PlanPage
    {
        public string? Title { get; set; }
        public List<string>? Sources { get; set; }
        public string? Action { get; set; }
        public string? Reason { get; set; }
    }

    private sealed class PlanRemoval
    {
        public string? Source { get; set; }
        public string? DuplicateOf { get; set; }
        public string? Reason { get; set; }
    }

    private static PlanJson? ParsePlan(string text)
    {
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            var plan = JsonSerializer.Deserialize<PlanJson>(text[start..(end + 1)], LenientJson);
            return plan?.Books is { Count: > 0 } ? plan : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Turn the model's plan into a proposal the server can stand behind: aliases
    /// resolved to real ids, unknown or repeated ids dropped (first mention wins),
    /// everything unmentioned left alone, and merges that would flatten a grid
    /// page downgraded to plain moves.
    /// </summary>
    private static ReorgProposalDto BuildProposal(PlanJson plan, Collected c)
    {
        var byKey = new Dictionary<string, PageInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in c.Pages)
        {
            byKey[p.Alias] = p;
            byKey[p.Id] = p;
        }

        var bookByKey = new Dictionary<string, BookDto>(StringComparer.OrdinalIgnoreCase);
        foreach (var b in c.Books)
        {
            bookByKey[c.BookAliases[b.Id]] = b;
            bookByKey[b.Id] = b;
        }

        PageInfo? Resolve(string? key) =>
            key is not null && byKey.TryGetValue(key.Trim(), out var p) ? p : null;

        var seen = new HashSet<string>();
        var itemSeq = 0;
        // bookId → ordered folders (null key = top level) → items.
        var layout = new Dictionary<string, List<(string? Folder, List<ReorgPagePlanDto> Items)>>();
        var bookTitles = new Dictionary<string, string?>();
        var itemOfPage = new Dictionary<string, string>();

        List<ReorgPagePlanDto> FolderList(string bookId, string? folder)
        {
            if (!layout.TryGetValue(bookId, out var folders))
                layout[bookId] = folders = [];
            var match = folders.FindIndex(f => string.Equals(f.Folder, folder, StringComparison.OrdinalIgnoreCase));
            if (match >= 0) return folders[match].Items;
            var items = new List<ReorgPagePlanDto>();
            folders.Add((folder, items));
            return items;
        }

        ReorgPagePlanDto MakeItem(string title, string action, List<PageInfo> sources, string bookId, string? folder, string? reason)
        {
            var primary = sources[0];
            var moved = primary.BookId != bookId
                || !string.Equals(primary.FolderTitle, folder, StringComparison.OrdinalIgnoreCase);
            var id = $"i{++itemSeq}";
            foreach (var s in sources) itemOfPage[s.Id] = id;
            return new ReorgPagePlanDto(
                Id: id,
                Title: title,
                Action: action,
                Moved: moved,
                Renamed: !string.Equals(title, primary.Title, StringComparison.Ordinal),
                Sources: sources.Select(ToSource).ToList(),
                Reason: Normalize(reason));
        }

        foreach (var pb in plan.Books ?? [])
        {
            var planBook = pb.Book is not null && bookByKey.TryGetValue(pb.Book.Trim(), out var bk) ? bk : null;
            if (planBook is not null && Normalize(pb.Title) is { } newTitle
                && !string.Equals(newTitle, planBook.Title, StringComparison.Ordinal))
            {
                bookTitles.TryAdd(planBook.Id, newTitle);
            }

            foreach (var section in pb.Sections ?? [])
            {
                var folder = Normalize(section.Folder?.Trim().Trim('/'));
                foreach (var pp in section.Pages ?? [])
                {
                    var sources = (pp.Sources ?? [])
                        .Select(Resolve)
                        .OfType<PageInfo>()
                        .Where(p => seen.Add(p.Id))
                        .ToList();
                    if (sources.Count == 0) continue;

                    // An unknown book id: the page stays in the book it is in.
                    var bookId = planBook?.Id ?? sources[0].BookId;
                    var title = Normalize(pp.Title) ?? sources[0].Title;
                    if (title.Length > 200) title = title[..200];
                    var action = (pp.Action ?? "").Trim().ToLowerInvariant() switch
                    {
                        "merge" => "merge",
                        "rewrite" => "rewrite",
                        _ => "keep",
                    };
                    if (sources.Count > 1) action = "merge";
                    else if (action == "merge") action = "keep";

                    var items = FolderList(bookId, folder);

                    // A grid page's cells live in comment markers a model rewrite
                    // would flatten; such pages are moved, never rewritten.
                    if (action != "keep" && sources.Any(s => ReorgText.HasGridLayout(s.Content)))
                    {
                        items.Add(MakeItem(title, "keep", [sources[0]], bookId, folder,
                            "Kept as written: it uses a grid layout, which an AI rewrite would lose."));
                        foreach (var extra in sources.Skip(1))
                            items.Add(MakeItem(extra.Title, "keep", [extra], bookId, folder, pp.Reason));
                        continue;
                    }

                    items.Add(MakeItem(title, action, sources, bookId, folder, pp.Reason));
                }
            }
        }

        var removals = new List<ReorgRemovalDto>();
        var removalSeq = 0;
        foreach (var r in plan.Remove ?? [])
        {
            var page = Resolve(r.Source);
            if (page is null || !seen.Add(page.Id)) continue;
            var dupOf = Resolve(r.DuplicateOf) is { } d && itemOfPage.TryGetValue(d.Id, out var it) ? it : null;
            removals.Add(new ReorgRemovalDto($"r{++removalSeq}", ToSource(page), Normalize(r.Reason), dupOf));
        }

        var untouched = c.Pages.Where(p => !seen.Contains(p.Id)).Select(ToSource).ToList();

        var chaptersByBook = c.Snapshot.Books.ToDictionary(b => b.Id, b => b.Folders);
        var books = c.Books
            .Where(b => layout.ContainsKey(b.Id) || bookTitles.ContainsKey(b.Id))
            .Select(b => new ReorgBookPlanDto(
                BookId: b.Id,
                CurrentTitle: b.Title,
                NewTitle: bookTitles.GetValueOrDefault(b.Id),
                Folders: (layout.GetValueOrDefault(b.Id) ?? [])
                    .Select(f => new ReorgFolderPlanDto(
                        f.Folder,
                        f.Folder is null || chaptersByBook[b.Id].Any(x =>
                            string.Equals(x.Title, f.Folder, StringComparison.OrdinalIgnoreCase)),
                        f.Items))
                    .ToList()))
            .ToList();

        return new ReorgProposalDto(
            Summary: Normalize(plan.Summary) ?? "",
            Books: books,
            Removals: removals,
            Untouched: untouched);
    }

    private static ReorgSourceDto ToSource(PageInfo p) => new(p.Id, p.BookId, p.Title, p.FolderTitle, p.Words);

    // ===== apply =====

    private sealed record Selection(
        IReadOnlyList<string> Items,
        IReadOnlyList<string> Removals,
        IReadOnlyList<string> RenameBooks);

    /// <summary>Everything one apply run keeps track of while it works.</summary>
    private sealed class ApplyState
    {
        public required JobRow Job { get; init; }
        public required ReorgSnapshotDto Snapshot { get; init; }
        public required Dictionary<string, ReorgSnapshotPageDto> SnapPages { get; init; }
        public List<ReorgLogEntryDto> Log { get; } = [];
        /// <summary>(bookId, lower-case title) → chapter id, for reuse instead of duplicates.</summary>
        public Dictionary<(string, string), string> Chapters { get; } = [];
        /// <summary>Old page id → where links to it should now point.</summary>
        public Dictionary<string, (string BookId, string PageId)> Redirects { get; } = [];
        /// <summary>Folders that lost a page — removed at the end if nothing is left in them.</summary>
        public HashSet<string> MaybeEmpty { get; } = [];
        public Dictionary<string, int> ArchiveSort { get; } = [];
        public int PromptTokens;
        public int CompletionTokens;
        public int Done;
        public int Total;
        public string ArchiveTitle { get; } = $"Archive — reorganised {DateTimeOffset.UtcNow:yyyy-MM-dd}";
    }

    private async Task ApplyRunAsync(JobRow job, CancellationToken ct)
    {
        var proposal = job.Proposal is null ? null : JsonSerializer.Deserialize<ReorgProposalDto>(job.Proposal, JsonOptions);
        var snapshot = job.Snapshot is null ? null : JsonSerializer.Deserialize<ReorgSnapshotDto>(job.Snapshot, JsonOptions);
        var selection = job.Selection is null ? null : JsonSerializer.Deserialize<Selection>(job.Selection, JsonOptions);
        if (proposal is null || snapshot is null || selection is null)
            throw new InvalidOperationException("The job has no proposal to apply.");

        var state = new ApplyState
        {
            Job = job,
            Snapshot = snapshot,
            SnapPages = snapshot.Books.SelectMany(b => b.Pages).ToDictionary(p => p.Id),
        };
        var items = selection.Items.ToHashSet();
        var removals = selection.Removals.ToHashSet();
        var renames = selection.RenameBooks.ToHashSet();

        foreach (var book in snapshot.Books)
        foreach (var chapter in await documents.ListChaptersAsync(book.Id, ct))
            state.Chapters.TryAdd((chapter.BookId, chapter.Title.ToLowerInvariant()), chapter.Id);

        state.Total = proposal.Books.Sum(b => b.Folders.Sum(f => f.Pages.Count(p => items.Contains(p.Id))))
            + proposal.Removals.Count(r => removals.Contains(r.Id));

        try
        {
            foreach (var book in proposal.Books)
            {
                ct.ThrowIfCancellationRequested();
                if (book.NewTitle is { } newTitle && renames.Contains(book.BookId))
                    await RenameBookAsync(state, book.BookId, newTitle, ct);

                var folderOrder = 0;
                foreach (var folder in book.Folders)
                {
                    // Ticked items, plus the untouched ones around them — those
                    // only take their place in the new order.
                    var chosen = folder.Pages.Where(p => items.Contains(p.Id) || IsNoop(p)).ToList();
                    if (!chosen.Any(p => items.Contains(p.Id))) continue;

                    var chapterArg = folder.Title is null
                        ? ""
                        : await EnsureChapterAsync(state, book.BookId, folder.Title, folderOrder++, ct);
                    var order = 0;
                    foreach (var item in chosen)
                    {
                        ct.ThrowIfCancellationRequested();
                        await ApplyItemAsync(state, item, book.BookId, chapterArg, order++, ct);
                        // Written as it goes: a run killed mid-way still shows what it did.
                        await StoreLogAsync(job.Id, state, final: false);
                    }
                }
            }

            foreach (var removal in proposal.Removals.Where(r => removals.Contains(r.Id)))
            {
                ct.ThrowIfCancellationRequested();
                await ApplyRemovalAsync(state, removal, proposal, ct);
                await StoreLogAsync(job.Id, state, final: false);
            }

            await SetProgressAsync(job.Id, "Updating links to moved pages");
            await RewriteLinksAsync(state, ct);
            await RemoveEmptiedFoldersAsync(state, ct);
        }
        finally
        {
            await StoreLogAsync(job.Id, state, final: true);
        }

        await FinishAsync(job.Id, "applied", null);
    }

    private static bool IsNoop(ReorgPagePlanDto p) => p.Action == "keep" && !p.Moved && !p.Renamed;

    private async Task RenameBookAsync(ApplyState state, string bookId, string title, CancellationToken ct)
    {
        var book = await documents.GetBookAsync(bookId, ct);
        if (book is null)
        {
            state.Log.Add(new ReorgLogEntryDto(null, "skipped", $"Book '{title}' no longer exists.", bookId));
            return;
        }

        await documents.UpdateBookAsync(bookId, new UpdateBookRequest(title, Description: null, Slug: null, SortOrder: null), ct);
        state.Log.Add(new ReorgLogEntryDto(null, "ok", $"Renamed book '{book.Title}' to '{title}'.", bookId));
    }

    private async Task<string> EnsureChapterAsync(
        ApplyState state, string bookId, string title, int sortOrder, CancellationToken ct)
    {
        if (state.Chapters.TryGetValue((bookId, title.ToLowerInvariant()), out var existing))
        {
            await documents.UpdateChapterAsync(existing, new UpdateChapterRequest(null, null, sortOrder), ct);
            return existing;
        }

        var created = await documents.CreateChapterAsync(bookId, new CreateChapterRequest(title, null, sortOrder), ct);
        state.Chapters[(bookId, title.ToLowerInvariant())] = created.Id;
        // Made before its pages arrive: if every one of them is skipped or
        // fails, the end-of-run sweep takes the empty folder away again.
        state.MaybeEmpty.Add(created.Id);
        return created.Id;
    }

    /// <summary>
    /// The current pages behind a plan entry, or the reason not to touch them:
    /// gone, or edited since the analysis (the proposal was about other text).
    /// </summary>
    private async Task<(List<PageDto>? Pages, string? Problem)> LoadSourcesAsync(
        ApplyState state, IEnumerable<ReorgSourceDto> sources, CancellationToken ct)
    {
        var pages = new List<PageDto>();
        foreach (var s in sources)
        {
            var page = await documents.GetPageAsync(s.PageId, ct);
            if (page is null) return (null, $"'{s.Title}' no longer exists.");
            if (state.SnapPages.TryGetValue(s.PageId, out var snap) && page.UpdatedAt > snap.UpdatedAt.AddSeconds(1))
                return (null, $"'{page.Title}' was edited after the analysis — left as it is.");
            pages.Add(page);
        }

        return (pages, null);
    }

    private async Task ApplyItemAsync(
        ApplyState state, ReorgPagePlanDto item, string bookId, string chapterArg, int order, CancellationToken ct)
    {
        if (IsNoop(item))
        {
            // Only its position changes; a page already in place is not rewritten.
            var page = await documents.GetPageAsync(item.Sources[0].PageId, ct);
            if (page is not null && page.SortOrder != order)
            {
                await documents.UpdatePageAsync(page.Id, new UpdatePageRequest(
                    page.Title, Slug: null, Content: null, ChapterId: null, SortOrder: order), ct);
            }
            return;
        }

        state.Done++;
        var (pages, problem) = await LoadSourcesAsync(state, item.Sources, ct);
        if (pages is null)
        {
            state.Log.Add(new ReorgLogEntryDto(item.Id, "skipped", problem!));
            return;
        }

        var primary = pages[0];
        string? content = null;
        string message;
        if (item.Action is "merge" or "rewrite")
        {
            await SetProgressAsync(state.Job.Id,
                $"{(item.Action == "merge" ? "Merging" : "Rewriting")} '{item.Title}' ({state.Done} of {state.Total})");
            try
            {
                (content, message) = await ConsolidateAsync(state, item, pages, ct);
            }
            catch (Exception ex) when (ex is LlmException or InvalidOperationException or KeyNotFoundException)
            {
                state.Log.Add(new ReorgLogEntryDto(item.Id, "failed", $"'{item.Title}': {ex.Message} Left unchanged."));
                return;
            }
        }
        else
        {
            await SetProgressAsync(state.Job.Id, $"Moving '{item.Title}' ({state.Done} of {state.Total})");
            message = item.Renamed && item.Moved
                ? $"Renamed '{primary.Title}' to '{item.Title}' and moved it."
                : item.Renamed ? $"Renamed '{primary.Title}' to '{item.Title}'." : $"Moved '{item.Title}'.";
        }

        await documents.UpdatePageAsync(primary.Id, new UpdatePageRequest(
            Title: item.Title,
            Slug: null,
            Content: content,
            ChapterId: chapterArg,
            SortOrder: order,
            BookId: bookId), ct);
        if (primary.ChapterId is { } oldFolder) state.MaybeEmpty.Add(oldFolder);
        if (primary.BookId != bookId) state.Redirects[primary.Id] = (bookId, primary.Id);

        var link = $"/books/{bookId}/pages/{primary.Id}";
        foreach (var other in pages.Skip(1))
        {
            await ArchiveAsync(state, other, $"Its content was merged into [{item.Title}]({link}).", ct);
            state.Redirects[other.Id] = (bookId, primary.Id);
        }

        state.Log.Add(new ReorgLogEntryDto(item.Id, "ok", message, bookId, primary.Id));
    }

    private async Task ApplyRemovalAsync(
        ApplyState state, ReorgRemovalDto removal, ReorgProposalDto proposal, CancellationToken ct)
    {
        state.Done++;
        await SetProgressAsync(state.Job.Id, $"Archiving '{removal.Page.Title}' ({state.Done} of {state.Total})");
        var (pages, problem) = await LoadSourcesAsync(state, [removal.Page], ct);
        if (pages is null)
        {
            state.Log.Add(new ReorgLogEntryDto(removal.Id, "skipped", problem!));
            return;
        }

        // Point at the page that holds the same content — if that part of the
        // proposal was applied; otherwise the note just says why it was archived.
        string note = "It duplicated content found elsewhere in this library.";
        if (removal.DuplicateOf is { } dupItem
            && state.Log.FirstOrDefault(l => l.ItemId == dupItem && l.Status == "ok") is { PageId: { } pid, BookId: { } bid })
        {
            var title = proposal.Books.SelectMany(b => b.Folders).SelectMany(f => f.Pages)
                .FirstOrDefault(p => p.Id == dupItem)?.Title ?? "the page that replaces it";
            note = $"Its content is covered by [{title}](/books/{bid}/pages/{pid}).";
            state.Redirects[pages[0].Id] = (bid, pid);
        }

        await ArchiveAsync(state, pages[0], note, ct);
        state.Log.Add(new ReorgLogEntryDto(
            removal.Id, "ok", $"Archived '{pages[0].Title}' as a duplicate.", pages[0].BookId, pages[0].Id));
    }

    /// <summary>
    /// Move a page into its book's archive folder with a note on top — the page,
    /// its text and its history all survive; only its place in the book changes.
    /// </summary>
    private async Task ArchiveAsync(ApplyState state, PageDto page, string note, CancellationToken ct)
    {
        var folderId = await EnsureChapterAsync(state, page.BookId, state.ArchiveTitle, 10_000, ct);
        var sort = state.ArchiveSort.GetValueOrDefault(page.BookId);
        state.ArchiveSort[page.BookId] = sort + 1;
        var content =
            $"> **Archived by AI reorganisation on {DateTimeOffset.UtcNow:yyyy-MM-dd}.** {note}\n\n{page.Content}";
        await documents.UpdatePageAsync(page.Id, new UpdatePageRequest(
            page.Title, Slug: null, Content: content, ChapterId: folderId, SortOrder: sort), ct);
        if (page.ChapterId is { } oldFolder) state.MaybeEmpty.Add(oldFolder);
    }

    /// <summary>
    /// The model's half of a merge or rewrite, with its safety rails: fences out
    /// and back in, an oversize merge combined losslessly instead of truncated,
    /// and an answer that lost too much of the text refused.
    /// </summary>
    private async Task<(string Content, string Message)> ConsolidateAsync(
        ApplyState state, ReorgPagePlanDto item, List<PageDto> pages, CancellationToken ct)
    {
        var blocks = new List<ReorgText.Block>();
        var material = new StringBuilder();
        for (var i = 0; i < pages.Count; i++)
        {
            material.Append("=== Source ").Append(i + 1).Append(": \"").Append(pages[i].Title).Append("\" ===\n")
                .Append(ReorgText.Protect(pages[i].Content, blocks).Trim()).Append("\n\n");
        }

        if (material.Length > MaxMergeChars)
        {
            if (item.Action == "rewrite")
                throw new InvalidOperationException("The page is too long to rewrite in one AI call.");
            // Too big for one call: combine without the model — nothing is lost,
            // the structure still improves, and the text can be tidied by hand.
            var combined = string.Join("\n\n", pages.Select(p => $"## {p.Title}\n\n{p.Content.Trim()}")) + "\n";
            return (combined, $"Combined {pages.Count} pages into '{item.Title}' (too long for the AI — joined as written).");
        }

        var assignment = item.Action == "merge"
            ? $"Merge these {pages.Count} pages into one page titled \"{item.Title}\"."
            : $"Rewrite this page, titled \"{item.Title}\", so it is simpler and easier to read.";
        if (item.Reason is { } reason) assignment += $"\nWhy: {reason}";
        if (Normalize(state.Job.Instructions) is { } extra)
            assignment += $"\n\nAdditional instructions from the user:\n{extra}";

        var response = await CompleteAsync(new LlmCompleteRequest(
            Task: LlmPrompts.ReorgMerge,
            Prompt: assignment,
            Context: material.ToString(),
            Selection: null,
            ProviderId: state.Job.ProviderId,
            Model: state.Job.Model,
            MaxTokens: null,
            Temperature: null), ct);
        state.PromptTokens += response.PromptTokens ?? 0;
        state.CompletionTokens += response.CompletionTokens ?? 0;

        var text = LeadingH1Regex().Replace(response.Text.Trim(), "");
        if (string.IsNullOrWhiteSpace(text))
            throw new LlmException($"{response.ProviderName} returned an empty page.");

        var restored = ReorgText.Restore(text, blocks);
        var before = pages.Sum(p => p.Content.Length == 0 ? 0 : ReorgText.WordCount(p.Content));
        var after = ReorgText.WordCount(restored);
        // Below a dozen words a page is a sentence or two, and any percentage is noise.
        if (before >= MinGuardedWords && after < before * MinKeptWords)
        {
            throw new LlmException(
                $"The AI's version kept only {after} of {before} words — it was probably cut off or dropped content.");
        }

        return (restored, item.Action == "merge"
            ? $"Merged {pages.Count} pages into '{item.Title}'."
            : $"Rewrote '{item.Title}' ({before} → {after} words).");
    }

    /// <summary>
    /// Links elsewhere in the scope that point at a moved or archived page are
    /// repointed: a moved page gets its new book in the URL, and a page merged
    /// away or archived as a duplicate sends readers to the page that took over.
    /// </summary>
    private async Task RewriteLinksAsync(ApplyState state, CancellationToken ct)
    {
        if (state.Redirects.Count == 0) return;
        var changed = 0;
        foreach (var book in state.Snapshot.Books)
        {
            foreach (var summary in await documents.ListPagesAsync(book.Id, ct))
            {
                ct.ThrowIfCancellationRequested();
                var page = await documents.GetPageAsync(summary.Id, ct);
                if (page is null || !page.Content.Contains("/pages/", StringComparison.Ordinal)) continue;
                var next = PageLinkRegex().Replace(page.Content, m =>
                    state.Redirects.TryGetValue(m.Groups[2].Value, out var to)
                        ? $"/books/{to.BookId}/pages/{to.PageId}"
                        : m.Value);
                if (next == page.Content) continue;
                await documents.UpdatePageAsync(page.Id, new UpdatePageRequest(
                    page.Title, Slug: null, Content: next, ChapterId: null, SortOrder: null), ct);
                changed++;
            }
        }

        if (changed > 0)
            state.Log.Add(new ReorgLogEntryDto(null, "ok", $"Updated links on {changed} page{(changed == 1 ? "" : "s")}."));
    }

    /// <summary>
    /// A folder emptied by this run goes. The count is raw SQL on purpose: the
    /// service's page list hides other people's private pages, and a folder that
    /// still holds one of those is not empty.
    /// </summary>
    private async Task RemoveEmptiedFoldersAsync(ApplyState state, CancellationToken ct)
    {
        foreach (var chapterId in state.MaybeEmpty)
        {
            await using (var conn = await db.OpenConnectionAsync(ct))
            await using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "SELECT COUNT(*) FROM page WHERE chapter_id = $id";
                SqliteHelpers.Add(cmd, "$id", chapterId);
                if (Convert.ToInt64(await cmd.ExecuteScalarAsync(ct)) > 0) continue;
            }

            var title = state.Snapshot.Books.SelectMany(b => b.Folders).FirstOrDefault(f => f.Id == chapterId)?.Title;
            if (await documents.DeleteChapterAsync(chapterId, ct) && title is not null)
                state.Log.Add(new ReorgLogEntryDto(null, "ok", $"Removed the now-empty folder '{title}'."));
        }
    }

    private async Task<LlmCompleteResponse> CompleteAsync(LlmCompleteRequest request, CancellationToken ct)
    {
        try
        {
            return await llm.CompleteAsync(request, ct);
        }
        catch (KeyNotFoundException ex)
        {
            // "No enabled LLM provider is configured." is a sentence for a person.
            throw new LlmException(ex.Message);
        }
    }

    [GeneratedRegex(@"/books/([A-Za-z0-9_-]+)/pages/([A-Za-z0-9_-]+)")]
    private static partial Regex PageLinkRegex();

    [GeneratedRegex(@"^#\s+[^\n]*\n+")]
    private static partial Regex LeadingH1Regex();

    // ===== persistence =====

    private sealed class JobRow
    {
        public required string Id { get; init; }
        public required string Scope { get; init; }
        public required string ScopeId { get; init; }
        public required string ScopeTitle { get; init; }
        public string? Instructions { get; init; }
        public string? ProviderId { get; init; }
        public string? Model { get; init; }
        public string? CreatedById { get; init; }
        public string? CreatedByName { get; init; }
        public bool CreatedByAdmin { get; init; }
        public string? Snapshot { get; init; }
        public string? Proposal { get; init; }
        public string? Selection { get; init; }
    }

    private async Task<JobRow?> LoadAsync(string jobId)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, scope, scope_id, scope_title, instructions, provider_id, model,
                   created_by, created_by_name, created_by_admin, snapshot, proposal, selection
            FROM reorg_job WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        await using var r = await cmd.ExecuteReaderAsync();
        if (!await r.ReadAsync()) return null;
        return new JobRow
        {
            Id = r.GetString(0),
            Scope = r.GetString(1),
            ScopeId = r.GetString(2),
            ScopeTitle = r.GetString(3),
            Instructions = SqliteHelpers.GetNullableString(r, 4),
            ProviderId = SqliteHelpers.GetNullableString(r, 5),
            Model = SqliteHelpers.GetNullableString(r, 6),
            CreatedById = SqliteHelpers.GetNullableString(r, 7),
            CreatedByName = SqliteHelpers.GetNullableString(r, 8),
            CreatedByAdmin = r.GetInt64(9) != 0,
            Snapshot = SqliteHelpers.GetNullableString(r, 10),
            Proposal = SqliteHelpers.GetNullableString(r, 11),
            Selection = SqliteHelpers.GetNullableString(r, 12),
        };
    }

    private const string SelectSql = """
        SELECT id, scope, scope_id, scope_title, status, progress, error, instructions,
               provider_name, COALESCE(model_used, model), prompt_tokens, completion_tokens,
               elapsed_ms, created_by_name, created_at, started_at, finished_at,
               proposal, snapshot, log
        FROM reorg_job
        """;

    private static ReorgJobDto Map(SqliteDataReader r, bool full)
    {
        T? Json<T>(int ordinal) where T : class
        {
            if (!full || SqliteHelpers.GetNullableString(r, ordinal) is not { Length: > 0 } json) return null;
            try { return JsonSerializer.Deserialize<T>(json, JsonOptions); }
            catch (JsonException) { return null; }
        }

        return new ReorgJobDto(
            Id: r.GetString(0),
            Scope: r.GetString(1),
            ScopeId: r.GetString(2),
            ScopeTitle: r.GetString(3),
            Status: r.GetString(4),
            Progress: SqliteHelpers.GetNullableString(r, 5),
            Error: SqliteHelpers.GetNullableString(r, 6),
            Instructions: SqliteHelpers.GetNullableString(r, 7),
            ProviderName: SqliteHelpers.GetNullableString(r, 8),
            Model: SqliteHelpers.GetNullableString(r, 9),
            PromptTokens: r.IsDBNull(10) ? null : r.GetInt32(10),
            CompletionTokens: r.IsDBNull(11) ? null : r.GetInt32(11),
            ElapsedMs: r.IsDBNull(12) ? null : r.GetInt32(12),
            CreatedByName: SqliteHelpers.GetNullableString(r, 13),
            CreatedAt: SqliteHelpers.ReadTimestamp(r, 14),
            StartedAt: r.IsDBNull(15) ? null : SqliteHelpers.ReadTimestamp(r, 15),
            FinishedAt: r.IsDBNull(16) ? null : SqliteHelpers.ReadTimestamp(r, 16),
            Proposal: Json<ReorgProposalDto>(17),
            Current: Json<ReorgSnapshotDto>(18),
            Log: Json<List<ReorgLogEntryDto>>(19));
    }

    private async Task<bool> HasActiveJobAsync(string scope, string scopeId, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT 1 FROM reorg_job
            WHERE scope = $scope AND scope_id = $scope_id AND status IN ('queued', 'analyzing', 'applying')
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$scope", scope);
        SqliteHelpers.Add(cmd, "$scope_id", scopeId);
        return await cmd.ExecuteScalarAsync(ct) is not null;
    }

    private async Task SetStatusAsync(string jobId, string status, string? progress, bool started = false)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            UPDATE reorg_job SET status = $status, progress = $progress, updated_at = $now
            {(started ? ", started_at = $now" : "")}
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$status", status);
        SqliteHelpers.Add(cmd, "$progress", progress);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task SetProgressAsync(string jobId, string progress)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE reorg_job SET progress = $progress, updated_at = $now WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$progress", progress);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>The apply log so far; the run's token usage is added once, at the end.</summary>
    private async Task StoreLogAsync(string jobId, ApplyState state, bool final)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = final
            ? """
              UPDATE reorg_job
              SET log = $log,
                  prompt_tokens = COALESCE(prompt_tokens, 0) + $pt,
                  completion_tokens = COALESCE(completion_tokens, 0) + $cmp,
                  updated_at = $now
              WHERE id = $id
              """
            : "UPDATE reorg_job SET log = $log, updated_at = $now WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$log", JsonSerializer.Serialize(state.Log, JsonOptions));
        SqliteHelpers.Add(cmd, "$pt", state.PromptTokens);
        SqliteHelpers.Add(cmd, "$cmp", state.CompletionTokens);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync();
    }

    private async Task FinishAsync(string jobId, string status, string? error)
    {
        await using var conn = await db.OpenConnectionAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE reorg_job
            SET status = $status, error = $error, progress = NULL, finished_at = $now, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$status", status);
        SqliteHelpers.Add(cmd, "$error", error);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync();
    }

    private static int? Add(int? a, int? b) => a is null && b is null ? null : (a ?? 0) + (b ?? 0);

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string OneLine(string value, int max)
    {
        var line = Regex.Replace(value, @"\s+", " ").Trim();
        return line.Length <= max ? line : line[..max] + "…";
    }
}
