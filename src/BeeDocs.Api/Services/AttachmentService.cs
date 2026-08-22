using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>An upload the caller rejected on its own terms — bad type, too big, empty.</summary>
public sealed class InvalidAttachmentException(string message) : Exception(message);

/// <summary>One uploaded file, as handed to <see cref="IAttachmentService"/>.</summary>
/// <param name="Length">Declared size, checked before a byte is written.</param>
public sealed record AttachmentUpload(
    Stream Content,
    string FileName,
    string? ContentType,
    long Length
);

/// <summary>An attachment's bytes, opened for streaming back to a client.</summary>
public sealed record AttachmentDownload(
    Stream Content,
    string FileName,
    string ContentType,
    long SizeBytes
) : IDisposable
{
    public void Dispose() => Content.Dispose();
}

public interface IAttachmentService
{
    Task<IReadOnlyList<AttachmentSummaryDto>> ListByBookAsync(string bookId, CancellationToken ct = default);
    Task<AttachmentDto?> GetAsync(string id, CancellationToken ct = default);

    /// <summary>Store an uploaded file against a book.</summary>
    /// <exception cref="KeyNotFoundException">The book does not exist.</exception>
    /// <exception cref="InvalidAttachmentException">The file is empty, too large, or of a type that is not accepted.</exception>
    Task<AttachmentDto> CreateAsync(
        string bookId, AttachmentUpload upload, string? title, string? description, CancellationToken ct = default);

    /// <summary>Properties only — title, description, owner, download name.</summary>
    Task<AttachmentDto?> UpdateAsync(string id, UpdateAttachmentRequest request, CancellationToken ct = default);

    /// <summary>Swap the bytes, keeping the id, title and description. Null when the attachment is unknown.</summary>
    Task<AttachmentDto?> ReplaceFileAsync(string id, AttachmentUpload upload, CancellationToken ct = default);

    /// <summary>Open the stored file. Null when the attachment — or the file behind it — is gone.</summary>
    Task<AttachmentDownload?> OpenAsync(string id, CancellationToken ct = default);

    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}

