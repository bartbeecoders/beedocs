using System.IO.Compression;
using System.Text;
using System.Xml;

namespace BeeDocs.Api.Services;

/// <summary>
/// Pulls searchable plain text out of an uploaded document.
///
/// This is what makes an attachment findable by what it <em>says</em> rather
/// than only by what someone called it. Every format is best-effort and every
/// failure is silent: a corrupt .docx, an encrypted PDF or a format nobody
/// taught this class about all reduce to "no text", never to a failed index
/// write. Metadata (title, description, file name) is indexed separately and
/// always, so a file that yields nothing here is still findable.
///
/// Formats fall into three groups:
/// <list type="bullet">
/// <item>Plain text and XML — read directly.</item>
/// <item>Zip-based documents (OOXML, OpenDocument) — <see cref="ZipArchive"/> plus
/// an <see cref="XmlReader"/> over the one part that holds the words. No
/// dependency needed; both are in the BCL.</item>
/// <item>PDF — PdfPig, the one thing here that cannot be done without a parser.</item>
/// </list>
/// </summary>
public static class AttachmentTextExtractor
{
    /// <summary>
    /// Files past this are indexed by metadata alone.
    ///
    /// Extraction happens on the search-index drain, which runs before a search:
    /// spending a minute parsing a 90 MB scanned PDF there would make the whole
    /// library feel broken to whoever happened to hit Ctrl+K.
    /// </summary>
    public const long MaxExtractBytes = 32L * 1024 * 1024;

    /// <summary>
    /// Cap on the text kept per document. Long enough for a real specification,
    /// short enough that one 500-page manual cannot dominate the FTS index or
    /// the SQLite file it lives in.
    /// </summary>
    public const int MaxExtractedChars = 256 * 1024;

