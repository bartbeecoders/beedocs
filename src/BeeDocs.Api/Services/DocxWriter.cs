using System.Globalization;
using System.IO.Compression;
using System.Security;
using System.Text;

namespace BeeDocs.Api.Services;

/// <summary>An image the writer managed to load and can embed.</summary>
/// <param name="Data">Raw file bytes.</param>
/// <param name="Extension">Lowercase extension without the dot ("png", "jpeg", "gif").</param>
public sealed record DocxImage(byte[] Data, string Extension, int PixelWidth, int PixelHeight);

/// <summary>
/// Writes a WordprocessingML (.docx) package by hand.
///
/// A .docx is a zip of XML parts, and the subset needed for documentation
/// output — headings, paragraphs, lists, tables, code blocks, hyperlinks and
/// inline images — is small enough that hand-writing it avoids taking a
/// dependency on the OpenXML SDK (whose current release also drags in a
/// System.IO.Packaging version flagged by NuGet audit).
///
/// Deliberate limitations, documented in Docs/EXPORT-IMPORT.md:
///   • Mermaid/BeeDiagram fences become captioned code blocks — rasterising
///     them needs a browser, which the API does not have.
///   • SVG images cannot be embedded in a .docx; they are linked instead.
/// </summary>
public sealed class DocxWriter(Func<string, DocxImage?>? imageResolver = null)
{
    private const int EmuPerInch = 914400;
    private const int ContentWidthEmu = (int)(6.2 * EmuPerInch);

    private readonly StringBuilder _body = new();
    private readonly List<(string Id, string Target, bool External, string Type)> _rels = [];
    private readonly List<(string Name, byte[] Data)> _media = [];
    private readonly HashSet<string> _mediaExtensions = [];

    /// <summary>
    /// One entry per <c>w:num</c> instance; the index + 1 is its numId. Every
    /// ordered list needs its own instance with a start override, otherwise all
    /// numbered lists in the document share a counter and the second list
    /// continues where the first stopped.
    /// </summary>
    private readonly List<(int AbstractId, bool RestartAtOne)> _numbering = [];
    private int _bulletNumId;

    private int _relSeed = 3; // rId1 = styles, rId2 = numbering
    private int _drawingId = 1;

    private string NextRelId() => $"rId{_relSeed++}";

    private int BulletNumId()
    {
        if (_bulletNumId == 0)
        {
            _numbering.Add((0, false));
            _bulletNumId = _numbering.Count;
        }
        return _bulletNumId;
    }

    private int NewOrderedNumId()
    {
        _numbering.Add((1, true));
        return _numbering.Count;
    }

    // --- Public composition API ---

    public void AddTitlePage(string title, string? subtitle, IEnumerable<string> metaLines)
    {
        _body.Append(Paragraph(Run(title, bold: true, sizeHalfPoints: 56), style: null, jc: "center", spacingBefore: 2400, spacingAfter: 240));
        if (!string.IsNullOrWhiteSpace(subtitle))
            _body.Append(Paragraph(Run(subtitle!, sizeHalfPoints: 24, color: "444444"), style: null, jc: "center", spacingAfter: 120));
        foreach (var line in metaLines)
            _body.Append(Paragraph(Run(line, sizeHalfPoints: 18, color: "777777"), style: null, jc: "center"));
        AddPageBreak();
    }

