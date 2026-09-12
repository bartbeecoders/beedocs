using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;
using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>BeeDocs:BackupWorkPath — scratch space for archives being built or restored. Default data/backup-work.</summary>
public sealed record BackupOptions(string WorkRoot);

/// <summary>What an admin configured on Settings → Backup. Stored as JSON in app_setting.</summary>
public sealed record BackupSettings(
    int ScheduleHours,
    IReadOnlyList<string> ProviderIds,
    int KeepLast,
    bool IncludeUploads,
    bool IncludeAttachments,
    bool IncludeBranding,
    bool IncludeOffloaded)
{
    public static readonly BackupSettings Default = new(0, [], 7, true, true, true, true);
}

/// <summary>What is inside an archive — the first entry, read before anything is touched on restore.</summary>
public sealed record BackupManifest(
    int Format,
    string AppVersion,
    DateTimeOffset CreatedAt,
    bool Uploads,
    bool Attachments,
    bool Branding,
    int OffloadedCount,
    IReadOnlyList<string> OffloadedErrors);

/// <summary>One offloaded body captured in the archive, keyed back to its row.</summary>
public sealed record OffloadedEntry(string Table, string Id, string Ref, string Path);

/// <summary>
/// Backup and restore of everything an instance holds: the SQLite database,
/// uploaded images, book attachments, the branding logo — and, optionally, the
/// content bodies that live at storage providers, fetched back in so the
/// archive stands on its own. One zip, uploaded to one or more storage
/// providers (the same rows Settings → Storage manages, through their
/// <see cref="IBackupStore"/> side) or streamed to the admin's browser.
/// <para>
/// The database is snapshotted with <c>VACUUM INTO</c>, which produces a
/// consistent single-file copy while writers keep writing (WAL), and restored
/// with SQLite's online backup API into the live connection — pages are
/// replaced under SQLite's own locking, so no file is ever swapped beneath an
/// open handle and the WAL cannot be left describing a database that no longer
/// exists. Every other API call is refused (503) while that copy runs, via
/// <see cref="MaintenanceGate"/>.
/// </para>
/// <para>
/// Git clones are deliberately not archived: they are re-clonable from their
/// remotes and can dwarf everything else. A restore marks repos whose clone is
/// missing so the admin knows to re-add them.
/// </para>
/// </summary>
public sealed class BackupService(
    SqliteConnectionFactory db,
    BackupOptions options,
    StorageOptions storage,
    BrandingOptions branding,
    GitOptions git,
    IStorageProviderService providers,
    ContentStoreRouter router,
    ISearchIndexService search,
    RbaSettingsService rbaSettings,
    ApiKeySettingsService apiKeySettings,
    BrandingService brandingService,
    MaintenanceGate gate,
    ILogger<BackupService> logger)
{
    public const string ArchivePrefix = "backups/";
    private const string SettingKey = "backup.settings";
    private const int ManifestFormat = 1;
    private const string DbEntry = "sqlite/beedocs.db";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    /// <summary>Inline column per content table — where a captured body goes back on restore.</summary>
    private static readonly Dictionary<string, string> BodyColumns = new()
    {
        ["page"] = "content",
        ["page_revision"] = "content",
        ["diagram"] = "source",
        ["slide_deck"] = "source",
        ["kanban_board"] = "source",
        ["project_plan"] = "source",
        ["note"] = "source",
    };

    private static readonly string AppVersion = (Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString()
        ?? "0.0.0").Split('+')[0];

    // One backup or restore at a time. Wait(0) rather than a lock: a second
    // click must answer "already running", not queue behind the first.
    private readonly SemaphoreSlim _single = new(1, 1);
    private volatile BackupRunDto? _current;

    public bool IsBusy => _current is not null;

    // ----- Settings -----

    public async Task<BackupSettings> GetSettingsAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        return await ReadSettingsAsync(conn, ct);
    }

    private static async Task<BackupSettings> ReadSettingsAsync(SqliteConnection conn, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_setting WHERE key = $key LIMIT 1";
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        var raw = await cmd.ExecuteScalarAsync(ct) as string;
        if (string.IsNullOrWhiteSpace(raw)) return BackupSettings.Default;
        try
        {
            return JsonSerializer.Deserialize<BackupSettings>(raw, Json) ?? BackupSettings.Default;
        }
        catch (JsonException)
        {
            return BackupSettings.Default;
        }
    }

    /// <exception cref="ArgumentException">An unknown provider id, or a schedule with no target.</exception>
    public async Task<BackupSettingsDto> SetSettingsAsync(UpdateBackupSettingsRequest request, CancellationToken ct = default)
    {
        var known = (await providers.ListAsync(ct)).Select(p => p.Id).ToHashSet();
        var ids = (request.ProviderIds ?? []).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToList();
        var unknown = ids.FirstOrDefault(id => !known.Contains(id));
        if (unknown is not null)
            throw new ArgumentException($"Unknown storage provider '{unknown}'.");

        var hours = request.ScheduleHours ?? 0;
        if (hours < 0 || hours > 24 * 90)
            throw new ArgumentException("The schedule must be between 0 (manual) and 2160 hours (90 days).");
        if (hours > 0 && ids.Count == 0)
            throw new ArgumentException("Pick at least one storage provider before scheduling backups.");

        var keep = request.KeepLast ?? BackupSettings.Default.KeepLast;
        if (keep < 0 || keep > 1000)
            throw new ArgumentException("Keep between 0 (all) and 1000 archives.");

        var settings = new BackupSettings(
            hours,
            ids,
            keep,
            request.IncludeUploads ?? true,
            request.IncludeAttachments ?? true,
            request.IncludeBranding ?? true,
            request.IncludeOffloaded ?? true);

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_setting (key, value, updated_at)
            VALUES ($key, $value, $updated_at)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """;
        SqliteHelpers.Add(cmd, "$key", SettingKey);
        SqliteHelpers.Add(cmd, "$value", JsonSerializer.Serialize(settings, Json));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
        return ToDto(settings);
    }

    private static BackupSettingsDto ToDto(BackupSettings s) => new(
        s.ScheduleHours, s.ProviderIds, s.KeepLast, s.IncludeUploads, s.IncludeAttachments, s.IncludeBranding, s.IncludeOffloaded);

    // ----- Status & history -----

    public async Task<BackupStatusDto> GetStatusAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var settings = await ReadSettingsAsync(conn, ct);
        var list = (await providers.ListAsync(ct))
            .Select(p => new BackupProviderDto(p.Id, p.Name, p.Kind, IsReady(p)))
            .ToList();
        var runs = await ListRunsAsync(conn, 30, ct);
        return new BackupStatusDto(
            ToDto(settings),
            list,
            _current,
            await NextScheduledAtAsync(conn, settings, ct),
            runs,
            gate.Active);
    }

    private static bool IsReady(StorageProviderDto p) => p.Kind switch
    {
        StorageProviderKinds.AzureBlob => p.HasConnectionString,
        StorageProviderKinds.GoogleDrive => p.GoogleConnected,
        StorageProviderKinds.S3 => !string.IsNullOrEmpty(p.S3Bucket) && !string.IsNullOrEmpty(p.S3AccessKey) && p.HasS3SecretKey,
        _ => false,
    };

    public async Task<DateTimeOffset?> NextScheduledAtAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        return await NextScheduledAtAsync(conn, await ReadSettingsAsync(conn, ct), ct);
    }

    /// <summary>
    /// Last backup start (any trigger, any outcome) plus the interval; "now" when
    /// none has ever run. A failed run counts, so a broken target retries on the
    /// schedule rather than every minute.
    /// </summary>
    private static async Task<DateTimeOffset?> NextScheduledAtAsync(SqliteConnection conn, BackupSettings settings, CancellationToken ct)
    {
        if (settings.ScheduleHours <= 0 || settings.ProviderIds.Count == 0) return null;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT MAX(started_at) FROM backup_run WHERE kind = 'backup'";
        var last = await cmd.ExecuteScalarAsync(ct) as string;
        if (string.IsNullOrEmpty(last) || !DateTimeOffset.TryParse(last, null, System.Globalization.DateTimeStyles.AssumeUniversal, out var at))
            return DateTimeOffset.UtcNow;
        return at.AddHours(settings.ScheduleHours);
    }

    private static async Task<List<BackupRunDto>> ListRunsAsync(SqliteConnection conn, int limit, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, kind, trigger, status, started_at, finished_at, started_by, archive_key, size_bytes, targets, message
            FROM backup_run ORDER BY started_at DESC LIMIT $limit
            """;
        SqliteHelpers.Add(cmd, "$limit", limit);
        var list = new List<BackupRunDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var targetsRaw = SqliteHelpers.GetNullableString(reader, 9);
            IReadOnlyList<BackupTargetResultDto> targets = [];
            if (!string.IsNullOrEmpty(targetsRaw))
            {
                try
                {
                    targets = JsonSerializer.Deserialize<List<BackupTargetResultDto>>(targetsRaw, Json) ?? [];
                }
                catch (JsonException)
                {
                    // A corrupt row must not take the page down with it.
                }
            }
            list.Add(new BackupRunDto(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                SqliteHelpers.ReadTimestamp(reader, 4),
                reader.IsDBNull(5) ? null : SqliteHelpers.ReadTimestamp(reader, 5),
                SqliteHelpers.GetNullableString(reader, 6),
                SqliteHelpers.GetNullableString(reader, 7),
                reader.IsDBNull(8) ? null : reader.GetInt64(8),
                targets,
                SqliteHelpers.GetNullableString(reader, 10)));
        }
        return list;
    }

    private async Task WriteRunAsync(BackupRunDto run, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO backup_run (id, kind, trigger, status, started_at, finished_at, started_by, archive_key, size_bytes, targets, message)
            VALUES ($id, $kind, $trigger, $status, $started_at, $finished_at, $started_by, $archive_key, $size_bytes, $targets, $message)
            ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
              archive_key = excluded.archive_key, size_bytes = excluded.size_bytes,
              targets = excluded.targets, message = excluded.message
            """;
        SqliteHelpers.Add(cmd, "$id", run.Id);
        SqliteHelpers.Add(cmd, "$kind", run.Kind);
        SqliteHelpers.Add(cmd, "$trigger", run.Trigger);
        SqliteHelpers.Add(cmd, "$status", run.Status);
        SqliteHelpers.Add(cmd, "$started_at", SqliteHelpers.FormatTimestamp(run.StartedAt));
        SqliteHelpers.Add(cmd, "$finished_at", run.FinishedAt is { } f ? SqliteHelpers.FormatTimestamp(f) : null);
        SqliteHelpers.Add(cmd, "$started_by", run.StartedBy);
        SqliteHelpers.Add(cmd, "$archive_key", run.ArchiveKey);
        SqliteHelpers.Add(cmd, "$size_bytes", run.SizeBytes);
        SqliteHelpers.Add(cmd, "$targets", run.Targets.Count > 0 ? JsonSerializer.Serialize(run.Targets, Json) : null);
        SqliteHelpers.Add(cmd, "$message", run.Message);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// A restored history can hold rows that were "running" when the snapshot
    /// was taken (an upload in progress, or an archive made by an older build).
    /// They never finish in this timeline, so say so.
    /// </summary>
    private async Task CloseStaleRunsAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE backup_run SET status = 'failed', finished_at = $now,
              message = 'Was still running when the restored archive was made.'
            WHERE status = 'running'
            """;
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    /// <summary>Rows left "running" by a crash mid-backup. Called once at startup.</summary>
    public async Task SweepOrphanedRunsAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE backup_run SET status = 'failed', finished_at = $now,
              message = 'The server restarted while this run was in progress.'
            WHERE status = 'running'
            """;
        SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        var n = await cmd.ExecuteNonQueryAsync(ct);
        if (n > 0) logger.LogWarning("{Count} backup/restore run(s) were interrupted by a restart and marked failed.", n);
        Directory.CreateDirectory(options.WorkRoot);
        foreach (var stale in Directory.EnumerateFiles(options.WorkRoot, "*.zip"))
            TryDelete(stale);
        foreach (var stale in Directory.EnumerateFiles(options.WorkRoot, "restore-*.db"))
            TryDelete(stale);
    }

    // ----- Backup -----

    /// <summary>Start a backup in the background. Null when one (or a restore) is already running.</summary>
    public string? StartBackup(string trigger, string? startedBy)
    {
        if (!_single.Wait(0)) return null;
        var run = new BackupRunDto(
            SqliteHelpers.NewId(), "backup", trigger, "running", DateTimeOffset.UtcNow, null, startedBy, null, null, [], null);
        _current = run;
        _ = Task.Run(async () =>
        {
            try
            {
                // The row is written by RunBackupAsync once the archive exists —
                // written here, the snapshot would carry its own "running" row
                // and a restore would show a backup that never finishes.
                var finished = await RunBackupAsync(run, CancellationToken.None);
                await WriteRunAsync(finished, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Backup {RunId} failed.", run.Id);
                await WriteRunAsync(run with { Status = "failed", FinishedAt = DateTimeOffset.UtcNow, Message = ex.GetBaseException().Message }, CancellationToken.None);
            }
            finally
            {
                _current = null;
                _single.Release();
            }
        });
        return run.Id;
    }

    private async Task<BackupRunDto> RunBackupAsync(BackupRunDto run, CancellationToken ct)
    {
        var settings = await GetSettingsAsync(ct);
        if (settings.ProviderIds.Count == 0)
            return run with { Status = "failed", FinishedAt = DateTimeOffset.UtcNow, Message = "No storage provider is selected as a backup target." };

        Directory.CreateDirectory(options.WorkRoot);
        var key = ArchivePrefix + ArchiveFileName(run.StartedAt);
        var path = Path.Combine(options.WorkRoot, Path.GetFileName(key));
        try
        {
            var manifest = await BuildArchiveAsync(settings, path, ct);
            var size = new FileInfo(path).Length;
            _current = run = run with { ArchiveKey = key, SizeBytes = size };
            await WriteRunAsync(run, ct);

            var targets = new List<BackupTargetResultDto>();
            foreach (var providerId in settings.ProviderIds)
            {
                var name = (await providers.GetAsync(providerId, ct))?.Name ?? providerId;
                try
                {
                    var store = await router.ResolveBackupAsync(providerId, ct);
                    await using (var file = File.OpenRead(path))
                        await store.UploadAsync(key, file, size, ct);
                    var pruned = await PruneAsync(store, settings.KeepLast, ct);
                    targets.Add(new BackupTargetResultDto(providerId, name, true,
                        pruned > 0 ? $"Uploaded. {pruned} older archive(s) removed." : "Uploaded."));
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Backup {RunId}: upload to provider {ProviderId} failed.", run.Id, providerId);
                    targets.Add(new BackupTargetResultDto(providerId, name, false, ex.GetBaseException().Message));
                }
                _current = run with { Targets = targets };
            }

            var ok = targets.Count(t => t.Ok);
            var summary = new StringBuilder();
            summary.Append($"{FormatSize(size)}, {ok} of {targets.Count} target(s) reached.");
            if (manifest.OffloadedErrors.Count > 0)
                summary.Append($" {manifest.OffloadedErrors.Count} offloaded bod(y/ies) could not be fetched.");
            return run with
            {
                Status = ok > 0 ? "completed" : "failed",
                FinishedAt = DateTimeOffset.UtcNow,
                Targets = targets,
                Message = summary.ToString(),
            };
        }
        finally
        {
            TryDelete(path);
        }
    }

    /// <summary>Stream a freshly built archive — the browser download path. Nothing is recorded as a run.</summary>
    public async Task ExportAsync(Stream destination, CancellationToken ct)
    {
        Directory.CreateDirectory(options.WorkRoot);
        var path = Path.Combine(options.WorkRoot, "export-" + ArchiveFileName(DateTimeOffset.UtcNow));
        try
        {
            await BuildArchiveAsync(await GetSettingsAsync(ct), path, ct);
            await using var file = File.OpenRead(path);
            await file.CopyToAsync(destination, ct);
        }
        finally
        {
            TryDelete(path);
        }
    }

    public static string ArchiveFileName(DateTimeOffset at) =>
        $"beedocs-{at.UtcDateTime:yyyyMMdd-HHmmss}Z.zip";

    private async Task<BackupManifest> BuildArchiveAsync(BackupSettings settings, string path, CancellationToken ct)
    {
        var dbPath = db.DatabasePath
            ?? throw new InvalidOperationException("An in-memory database cannot be backed up.");
        var snapshot = Path.Combine(options.WorkRoot, $"snapshot-{Guid.NewGuid():N}.db");

        try
        {
            // VACUUM INTO writes a compacted, transactionally consistent copy
            // while other connections keep working — no lock on the live file
            // beyond a read transaction.
            await using (var conn = await db.OpenConnectionAsync(ct))
            await using (var cmd = conn.CreateCommand())
            {
                cmd.CommandText = "VACUUM INTO $path";
                SqliteHelpers.Add(cmd, "$path", snapshot);
                await cmd.ExecuteNonQueryAsync(ct);
            }

            var offloaded = new List<OffloadedEntry>();
            var offloadErrors = new List<string>();

            TryDelete(path);
            using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
            {
                // Files first, manifest last: the manifest's counts are only known
                // once everything else is in, and ZipArchive writes sequentially.
                zip.CreateEntryFromFile(snapshot, DbEntry, CompressionLevel.Optimal);

                if (settings.IncludeUploads) AddDirectory(zip, storage.UploadsRoot, "uploads");
                if (settings.IncludeAttachments) AddDirectory(zip, storage.AttachmentsRoot, "attachments");
                if (settings.IncludeBranding) AddDirectory(zip, branding.Root, "branding");

                if (settings.IncludeOffloaded)
                    await CaptureOffloadedAsync(zip, offloaded, offloadErrors, ct);

                var manifest = new BackupManifest(
                    ManifestFormat, AppVersion, DateTimeOffset.UtcNow,
                    settings.IncludeUploads, settings.IncludeAttachments, settings.IncludeBranding,
                    offloaded.Count, offloadErrors);
                await WriteJsonEntryAsync(zip, "manifest.json", manifest, ct);
                if (offloaded.Count > 0)
                    await WriteJsonEntryAsync(zip, "offloaded/index.json", offloaded, ct);
                return manifest;
            }
        }
        finally
        {
            TryDelete(snapshot);
        }
    }

    private static void AddDirectory(ZipArchive zip, string root, string entryRoot)
    {
        if (!Directory.Exists(root)) return;
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            // Already-compressed media gains nothing from deflate but CPU.
            var level = Path.GetExtension(file).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".zip" or ".pdf" or ".docx" or ".pptx" or ".xlsx"
                ? CompressionLevel.NoCompression
                : CompressionLevel.Optimal;
            zip.CreateEntryFromFile(file, $"{entryRoot}/{relative}", level);
        }
    }

    /// <summary>
    /// Every row whose body lives at a provider, fetched and stored under
    /// <c>offloaded/{table}/{id}</c>. Provider trouble is recorded, not thrown —
    /// a backup with one unreachable body is worth more than no backup.
    /// </summary>
    private async Task CaptureOffloadedAsync(ZipArchive zip, List<OffloadedEntry> entries, List<string> errors, CancellationToken ct)
    {
        foreach (var table in StorageProviderService.ContentTables)
        {
            var rows = new List<(string Id, string Ref)>();
            await using (var conn = await db.OpenConnectionAsync(ct))
            await using (var cmd = conn.CreateCommand())
            {
                // Table names are compile-time constants from ContentTables.
                cmd.CommandText = $"SELECT id, content_ref FROM {table} WHERE content_ref IS NOT NULL";
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct))
                    rows.Add((reader.GetString(0), reader.GetString(1)));
            }

            foreach (var (id, @ref) in rows)
            {
                if (!ContentRef.TryParse(@ref, out var providerId, out var key)) continue;
                try
                {
                    var store = await router.ResolveAsync(providerId, ct);
                    var body = await store.GetAsync(key, ct);
                    var entryPath = $"offloaded/{table}/{id}";
                    var entry = zip.CreateEntry(entryPath, CompressionLevel.Optimal);
                    await using (var s = entry.Open())
                        await s.WriteAsync(Encoding.UTF8.GetBytes(body), ct);
                    entries.Add(new OffloadedEntry(table, id, @ref, entryPath));
                }
                catch (Exception ex)
                {
                    errors.Add($"{table}/{id}: {ex.GetBaseException().Message}");
                }
            }
        }
    }

    private static async Task WriteJsonEntryAsync<T>(ZipArchive zip, string name, T value, CancellationToken ct)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        await using var s = entry.Open();
        await JsonSerializer.SerializeAsync(s, value, Json, ct);
    }

    /// <summary>Delete archives beyond the newest <paramref name="keepLast"/>. Names carry timestamps, so the sort is lexical.</summary>
    private static async Task<int> PruneAsync(IBackupStore store, int keepLast, CancellationToken ct)
    {
        if (keepLast <= 0) return 0;
        var archives = (await store.ListAsync(ArchivePrefix, ct))
            .Where(a => a.Key.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(a => a.Key, StringComparer.Ordinal)
            .Skip(keepLast)
            .ToList();
        foreach (var old in archives)
            await store.DeleteAsync(old.Key, ct);
        return archives.Count;
    }

    // ----- Archives at a provider -----

    public async Task<IReadOnlyList<BackupArchiveDto>> ListArchivesAsync(string providerId, CancellationToken ct = default)
    {
        var store = await router.ResolveBackupAsync(providerId, ct);
        return (await store.ListAsync(ArchivePrefix, ct))
            .Where(a => a.Key.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(a => a.Key, StringComparer.Ordinal)
            .Select(a => new BackupArchiveDto(a.Key, a.Size, a.LastModified))
            .ToList();
    }

    public async Task DownloadArchiveAsync(string providerId, string key, Stream destination, CancellationToken ct = default)
    {
        var store = await router.ResolveBackupAsync(providerId, ct);
        await store.DownloadAsync(ValidArchiveKey(key), destination, ct);
    }

    public async Task DeleteArchiveAsync(string providerId, string key, CancellationToken ct = default)
    {
        var store = await router.ResolveBackupAsync(providerId, ct);
        await store.DeleteAsync(ValidArchiveKey(key), ct);
    }

    /// <summary>Only names this service produced — never an arbitrary object at the provider.</summary>
    private static string ValidArchiveKey(string key)
    {
        if (!key.StartsWith(ArchivePrefix, StringComparison.Ordinal)
            || key.Contains("..", StringComparison.Ordinal)
            || !key.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)
            || key.IndexOf('/', ArchivePrefix.Length) >= 0)
        {
            throw new ArgumentException("Not a backup archive name.");
        }
        return key;
    }

    // ----- Restore -----

    /// <summary>Path where an uploaded archive should be saved before <see cref="StartRestoreFromFile"/>.</summary>
    public string NewUploadPath()
    {
        Directory.CreateDirectory(options.WorkRoot);
        return Path.Combine(options.WorkRoot, $"upload-{Guid.NewGuid():N}.zip");
    }

    /// <summary>Download the archive from a provider, then restore. Null when busy.</summary>
    public string? StartRestore(string providerId, string key, string? startedBy)
    {
        ValidArchiveKey(key);
        return StartRestoreCore(key, startedBy, async ct =>
        {
            Directory.CreateDirectory(options.WorkRoot);
            var path = Path.Combine(options.WorkRoot, $"download-{Guid.NewGuid():N}.zip");
            await using (var file = File.Create(path))
                await DownloadArchiveAsync(providerId, key, file, ct);
            return path;
        });
    }

    /// <summary>Restore from an archive already on disk (an upload). The file is deleted afterwards. Null when busy.</summary>
    public string? StartRestoreFromFile(string path, string originalName, string? startedBy) =>
        StartRestoreCore(originalName, startedBy, _ => Task.FromResult(path));

    private string? StartRestoreCore(string archiveLabel, string? startedBy, Func<CancellationToken, Task<string>> fetch)
    {
        if (!_single.Wait(0)) return null;
        var run = new BackupRunDto(
            SqliteHelpers.NewId(), "restore", "manual", "running", DateTimeOffset.UtcNow, null, startedBy, archiveLabel, null, [], null);
        _current = run;
        _ = Task.Run(async () =>
        {
            string? path = null;
            try
            {
                await WriteRunAsync(run, CancellationToken.None);
                path = await fetch(CancellationToken.None);
                _current = run = run with { SizeBytes = new FileInfo(path).Length };
                var message = await RunRestoreAsync(path, CancellationToken.None);
                run = run with { Status = "completed", FinishedAt = DateTimeOffset.UtcNow, Message = message };
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Restore {RunId} failed.", run.Id);
                run = run with { Status = "failed", FinishedAt = DateTimeOffset.UtcNow, Message = ex.GetBaseException().Message };
            }
            finally
            {
                gate.Exit();
                if (path is not null) TryDelete(path);
                // The database may have been replaced: the row written at the
                // start is gone with it, so this is an insert as much as an update.
                try
                {
                    await WriteRunAsync(run, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Could not record restore {RunId}.", run.Id);
                }
                _current = null;
                _single.Release();
            }
        });
        return run.Id;
    }

    private async Task<string> RunRestoreAsync(string archivePath, CancellationToken ct)
    {
        var dbPath = db.DatabasePath
            ?? throw new InvalidOperationException("An in-memory database cannot be restored into.");

        using var zip = ZipFile.OpenRead(archivePath);
        var manifestEntry = zip.GetEntry("manifest.json")
            ?? throw new InvalidOperationException("This is not a BeeDocs backup: manifest.json is missing.");
        BackupManifest manifest;
        await using (var s = manifestEntry.Open())
        {
            manifest = await JsonSerializer.DeserializeAsync<BackupManifest>(s, Json, ct)
                ?? throw new InvalidOperationException("The backup manifest could not be read.");
        }
        if (manifest.Format > ManifestFormat)
            throw new InvalidOperationException($"This backup was made by a newer BeeDocs (format {manifest.Format}); upgrade first.");
        var dbEntry = zip.GetEntry(DbEntry)
            ?? throw new InvalidOperationException("The backup holds no database.");

        // Extract and sanity-check the database before anything live is touched.
        Directory.CreateDirectory(options.WorkRoot);
        var restored = Path.Combine(options.WorkRoot, $"restore-{Guid.NewGuid():N}.db");
        try
        {
            dbEntry.ExtractToFile(restored, overwrite: true);
            await using (var probe = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = restored, Mode = SqliteOpenMode.ReadOnly }.ToString()))
            {
                await probe.OpenAsync(ct);
                await using var check = probe.CreateCommand();
                check.CommandText = "PRAGMA quick_check";
                var verdict = await check.ExecuteScalarAsync(ct) as string;
                if (verdict != "ok") throw new InvalidOperationException($"The backup's database is damaged ({verdict}).");
                check.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('book', 'page', 'app_setting')";
                if (Convert.ToInt64(await check.ExecuteScalarAsync(ct)) < 3)
                    throw new InvalidOperationException("The backup's database is not a BeeDocs database.");
            }

            gate.Enter("A backup is being restored. BeeDocs will be back in a moment.");
            // Let requests already past the gate finish their SQLite writes.
            await Task.Delay(1500, ct);

            var sessions = await SnapshotSessionsAsync(ct);
            var safety = await SafetyCopyAsync(ct);
            var notes = new List<string> { $"Archive from {manifest.CreatedAt:u} (BeeDocs {manifest.AppVersion})." };

            await CopyDatabaseAsync(restored, ct);
            await DatabaseInitializer.EnsureSchemaAsync(db, ct);
            await CloseStaleRunsAsync(ct);
            var kept = await RestoreSessionsAsync(sessions, ct);
            notes.Add(kept > 0 ? $"{kept} sign-in session(s) kept." : "Everyone has to sign in again.");

            var inlined = await InlineOffloadedAsync(zip, ct);
            if (inlined > 0)
                notes.Add($"{inlined} offloaded bod(y/ies) restored inline — re-assign shelf storage to offload them again.");

            if (manifest.Uploads) RestoreDirectory(zip, "uploads", storage.UploadsRoot);
            if (manifest.Attachments) RestoreDirectory(zip, "attachments", storage.AttachmentsRoot);
            if (manifest.Branding) RestoreDirectory(zip, "branding", branding.Root);

            var missingRepos = await MarkMissingClonesAsync(ct);
            if (missingRepos > 0)
                notes.Add($"{missingRepos} git repositor(y/ies) have no clone on this server — remove and re-add them.");

            // Every singleton that caches a row of the old database.
            rbaSettings.Invalidate();
            apiKeySettings.Invalidate();
            brandingService.Invalidate();
            router.Clear();
            try
            {
                await search.InitializeAsync(ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Search index could not be rebuilt after the restore.");
                notes.Add("Search index needs a rebuild (Settings → Search → Reindex).");
            }

            if (safety is not null) notes.Add($"Previous database kept at {safety}.");
            return string.Join(" ", notes);
        }
        finally
        {
            TryDelete(restored);
        }
    }

    /// <summary>
    /// SQLite's online backup API from the extracted file into the live
    /// connection: pages are copied under the destination's write lock, so the
    /// file the pool's connections hold open is the one that changes — no
    /// swap, no stale WAL. Retries while another connection still holds a
    /// transaction the gate did not stop in time.
    /// </summary>
    private async Task CopyDatabaseAsync(string sourcePath, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var source = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = sourcePath, Mode = SqliteOpenMode.ReadOnly }.ToString());
                await source.OpenAsync(ct);
                await using var destination = await db.OpenConnectionAsync(ct);
                source.BackupDatabase(destination);
                await using var checkpoint = destination.CreateCommand();
                checkpoint.CommandText = "PRAGMA wal_checkpoint(TRUNCATE)";
                await checkpoint.ExecuteNonQueryAsync(ct);
                return;
            }
            catch (SqliteException ex) when (attempt < 10 && ex.SqliteErrorCode is 5 or 6) // BUSY, LOCKED
            {
                logger.LogInformation("Database busy during restore (attempt {Attempt}); retrying.", attempt);
                await Task.Delay(500 * attempt, ct);
            }
        }
    }

    private sealed record SessionRow(string TokenHash, string UserId, string CreatedAt, string ExpiresAt, string LastSeenAt);

    private async Task<List<SessionRow>> SnapshotSessionsAsync(CancellationToken ct)
    {
        var list = new List<SessionRow>();
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT token_hash, user_id, created_at, expires_at, last_seen_at FROM user_session";
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(new SessionRow(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4)));
        return list;
    }

    /// <summary>
    /// Re-insert the sessions that existed before the copy, for accounts the
    /// restored database still knows. The admin who clicked Restore keeps their
    /// session that way instead of being bounced to the login screen by their
    /// own action.
    /// </summary>
    private async Task<int> RestoreSessionsAsync(List<SessionRow> sessions, CancellationToken ct)
    {
        if (sessions.Count == 0) return 0;
        var kept = 0;
        await using var conn = await db.OpenConnectionAsync(ct);
        foreach (var s in sessions)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = """
                INSERT OR IGNORE INTO user_session (token_hash, user_id, created_at, expires_at, last_seen_at)
                SELECT $token_hash, $user_id, $created_at, $expires_at, $last_seen_at
                WHERE EXISTS (SELECT 1 FROM app_user WHERE id = $user_id AND enabled = 1)
                """;
            SqliteHelpers.Add(cmd, "$token_hash", s.TokenHash);
            SqliteHelpers.Add(cmd, "$user_id", s.UserId);
            SqliteHelpers.Add(cmd, "$created_at", s.CreatedAt);
            SqliteHelpers.Add(cmd, "$expires_at", s.ExpiresAt);
            SqliteHelpers.Add(cmd, "$last_seen_at", s.LastSeenAt);
            kept += await cmd.ExecuteNonQueryAsync(ct);
        }
        return kept;
    }

    /// <summary>VACUUM INTO a sibling of the work dir; only the newest safety copy is kept.</summary>
    private async Task<string?> SafetyCopyAsync(CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(options.WorkRoot);
            foreach (var old in Directory.EnumerateFiles(options.WorkRoot, "pre-restore-*.db"))
                TryDelete(old);
            var path = Path.Combine(options.WorkRoot, $"pre-restore-{DateTimeOffset.UtcNow.UtcDateTime:yyyyMMdd-HHmmss}.db");
            await using var conn = await db.OpenConnectionAsync(ct);
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "VACUUM INTO $path";
            SqliteHelpers.Add(cmd, "$path", path);
            await cmd.ExecuteNonQueryAsync(ct);
            return path;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not take a safety copy of the database before restoring.");
            return null;
        }
    }

    /// <summary>
    /// Bodies the archive captured go back *inline*: the provider objects the
    /// restored rows point at may be gone (a different provider row, a wiped
    /// bucket), and a row that carries its own body can never fail to load.
    /// The shelf keeps its provider, so the next save — or a re-run of the
    /// shelf storage assignment — offloads them again.
    /// </summary>
    private async Task<int> InlineOffloadedAsync(ZipArchive zip, CancellationToken ct)
    {
        var index = zip.GetEntry("offloaded/index.json");
        if (index is null) return 0;
        List<OffloadedEntry> entries;
        await using (var s = index.Open())
            entries = await JsonSerializer.DeserializeAsync<List<OffloadedEntry>>(s, Json, ct) ?? [];

        var inlined = 0;
        await using var conn = await db.OpenConnectionAsync(ct);
        foreach (var e in entries)
        {
            if (!BodyColumns.TryGetValue(e.Table, out var column)) continue;
            var entry = zip.GetEntry(e.Path);
            if (entry is null) continue;
            string body;
            await using (var s = entry.Open())
            using (var reader = new StreamReader(s, Encoding.UTF8))
                body = await reader.ReadToEndAsync(ct);

            await using var cmd = conn.CreateCommand();
            // Table and column come from BodyColumns, never from the archive.
            cmd.CommandText = $"UPDATE {e.Table} SET {column} = $body, content_ref = NULL, content_size = NULL WHERE id = $id AND content_ref = $ref";
            SqliteHelpers.Add(cmd, "$body", body);
            SqliteHelpers.Add(cmd, "$id", e.Id);
            SqliteHelpers.Add(cmd, "$ref", e.Ref);
            inlined += await cmd.ExecuteNonQueryAsync(ct);
        }
        return inlined;
    }

    /// <summary>
    /// Replace a directory's contents with the archive's. Extracted beside the
    /// target first, so a corrupt entry fails before anything is removed; every
    /// entry path is jailed under the target.
    /// </summary>
    private static void RestoreDirectory(ZipArchive zip, string entryRoot, string targetRoot)
    {
        var prefix = entryRoot + "/";
        var entries = zip.Entries.Where(e => e.FullName.StartsWith(prefix, StringComparison.Ordinal) && !e.FullName.EndsWith('/')).ToList();

        var staging = targetRoot.TrimEnd(Path.DirectorySeparatorChar) + ".restoring";
        if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        Directory.CreateDirectory(staging);
        var stagingFull = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;

        foreach (var entry in entries)
        {
            var relative = entry.FullName[prefix.Length..];
            var destination = Path.GetFullPath(Path.Combine(staging, relative));
            if (!destination.StartsWith(stagingFull, StringComparison.Ordinal))
                throw new InvalidOperationException($"The archive entry '{entry.FullName}' escapes its directory.");
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, overwrite: true);
        }

        Directory.CreateDirectory(targetRoot);
        foreach (var file in Directory.EnumerateFiles(targetRoot)) File.Delete(file);
        foreach (var dir in Directory.EnumerateDirectories(targetRoot)) Directory.Delete(dir, recursive: true);
        foreach (var file in Directory.EnumerateFiles(staging)) File.Move(file, Path.Combine(targetRoot, Path.GetFileName(file)));
        foreach (var dir in Directory.EnumerateDirectories(staging)) Directory.Move(dir, Path.Combine(targetRoot, Path.GetFileName(dir)));
        Directory.Delete(staging, recursive: true);
    }

    private async Task<int> MarkMissingClonesAsync(CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var ids = new List<string>();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT id FROM git_repo WHERE status = 'ready'";
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) ids.Add(reader.GetString(0));
        }
        var missing = ids.Where(id => !Directory.Exists(Path.Combine(git.Root, id))).ToList();
        foreach (var id in missing)
        {
            await using var cmd = conn.CreateCommand();
            cmd.CommandText = "UPDATE git_repo SET status = 'error', last_error = $error, updated_at = $now WHERE id = $id";
            SqliteHelpers.Add(cmd, "$error", "The clone is missing on this server (restored from a backup). Remove the repository and add it again.");
            SqliteHelpers.Add(cmd, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        return missing.Count;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // Scratch files; the startup sweep gets another chance.
        }
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
        < 1024L * 1024 * 1024 => $"{bytes / 1024.0 / 1024:0.#} MB",
        _ => $"{bytes / 1024.0 / 1024 / 1024:0.##} GB",
    };
}