    /// <summary>Extensions read straight off disk as UTF-8.</summary>
    private static readonly HashSet<string> PlainTextExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".log" };

    /// <summary>Extensions whose bytes are XML: index the text nodes, not the markup.</summary>
    private static readonly HashSet<string> XmlExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".xml", ".svg" };

    /// <summary>
    /// Extract what text there is. Never throws.
    /// </summary>
    /// <param name="path">Absolute path to the stored file.</param>
    /// <param name="fileName">Original name — its extension decides the strategy.</param>
    /// <param name="sizeBytes">Stored size, checked against <see cref="MaxExtractBytes"/>.</param>
    public static string Extract(string path, string fileName, long sizeBytes, CancellationToken ct = default)
    {
        if (sizeBytes > MaxExtractBytes || !File.Exists(path)) return "";

        var ext = Path.GetExtension(fileName);
        try
        {
            var text = ext.ToLowerInvariant() switch
            {
                var e when PlainTextExtensions.Contains(e) => ReadAllText(path),
                var e when XmlExtensions.Contains(e) => FromXmlFile(path),
                ".docx" or ".pptx" or ".xlsx" => FromOoxml(path, ext, ct),
                ".odt" or ".ods" or ".odp" => FromOpenDocument(path),
                ".rtf" => FromRtf(ReadAllText(path)),
                ".pdf" => FromPdf(path, ct),
                // An archive's *contents* are out of reach, but the names inside
                // it are exactly how someone looks for "the zip with the
                // firmware in it".
                ".zip" => FromZipEntryNames(path),
                _ => "",
            };
            return Truncate(Normalize(text));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Malformed, encrypted, truncated, or simply not what its extension
            // claims. The document is still indexed by its metadata.
            return "";
        }
    }

    /// <summary>Whether this extension is one the extractor knows how to read.</summary>
    public static bool CanExtract(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return PlainTextExtensions.Contains(ext)
            || XmlExtensions.Contains(ext)
            || ext is ".docx" or ".pptx" or ".xlsx" or ".odt" or ".ods" or ".odp"
                or ".rtf" or ".pdf" or ".zip";
    }

    // -------------------------------------------------------------------------
    // PDF
    // -------------------------------------------------------------------------

    /// <summary>
    /// Page text via PdfPig. A PDF has no text layer at all when it is a scan,
    /// which is not an error — it simply has nothing to index, and OCR is a
    /// different feature with much heavier dependencies.
    ///
    /// Words, not <c>page.Text</c>: that property concatenates the page's text
    /// runs with nothing between them, so a heading and the line under it come
    /// back as "SpecificationRevision" — one token, which FTS will never match
    /// on either word. PdfPig knows where the word boundaries are; joining its
    /// words with spaces is what makes the page searchable rather than merely
    /// extracted.
    /// </summary>
    private static string FromPdf(string path, CancellationToken ct)
    {
        using var document = UglyToad.PdfPig.PdfDocument.Open(path);
        var sb = new StringBuilder();
        foreach (var page in document.GetPages())
        {
            ct.ThrowIfCancellationRequested();
            if (sb.Length > MaxExtractedChars) break;
            Append(sb, string.Join(' ', page.GetWords().Select(w => w.Text)));
        }
        return sb.ToString();
    }

    // -------------------------------------------------------------------------
    // Zip-based office documents
    // -------------------------------------------------------------------------

    /// <summary>
    /// Word, PowerPoint and Excel are zips of XML. Which parts hold the words
    /// differs; how the words sit inside them does not — everything visible is
    /// in a <c>&lt;t&gt;</c> element, whatever the namespace prefix.
    /// </summary>
    private static string FromOoxml(string path, string ext, CancellationToken ct)
    {
        using var zip = ZipFile.OpenRead(path);
        var sb = new StringBuilder();

        foreach (var entry in OoxmlParts(zip, ext))
        {
            ct.ThrowIfCancellationRequested();
            if (sb.Length > MaxExtractedChars) break;
            using var stream = entry.Open();
            Append(sb, ReadXml(stream, textElementsOnly: true));
        }

        return sb.ToString();
    }

    /// <summary>The parts of an OOXML package that carry readable text, in reading order.</summary>
    private static IEnumerable<ZipArchiveEntry> OoxmlParts(ZipArchive zip, string ext)
    {
        bool Is(ZipArchiveEntry e, string prefix, string suffix = ".xml") =>
            e.FullName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && e.FullName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);

        switch (ext.ToLowerInvariant())
        {
            case ".docx":
                // Body first, then the running text most documents put their
                // document number and classification in.
                foreach (var e in zip.Entries.Where(e => Is(e, "word/document")))
                    yield return e;
                foreach (var e in zip.Entries.Where(e => Is(e, "word/header") || Is(e, "word/footer")))
                    yield return e;
                foreach (var e in zip.Entries.Where(e => Is(e, "word/footnotes") || Is(e, "word/endnotes")))
                    yield return e;
                break;

            case ".pptx":
                // Numbered, so slide10 must not sort between slide1 and slide2 —
                // a deck indexed out of order still matches, but its snippets
                // would quote the wrong part of the talk.
                foreach (var e in zip.Entries
                             .Where(e => Is(e, "ppt/slides/slide"))
                             .OrderBy(e => TrailingNumber(e.FullName)))
                    yield return e;
                foreach (var e in zip.Entries
                             .Where(e => Is(e, "ppt/notesSlides/notesSlide"))
                             .OrderBy(e => TrailingNumber(e.FullName)))
                    yield return e;
                break;

            case ".xlsx":
                // Nearly every text cell in a workbook is a pointer into this
                // one table; the sheets themselves mostly hold numbers.
                foreach (var e in zip.Entries.Where(e => Is(e, "xl/sharedStrings")))
                    yield return e;
                foreach (var e in zip.Entries
                             .Where(e => Is(e, "xl/worksheets/sheet"))
                             .OrderBy(e => TrailingNumber(e.FullName)))
                    yield return e;
                break;
        }
    }

    /// <summary>OpenDocument keeps the whole body in one part.</summary>
    private static string FromOpenDocument(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var content = zip.GetEntry("content.xml");
        if (content is null) return "";
        using var stream = content.Open();
        // No <t> wrapper here: ODF puts text directly inside text:p / text:span.
        return ReadXml(stream, textElementsOnly: false);
    }

    private static string FromZipEntryNames(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var sb = new StringBuilder();
        foreach (var entry in zip.Entries)
        {
            if (sb.Length > MaxExtractedChars) break;
            if (entry.FullName.EndsWith('/')) continue;
            Append(sb, entry.FullName);
        }
        return sb.ToString();
    }

    /// <summary>Order numbered parts (slide2.xml before slide10.xml) numerically.</summary>
    private static int TrailingNumber(string name)
    {
        var file = Path.GetFileNameWithoutExtension(name);
        var digits = file.Length;
        while (digits > 0 && char.IsAsciiDigit(file[digits - 1])) digits--;
        return digits < file.Length && int.TryParse(file[digits..], out var n) ? n : 0;
    }

    // -------------------------------------------------------------------------
    // XML
    // -------------------------------------------------------------------------

    private static string FromXmlFile(string path)
    {
        using var stream = File.OpenRead(path);
        return ReadXml(stream, textElementsOnly: false);
    }

    /// <summary>
    /// Text out of an XML stream, one line per paragraph.
    /// </summary>
    /// <param name="textElementsOnly">
    /// True for OOXML, where only <c>&lt;t&gt;</c> holds words and taking every
    /// text node would sweep in style ids and relationship targets. False for
    /// ODF and loose XML, where the words are the text nodes.
    /// </param>
    private static string ReadXml(Stream stream, bool textElementsOnly)
    {
        var settings = new XmlReaderSettings
        {
            IgnoreComments = true,
            IgnoreProcessingInstructions = true,
            IgnoreWhitespace = false,
            // A document is data, not a source of instructions: never resolve an
            // external entity it names.
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
            CloseInput = false,
        };

        using var reader = XmlReader.Create(stream, settings);
        var sb = new StringBuilder();
        var line = new StringBuilder();
        var inText = !textElementsOnly;

        void FlushLine()
        {
            if (line.Length == 0) return;
            Append(sb, line.ToString());
            line.Clear();
        }

        while (reader.Read())
        {
            if (sb.Length > MaxExtractedChars) break;

            switch (reader.NodeType)
            {
                case XmlNodeType.Element:
                    if (textElementsOnly && reader.LocalName == "t") inText = true;
                    // Word puts explicit breaks and tabs between runs; without
                    // these, "Total:" and "42" would be indexed as "Total:42".
                    if (reader.LocalName is "br" or "tab" or "cr") line.Append(' ');
                    if (reader.LocalName == "p" && reader.IsEmptyElement) FlushLine();
                    break;

                case XmlNodeType.Text:
                case XmlNodeType.CDATA:
                case XmlNodeType.SignificantWhitespace:
                    if (inText) line.Append(reader.Value);
                    break;

                case XmlNodeType.EndElement:
                    if (textElementsOnly && reader.LocalName == "t") inText = false;
                    // Paragraphs, table cells and shared-string items are all
                    // line boundaries in the text this produces.
                    if (reader.LocalName is "p" or "si" or "tc") FlushLine();
                    break;
            }
        }

        FlushLine();
        return sb.ToString();
    }

    // -------------------------------------------------------------------------
    // RTF
    // -------------------------------------------------------------------------

    /// <summary>
    /// Strip RTF down to its words: drop control words, brace groups and the
    /// binary blobs embedded objects leave behind. Not a parser — good enough to
    /// find a sentence in a document someone saved out of an old editor.
    /// </summary>
    private static string FromRtf(string rtf)
    {
        var sb = new StringBuilder();
        var i = 0;
        // Nesting depth of groups introduced by \*\something — those hold
        // metadata (fonts, colours, stylesheets), never body text.
        var skipDepth = 0;
        var depth = 0;

        while (i < rtf.Length)
        {
            var c = rtf[i];
            if (c == '{')
            {
                depth++;
                i++;
            }
            else if (c == '}')
            {
                if (skipDepth > 0 && depth <= skipDepth) skipDepth = 0;
                depth--;
                i++;
            }
            else if (c == '\\')
            {
                i++;
                if (i >= rtf.Length) break;

                if (rtf[i] == '*')
                {
                    skipDepth = depth;
                    i++;
                    continue;
                }

                // Escaped literal: \\ \{ \}
                if (rtf[i] is '\\' or '{' or '}')
                {
                    if (skipDepth == 0) sb.Append(rtf[i]);
                    i++;
                    continue;
                }

                var start = i;
                while (i < rtf.Length && char.IsAsciiLetter(rtf[i])) i++;
                var word = rtf[start..i];
                while (i < rtf.Length && (rtf[i] == '-' || char.IsAsciiDigit(rtf[i]))) i++;
                if (i < rtf.Length && rtf[i] == ' ') i++;

                if (word is "par" or "line" or "cell" or "row" or "sect")
                    sb.Append('\n');
                else if (word is "tab")
                    sb.Append(' ');
                else if (word is "fonttbl" or "colortbl" or "stylesheet" or "info" or "pict")
                    skipDepth = depth;
            }
            else
            {
                if (skipDepth == 0) sb.Append(c);
                i++;
            }
        }

        return sb.ToString();
    }

    // -------------------------------------------------------------------------
    // Shared
    // -------------------------------------------------------------------------

    /// <summary>Read as UTF-8, tolerating a BOM and stray invalid bytes.</summary>
    private static string ReadAllText(string path)
    {
        using var stream = File.OpenRead(path);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var buffer = new char[MaxExtractedChars];
        var read = reader.ReadBlock(buffer, 0, buffer.Length);
        return new string(buffer, 0, read);
    }

    private static void Append(StringBuilder sb, string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (sb.Length > 0) sb.Append('\n');
        sb.Append(text);
    }

    /// <summary>Collapse blank lines and trailing whitespace, as page text is.</summary>
    private static string Normalize(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var sb = new StringBuilder(text.Length);
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            if (sb.Length > 0) sb.Append('\n');
            sb.Append(trimmed);
        }
        return sb.ToString();
    }

    private static string Truncate(string text) =>
        text.Length <= MaxExtractedChars ? text : text[..MaxExtractedChars];
}
