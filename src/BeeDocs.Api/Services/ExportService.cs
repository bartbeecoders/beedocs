using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

public enum ExportFormat
{
    /// <summary>Lossless BeeDocs zip that <see cref="IImportService"/> can read back.</summary>
    Archive,
    /// <summary>Markdown: a zip mirroring the book structure, or a single .md for one page.</summary>
    Markdown,
    /// <summary>Word document.</summary>
    Docx,
}

public sealed record ExportPayload(byte[] Content, string ContentType, string FileName);

public interface IExportService
{
    Task<ExportPayload?> ExportBookAsync(string bookId, ExportFormat format, CancellationToken ct = default);
    Task<ExportPayload?> ExportPageAsync(string pageId, ExportFormat format, CancellationToken ct = default);
}

public sealed partial class ExportService(
    IDocumentService documents,
    IDiagramService diagrams,
    IShapeCollectionService collections,
    StorageOptions storage
) : IExportService
{
    private const string ZipContentType = "application/zip";
    private const string DocxContentType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    /// <summary>Matches upload URLs anywhere in page Markdown or BeeDiagram JSON.</summary>
    [GeneratedRegex(@"/uploads/([A-Za-z0-9][A-Za-z0-9._-]*)", RegexOptions.IgnoreCase)]
    private static partial Regex UploadUrlRegex();

    // --- Book ---

    public async Task<ExportPayload?> ExportBookAsync(string bookId, ExportFormat format, CancellationToken ct = default)
    {
        var bundle = await LoadBookAsync(bookId, ct);
        if (bundle is null) return null;

        var name = SlugHelper.Slugify(bundle.Book.Title) is { Length: > 0 } s ? s : "book";

        return format switch
        {
            ExportFormat.Archive => new ExportPayload(BuildArchive(bundle, "book"), ZipContentType, $"{name}.beedocs"),
            ExportFormat.Markdown => new ExportPayload(BuildMarkdownZip(bundle), ZipContentType, $"{name}-markdown.zip"),
            ExportFormat.Docx => new ExportPayload(BuildBookDocx(bundle), DocxContentType, $"{name}.docx"),
            _ => null,
        };
    }

    // --- Single page ---

    public async Task<ExportPayload?> ExportPageAsync(string pageId, ExportFormat format, CancellationToken ct = default)
    {
        var page = await documents.GetPageAsync(pageId, ct);
        if (page is null) return null;

        var book = await documents.GetBookAsync(page.BookId, ct);
        if (book is null) return null;

        var chapters = await documents.ListChaptersAsync(page.BookId, ct);
        var chapter = page.ChapterId is null
            ? null
            : chapters.FirstOrDefault(c => c.Id == page.ChapterId);

        var pageDiagrams = new List<DiagramDto>();
        foreach (var summary in await diagrams.ListByPageAsync(pageId, ct))
        {
            var full = await diagrams.GetAsync(summary.Id, ct);
            if (full is not null) pageDiagrams.Add(full);
        }
        // beediagram-ref fences can point at book-level diagrams that are not
        // attached to this page; pull those in too so the export stands alone.
        foreach (var refId in ReferencedDiagramIds(page.Content))
        {
            if (pageDiagrams.Any(d => d.Id == refId)) continue;
            var full = await diagrams.GetAsync(refId, ct);
            if (full is not null) pageDiagrams.Add(full);
        }

        // Page exports don't carry book-level shape collections.
        var bundle = new BookBundle(
            book,
            chapter is null ? [] : [chapter],
            [page],
            pageDiagrams,
            []);

        var name = SlugHelper.Slugify(page.Title) is { Length: > 0 } s ? s : "document";

        return format switch
        {
            ExportFormat.Archive => new ExportPayload(BuildArchive(bundle, "page"), ZipContentType, $"{name}.beedocs"),
            ExportFormat.Markdown => new ExportPayload(
                Encoding.UTF8.GetBytes(PageMarkdown(page, chapter?.Title)),
                "text/markdown; charset=utf-8",
                $"{name}.md"),
            ExportFormat.Docx => new ExportPayload(BuildPageDocx(page, book), DocxContentType, $"{name}.docx"),
            _ => null,
        };
    }

    // --- Loading ---

    private sealed record BookBundle(
        BookDto Book,
        IReadOnlyList<ChapterDto> Chapters,
        IReadOnlyList<PageDto> Pages,
        IReadOnlyList<DiagramDto> Diagrams,
        IReadOnlyList<ShapeCollectionDto> Collections);

    private async Task<BookBundle?> LoadBookAsync(string bookId, CancellationToken ct)
    {
        var book = await documents.GetBookAsync(bookId, ct);
        if (book is null) return null;

        var chapters = await documents.ListChaptersAsync(bookId, ct);
        var summaries = await documents.ListPagesAsync(bookId, ct);

        var pages = new List<PageDto>();
        foreach (var summary in summaries)
        {
            var page = await documents.GetPageAsync(summary.Id, ct);
            if (page is not null) pages.Add(page);
        }

        var diagramList = new List<DiagramDto>();
        foreach (var summary in await diagrams.ListByBookAsync(bookId, ct))
        {
            var full = await diagrams.GetAsync(summary.Id, ct);
            if (full is not null) diagramList.Add(full);
        }

        var collectionList = (await collections.ListByBookAsync(bookId, ct)).ToList();

        return new BookBundle(book, chapters, pages, diagramList, collectionList);
    }

    private static IEnumerable<string> ReferencedDiagramIds(string content)
    {
        foreach (Match m in Regex.Matches(
            content ?? string.Empty,
            @"^```beediagram-ref[ \t]*\n([\s\S]*?)^```",
            RegexOptions.Multiline | RegexOptions.IgnoreCase))
        {
            var id = m.Groups[1].Value.Trim().Split('\n')[0].Trim();
            if (id.Length > 0) yield return id;
        }
    }

    // --- Assets ---

    /// <summary>Upload file names referenced by any page content or diagram source.</summary>
    private static List<string> CollectAssetNames(BookBundle bundle)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var page in bundle.Pages)
            foreach (Match m in UploadUrlRegex().Matches(page.Content ?? string.Empty))
                names.Add(m.Groups[1].Value);
        foreach (var diagram in bundle.Diagrams)
            foreach (Match m in UploadUrlRegex().Matches(diagram.Source ?? string.Empty))
                names.Add(m.Groups[1].Value);
        foreach (var collection in bundle.Collections)
            foreach (Match m in UploadUrlRegex().Matches(collection.Source ?? string.Empty))
                names.Add(m.Groups[1].Value);
        return [.. names];
    }

    private byte[]? TryReadUpload(string fileName)
    {
        // Defend against traversal: only a bare file name inside the uploads root.
        var safe = Path.GetFileName(fileName);
        if (string.IsNullOrWhiteSpace(safe)) return null;

        var path = Path.Combine(storage.UploadsRoot, safe);
        var full = Path.GetFullPath(path);
        if (!full.StartsWith(Path.GetFullPath(storage.UploadsRoot), StringComparison.Ordinal)) return null;

        return File.Exists(full) ? File.ReadAllBytes(full) : null;
    }

    private DocxImage? ResolveDocxImage(string url)
    {
        var match = UploadUrlRegex().Match(url ?? string.Empty);
        if (!match.Success) return null;

        var name = match.Groups[1].Value;
        var ext = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
        // Word cannot display SVG through the legacy picture part.
        if (ext is "svg" or "") return null;
        if (ext == "jpg") ext = "jpeg";

        var data = TryReadUpload(name);
        if (data is null) return null;

        var size = ImageInfo.TryReadDimensions(data) ?? (800, 600);
        return new DocxImage(data, ext, size.Width, size.Height);
    }

    // --- Archive (round-trippable) ---

    private byte[] BuildArchive(BookBundle bundle, string kind)
    {
        var manifest = new ArchiveManifest
        {
            Kind = kind,
            Generator = "BeeDocs",
            ExportedAt = DateTimeOffset.UtcNow,
            Book = new ArchiveBook
            {
                OriginalId = bundle.Book.Id,
                Title = bundle.Book.Title,
                Description = bundle.Book.Description,
                Slug = bundle.Book.Slug,
                SortOrder = bundle.Book.SortOrder,
            },
        };

        var chapterRefs = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < bundle.Chapters.Count; i++)
        {
            var chapter = bundle.Chapters[i];
            var reference = $"ch{i + 1}";
            chapterRefs[chapter.Id] = reference;
            manifest.Chapters.Add(new ArchiveChapter
            {
                Ref = reference,
                OriginalId = chapter.Id,
                Title = chapter.Title,
                Slug = chapter.Slug,
                SortOrder = chapter.SortOrder,
            });
        }

        var pageRefs = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < bundle.Pages.Count; i++)
        {
            var page = bundle.Pages[i];
            var reference = $"p{i + 1}";
            pageRefs[page.Id] = reference;
            manifest.Pages.Add(new ArchivePage
            {
                Ref = reference,
                OriginalId = page.Id,
                ChapterRef = page.ChapterId is not null && chapterRefs.TryGetValue(page.ChapterId, out var cr) ? cr : null,
                Title = page.Title,
                Slug = page.Slug,
                Content = page.Content,
                SortOrder = page.SortOrder,
            });
        }

        for (var i = 0; i < bundle.Diagrams.Count; i++)
        {
            var diagram = bundle.Diagrams[i];
            manifest.Diagrams.Add(new ArchiveDiagram
            {
                Ref = $"d{i + 1}",
                OriginalId = diagram.Id,
                PageRef = diagram.PageId is not null && pageRefs.TryGetValue(diagram.PageId, out var pr) ? pr : null,
                Title = diagram.Title,
                Kind = diagram.Kind,
                Source = diagram.Source,
            });
        }

        for (var i = 0; i < bundle.Collections.Count; i++)
        {
            var collection = bundle.Collections[i];
            manifest.Collections.Add(new ArchiveShapeCollection
            {
                Ref = $"c{i + 1}",
                OriginalId = collection.Id,
                Name = collection.Name,
                Description = collection.Description,
                Source = collection.Source,
            });
        }

        var assets = new List<(string Path, byte[] Data)>();
        foreach (var name in CollectAssetNames(bundle))
        {
            var data = TryReadUpload(name);
            if (data is null) continue;
            var path = $"assets/{name}";
            assets.Add((path, data));
            manifest.Assets.Add(new ArchiveAsset { Path = path, Url = $"/uploads/{name}" });
        }

        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteText(zip, "beedocs.json", JsonSerializer.Serialize(manifest, ArchiveManifest.JsonOptions));
            WriteText(zip, "README.txt",
                $"""
                BeeDocs export — {bundle.Book.Title}

                This is a BeeDocs portable archive. Import it from the BeeDocs UI
                (Library → Import) or with:

                  curl -F file=@<this-file> -F mode=rename http://<host>/api/import

                Contents: {manifest.Pages.Count} page(s), {manifest.Chapters.Count} folder(s),
                {manifest.Diagrams.Count} diagram(s), {manifest.Collections.Count} shape collection(s),
                {manifest.Assets.Count} image(s).
                Exported {manifest.ExportedAt:u}.
                """);

            foreach (var (path, data) in assets)
                WriteBytes(zip, path, data);
        }
        return buffer.ToArray();
    }

    // --- Markdown ---

    private byte[] BuildMarkdownZip(BookBundle bundle)
    {
        var chaptersById = bundle.Chapters.ToDictionary(c => c.Id, StringComparer.Ordinal);
        var usedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            var index = new StringBuilder();
            index.Append("# ").Append(bundle.Book.Title).Append("\n\n");
            if (!string.IsNullOrWhiteSpace(bundle.Book.Description))
                index.Append(bundle.Book.Description).Append("\n\n");
            index.Append("Exported from BeeDocs on ")
                .Append(DateTimeOffset.UtcNow.ToString("u"))
                .Append(".\n\n## Contents\n\n");

            foreach (var page in bundle.Pages)
            {
                var chapter = page.ChapterId is not null && chaptersById.TryGetValue(page.ChapterId, out var c) ? c : null;
                var folder = chapter is null ? string.Empty : $"{SafeName(chapter.Slug, chapter.Title)}/";
                var path = $"{folder}{SafeName(page.Slug, page.Title)}.md";

                var suffix = 2;
                while (!usedPaths.Add(path))
                    path = $"{folder}{SafeName(page.Slug, page.Title)}-{suffix++}.md";

                WriteText(zip, path, PageMarkdown(page, chapter?.Title));
                index.Append("- [").Append(page.Title).Append("](").Append(path).Append(")\n");
            }

            if (bundle.Pages.Count == 0)
                index.Append("_This book has no pages yet._\n");

            WriteText(zip, "README.md", index.ToString());

            foreach (var diagram in bundle.Diagrams)
            {
                var ext = diagram.Kind switch
                {
                    "mermaid" or "c4" => "mmd",
                    "plantuml" => "puml",
                    _ => "json",
                };
                WriteText(zip, $"diagrams/{SafeName(null, diagram.Title)}.{ext}", diagram.Source);
            }

            foreach (var name in CollectAssetNames(bundle))
            {
                var data = TryReadUpload(name);
                if (data is not null) WriteBytes(zip, $"assets/{name}", data);
            }
        }
        return buffer.ToArray();
    }

    /// <summary>
    /// A page as a standalone Markdown file. The YAML front matter is what the
    /// importer reads back, so a Markdown export round-trips titles and ordering
    /// even though it is not the lossless format.
    /// </summary>
    private static string PageMarkdown(PageDto page, string? chapterTitle)
    {
        var sb = new StringBuilder();
        sb.Append("---\n");
        sb.Append("title: ").Append(YamlScalar(page.Title)).Append('\n');
        sb.Append("slug: ").Append(YamlScalar(page.Slug)).Append('\n');
        if (!string.IsNullOrWhiteSpace(chapterTitle))
            sb.Append("folder: ").Append(YamlScalar(chapterTitle!)).Append('\n');
        sb.Append("sortOrder: ").Append(page.SortOrder).Append('\n');
        sb.Append("updatedAt: ").Append(page.UpdatedAt.ToString("u")).Append('\n');
        sb.Append("exportedBy: BeeDocs\n");
        sb.Append("---\n\n");
        sb.Append("# ").Append(page.Title).Append("\n\n");
        sb.Append(page.Content.Replace("\r\n", "\n").TrimEnd()).Append('\n');
        return sb.ToString();
    }

    private static string YamlScalar(string value)
    {
        var escaped = value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        return $"\"{escaped}\"";
    }

    // --- DOCX ---

    private byte[] BuildBookDocx(BookBundle bundle)
    {
        var writer = new DocxWriter(ResolveDocxImage);
        var chaptersById = bundle.Chapters.ToDictionary(c => c.Id, StringComparer.Ordinal);

        writer.AddTitlePage(
            bundle.Book.Title,
            bundle.Book.Description,
            [
                $"{bundle.Pages.Count} page(s) · {bundle.Chapters.Count} folder(s)",
                $"Exported from BeeDocs on {DateTimeOffset.Now:f}",
            ]);

        writer.AddContentsList([.. bundle.Pages.Select(p => p.Title)]);

        string? currentChapter = null;
        for (var i = 0; i < bundle.Pages.Count; i++)
        {
            var page = bundle.Pages[i];
            var chapter = page.ChapterId is not null && chaptersById.TryGetValue(page.ChapterId, out var c) ? c : null;

            if (chapter?.Title != currentChapter)
            {
                currentChapter = chapter?.Title;
                if (currentChapter is not null)
                {
                    if (i > 0) writer.AddPageBreak();
                    writer.AddHeading(currentChapter, 1);
                }
            }
            else if (i > 0)
            {
                writer.AddPageBreak();
            }

            writer.AddHeading(page.Title, chapter is null ? 1 : 2);
            writer.AddBlocks(MarkdownDoc.Parse(page.Content));
        }

        if (bundle.Pages.Count == 0)
            writer.AddBlocks([new MarkdownDoc.ParagraphBlock(MarkdownDoc.ParseInlines("This book has no pages yet."))]);

        return writer.Build();
    }

    private byte[] BuildPageDocx(PageDto page, BookDto book)
    {
        var writer = new DocxWriter(ResolveDocxImage);
        writer.AddTitlePage(
            page.Title,
            book.Title,
            [$"Exported from BeeDocs on {DateTimeOffset.Now:f}"]);
        writer.AddBlocks(MarkdownDoc.Parse(page.Content));
        return writer.Build();
    }

    // --- Zip helpers ---

    private static void WriteText(ZipArchive zip, string path, string content) =>
        WriteBytes(zip, path, new UTF8Encoding(false).GetBytes(content));

    private static void WriteBytes(ZipArchive zip, string path, byte[] data)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        using var stream = entry.Open();
        stream.Write(data, 0, data.Length);
    }

    private static string SafeName(string? slug, string fallback)
    {
        var candidate = !string.IsNullOrWhiteSpace(slug) ? slug! : SlugHelper.Slugify(fallback);
        candidate = SlugHelper.Slugify(candidate);
        return string.IsNullOrWhiteSpace(candidate) ? "untitled" : candidate;
    }
}