/// <summary>
/// Files kept alongside a book's pages: PDFs, Word/PowerPoint/Excel documents,
/// archives.
///
/// The payload is opaque bytes on disk under
/// <see cref="StorageOptions.AttachmentsRoot"/>, not text in SQLite, which is
/// what separates this from every other content service: there is no
/// <see cref="ContentResolver"/> and no storage-provider offload, and the row is
/// metadata alone. Uploads are written to their final path directly, so a failed
/// insert can leave an orphaned file — deliberately the safer of the two
/// directions, since the reverse strands a row that downloads a 404.
/// </summary>
public sealed class AttachmentService(
    SqliteConnectionFactory db,
    StorageOptions storage,
    ICurrentUserAccessor currentUser) : IAttachmentService
{
    /// <summary>
    /// A single document, not a disk image. Kestrel's body limit (256 MB, set in
    /// Program.cs) still bounds the request; this bounds what is kept.
    /// </summary>
    public const long MaxAttachmentBytes = 100L * 1024 * 1024;

    /// <summary>
    /// What may be stored, by extension. An allow-list rather than a deny-list:
    /// the files are handed back to browsers, so anything executable or scriptable
    /// staying out is the point. The list is deliberately about documents.
    /// </summary>
    private static readonly Dictionary<string, string> AllowedTypes =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // Portable documents
            [".pdf"] = "application/pdf",
            // Microsoft Office
            [".doc"] = "application/msword",
            [".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            [".xls"] = "application/vnd.ms-excel",
            [".xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            [".ppt"] = "application/vnd.ms-powerpoint",
            [".pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            [".vsd"] = "application/vnd.visio",
            [".vsdx"] = "application/vnd.ms-visio.drawing",
            // OpenDocument
            [".odt"] = "application/vnd.oasis.opendocument.text",
            [".ods"] = "application/vnd.oasis.opendocument.spreadsheet",
            [".odp"] = "application/vnd.oasis.opendocument.presentation",
            // Plain text and data
            [".txt"] = "text/plain",
            [".md"] = "text/markdown",
            [".rtf"] = "application/rtf",
            [".csv"] = "text/csv",
            [".json"] = "application/json",
            [".xml"] = "application/xml",
            [".yaml"] = "application/yaml",
            [".yml"] = "application/yaml",
            // Archives
            [".zip"] = "application/zip",
            [".7z"] = "application/x-7z-compressed",
            [".tar"] = "application/x-tar",
            [".gz"] = "application/gzip",
            // Images, so a scanned document or a screenshot can be filed as one
            [".png"] = "image/png",
            [".jpg"] = "image/jpeg",
            [".jpeg"] = "image/jpeg",
            [".gif"] = "image/gif",
            [".webp"] = "image/webp",
            [".svg"] = "image/svg+xml",
        };

    /// <summary>The extensions <see cref="AllowedTypes"/> accepts, for an error message and the file picker.</summary>
    public static IReadOnlyCollection<string> AllowedExtensions { get; } =
        AllowedTypes.Keys.OrderBy(e => e, StringComparer.Ordinal).ToArray();

    private const string Select = """
        SELECT a.id, a.book_id, a.title, a.description, a.file_name, a.stored_name,
               a.content_type, a.size_bytes, a.owner_id, a.created_at, a.updated_at,
               COALESCE(NULLIF(TRIM(u.display_name), ''), u.username) AS owner_name
        FROM attachment a
        LEFT JOIN app_user u ON u.id = a.owner_id
        """;

    public async Task<IReadOnlyList<AttachmentSummaryDto>> ListByBookAsync(
        string bookId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{Select} WHERE a.book_id = $book_id ORDER BY a.title COLLATE NOCASE";
        SqliteHelpers.Add(cmd, "$book_id", bookId);

        var list = new List<AttachmentSummaryDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
        {
            var (row, ownerName) = Read(reader);
            list.Add(new AttachmentSummaryDto(
                Id: row.Id,
                BookId: row.BookId,
                Title: row.Title,
                FileName: row.FileName,
                ContentType: row.ContentType,
                SizeBytes: row.SizeBytes,
                OwnerId: row.OwnerId,
                OwnerName: ownerName,
                DownloadUrl: DownloadUrl(row.Id),
                UpdatedAt: row.UpdatedAt));
        }
        return list;
    }

    public async Task<AttachmentDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var found = await SelectAsync(conn, id, ct);
        return found is null ? null : ToDto(found.Value.Row, found.Value.OwnerName);
    }

    public async Task<AttachmentDto> CreateAsync(
        string bookId,
        AttachmentUpload upload,
        string? title,
        string? description,
        CancellationToken ct = default)
    {
        var ext = ValidateAndResolveExtension(upload);

        await using var conn = await db.OpenConnectionAsync(ct);
        string? bookOwnerId;
        await using (var check = conn.CreateCommand())
        {
            check.CommandText = "SELECT owner_id FROM book WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(check, "$id", bookId);
            await using var reader = await check.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct))
                throw new KeyNotFoundException($"Book '{bookId}' not found.");
            bookOwnerId = SqliteHelpers.GetNullableString(reader, 0);
        }

        var now = DateTimeOffset.UtcNow;
        var fileName = SafeFileName(upload.FileName, ext);
        var row = new Attachment
        {
            Id = SqliteHelpers.NewId(),
            BookId = bookId,
            Title = string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(fileName) : title.Trim(),
            Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim(),
            FileName = fileName,
            ContentType = ResolveContentType(upload.ContentType, ext),
            // A page inherits its book's owner; a file does the same, falling back
            // to whoever uploaded it so a book with no owner still records one.
            OwnerId = bookOwnerId ?? currentUser.Current.Id,
            CreatedAt = now,
            UpdatedAt = now,
        };
        row.StoredName = row.Id + ext;
        row.SizeBytes = await WriteFileAsync(row.StoredName, upload, ct);

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                INSERT INTO attachment (id, book_id, title, description, file_name, stored_name,
                  content_type, size_bytes, owner_id, created_at, updated_at)
                VALUES ($id, $book_id, $title, $description, $file_name, $stored_name,
                  $content_type, $size_bytes, $owner_id, $created_at, $updated_at)
                """;
            Bind(cmd, row);
            SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(row.CreatedAt));
            await cmd.ExecuteNonQueryAsync(ct);
        }

        return ToDto(row, await OwnerNameAsync(conn, row.OwnerId, ct));
    }

    public async Task<AttachmentDto?> UpdateAsync(
        string id, UpdateAttachmentRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var found = await SelectAsync(conn, id, ct);
        if (found is null) return null;
        var row = found.Value.Row;

        row.Title = request.Title.Trim();
        // Same convention as UpdateBookRequest: null leaves the field alone, ""
        // clears it. The properties pane sends partial updates.
        if (request.Description is not null)
            row.Description = request.Description.Trim() is { Length: > 0 } d ? d : null;
        if (request.OwnerId is not null)
            row.OwnerId = request.OwnerId.Trim() is { Length: > 0 } o ? o : null;
        // Renaming the download must not renegotiate the stored type: the bytes
        // did not change, so the extension on disk stays the one they were
        // validated as, and a name given without it gets it back.
        if (request.FileName is not null && request.FileName.Trim() is { Length: > 0 } n)
            row.FileName = SafeFileName(n, Path.GetExtension(row.StoredName));
        row.UpdatedAt = DateTimeOffset.UtcNow;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE attachment SET title = $title, description = $description,
                  file_name = $file_name, stored_name = $stored_name, content_type = $content_type,
                  size_bytes = $size_bytes, owner_id = $owner_id, book_id = $book_id,
                  updated_at = $updated_at
                WHERE id = $id
                """;
            Bind(cmd, row);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        return ToDto(row, await OwnerNameAsync(conn, row.OwnerId, ct));
    }

    public async Task<AttachmentDto?> ReplaceFileAsync(
        string id, AttachmentUpload upload, CancellationToken ct = default)
    {
        var ext = ValidateAndResolveExtension(upload);

        await using var conn = await db.OpenConnectionAsync(ct);
        var found = await SelectAsync(conn, id, ct);
        if (found is null) return null;
        var row = found.Value.Row;

        // A new extension means a new path, so the old file is only removed once
        // the row points at the new one — a crash in between leaves a stray file,
        // never a row whose download 404s.
        var previousStored = row.StoredName;
        row.StoredName = row.Id + ext;
        row.FileName = SafeFileName(upload.FileName, ext);
        row.ContentType = ResolveContentType(upload.ContentType, ext);
        row.SizeBytes = await WriteFileAsync(row.StoredName, upload, ct);
        row.UpdatedAt = DateTimeOffset.UtcNow;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = """
                UPDATE attachment SET title = $title, description = $description,
                  file_name = $file_name, stored_name = $stored_name, content_type = $content_type,
                  size_bytes = $size_bytes, owner_id = $owner_id, book_id = $book_id,
                  updated_at = $updated_at
                WHERE id = $id
                """;
            Bind(cmd, row);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        if (!string.Equals(previousStored, row.StoredName, StringComparison.Ordinal))
            DeleteFile(previousStored);

        return ToDto(row, await OwnerNameAsync(conn, row.OwnerId, ct));
    }

    public async Task<AttachmentDownload?> OpenAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var found = await SelectAsync(conn, id, ct);
        if (found is null) return null;
        var row = found.Value.Row;

        var path = StoredPath(row.StoredName);
        if (!File.Exists(path)) return null;

        return new AttachmentDownload(
            File.OpenRead(path), row.FileName, row.ContentType, row.SizeBytes);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var found = await SelectAsync(conn, id, ct);
        if (found is null) return false;

        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "DELETE FROM attachment WHERE id = $id";
            SqliteHelpers.Add(cmd, "$id", id);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        DeleteFile(found.Value.Row.StoredName);
        return true;
    }

    // -------------------------------------------------------------------------
    // Files on disk
    // -------------------------------------------------------------------------

    /// <summary>
    /// Where an attachment's bytes live. <paramref name="storedName"/> is always
    /// <c>{id}{ext}</c> written by this service, never anything an uploader chose,
    /// so this cannot be walked out of the directory.
    /// </summary>
    public static string StoredPath(string root, string storedName) =>
        Path.Combine(root, storedName);

    /// <summary>Remove stored files best-effort. Used by the book-delete cascade.</summary>
    public static void DeleteFiles(string root, IEnumerable<string> storedNames)
    {
        foreach (var name in storedNames)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            try
            {
                File.Delete(StoredPath(root, name));
            }
            catch (IOException)
            {
                // A file that will not go is a leak, not a failed delete: the row
                // is already gone and the caller has nothing useful to do about it.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }

    private string StoredPath(string storedName) => StoredPath(storage.AttachmentsRoot, storedName);

    private void DeleteFile(string storedName) => DeleteFiles(storage.AttachmentsRoot, [storedName]);

    /// <summary>Write the upload and return the bytes actually stored.</summary>
    private async Task<long> WriteFileAsync(
        string storedName, AttachmentUpload upload, CancellationToken ct)
    {
        Directory.CreateDirectory(storage.AttachmentsRoot);
        var path = StoredPath(storedName);
        await using (var file = File.Create(path))
        {
            await upload.Content.CopyToAsync(file, ct);
        }

        var written = new FileInfo(path).Length;
        // A stream can outrun its declared length (chunked bodies declare none),
        // so the cap is enforced again against what actually landed.
        if (written > MaxAttachmentBytes)
        {
            DeleteFile(storedName);
            throw new InvalidAttachmentException(SizeMessage);
        }
        if (written == 0)
        {
            DeleteFile(storedName);
            throw new InvalidAttachmentException("The uploaded file is empty.");
        }
        return written;
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    private static string SizeMessage =>
        $"File exceeds the maximum size of {MaxAttachmentBytes / (1024 * 1024)} MB.";

    /// <summary>
    /// Decide the extension the file is stored under, rejecting anything not on
    /// the allow-list. The extension — not the browser's content type — is what
    /// gates the upload: content types are trivially spoofed and often just
    /// <c>application/octet-stream</c>.
    /// </summary>
    private static string ValidateAndResolveExtension(AttachmentUpload upload)
    {
        if (upload.Length > MaxAttachmentBytes)
            throw new InvalidAttachmentException(SizeMessage);

        var ext = Path.GetExtension(upload.FileName ?? "");
        if (string.IsNullOrWhiteSpace(ext) || !AllowedTypes.ContainsKey(ext))
        {
            throw new InvalidAttachmentException(
                "Unsupported file type. Accepted: " +
                string.Join(", ", AllowedExtensions.Select(e => e.TrimStart('.').ToUpperInvariant())) + ".");
        }
        return ext.ToLowerInvariant();
    }

    /// <summary>
    /// Prefer the type the extension declares. Browsers routinely send
    /// <c>application/octet-stream</c> for .docx and nothing at all for less
    /// common formats, and the extension is already the thing that was validated.
    /// </summary>
    private static string ResolveContentType(string? uploaded, string ext)
    {
        if (AllowedTypes.TryGetValue(ext, out var known)) return known;
        var trimmed = (uploaded ?? "").Trim();
        return trimmed.Length == 0 || trimmed.Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase)
            ? "application/octet-stream"
            : trimmed;
    }

    /// <summary>
    /// The name a download is served as: the last path segment, stripped of
    /// characters no filesystem wants and carrying the stored extension. Nothing
    /// on disk is named from this — it only ever reaches a Content-Disposition
    /// header — but a browser saving it should still get a sane file.
    /// </summary>
    private static string SafeFileName(string? raw, string ext)
    {
        var name = Path.GetFileName((raw ?? "").Trim().Replace('\\', '/'));
        name = string.Join("_", name.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries));
        if (string.IsNullOrWhiteSpace(name)) name = "file" + ext;
        if (!name.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) name += ext;
        return name.Length > 200 ? name[^200..] : name;
    }

    // -------------------------------------------------------------------------
    // Rows
    // -------------------------------------------------------------------------

    private static string DownloadUrl(string id) => $"/api/attachments/{id}/download";

    private static void Bind(SqliteCommand cmd, Attachment row)
    {
        SqliteHelpers.Add(cmd, "$id", row.Id);
        SqliteHelpers.Add(cmd, "$book_id", row.BookId);
        SqliteHelpers.Add(cmd, "$title", row.Title);
        SqliteHelpers.Add(cmd, "$description", row.Description);
        SqliteHelpers.Add(cmd, "$file_name", row.FileName);
        SqliteHelpers.Add(cmd, "$stored_name", row.StoredName);
        SqliteHelpers.Add(cmd, "$content_type", row.ContentType);
        SqliteHelpers.Add(cmd, "$size_bytes", row.SizeBytes);
        SqliteHelpers.Add(cmd, "$owner_id", row.OwnerId);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(row.UpdatedAt));
    }

    private static async Task<(Attachment Row, string? OwnerName)?> SelectAsync(
        SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"{Select} WHERE a.id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return Read(reader);
    }

    private static (Attachment Row, string? OwnerName) Read(SqliteDataReader reader) => (
        new Attachment
        {
            Id = reader.GetString(0),
            BookId = reader.GetString(1),
            Title = reader.GetString(2),
            Description = SqliteHelpers.GetNullableString(reader, 3),
            FileName = reader.GetString(4),
            StoredName = reader.GetString(5),
            ContentType = reader.GetString(6),
            SizeBytes = reader.GetInt64(7),
            OwnerId = SqliteHelpers.GetNullableString(reader, 8),
            CreatedAt = SqliteHelpers.ReadTimestamp(reader, 9),
            UpdatedAt = SqliteHelpers.ReadTimestamp(reader, 10),
        },
        SqliteHelpers.GetNullableString(reader, 11));

    /// <summary>
    /// Resolve the owner's display name after a write, so the DTO carries the
    /// same field a read would. Null owner needs no query.
    /// </summary>
    private static async Task<string?> OwnerNameAsync(
        SqliteConnection conn, string? ownerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(ownerId)) return null;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT COALESCE(NULLIF(TRIM(display_name), ''), username)
            FROM app_user WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", ownerId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    private static AttachmentDto ToDto(Attachment a, string? ownerName) => new(
        Id: a.Id,
        BookId: a.BookId,
        Title: a.Title,
        Description: a.Description,
        FileName: a.FileName,
        ContentType: a.ContentType,
        SizeBytes: a.SizeBytes,
        OwnerId: a.OwnerId,
        OwnerName: ownerName,
        DownloadUrl: DownloadUrl(a.Id),
        CreatedAt: a.CreatedAt,
        UpdatedAt: a.UpdatedAt);
}
