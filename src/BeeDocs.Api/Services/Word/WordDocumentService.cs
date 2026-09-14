using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services.Word;

public interface IWordDocumentService
{
    /// <summary>The attachment's body as editable HTML. Null when the attachment is unknown or hidden.</summary>
    /// <exception cref="WordDocumentException">Not a .docx, or a broken package.</exception>
    Task<WordDocumentDto?> ReadAsync(string attachmentId, CancellationToken ct = default);

    /// <summary>Write the editor's HTML back into the stored .docx, keeping the attachment's identity.</summary>
    Task<AttachmentDto?> SaveAsync(string attachmentId, SaveWordDocumentRequest request, CancellationToken ct = default);

    /// <summary>An image part from inside the package, for the editor to show.</summary>
    Task<AttachmentDownload?> OpenMediaAsync(string attachmentId, string name, CancellationToken ct = default);

    /// <summary>A new, empty .docx filed against a book.</summary>
    Task<AttachmentDto> CreateBlankAsync(string bookId, string title, CancellationToken ct = default);
}

/// <summary>
/// Opens .docx attachments as editable documents.
///
/// The attachment stays what it is — opaque bytes on disk, one row of metadata —
/// and this service is the one place that looks inside. A read converts the
/// package to HTML (<see cref="DocxReader"/>), a save converts back and hands
/// the new bytes to <see cref="IAttachmentService.ReplaceFileAsync"/>, so the id,
/// title, owner and links to the file all survive every edit exactly as they do
/// for a manual re-upload.
/// </summary>
public sealed class WordDocumentService(IAttachmentService attachments) : IWordDocumentService
{
    public const string DocxContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    private static readonly Dictionary<string, string> MediaTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".bmp"] = "image/bmp",
        [".tif"] = "image/tiff",
        [".tiff"] = "image/tiff",
        [".svg"] = "image/svg+xml",
        [".emf"] = "image/emf",
        [".wmf"] = "image/wmf",
    };

    public static string MediaUrlBase(string attachmentId) => $"/api/attachments/{attachmentId}/word/media/";

    public async Task<WordDocumentDto?> ReadAsync(string attachmentId, CancellationToken ct = default)
    {
        var meta = await attachments.GetAsync(attachmentId, ct);
        if (meta is null) return null;
        using var file = await attachments.OpenAsync(attachmentId, ct);
        if (file is null) return null;
        RequireDocx(file.FileName);

        var result = DocxReader.Read(file.Content, MediaUrlBase(attachmentId));
        return new WordDocumentDto(
            Id: meta.Id,
            BookId: meta.BookId,
            Title: meta.Title,
            FileName: meta.FileName,
            Html: result.Html,
            Css: result.Css,
            Page: result.Page,
            HasHeaderFooter: result.HasHeaderFooter,
            StyleGallery: result.StyleGallery,
            SizeBytes: meta.SizeBytes,
            UpdatedAt: meta.UpdatedAt);
    }

    public async Task<AttachmentDto?> SaveAsync(
        string attachmentId, SaveWordDocumentRequest request, CancellationToken ct = default)
    {
        byte[] rewritten;
        string fileName;
        using (var file = await attachments.OpenAsync(attachmentId, ct))
        {
            if (file is null) return null;
            RequireDocx(file.FileName);
            fileName = file.FileName;
            // The writer needs a seekable stream and the replace below overwrites
            // this very path, so the original is read fully before anything is written.
            using var original = new MemoryStream();
            await file.Content.CopyToAsync(original, ct);
            original.Position = 0;
            rewritten = DocxDocumentWriter.Write(original, request.Html ?? "", request.Page);
        }

        using var upload = new MemoryStream(rewritten);
        return await attachments.ReplaceFileAsync(
            attachmentId,
            new AttachmentUpload(upload, fileName, DocxContentType, rewritten.Length),
            ct);
    }

    public async Task<AttachmentDownload?> OpenMediaAsync(string attachmentId, string name, CancellationToken ct = default)
    {
        // The name came from the reader (a part path relative to word/), but it
        // is also a URL segment anyone can type: keep it inside the package.
        if (string.IsNullOrWhiteSpace(name) || name.Contains("..") || name.StartsWith('/') || name.Contains('\\'))
            return null;
        var ext = Path.GetExtension(name);
        if (!MediaTypes.TryGetValue(ext, out var contentType)) return null;

        using var file = await attachments.OpenAsync(attachmentId, ct);
        if (file is null) return null;
        RequireDocx(file.FileName);

        using var zip = new System.IO.Compression.ZipArchive(file.Content, System.IO.Compression.ZipArchiveMode.Read);
        var main = DocxReader.MainPartName(zip);
        var partDir = main.Contains('/') ? main[..(main.LastIndexOf('/') + 1)] : "";
        var entry = zip.GetEntry(partDir + name) ?? zip.GetEntry(name);
        if (entry is null) return null;

        var buffer = new MemoryStream();
        using (var s = entry.Open())
        {
            await s.CopyToAsync(buffer, ct);
        }
        buffer.Position = 0;
        return new AttachmentDownload(buffer, Path.GetFileName(name), contentType, buffer.Length);
    }

    public async Task<AttachmentDto> CreateBlankAsync(string bookId, string title, CancellationToken ct = default)
    {
        var bytes = DocxDocumentWriter.Blank();
        var clean = string.Join("_", (title ?? "").Trim().Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries));
        if (clean.Length == 0) clean = "Document";
        using var stream = new MemoryStream(bytes);
        return await attachments.CreateAsync(
            bookId,
            new AttachmentUpload(stream, clean + ".docx", DocxContentType, bytes.Length),
            title,
            null,
            ct);
    }

    private static void RequireDocx(string fileName)
    {
        if (!fileName.EndsWith(".docx", StringComparison.OrdinalIgnoreCase))
            throw new WordDocumentException("Only .docx files can be opened in the Word editor.", 415);
    }
}
