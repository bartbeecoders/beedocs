using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

public interface IImportService
{
    /// <summary>Describe what a file contains without writing anything.</summary>
    Task<ImportPreviewDto> InspectAsync(Stream file, string fileName, CancellationToken ct = default);

    /// <summary>
    /// Import a file. When <paramref name="targetBookId"/> is null a book is
    /// created; otherwise pages/diagrams are added to that book.
    /// </summary>
    Task<ImportResultDto> ImportAsync(
        Stream file,
        string fileName,
        ImportNameMode mode,
        string? targetBookId,
        string? titleOverride,
        CancellationToken ct = default);
}

public sealed partial class ImportService(
    IDocumentService documents,
    IDiagramService diagrams,
    IShapeCollectionService collections,
    StorageOptions storage
) : IImportService
{
    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    };

    [GeneratedRegex(@"^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?", RegexOptions.Multiline)]
    private static partial Regex FrontMatterRegex();

    [GeneratedRegex(@"^```beediagram-ref[ \t]*\r?\n([\s\S]*?)^```", RegexOptions.Multiline | RegexOptions.IgnoreCase)]
    private static partial Regex DiagramRefRegex();

    // --- Parsing (shared by inspect and import) ---

    /// <summary>A file normalised into the archive shape, whatever it arrived as.</summary>
    private sealed record ParsedImport(
        string Source,
        ArchiveManifest Manifest,
        Dictionary<string, byte[]> Assets,
        List<string> Warnings);

    private static ParsedImport Parse(Stream file, string fileName)
    {
        var warnings = new List<string>();
        var extension = Path.GetExtension(fileName).ToLowerInvariant();

        if (extension is ".md" or ".markdown" or ".txt")
        {
            using var reader = new StreamReader(file, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            var text = reader.ReadToEnd();
            var manifest = ManifestFromMarkdown(
                [(Path.GetFileNameWithoutExtension(fileName), text)],
                Path.GetFileNameWithoutExtension(fileName),
                warnings);
            return new ParsedImport("markdown", manifest, [], warnings);
        }

        // Everything else must be a zip (.beedocs or .zip).
        using var seekable = ToSeekable(file);
        ZipArchive zip;
        try
        {
            zip = new ZipArchive(seekable, ZipArchiveMode.Read, leaveOpen: true);
        }
        catch (InvalidDataException)
        {
            throw new InvalidImportException(
                "Unrecognised file. Expected a BeeDocs archive (.beedocs), a zip of Markdown files, or a single .md file.");
        }

        using (zip)
        {
            var manifestEntry = zip.Entries.FirstOrDefault(e =>
                e.FullName.Equals("beedocs.json", StringComparison.OrdinalIgnoreCase));

            if (manifestEntry is not null)
                return ParseArchive(zip, manifestEntry, warnings);

            return ParseMarkdownZip(zip, fileName, warnings);
        }
    }

    private static ParsedImport ParseArchive(ZipArchive zip, ZipArchiveEntry manifestEntry, List<string> warnings)
    {
        ArchiveManifest? manifest;
        using (var stream = manifestEntry.Open())
        {
            try
            {
                manifest = JsonSerializer.Deserialize<ArchiveManifest>(stream, ArchiveManifest.JsonOptions);
            }
            catch (JsonException e)
            {
                throw new InvalidImportException($"The archive manifest is not valid JSON: {e.Message}");
            }
        }

        if (manifest is null)
            throw new InvalidImportException("The archive manifest is empty.");

        if (manifest.FormatVersion > ArchiveManifest.CurrentFormatVersion)
        {
            warnings.Add(
                $"Archive was written by a newer BeeDocs (format {manifest.FormatVersion}, this build reads " +
                $"{ArchiveManifest.CurrentFormatVersion}). Unknown fields were ignored.");
        }

        var assets = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var asset in manifest.Assets)
        {
            var entry = zip.Entries.FirstOrDefault(e => e.FullName.Equals(asset.Path, StringComparison.OrdinalIgnoreCase));
            if (entry is null)
            {
                warnings.Add($"Image '{asset.Path}' listed in the manifest is missing from the archive.");
                continue;
            }
            assets[asset.Url] = ReadEntry(entry);
        }

        return new ParsedImport("archive", manifest, assets, warnings);
    }

    private static ParsedImport ParseMarkdownZip(ZipArchive zip, string fileName, List<string> warnings)
    {
        var files = new List<(string Path, string Text)>();
        var assets = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/') || entry.Length == 0) continue;

            var ext = Path.GetExtension(entry.FullName).ToLowerInvariant();
            if (ext is ".md" or ".markdown")
            {
                // README.md is the generated index, not a page.
                if (Path.GetFileName(entry.FullName).Equals("README.md", StringComparison.OrdinalIgnoreCase))
                    continue;
                using var reader = new StreamReader(entry.Open(), Encoding.UTF8, true);
                files.Add((entry.FullName, reader.ReadToEnd()));
            }
            else if (ImageExtensions.Contains(ext))
            {
                assets[$"/uploads/{Path.GetFileName(entry.FullName)}"] = ReadEntry(entry);
            }
        }

        if (files.Count == 0)
            throw new InvalidImportException("No Markdown files found in the zip.");

        var bookTitle = Path.GetFileNameWithoutExtension(fileName);
        if (bookTitle.EndsWith("-markdown", StringComparison.OrdinalIgnoreCase))
            bookTitle = bookTitle[..^"-markdown".Length];

        var manifest = ManifestFromMarkdown(files, bookTitle, warnings);
        return new ParsedImport("markdown-zip", manifest, assets, warnings);
    }

    /// <summary>Turn loose Markdown files into a manifest, using front matter when present.</summary>
    private static ArchiveManifest ManifestFromMarkdown(
        IReadOnlyList<(string Path, string Text)> files,
        string bookTitle,
        List<string> warnings)
    {
        var manifest = new ArchiveManifest
        {
            Kind = files.Count == 1 ? "page" : "book",
            Book = new ArchiveBook { Title = Humanize(bookTitle) },
        };

        var chapterRefs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        for (var i = 0; i < files.Count; i++)
        {
            var (path, text) = files[i];
            var (frontMatter, body) = SplitFrontMatter(text);

            var title = frontMatter.GetValueOrDefault("title")
                ?? FirstHeading(body)
                ?? Humanize(Path.GetFileNameWithoutExtension(path));

            // Our own export writes the title as front matter *and* as a leading
            // H1; drop the duplicate so re-imported pages do not show it twice.
            body = StripLeadingHeading(body, title);

            var folder = frontMatter.GetValueOrDefault("folder");
            if (folder is null)
            {
                var dir = Path.GetDirectoryName(path)?.Replace('\\', '/').Trim('/');
                if (!string.IsNullOrWhiteSpace(dir) && !dir.Equals("assets", StringComparison.OrdinalIgnoreCase))
                    folder = Humanize(dir.Split('/')[^1]);
            }

            string? chapterRef = null;
            if (!string.IsNullOrWhiteSpace(folder))
            {
                if (!chapterRefs.TryGetValue(folder, out var existing))
                {
                    existing = $"ch{chapterRefs.Count + 1}";
                    chapterRefs[folder] = existing;
                    manifest.Chapters.Add(new ArchiveChapter
                    {
                        Ref = existing,
                        Title = folder,
                        SortOrder = chapterRefs.Count,
                    });
                }
                chapterRef = existing;
            }

            var sortOrder = int.TryParse(frontMatter.GetValueOrDefault("sortOrder"), out var parsed) ? parsed : i;

            manifest.Pages.Add(new ArchivePage
            {
                Ref = $"p{i + 1}",
                ChapterRef = chapterRef,
                Title = title,
                Content = body.TrimStart('\n'),
                SortOrder = sortOrder,
            });
        }

        if (manifest.Pages.Any(p => DiagramRefRegex().IsMatch(p.Content)))
        {
            warnings.Add(
                "Some pages reference stored diagrams (beediagram-ref). Markdown files do not carry them — " +
                "those blocks will show as missing. Use a .beedocs archive to move diagrams.");
        }

        return manifest;
    }

    private static (Dictionary<string, string> FrontMatter, string Body) SplitFrontMatter(string text)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var normalized = text.Replace("\r\n", "\n");
        if (!normalized.StartsWith("---\n", StringComparison.Ordinal))
            return (map, normalized);

        var match = FrontMatterRegex().Match(normalized);
        if (!match.Success || match.Index != 0) return (map, normalized);

        foreach (var line in match.Groups[1].Value.Split('\n'))
        {
            var idx = line.IndexOf(':');
            if (idx <= 0) continue;
            var key = line[..idx].Trim();
            var value = line[(idx + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
                value = value[1..^1].Replace("\\\"", "\"").Replace("\\\\", "\\");
            map[key] = value;
        }

        return (map, normalized[match.Length..]);
    }

    private static string? FirstHeading(string body)
    {
        foreach (var line in body.Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("# ", StringComparison.Ordinal))
                return trimmed[2..].Trim();
            if (trimmed.Length > 0) return null;
        }
        return null;
    }

    private static string StripLeadingHeading(string body, string title)
    {
        var lines = body.Replace("\r\n", "\n").Split('\n').ToList();
        var i = 0;
        while (i < lines.Count && lines[i].Trim().Length == 0) i++;
        if (i < lines.Count)
        {
            var trimmed = lines[i].Trim();
            if (trimmed.StartsWith("# ", StringComparison.Ordinal)
                && trimmed[2..].Trim().Equals(title.Trim(), StringComparison.Ordinal))
            {
                lines.RemoveRange(0, i + 1);
                return string.Join('\n', lines).TrimStart('\n');
            }
        }
        return body;
    }

    private static string Humanize(string value)
    {
        var cleaned = value.Replace('-', ' ').Replace('_', ' ').Trim();
        if (cleaned.Length == 0) return "Imported";
        return char.ToUpperInvariant(cleaned[0]) + cleaned[1..];
    }

    // --- Inspect ---

    public async Task<ImportPreviewDto> InspectAsync(Stream file, string fileName, CancellationToken ct = default)
    {
        var parsed = Parse(file, fileName);
        var books = await documents.ListBooksAsync(ct);

        var title = parsed.Manifest.Book.Title;
        var exists = books.Any(b => b.Title.Equals(title, StringComparison.OrdinalIgnoreCase));

        return new ImportPreviewDto(
            Source: parsed.Source,
            Kind: parsed.Manifest.Kind,
            BookTitle: title,
            ChapterCount: parsed.Manifest.Chapters.Count,
            PageCount: parsed.Manifest.Pages.Count,
            DiagramCount: parsed.Manifest.Diagrams.Count,
            CollectionCount: parsed.Manifest.Collections.Count,
            AssetCount: parsed.Assets.Count,
            PageTitles: [.. parsed.Manifest.Pages.Select(p => p.Title).Take(50)],
            BookTitleExists: exists,
            SuggestedTitle: exists ? UniqueName(title, books.Select(b => b.Title)) : title,
            Warnings: parsed.Warnings);
    }

    // --- Import ---

    public async Task<ImportResultDto> ImportAsync(
        Stream file,
        string fileName,
        ImportNameMode mode,
        string? targetBookId,
        string? titleOverride,
        CancellationToken ct = default)
    {
        var parsed = Parse(file, fileName);
        var manifest = parsed.Manifest;
        var warnings = new List<string>(parsed.Warnings);

        // 1. Copy images into the uploads store under fresh names and build the
        //    URL rewrite map, so imported content never points at another
        //    instance's files (or collides with ours).
        var assetMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var assetsCreated = 0;
        foreach (var (originalUrl, data) in parsed.Assets)
        {
            var stored = TryStoreUpload(originalUrl, data);
            if (stored is null)
            {
                warnings.Add($"Could not store image '{originalUrl}'.");
                continue;
            }
            assetMap[originalUrl] = stored;
            assetsCreated++;
        }

        // 2. Resolve the target book.
        BookDto? book = null;
        var bookCreated = false;

        if (!string.IsNullOrWhiteSpace(targetBookId))
        {
            book = await documents.GetBookAsync(targetBookId!, ct)
                ?? throw new InvalidImportException($"Target book '{targetBookId}' was not found.");
        }
        else
        {
            var existingBooks = await documents.ListBooksAsync(ct);
            var desired = !string.IsNullOrWhiteSpace(titleOverride)
                ? titleOverride!.Trim()
                : manifest.Book.Title;

            if (mode == ImportNameMode.Rename)
                desired = UniqueName(desired, existingBooks.Select(b => b.Title));

            book = await documents.CreateBookAsync(
                new CreateBookRequest(desired, manifest.Book.Description, null), ct);
            bookCreated = true;
        }

        // 3. Folders. Reuse a folder of the same name when importing into an
        //    existing book, otherwise the tree grows duplicates on every import.
        var existingChapters = await documents.ListChaptersAsync(book.Id, ct);
        var chapterIdByRef = new Dictionary<string, string>(StringComparer.Ordinal);
        var chaptersCreated = 0;

        foreach (var chapter in manifest.Chapters)
        {
            var match = existingChapters.FirstOrDefault(c =>
                c.Title.Equals(chapter.Title, StringComparison.OrdinalIgnoreCase));

            if (match is not null && mode == ImportNameMode.Keep)
            {
                chapterIdByRef[chapter.Ref] = match.Id;
                continue;
            }

            var title = mode == ImportNameMode.Rename && match is not null
                ? UniqueName(chapter.Title, existingChapters.Select(c => c.Title))
                : chapter.Title;

            var created = await documents.CreateChapterAsync(
                book.Id, new CreateChapterRequest(title, null, chapter.SortOrder), ct);
            chapterIdByRef[chapter.Ref] = created.Id;
            chaptersCreated++;
            existingChapters = await documents.ListChaptersAsync(book.Id, ct);
        }

        // 4. Diagrams first (without a page link) so page content can be
        //    rewritten to the new ids before the pages are written.
        var diagramIdByOriginal = new Dictionary<string, string>(StringComparer.Ordinal);
        var createdDiagrams = new List<(string NewId, string? PageRef)>();
        var diagramsCreated = 0;

        foreach (var diagram in manifest.Diagrams)
        {
            var source = RewriteAssets(diagram.Source, assetMap);
            var created = await diagrams.CreateAsync(
                book.Id,
                new CreateDiagramRequest(diagram.Title, diagram.Kind, source, null),
                ct);
            if (!string.IsNullOrWhiteSpace(diagram.OriginalId))
                diagramIdByOriginal[diagram.OriginalId!] = created.Id;
            createdDiagrams.Add((created.Id, diagram.PageRef));
            diagramsCreated++;
        }

        // 5. Pages.
        var existingPages = await documents.ListPagesAsync(book.Id, ct);
        var takenTitles = existingPages.Select(p => p.Title).ToList();
        var pageIdByRef = new Dictionary<string, string>(StringComparer.Ordinal);
        var imported = new List<ImportedPageDto>();

        foreach (var page in manifest.Pages)
        {
            var title = page.Title;
            if (mode == ImportNameMode.Rename
                && takenTitles.Any(t => t.Equals(title, StringComparison.OrdinalIgnoreCase)))
            {
                title = UniqueName(title, takenTitles);
            }
            takenTitles.Add(title);

            var content = RewriteAssets(page.Content, assetMap);
            content = RewriteDiagramRefs(content, diagramIdByOriginal, warnings);

            string? chapterId = null;
            if (page.ChapterRef is not null && chapterIdByRef.TryGetValue(page.ChapterRef, out var mapped))
                chapterId = mapped;

            var created = await documents.CreatePageAsync(
                book.Id,
                new CreatePageRequest(title, null, content, chapterId, page.SortOrder),
                ct);

            pageIdByRef[page.Ref] = created.Id;
            imported.Add(new ImportedPageDto(created.Id, created.Title, created.Slug));
        }

        // 6. Attach diagrams to their pages now that page ids exist.
        foreach (var (diagramId, pageRef) in createdDiagrams)
        {
            if (pageRef is null || !pageIdByRef.TryGetValue(pageRef, out var pageId)) continue;
            var current = await diagrams.GetAsync(diagramId, ct);
            if (current is null) continue;
            await diagrams.UpdateAsync(
                diagramId,
                new UpdateDiagramRequest(current.Title, current.Kind, current.Source, pageId),
                ct);
        }

        // 7. Book-scoped studio shape collections.
        var collectionsCreated = 0;
        foreach (var collection in manifest.Collections)
        {
            var source = RewriteAssets(collection.Source, assetMap);
            await collections.CreateAsync(
                book.Id,
                new CreateShapeCollectionRequest(collection.Name, collection.Description, source),
                ct);
            collectionsCreated++;
        }

        return new ImportResultDto(
            Kind: manifest.Kind,
            BookId: book.Id,
            BookTitle: book.Title,
            BookCreated: bookCreated,
            ChaptersCreated: chaptersCreated,
            PagesCreated: imported.Count,
            DiagramsCreated: diagramsCreated,
            CollectionsCreated: collectionsCreated,
            AssetsCreated: assetsCreated,
            Warnings: warnings,
            Pages: imported);
    }

    // --- Rewriting ---

    private static string RewriteAssets(string content, Dictionary<string, string> assetMap)
    {
        if (string.IsNullOrEmpty(content) || assetMap.Count == 0) return content ?? string.Empty;
        var result = content;
        foreach (var (oldUrl, newUrl) in assetMap)
            result = result.Replace(oldUrl, newUrl, StringComparison.OrdinalIgnoreCase);
        return result;
    }

    private static string RewriteDiagramRefs(
        string content,
        Dictionary<string, string> diagramIdByOriginal,
        List<string> warnings)
    {
        if (string.IsNullOrEmpty(content)) return content ?? string.Empty;

        return DiagramRefRegex().Replace(content, match =>
        {
            var body = match.Groups[1].Value;
            var id = body.Trim().Split('\n')[0].Trim();
            if (id.Length == 0) return match.Value;

            if (diagramIdByOriginal.TryGetValue(id, out var newId))
                return match.Value.Replace(id, newId, StringComparison.Ordinal);

            warnings.Add($"Diagram reference '{id}' had no matching diagram in the file; the block will show as missing.");
            return match.Value;
        });
    }

    // --- Uploads ---

    private string? TryStoreUpload(string originalUrl, byte[] data)
    {
        var ext = Path.GetExtension(originalUrl).ToLowerInvariant();
        if (!ImageExtensions.Contains(ext)) return null;

        try
        {
            Directory.CreateDirectory(storage.UploadsRoot);
            var name = Guid.NewGuid().ToString("N")[..16] + ext;
            File.WriteAllBytes(Path.Combine(storage.UploadsRoot, name), data);
            return $"/uploads/{name}";
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    // --- Naming ---

    /// <summary>"Handbook" → "Handbook (2)" until it is free.</summary>
    private static string UniqueName(string desired, IEnumerable<string> taken)
    {
        var set = taken.ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!set.Contains(desired)) return desired;

        // Strip an existing "(n)" suffix so repeats do not stack up.
        var stem = Regex.Replace(desired, @"\s*\(\d+\)$", string.Empty);
        for (var i = 2; i < 1000; i++)
        {
            var candidate = $"{stem} ({i})";
            if (!set.Contains(candidate)) return candidate;
        }
        return $"{stem} ({Guid.NewGuid().ToString("N")[..6]})";
    }

    // --- Stream helpers ---

    private static Stream ToSeekable(Stream input)
    {
        if (input.CanSeek)
        {
            input.Position = 0;
            return input;
        }
        var buffer = new MemoryStream();
        input.CopyTo(buffer);
        buffer.Position = 0;
        return buffer;
    }

    private static byte[] ReadEntry(ZipArchiveEntry entry)
    {
        using var stream = entry.Open();
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }
}

/// <summary>The uploaded file could not be understood — surfaced to the user as a 400.</summary>
public sealed class InvalidImportException(string message) : Exception(message);
