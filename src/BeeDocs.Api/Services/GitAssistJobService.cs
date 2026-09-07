using System.Collections.Concurrent;
using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// AI drafting as a background job: the POST returns immediately with a row the
/// UI polls (queued → running → completed | failed), the generation runs in a
/// fire-and-forget task (the git-clone pattern — LLM calls are minutes-scale
/// and must not hold a request open), and the finished Markdown lives on the
/// row until someone deletes the job. On top of that sit the two verbs the
/// dialog cannot do synchronously: publishing the result into the library as a
/// book page, and re-running a job with the same parameters so the published
/// page is *updated in place* — a new revision on the same page id, so links
/// and history survive a regeneration.
/// </summary>
public sealed class GitAssistJobService(
    SqliteConnectionFactory db,
    IGitRepoService repos,
    GitAssistService assist,
    IDocumentService documents,
    ICurrentUserAccessor currentUser,
    ILogger<GitAssistJobService> logger)
{
    /// <summary>Live jobs' cancellation handles — deleting a running job cancels it.</summary>
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    public async Task<GitAssistJobDto> StartAsync(
        string repoId, StartGitAssistJobRequest request, CancellationToken ct = default)
    {
        var repo = await repos.GetAsync(repoId, ct)
            ?? throw new KeyNotFoundException($"Repository '{repoId}' not found.");
        if (repo.Status != "ready")
            throw new GitException($"{repo.Name} is not ready ({repo.Status}) — sync or re-add it first.");

        var kind = GitAssistService.Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown assist kind '{request.Kind}'. Use one of: {string.Join(", ", GitAssistService.Kinds.All)}.");

        // Bad publish targets fail now, at the person, not minutes later in a
        // background task where the error is only a row in a list.
        var shelfId = Normalize(request.ShelfId);
        var bookId = Normalize(request.BookId);
        if (shelfId is not null && await documents.GetShelfAsync(shelfId, ct) is null)
            throw new ArgumentException($"Shelf '{shelfId}' was not found.");
        if (bookId is not null && await documents.GetBookAsync(bookId, ct) is null)
            throw new ArgumentException($"Book '{bookId}' was not found.");

        var actor = currentUser.Current;
        var now = DateTimeOffset.UtcNow;
        var job = new GitAssistJob
        {
            Id = SqliteHelpers.NewId(),
            RepoId = repo.Id,
            Kind = kind,
            Instructions = Normalize(request.Instructions),
            ProviderId = Normalize(request.ProviderId),
            Model = Normalize(request.Model),
            PublishBook = request.PublishBook ?? false,
            ShelfId = shelfId,
            BookId = bookId,
            CreatedById = actor.Id,
            CreatedByName = actor.Name,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await InsertAsync(job, ct);
        Launch(job.Id);
        return (await GetAsync(job.Id, includeMarkdown: false, ct))!;
    }

    /// <summary>
    /// A fresh run with the prior job's parameters — and, crucially, its
    /// book/page linkage, so the regenerated draft lands on the same page.
    /// </summary>
    public async Task<GitAssistJobDto?> RerunAsync(
        string jobId, RerunGitAssistJobRequest request, CancellationToken ct = default)
    {
        var source = await LoadAsync(jobId, ct);
        if (source is null) return null;

        var repo = await repos.GetAsync(source.RepoId, ct)
            ?? throw new KeyNotFoundException($"Repository '{source.RepoId}' not found.");
        if (repo.Status != "ready")
            throw new GitException($"{repo.Name} is not ready ({repo.Status}) — sync or re-add it first.");

        var actor = currentUser.Current;
        var now = DateTimeOffset.UtcNow;
        var job = new GitAssistJob
        {
            Id = SqliteHelpers.NewId(),
            RepoId = source.RepoId,
            Kind = source.Kind,
            Instructions = Normalize(request.Instructions) ?? source.Instructions,
            ProviderId = source.ProviderId,
            Model = source.Model,
            // A rerun of a published job republishes; of an unpublished one, not.
            PublishBook = source.PublishBook || source.PageId is not null || source.BookId is not null,
            ShelfId = source.ShelfId,
            BookId = source.BookId,
            PageId = source.PageId,
            CreatedById = actor.Id,
            CreatedByName = actor.Name,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await InsertAsync(job, ct);
        Launch(job.Id);
        return await GetAsync(job.Id, includeMarkdown: false, ct);
    }

    /// <summary>
    /// Put a completed job's Markdown into the library on demand — for jobs run
    /// without auto-publish, or to publish again somewhere else.
    /// </summary>
    public async Task<GitAssistJobDto?> PublishAsync(
        string jobId, PublishGitAssistJobRequest request, CancellationToken ct = default)
    {
        var job = await LoadAsync(jobId, ct);
        if (job is null) return null;
        if (job.Status != "completed" || string.IsNullOrEmpty(job.Markdown))
            throw new GitException("Only a completed job with a result can be published.");

        var repo = await repos.GetAsync(job.RepoId, ct)
            ?? throw new KeyNotFoundException($"Repository '{job.RepoId}' not found.");

        // null falls back to the job's own target; "" explicitly clears to root.
        var shelfId = request.ShelfId is null ? job.ShelfId : Normalize(request.ShelfId);
        var bookId = Normalize(request.BookId) ?? job.BookId;
        // A different destination book means the old page linkage no longer applies.
        var pageId = bookId is not null && bookId != job.BookId ? null : job.PageId;

        var (finalBookId, finalPageId) =
            await PublishCoreAsync(job, repo, job.Markdown, shelfId, bookId, pageId, ct);
        await StorePublishTargetAsync(job.Id, shelfId, finalBookId, finalPageId, ct);
        return await GetAsync(job.Id, includeMarkdown: false, ct);
    }

    public async Task<IReadOnlyList<GitAssistJobDto>> ListAsync(
        string? repoId, int limit = 100, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            {SelectSql}
            {(repoId is null ? "" : "WHERE j.repo_id = $repo_id")}
            ORDER BY j.created_at DESC
            LIMIT $limit
            """;
        if (repoId is not null) SqliteHelpers.Add(cmd, "$repo_id", repoId);
        SqliteHelpers.Add(cmd, "$limit", Math.Clamp(limit, 1, 500));

        var list = new List<GitAssistJobDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(Map(reader, includeMarkdown: false));
        return list;
    }

    public async Task<GitAssistJobDto?> GetAsync(
        string jobId, bool includeMarkdown = true, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{SelectSql} WHERE j.id = $id";
        SqliteHelpers.Add(cmd, "$id", jobId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return Map(reader, includeMarkdown);
    }

    /// <summary>Delete the record; a still-running job is cancelled first.</summary>
    public async Task<bool> DeleteAsync(string jobId, CancellationToken ct = default)
    {
        if (_running.TryGetValue(jobId, out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* the run just finished */ }
        }

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM git_assist_job WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", jobId);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    // ----- the background run -----

    private void Launch(string jobId)
    {
        // Fire-and-forget on purpose: every dependency is a singleton and the
        // outcome lands in the row, which the UI polls (the clone pattern).
        _ = Task.Run(() => RunAsync(jobId), CancellationToken.None);
    }

    private async Task RunAsync(string jobId)
    {
        var cts = new CancellationTokenSource();
        _running[jobId] = cts;
        try
        {
            var job = await LoadAsync(jobId, CancellationToken.None);
            if (job is null) return; // deleted before it started

            await MarkRunningAsync(jobId, CancellationToken.None);

            var repo = await repos.GetAsync(job.RepoId, CancellationToken.None)
                ?? throw new GitException("The repository was removed while the job was queued.");

            var result = await assist.GenerateAsync(
                repo, job.Kind, job.Instructions, job.ProviderId, job.Model, cts.Token);

            // The draft is safe in the row before publishing is attempted — a
            // publish failure must never cost the (paid-for) generation.
            await StoreResultAsync(jobId, result, CancellationToken.None);

            if (job.PublishBook)
            {
                try
                {
                    // The write is minutes after the request ended; the page
                    // history should still name whoever queued the job.
                    using var _ = AmbientActor.Use(new CurrentActor(job.CreatedById, job.CreatedByName));
                    // `job` predates the generation — the markdown comes from
                    // the result just stored, not from the stale row.
                    var (bookId, pageId) = await PublishCoreAsync(
                        job, repo, result.Markdown, job.ShelfId, job.BookId, job.PageId, cts.Token);
                    await StorePublishTargetAsync(jobId, job.ShelfId, bookId, pageId, CancellationToken.None);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    await FinishAsync(jobId, "failed",
                        $"The draft was generated, but publishing it to the library failed: {ex.Message} " +
                        "You can publish it again from the job list.", CancellationToken.None);
                    return;
                }
            }

            await FinishAsync(jobId, "completed", null, CancellationToken.None);
        }
        catch (OperationCanceledException)
        {
            await FinishAsync(jobId, "failed", "Cancelled.", CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Assist job {JobId} failed", jobId);
            await FinishAsync(jobId, "failed", ex.Message, CancellationToken.None);
        }
        finally
        {
            _running.TryRemove(jobId, out _);
            cts.Dispose();
        }
    }

    /// <summary>
    /// The result as library content. A single-page kind becomes one page
    /// titled by kind; a <c>book</c> kind becomes a book of pages from the JSON
    /// envelope. One book per repo unless the caller chose one; pages of the
    /// same title in the target book are updated rather than duplicated.
    /// </summary>
    private async Task<(string BookId, string PageId)> PublishCoreAsync(
        GitAssistJob job, GitRepoDto repo, string? markdown,
        string? shelfId, string? bookId, string? pageId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(markdown))
            throw new GitException("The job has no generated result to publish.");

        if (GitAssistBookDraft.TryParse(markdown, out var draft))
            return await PublishBookDraftAsync(job, repo, draft, shelfId, bookId, ct);

        if (job.Kind == GitAssistService.Kinds.Book)
            throw new GitException("The generated book draft is not valid JSON.");

        var title = GitAssistService.KindTitle(job.Kind);

        if (pageId is not null && await documents.GetPageAsync(pageId, ct) is { } existing)
        {
            await documents.UpdatePageAsync(existing.Id, new UpdatePageRequest(
                Title: existing.Title,
                Slug: null,
                Content: markdown,
                ChapterId: null,
                SortOrder: null), ct);
            return (existing.BookId, existing.Id);
        }

        var book = await ResolveBookAsync(job, shelfId, bookId, title: repo.Name,
            description: $"AI-generated documentation for the {repo.Name} repository.", ct);

        var pages = await documents.ListPagesAsync(book.Id, ct);
        var match = pages.FirstOrDefault(p =>
            string.Equals(p.Title, title, StringComparison.OrdinalIgnoreCase));
        if (match is not null)
        {
            await documents.UpdatePageAsync(match.Id, new UpdatePageRequest(
                Title: match.Title,
                Slug: null,
                Content: markdown,
                ChapterId: null,
                SortOrder: null), ct);
            return (book.Id, match.Id);
        }

        var page = await documents.CreatePageAsync(book.Id, new CreatePageRequest(
            Title: title,
            Slug: null,
            Content: markdown,
            ChapterId: null,
            SortOrder: pages.Count == 0 ? 0 : pages.Max(p => p.SortOrder) + 1,
            OwnerId: job.CreatedById), ct);
        return (book.Id, page.Id);
    }

    private async Task<(string BookId, string PageId)> PublishBookDraftAsync(
        GitAssistJob job, GitRepoDto repo, GitAssistBookDraft draft,
        string? shelfId, string? bookId, CancellationToken ct)
    {
        var bookTitle = string.IsNullOrWhiteSpace(draft.BookTitle) ? repo.Name : draft.BookTitle;
        var description = string.IsNullOrWhiteSpace(draft.BookDescription)
            ? $"AI-generated documentation for the {repo.Name} repository."
            : draft.BookDescription;

        var book = await ResolveBookAsync(job, shelfId, bookId, bookTitle, description, ct);
        var existing = (await documents.ListPagesAsync(book.Id, ct)).ToList();
        var nextOrder = existing.Count == 0 ? 0 : existing.Max(p => p.SortOrder) + 1;
        string? firstPageId = null;

        foreach (var page in draft.Pages)
        {
            var match = existing.FirstOrDefault(p =>
                string.Equals(p.Title, page.Title, StringComparison.OrdinalIgnoreCase));
            if (match is not null)
            {
                await documents.UpdatePageAsync(match.Id, new UpdatePageRequest(
                    Title: match.Title,
                    Slug: null,
                    Content: page.Markdown,
                    ChapterId: null,
                    SortOrder: null), ct);
                firstPageId ??= match.Id;
                continue;
            }

            var created = await documents.CreatePageAsync(book.Id, new CreatePageRequest(
                Title: page.Title,
                Slug: null,
                Content: page.Markdown,
                ChapterId: null,
                SortOrder: nextOrder++,
                OwnerId: job.CreatedById), ct);
            existing.Add(new PageSummaryDto(
                created.Id, created.BookId, created.ChapterId, created.Title, created.Slug,
                created.SortOrder, created.Version, created.OwnerId, created.OwnerName,
                created.IsPrivate, created.UpdatedAt));
            firstPageId ??= created.Id;
        }

        return (book.Id, firstPageId ?? throw new GitException("The book draft had no pages to publish."));
    }

    private async Task<BookDto> ResolveBookAsync(
        GitAssistJob job, string? shelfId, string? bookId,
        string title, string? description, CancellationToken ct)
    {
        if (bookId is not null && await documents.GetBookAsync(bookId, ct) is { } existing)
            return existing;

        if (shelfId is not null && await documents.GetShelfAsync(shelfId, ct) is null)
            throw new GitException($"Shelf '{shelfId}' no longer exists — pick another destination.");

        return await documents.CreateBookAsync(new CreateBookRequest(
            Title: title,
            Description: description,
            Slug: null,
            OwnerId: job.CreatedById,
            ShelfId: shelfId), ct);
    }

    /// <summary>
    /// Publish a reviewed single-page draft from the inline dialog — no job row,
    /// same title-matching rules as a job publish.
    /// </summary>
    public async Task<GitAssistPublishResultDto> PublishDraftAsync(
        string repoId, PublishGitAssistDraftRequest request, CancellationToken ct = default)
    {
        var repo = await repos.GetAsync(repoId, ct)
            ?? throw new KeyNotFoundException($"Repository '{repoId}' not found.");
        var kind = GitAssistService.Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown assist kind '{request.Kind}'. Use one of: {string.Join(", ", GitAssistService.Kinds.All)}.");
        if (kind == GitAssistService.Kinds.Book)
        {
            throw new ArgumentException(
                "A documentation book is published from its background job, not from this endpoint.");
        }

        if (string.IsNullOrWhiteSpace(request.Markdown))
            throw new ArgumentException("The draft is empty.");

        var shelfId = Normalize(request.ShelfId);
        var bookId = Normalize(request.BookId);
        if (shelfId is not null && await documents.GetShelfAsync(shelfId, ct) is null)
            throw new ArgumentException($"Shelf '{shelfId}' was not found.");
        if (bookId is not null && await documents.GetBookAsync(bookId, ct) is null)
            throw new ArgumentException($"Book '{bookId}' was not found.");

        var actor = currentUser.Current;
        var job = new GitAssistJob
        {
            Kind = kind,
            CreatedById = actor.Id,
            CreatedByName = actor.Name,
        };
        var (finalBookId, finalPageId) =
            await PublishCoreAsync(job, repo, request.Markdown, shelfId, bookId, pageId: null, ct);
        return new GitAssistPublishResultDto(finalBookId, finalPageId);
    }

    // ----- persistence -----

    private const string SelectSql = """
        SELECT j.id, j.repo_id, r.name, j.kind, j.status, j.error, j.instructions,
               j.provider_name, COALESCE(j.model_used, j.model), j.completion_tokens,
               j.elapsed_ms, j.context_files, j.publish_book, j.shelf_id, j.book_id,
               j.page_id, j.created_by_name, j.created_at, j.started_at, j.finished_at,
               j.markdown
        FROM git_assist_job j
        JOIN git_repo r ON r.id = j.repo_id
        """;

    private static GitAssistJobDto Map(SqliteDataReader reader, bool includeMarkdown)
    {
        IReadOnlyList<string> contextFiles = [];
        if (SqliteHelpers.GetNullableString(reader, 11) is { Length: > 0 } json)
        {
            try { contextFiles = JsonSerializer.Deserialize<List<string>>(json) ?? []; }
            catch (JsonException) { /* an unreadable list is cosmetic */ }
        }

        return new GitAssistJobDto(
            Id: reader.GetString(0),
            RepoId: reader.GetString(1),
            RepoName: reader.GetString(2),
            Kind: reader.GetString(3),
            Status: reader.GetString(4),
            Error: SqliteHelpers.GetNullableString(reader, 5),
            Instructions: SqliteHelpers.GetNullableString(reader, 6),
            ProviderName: SqliteHelpers.GetNullableString(reader, 7),
            Model: SqliteHelpers.GetNullableString(reader, 8),
            CompletionTokens: reader.IsDBNull(9) ? null : reader.GetInt32(9),
            ElapsedMs: reader.IsDBNull(10) ? null : reader.GetInt32(10),
            ContextFiles: contextFiles,
            PublishBook: reader.GetInt64(12) != 0,
            ShelfId: SqliteHelpers.GetNullableString(reader, 13),
            BookId: SqliteHelpers.GetNullableString(reader, 14),
            PageId: SqliteHelpers.GetNullableString(reader, 15),
            CreatedByName: SqliteHelpers.GetNullableString(reader, 16),
            CreatedAt: SqliteHelpers.ReadTimestamp(reader, 17),
            StartedAt: reader.IsDBNull(18) ? null : SqliteHelpers.ReadTimestamp(reader, 18),
            FinishedAt: reader.IsDBNull(19) ? null : SqliteHelpers.ReadTimestamp(reader, 19),
            Markdown: includeMarkdown ? SqliteHelpers.GetNullableString(reader, 20) : null);
    }

    private async Task<GitAssistJob?> LoadAsync(string jobId, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, repo_id, kind, instructions, provider_id, model, status,
                   markdown, publish_book, shelf_id, book_id, page_id,
                   created_by, created_by_name
            FROM git_assist_job WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new GitAssistJob
        {
            Id = reader.GetString(0),
            RepoId = reader.GetString(1),
            Kind = reader.GetString(2),
            Instructions = SqliteHelpers.GetNullableString(reader, 3),
            ProviderId = SqliteHelpers.GetNullableString(reader, 4),
            Model = SqliteHelpers.GetNullableString(reader, 5),
            Status = reader.GetString(6),
            Markdown = SqliteHelpers.GetNullableString(reader, 7),
            PublishBook = reader.GetInt64(8) != 0,
            ShelfId = SqliteHelpers.GetNullableString(reader, 9),
            BookId = SqliteHelpers.GetNullableString(reader, 10),
            PageId = SqliteHelpers.GetNullableString(reader, 11),
            CreatedById = SqliteHelpers.GetNullableString(reader, 12),
            CreatedByName = SqliteHelpers.GetNullableString(reader, 13),
        };
    }

    private async Task InsertAsync(GitAssistJob job, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO git_assist_job (
              id, repo_id, kind, instructions, provider_id, model, status,
              publish_book, shelf_id, book_id, page_id,
              created_by, created_by_name, created_at, updated_at)
            VALUES (
              $id, $repo_id, $kind, $instructions, $provider_id, $model, 'queued',
              $publish_book, $shelf_id, $book_id, $page_id,
              $created_by, $created_by_name, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", job.Id);
        SqliteHelpers.Add(cmd, "$repo_id", job.RepoId);
        SqliteHelpers.Add(cmd, "$kind", job.Kind);
        SqliteHelpers.Add(cmd, "$instructions", job.Instructions);
        SqliteHelpers.Add(cmd, "$provider_id", job.ProviderId);
        SqliteHelpers.Add(cmd, "$model", job.Model);
        SqliteHelpers.Add(cmd, "$publish_book", job.PublishBook ? 1 : 0);
        SqliteHelpers.Add(cmd, "$shelf_id", job.ShelfId);
        SqliteHelpers.Add(cmd, "$book_id", job.BookId);
        SqliteHelpers.Add(cmd, "$page_id", job.PageId);
        SqliteHelpers.Add(cmd, "$created_by", job.CreatedById);
        SqliteHelpers.Add(cmd, "$created_by_name", job.CreatedByName);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(job.CreatedAt));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(job.UpdatedAt));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task MarkRunningAsync(string jobId, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE git_assist_job
            SET status = 'running', started_at = $now, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task StoreResultAsync(string jobId, GitAssistResultDto result, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE git_assist_job
            SET markdown = $markdown, provider_name = $provider_name, model_used = $model_used,
                prompt_tokens = $prompt_tokens, completion_tokens = $completion_tokens,
                elapsed_ms = $elapsed_ms, context_files = $context_files, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$markdown", result.Markdown);
        SqliteHelpers.Add(cmd, "$provider_name", result.ProviderName);
        SqliteHelpers.Add(cmd, "$model_used", result.Model);
        SqliteHelpers.Add(cmd, "$prompt_tokens", result.PromptTokens);
        SqliteHelpers.Add(cmd, "$completion_tokens", result.CompletionTokens);
        SqliteHelpers.Add(cmd, "$elapsed_ms", result.ElapsedMs);
        SqliteHelpers.Add(cmd, "$context_files", JsonSerializer.Serialize(result.ContextFiles));
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task StorePublishTargetAsync(
        string jobId, string? shelfId, string bookId, string pageId, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE git_assist_job
            SET publish_book = 1, shelf_id = $shelf_id, book_id = $book_id,
                page_id = $page_id, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$shelf_id", shelfId);
        SqliteHelpers.Add(cmd, "$book_id", bookId);
        SqliteHelpers.Add(cmd, "$page_id", pageId);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private async Task FinishAsync(string jobId, string status, string? error, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE git_assist_job
            SET status = $status, error = $error, finished_at = $now, updated_at = $now
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", jobId);
        SqliteHelpers.Add(cmd, "$status", status);
        SqliteHelpers.Add(cmd, "$error", error);
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