    public void AddPageBreak()
    {
        _body.Append("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
    }

    public void AddHeading(string text, int level)
    {
        var clamped = Math.Clamp(level, 1, 6);
        _body.Append(Paragraph(Run(Esc(text), raw: true), style: $"Heading{clamped}"));
    }

    /// <summary>Table of contents as a plain list (Word cannot auto-populate a field without a rebuild).</summary>
    public void AddContentsList(IReadOnlyList<string> entries)
    {
        if (entries.Count == 0) return;
        AddHeading("Contents", 1);
        var numId = NewOrderedNumId();
        foreach (var entry in entries)
            _body.Append(Paragraph(Run(Esc(entry), raw: true), style: null, numId: numId, indentLevel: 0));
        AddPageBreak();
    }

    /// <summary>Render parsed Markdown blocks into the document body.</summary>
    public void AddBlocks(IEnumerable<MarkdownDoc.Block> blocks)
    {
        foreach (var block in blocks)
        {
            switch (block)
            {
                case MarkdownDoc.HeadingBlock h:
                    // Page titles occupy H1, so nudge in-content headings down a level.
                    _body.Append(Paragraph(InlineRuns(h.Inlines), style: $"Heading{Math.Clamp(h.Level + 1, 1, 6)}"));
                    break;

                case MarkdownDoc.ParagraphBlock p:
                    _body.Append(Paragraph(InlineRuns(p.Inlines), spacingAfter: 120));
                    break;

                case MarkdownDoc.QuoteBlock q:
                    _body.Append(Paragraph(
                        InlineRuns(q.Inlines, color: "444444", italic: true),
                        indentTwips: 360,
                        leftBorder: true,
                        spacingAfter: 120));
                    break;

                case MarkdownDoc.ListBlock l:
                {
                    // Allocated per list so each numbered list restarts at 1.
                    var numId = l.Ordered ? NewOrderedNumId() : BulletNumId();
                    foreach (var item in l.Items)
                        _body.Append(Paragraph(
                            InlineRuns(item.Inlines),
                            numId: numId,
                            indentLevel: item.Depth));
                    break;
                }

                case MarkdownDoc.CodeBlock c:
                    AddCodeBlock(c);
                    break;

                case MarkdownDoc.TableBlock t:
                    AddTable(t);
                    break;

                case MarkdownDoc.RuleBlock:
                    _body.Append("<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"CCCCCC\"/></w:pBdr></w:pPr></w:p>");
                    break;
            }
        }
    }

    private void AddCodeBlock(MarkdownDoc.CodeBlock code)
    {
        var caption = code.Language switch
        {
            "mermaid" => "Mermaid diagram (source)",
            "c4" => "C4 diagram (source)",
            "plantuml" => "PlantUML diagram (source)",
            "beediagram" => "BeeDiagram (source)",
            "beediagram-ref" => "BeeDiagram reference",
            _ => null,
        };

        if (caption is not null)
            _body.Append(Paragraph(Run(Esc(caption), italic: true, sizeHalfPoints: 18, color: "666666", raw: true), spacingBefore: 120));

        var lines = code.Text.Replace("\r\n", "\n").Split('\n');
        var runs = new StringBuilder();
        for (var i = 0; i < lines.Length; i++)
        {
            if (i > 0) runs.Append("<w:r><w:br/></w:r>");
            runs.Append(Run(Esc(lines[i]), mono: true, sizeHalfPoints: 18, raw: true));
        }

        _body.Append(Paragraph(
            runs.ToString(),
            shading: "F4F4F5",
            allBorders: true,
            indentTwips: 60,
            spacingBefore: 60,
            spacingAfter: 180));
    }

    private void AddTable(MarkdownDoc.TableBlock table)
    {
        var columns = Math.Max(table.Header.Count, table.Rows.Count > 0 ? table.Rows.Max(r => r.Count) : 0);
        if (columns == 0) return;

        var sb = new StringBuilder();
        sb.Append("<w:tbl><w:tblPr><w:tblW w:w=\"5000\" w:type=\"pct\"/><w:tblBorders>");
        foreach (var edge in new[] { "top", "left", "bottom", "right", "insideH", "insideV" })
            sb.Append(CultureInfo.InvariantCulture, $"<w:{edge} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BBBBBB\"/>");
        sb.Append("</w:tblBorders><w:tblCellMar>");
        sb.Append("<w:top w:w=\"60\" w:type=\"dxa\"/><w:left w:w=\"90\" w:type=\"dxa\"/>");
        sb.Append("<w:bottom w:w=\"60\" w:type=\"dxa\"/><w:right w:w=\"90\" w:type=\"dxa\"/>");
        sb.Append("</w:tblCellMar></w:tblPr><w:tblGrid>");
        for (var i = 0; i < columns; i++) sb.Append("<w:gridCol/>");
        sb.Append("</w:tblGrid>");

        sb.Append("<w:tr>");
        for (var i = 0; i < columns; i++)
        {
            var cell = i < table.Header.Count ? table.Header[i] : [];
            sb.Append("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F4F4F5\"/></w:tcPr>");
            sb.Append(Paragraph(InlineRuns(cell, bold: true), spacingAfter: 0));
            sb.Append("</w:tc>");
        }
        sb.Append("</w:tr>");

        foreach (var row in table.Rows)
        {
            sb.Append("<w:tr>");
            for (var i = 0; i < columns; i++)
            {
                var cell = i < row.Count ? row[i] : [];
                sb.Append("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/></w:tcPr>");
                sb.Append(Paragraph(InlineRuns(cell), spacingAfter: 0));
                sb.Append("</w:tc>");
            }
            sb.Append("</w:tr>");
        }

        sb.Append("</w:tbl>");
        // Word requires a block-level element after a table.
        sb.Append("<w:p><w:pPr><w:spacing w:after=\"120\"/></w:pPr></w:p>");
        _body.Append(sb);
    }

    // --- Inline rendering ---

    private string InlineRuns(
        IReadOnlyList<MarkdownDoc.Inline> inlines,
        bool bold = false,
        bool italic = false,
        string? color = null)
    {
        var sb = new StringBuilder();
        foreach (var inline in inlines)
        {
            switch (inline)
            {
                case MarkdownDoc.TextRun t when t.Text.Length > 0:
                    sb.Append(Run(
                        Esc(t.Text),
                        bold: bold || t.Bold,
                        italic: italic || t.Italic,
                        mono: t.Code,
                        strike: t.Strike,
                        shading: t.Code ? "F0F0F1" : null,
                        color: color,
                        raw: true));
                    break;

                case MarkdownDoc.LinkRun link:
                    sb.Append(Hyperlink(link));
                    break;

                case MarkdownDoc.ImageRun image:
                    sb.Append(Image(image));
                    break;
            }
        }
        return sb.Length == 0 ? Run(string.Empty, raw: true) : sb.ToString();
    }

    private string Hyperlink(MarkdownDoc.LinkRun link)
    {
        var text = Esc(string.IsNullOrWhiteSpace(link.Text) ? link.Url : link.Text);
        if (string.IsNullOrWhiteSpace(link.Url) || link.Url.StartsWith('#'))
            return Run(text, raw: true);

        var relId = NextRelId();
        _rels.Add((relId, link.Url, true, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"));
        return $"<w:hyperlink r:id=\"{relId}\">{Run(text, color: "1155CC", underline: true, raw: true)}</w:hyperlink>";
    }

    private string Image(MarkdownDoc.ImageRun image)
    {
        var resolved = imageResolver?.Invoke(image.Url);
        if (resolved is null)
        {
            // SVG, remote, or missing: fall back to a labelled link so nothing is silently lost.
            var label = string.IsNullOrWhiteSpace(image.Alt) ? image.Url : $"{image.Alt} ({image.Url})";
            return Run($"[image: {Esc(label)}]", italic: true, color: "666666", raw: true);
        }

        var name = $"image{_media.Count + 1}.{resolved.Extension}";
        _media.Add((name, resolved.Data));
        _mediaExtensions.Add(resolved.Extension);

        var relId = NextRelId();
        _rels.Add((relId, $"media/{name}", false, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"));

        var (cx, cy) = ScaleToContent(resolved.PixelWidth, resolved.PixelHeight);
        var id = _drawingId++;
        var alt = Esc(string.IsNullOrWhiteSpace(image.Alt) ? name : image.Alt);

        return $"""
            <w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
            <wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:docPr id="{id}" name="Picture {id}" descr="{alt}"/>
            <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr><pic:cNvPr id="{id}" name="{Esc(name)}" descr="{alt}"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="{relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
            """.Replace("\n", string.Empty);
    }

    private static (int Cx, int Cy) ScaleToContent(int pixelWidth, int pixelHeight)
    {
        var w = pixelWidth > 0 ? pixelWidth : 800;
        var h = pixelHeight > 0 ? pixelHeight : 600;
        // Assume 96 DPI, then clamp to the text column width, preserving aspect.
        var cx = (long)w * EmuPerInch / 96;
        var cy = (long)h * EmuPerInch / 96;
        if (cx > ContentWidthEmu)
        {
            cy = cy * ContentWidthEmu / cx;
            cx = ContentWidthEmu;
        }
        return ((int)Math.Max(cx, 1), (int)Math.Max(cy, 1));
    }

    // --- Low-level XML helpers ---

    private static string Run(
        string text,
        bool bold = false,
        bool italic = false,
        bool mono = false,
        bool strike = false,
        bool underline = false,
        int? sizeHalfPoints = null,
        string? color = null,
        string? shading = null,
        bool raw = false)
    {
        var props = new StringBuilder();
        if (mono) props.Append("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\" w:cs=\"Consolas\"/>");
        if (bold) props.Append("<w:b/>");
        if (italic) props.Append("<w:i/>");
        if (strike) props.Append("<w:strike/>");
        if (underline) props.Append("<w:u w:val=\"single\"/>");
        if (color is not null) props.Append(CultureInfo.InvariantCulture, $"<w:color w:val=\"{color}\"/>");
        if (sizeHalfPoints is int sz)
            props.Append(CultureInfo.InvariantCulture, $"<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/>");
        if (shading is not null)
            props.Append(CultureInfo.InvariantCulture, $"<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{shading}\"/>");

        var rPr = props.Length > 0 ? $"<w:rPr>{props}</w:rPr>" : string.Empty;
        var body = raw ? text : Esc(text);
        return $"<w:r>{rPr}<w:t xml:space=\"preserve\">{body}</w:t></w:r>";
    }

    private static string Paragraph(
        string runs,
        string? style = null,
        string? jc = null,
        int? numId = null,
        int indentLevel = 0,
        int indentTwips = 0,
        string? shading = null,
        bool allBorders = false,
        bool leftBorder = false,
        int spacingBefore = 0,
        int spacingAfter = 60)
    {
        var props = new StringBuilder();
        if (style is not null) props.Append(CultureInfo.InvariantCulture, $"<w:pStyle w:val=\"{style}\"/>");
        if (numId is int n)
            props.Append(CultureInfo.InvariantCulture, $"<w:numPr><w:ilvl w:val=\"{indentLevel}\"/><w:numId w:val=\"{n}\"/></w:numPr>");
        if (shading is not null)
            props.Append(CultureInfo.InvariantCulture, $"<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{shading}\"/>");
        if (allBorders)
        {
            props.Append("<w:pBdr>");
            foreach (var edge in new[] { "top", "left", "bottom", "right" })
                props.Append(CultureInfo.InvariantCulture, $"<w:{edge} w:val=\"single\" w:sz=\"4\" w:space=\"4\" w:color=\"E4E4E7\"/>");
            props.Append("</w:pBdr>");
        }
        else if (leftBorder)
        {
            props.Append("<w:pBdr><w:left w:val=\"single\" w:sz=\"18\" w:space=\"8\" w:color=\"C9920A\"/></w:pBdr>");
        }
        if (indentTwips > 0)
            props.Append(CultureInfo.InvariantCulture, $"<w:ind w:left=\"{indentTwips}\"/>");
        if (spacingBefore > 0 || spacingAfter > 0)
            props.Append(CultureInfo.InvariantCulture, $"<w:spacing w:before=\"{spacingBefore}\" w:after=\"{spacingAfter}\"/>");
        if (jc is not null) props.Append(CultureInfo.InvariantCulture, $"<w:jc w:val=\"{jc}\"/>");

        var pPr = props.Length > 0 ? $"<w:pPr>{props}</w:pPr>" : string.Empty;
        return $"<w:p>{pPr}{runs}</w:p>";
    }

    private static string Esc(string s) => SecurityElement.Escape(s) ?? string.Empty;

    // --- Packaging ---

    public byte[] Build()
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteEntry(zip, "[Content_Types].xml", ContentTypesXml());
            WriteEntry(zip, "_rels/.rels", RootRelsXml());
            WriteEntry(zip, "word/document.xml", DocumentXml());
            WriteEntry(zip, "word/styles.xml", StylesXml());
            WriteEntry(zip, "word/numbering.xml", NumberingXml());
            WriteEntry(zip, "word/_rels/document.xml.rels", DocumentRelsXml());

            foreach (var (name, data) in _media)
            {
                var entry = zip.CreateEntry($"word/media/{name}", CompressionLevel.Optimal);
                using var stream = entry.Open();
                stream.Write(data, 0, data.Length);
            }
        }
        return buffer.ToArray();
    }

    private static void WriteEntry(ZipArchive zip, string path, string content)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Optimal);
        using var stream = entry.Open();
        var bytes = new UTF8Encoding(false).GetBytes(content);
        stream.Write(bytes, 0, bytes.Length);
    }

    private string ContentTypesXml()
    {
        var defaults = new StringBuilder();
        defaults.Append("<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
        defaults.Append("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
        foreach (var ext in _mediaExtensions)
        {
            var mime = ext switch
            {
                "png" => "image/png",
                "jpeg" or "jpg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "application/octet-stream",
            };
            defaults.Append(CultureInfo.InvariantCulture, $"<Default Extension=\"{ext}\" ContentType=\"{mime}\"/>");
        }

        return $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{defaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>
            """;
    }

    private static string RootRelsXml() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>
        """;

    private string DocumentRelsXml()
    {
        var sb = new StringBuilder();
        sb.Append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""");
        sb.Append("""<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>""");
        sb.Append("""<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>""");
        foreach (var (id, target, external, type) in _rels)
        {
            var mode = external ? " TargetMode=\"External\"" : string.Empty;
            sb.Append(CultureInfo.InvariantCulture, $"<Relationship Id=\"{id}\" Type=\"{type}\" Target=\"{Esc(target)}\"{mode}/>");
        }
        sb.Append("</Relationships>");
        return sb.ToString();
    }

    private string DocumentXml() => $"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{_body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>
        """;

    private static string StylesXml()
    {
        var headings = new StringBuilder();
        var sizes = new[] { 40, 32, 28, 24, 22, 20 };
        for (var i = 1; i <= 6; i++)
        {
            headings.Append(CultureInfo.InvariantCulture, $"""
                <w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="{i - 1}"/><w:spacing w:before="{Math.Max(320 - (i * 30), 120)}" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="{sizes[i - 1]}"/><w:szCs w:val="{sizes[i - 1]}"/><w:color w:val="1A1A1A"/></w:rPr></w:style>
                """);
        }

        return $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>{headings}</w:styles>
            """;
    }

    private const int NumberingLevels = 5;

    private string NumberingXml()
    {
        // Always emit at least one instance: Word rejects a numbering part with
        // no w:num, and the body may legitimately contain no lists.
        if (_numbering.Count == 0) _numbering.Add((0, false));

        var bulletGlyphs = new[] { "•", "◦", "▪", "•", "◦" };
        var orderedFormats = new[] { "decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter" };

        var sb = new StringBuilder();
        sb.Append("""<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">""");

        // abstractNum 0 — bullets. No Symbol rFonts: the glyphs above are real
        // Unicode characters, and tagging them as Symbol makes Word map them
        // through the Symbol code page and render the wrong glyph.
        sb.Append("""<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>""");
        for (var lvl = 0; lvl < NumberingLevels; lvl++)
        {
            sb.Append(CultureInfo.InvariantCulture, $"""
                <w:lvl w:ilvl="{lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{bulletGlyphs[lvl]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + (lvl * 360)}" w:hanging="360"/></w:pPr></w:lvl>
                """);
        }
        sb.Append("</w:abstractNum>");

        // abstractNum 1 — ordered.
        sb.Append("""<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>""");
        for (var lvl = 0; lvl < NumberingLevels; lvl++)
        {
            sb.Append(CultureInfo.InvariantCulture, $"""
                <w:lvl w:ilvl="{lvl}"><w:start w:val="1"/><w:numFmt w:val="{orderedFormats[lvl]}"/><w:lvlText w:val="%{lvl + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + (lvl * 360)}" w:hanging="360"/></w:pPr></w:lvl>
                """);
        }
        sb.Append("</w:abstractNum>");

        for (var i = 0; i < _numbering.Count; i++)
        {
            var (abstractId, restart) = _numbering[i];
            sb.Append(CultureInfo.InvariantCulture, $"<w:num w:numId=\"{i + 1}\"><w:abstractNumId w:val=\"{abstractId}\"/>");
            if (restart)
            {
                for (var lvl = 0; lvl < NumberingLevels; lvl++)
                    sb.Append(CultureInfo.InvariantCulture,
                        $"<w:lvlOverride w:ilvl=\"{lvl}\"><w:startOverride w:val=\"1\"/></w:lvlOverride>");
            }
            sb.Append("</w:num>");
        }

        sb.Append("</w:numbering>");
        return sb.ToString();
    }
}
