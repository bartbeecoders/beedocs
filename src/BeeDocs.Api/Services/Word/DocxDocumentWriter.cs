using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace BeeDocs.Api.Services.Word;

/// <summary>
/// Writes the editor's HTML back into a .docx.
///
/// Only <c>word/document.xml</c> is regenerated. Every other part of the
/// original package — styles, numbering, theme, headers and footers, footnotes,
/// comments, settings, fonts — is copied through unchanged, and the parts that
/// have to grow (relationships for new pictures and links, numbering instances
/// for new lists, style definitions the document lacked) are appended to, never
/// rewritten. That is what makes a save non-destructive: a heading keeps the
/// document's own Heading 1, a table of contents kept as a raw chunk still finds
/// its bookmarks, and the next person opening the file in Word finds the
/// document they left, edited.
///
/// The HTML contract is the one <see cref="DocxReader"/> produces; see
/// Docs/WORD.md.
/// </summary>
public sealed class DocxDocumentWriter
{
    private static readonly XNamespace W = Ns.W;
    private const int EmuPerPx = 9525;

    private static readonly HashSet<string> BlockTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "blockquote", "pre", "hr",
        "section", "article", "header", "footer", "figure", "details", "summary", "dl", "dt", "dd", "address", "main", "nav",
    };

    private sealed record NumberingKind(bool Ordered, string HtmlType);

    // Package state
    private readonly ZipArchive _zip;
    private readonly string _partDir;
    private readonly string _mainName;
    private readonly XDocument _document;
    private readonly XDocument _rels;
    private readonly string _relsName;
    private XDocument? _styles;
    private XDocument? _numbering;
    private readonly XDocument _contentTypes;
    private readonly HashSet<string> _relIds = new(StringComparer.Ordinal);
    private readonly List<(string Name, byte[] Data)> _newMedia = [];
    private readonly HashSet<string> _newMediaExtensions = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _usedStyles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _maxIds = new(StringComparer.Ordinal);
    private int _drawingId;
    private int _relSeed;
    private int _contentWidthEmu;
    private bool _numberingChanged;
    private bool _stylesChanged;
    private bool _numberingCreated;
    private bool _stylesCreated;

    private DocxDocumentWriter(ZipArchive zip)
    {
        _zip = zip;
        _mainName = DocxReader.MainPartName(zip);
        _partDir = _mainName.Contains('/') ? _mainName[..(_mainName.LastIndexOf('/') + 1)] : "";
        var partFile = _mainName[_partDir.Length..];
        _relsName = $"{_partDir}_rels/{partFile}.rels";

        _document = LoadXml(zip.GetEntry(_mainName)) ?? throw new WordDocumentException("The file is not a Word document: no document part.");
        _rels = LoadXml(zip.GetEntry(_relsName)) ?? new XDocument(new XElement(Ns.Rel + "Relationships"));
        _contentTypes = LoadXml(zip.GetEntry("[Content_Types].xml"))
            ?? new XDocument(new XElement(Ns.Ct + "Types"));
        foreach (var r in _rels.Root!.Elements(Ns.Rel + "Relationship"))
        {
            var id = r.Attribute("Id")?.Value;
            if (id is not null) _relIds.Add(id);
        }
        _styles = LoadXml(zip.GetEntry(RelTarget(Ns.RelStyles) ?? $"{_partDir}styles.xml"));
        _numbering = LoadXml(zip.GetEntry(RelTarget(Ns.RelNumbering) ?? $"{_partDir}numbering.xml"));

        _drawingId = _document.Descendants(Ns.Wp + "docPr")
            .Select(d => RunProps.Int(d.Attribute("id")?.Value) ?? 0).DefaultIfEmpty(0).Max() + 1;
    }

    /// <summary>Rewrite <paramref name="original"/> with <paramref name="html"/> as its body. Returns the new package.</summary>
    public static byte[] Write(Stream original, string html, WordPageSetup? page)
    {
        ZipArchive zip;
        try
        {
            zip = new ZipArchive(original, ZipArchiveMode.Read, leaveOpen: true);
        }
        catch (InvalidDataException)
        {
            throw new WordDocumentException("The stored file is not a valid Word document (not a zip package).");
        }
        using (zip)
        {
            var writer = new DocxDocumentWriter(zip);
            return writer.Build(html, page);
        }
    }

    private static XDocument? LoadXml(ZipArchiveEntry? entry)
    {
        if (entry is null) return null;
        try
        {
            using var s = entry.Open();
            return XDocument.Load(s);
        }
        catch (System.Xml.XmlException e)
        {
            throw new WordDocumentException($"Part '{entry.FullName}' is not well-formed XML: {e.Message}");
        }
    }

    private string? RelTarget(string type)
    {
        foreach (var r in _rels.Root!.Elements(Ns.Rel + "Relationship"))
        {
            if (r.Attribute("Type")?.Value != type) continue;
            if (string.Equals(r.Attribute("TargetMode")?.Value, "External", StringComparison.OrdinalIgnoreCase)) continue;
            var target = r.Attribute("Target")?.Value ?? "";
            return ResolvePartPath(target);
        }
        return null;
    }

    private string ResolvePartPath(string target)
    {
        if (target.StartsWith('/')) return target[1..];
        var segments = new List<string>(_partDir.Split('/', StringSplitOptions.RemoveEmptyEntries));
        foreach (var seg in target.Split('/'))
        {
            if (seg == "..") { if (segments.Count > 0) segments.RemoveAt(segments.Count - 1); }
            else if (seg != "." && seg.Length > 0) segments.Add(seg);
        }
        return string.Join('/', segments);
    }

    // ---------------------------------------------------------------------
    // Assembly
    // ---------------------------------------------------------------------

    private byte[] Build(string html, WordPageSetup? page)
    {
        var body = _document.Root?.Element(W + "body") ?? throw new WordDocumentException("The document has no body.");
        var sectPr = BuildSectPr(body.Element(W + "sectPr"), page);
        _contentWidthEmu = ContentWidthEmu(sectPr);

        var tree = HtmlLite.Parse(html);
        var content = new StringBuilder();
        Blocks(tree.Children, content, null);
        if (content.Length == 0 || EndsWithTable(content)) content.Append("<w:p/>");

        EnsureStyles();

        var documentXml = new StringBuilder();
        documentXml.Append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        documentXml.Append(RootStartTag(_document.Root!));
        documentXml.Append("<w:body>").Append(content).Append(sectPr.ToString(SaveOptions.DisableFormatting)).Append("</w:body></w:document>");

        return WritePackage(documentXml.ToString());
    }

    private static bool EndsWithTable(StringBuilder sb)
    {
        const string tail = "</w:tbl>";
        if (sb.Length < tail.Length) return false;
        for (var i = 0; i < tail.Length; i++)
            if (sb[sb.Length - tail.Length + i] != tail[i]) return false;
        return true;
    }

    /// <summary>
    /// The original root element's start tag — every namespace declaration and
    /// attribute (<c>mc:Ignorable</c> and friends) kept, plus declarations for the
    /// prefixes the generated body uses if the file did not already have them.
    /// </summary>
    private static string RootStartTag(XElement root)
    {
        var sb = new StringBuilder("<w:document");
        var declared = new HashSet<string>(StringComparer.Ordinal);
        foreach (var a in root.Attributes())
        {
            if (!a.IsNamespaceDeclaration) continue;
            var prefix = a.Name.LocalName == "xmlns" ? "" : a.Name.LocalName;
            declared.Add(prefix);
            sb.Append(prefix.Length == 0 ? " xmlns=\"" : $" xmlns:{prefix}=\"").Append(Xml.Esc(a.Value)).Append('"');
        }
        var required = new (string Prefix, XNamespace Uri)[]
        {
            ("w", Ns.W), ("r", Ns.R), ("wp", Ns.Wp), ("a", Ns.A), ("pic", Ns.Pic), ("mc", Ns.Mc), ("v", Ns.V),
        };
        foreach (var (prefix, uri) in required)
        {
            if (declared.Contains(prefix)) continue;
            sb.Append($" xmlns:{prefix}=\"{uri.NamespaceName}\"");
        }
        foreach (var a in root.Attributes())
        {
            if (a.IsNamespaceDeclaration) continue;
            var prefix = a.Name.Namespace == XNamespace.None ? null : root.GetPrefixOfNamespace(a.Name.Namespace);
            var name = string.IsNullOrEmpty(prefix) ? a.Name.LocalName : $"{prefix}:{a.Name.LocalName}";
            sb.Append(' ').Append(name).Append("=\"").Append(Xml.Esc(a.Value)).Append('"');
        }
        sb.Append('>');
        return sb.ToString();
    }

    private static XElement BuildSectPr(XElement? original, WordPageSetup? page)
    {
        var sect = original is null
            ? new XElement(W + "sectPr",
                new XElement(W + "pgSz", new XAttribute(W + "w", 11906), new XAttribute(W + "h", 16838)),
                new XElement(W + "pgMar",
                    new XAttribute(W + "top", 1440), new XAttribute(W + "right", 1440),
                    new XAttribute(W + "bottom", 1440), new XAttribute(W + "left", 1440),
                    new XAttribute(W + "header", 709), new XAttribute(W + "footer", 709), new XAttribute(W + "gutter", 0)))
            : new XElement(original);

        if (page is null) return sect;

        var size = sect.Element(W + "pgSz");
        if (size is null)
        {
            size = new XElement(W + "pgSz");
            InsertInOrder(sect, size, ["footnotePr", "endnotePr", "type"]);
        }
        size.SetAttributeValue(W + "w", page.Width);
        size.SetAttributeValue(W + "h", page.Height);
        if (page.Width > page.Height) size.SetAttributeValue(W + "orient", "landscape");
        else size.SetAttributeValue(W + "orient", null);

        var mar = sect.Element(W + "pgMar");
        if (mar is null)
        {
            mar = new XElement(W + "pgMar",
                new XAttribute(W + "header", 709), new XAttribute(W + "footer", 709), new XAttribute(W + "gutter", 0));
            InsertInOrder(sect, mar, ["footnotePr", "endnotePr", "type", "pgSz"]);
        }
        mar.SetAttributeValue(W + "top", page.Top);
        mar.SetAttributeValue(W + "right", page.Right);
        mar.SetAttributeValue(W + "bottom", page.Bottom);
        mar.SetAttributeValue(W + "left", page.Left);
        return sect;
    }

    /// <summary>Place <paramref name="el"/> after the last of <paramref name="predecessors"/> present, keeping schema order.</summary>
    private static void InsertInOrder(XElement parent, XElement el, string[] predecessors)
    {
        XElement? after = null;
        foreach (var name in predecessors)
        {
            var found = parent.Elements(W + name).LastOrDefault();
            if (found is not null) after = found;
        }
        // Header/footer references come first in a sectPr and are not in the list above.
        var lastRef = parent.Elements().LastOrDefault(e => e.Name == W + "headerReference" || e.Name == W + "footerReference");
        if (after is null && lastRef is not null) after = lastRef;
        if (after is null) parent.AddFirst(el);
        else after.AddAfterSelf(el);
    }

    private static int ContentWidthEmu(XElement sectPr)
    {
        var size = sectPr.Element(W + "pgSz");
        var mar = sectPr.Element(W + "pgMar");
        var w = RunProps.Int(size?.Attribute(W + "w")?.Value) ?? 11906;
        var left = RunProps.Int(mar?.Attribute(W + "left")?.Value) ?? 1440;
        var right = RunProps.Int(mar?.Attribute(W + "right")?.Value) ?? 1440;
        return Math.Max(w - left - right, 2000) * 635;
    }

    private int ContentWidthTwips => _contentWidthEmu / 635;

    // ---------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------

    private sealed record ListContext(int NumId, int Level, bool Ordered);

    private void Blocks(List<HtmlNode> nodes, StringBuilder sb, ListContext? list)
    {
        var inline = new List<HtmlNode>();
        foreach (var n in nodes)
        {
            if (!n.IsText && BlockTags.Contains(n.Tag) || (!n.IsText && n.HasAttr("data-docx-raw") && n.Tag == "div"))
            {
                FlushInline(inline, sb, list);
                Block(n, sb, list);
            }
            else inline.Add(n);
        }
        FlushInline(inline, sb, list);
    }

    private void FlushInline(List<HtmlNode> inline, StringBuilder sb, ListContext? list)
    {
        if (inline.Count == 0) return;
        var meaningful = inline.Any(n => n.IsText ? !string.IsNullOrWhiteSpace(n.Text) : n.Tag is not "br");
        if (meaningful)
        {
            var wrapper = new HtmlNode { Tag = "p" };
            wrapper.Children.AddRange(inline);
            Paragraph(wrapper, sb, list);
        }
        inline.Clear();
    }

    private void Block(HtmlNode n, StringBuilder sb, ListContext? list)
    {
        if (n.HasAttr("data-docx-raw"))
        {
            AppendRaw(n.Attr("data-docx-raw"), sb);
            return;
        }
        switch (n.Tag)
        {
            case "p" or "h1" or "h2" or "h3" or "h4" or "h5" or "h6" or "pre" or "blockquote" or "figure" or "dt" or "dd" or "address" or "summary":
                if (n.Children.Any(c => !c.IsText && BlockTags.Contains(c.Tag) && c.Tag is not "hr"))
                    Blocks(n.Children, sb, list);
                else
                    Paragraph(n, sb, list);
                break;
            case "ul" or "ol":
                List(n, sb, list);
                break;
            case "table":
                Table(n, sb);
                break;
            case "hr":
                if (string.Equals(n.Attr("data-break"), "page", StringComparison.OrdinalIgnoreCase))
                    sb.Append("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
                else
                    sb.Append("<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"A0A0A0\"/></w:pBdr></w:pPr></w:p>");
                break;
            case "li":
                Paragraph(n, sb, list);
                break;
            default:
                Blocks(n.Children, sb, list);
                break;
        }
    }

    private void Paragraph(HtmlNode n, StringBuilder sb, ListContext? list, int extraIndentTwips = 0, bool suppressNumbering = false)
    {
        var style = n.Style();
        var pPr = new StringBuilder();

        var styleId = n.Attr("data-style");
        if (styleId.Length == 0)
        {
            styleId = n.Tag switch
            {
                "h1" => "Heading1", "h2" => "Heading2", "h3" => "Heading3",
                "h4" => "Heading4", "h5" => "Heading5", "h6" => "Heading6",
                "blockquote" => "Quote",
                _ => "",
            };
        }
        if (list is not null && !suppressNumbering && styleId.Length == 0) styleId = "ListParagraph";
        if (styleId.Length > 0)
        {
            _usedStyles.Add(styleId);
            pPr.Append(CultureInfo.InvariantCulture, $"<w:pStyle w:val=\"{Xml.Esc(styleId)}\"/>");
        }
        if (string.Equals(n.Attr("data-pagebreak"), "before", StringComparison.OrdinalIgnoreCase))
            pPr.Append("<w:pageBreakBefore/>");
        if (list is not null && !suppressNumbering)
            pPr.Append(CultureInfo.InvariantCulture, $"<w:numPr><w:ilvl w:val=\"{list.Level}\"/><w:numId w:val=\"{list.NumId}\"/></w:numPr>");

        var shading = style.TryGetValue("background-color", out var bg) ? Css.Color(bg) : null;
        if (shading is not null)
            pPr.Append(CultureInfo.InvariantCulture, $"<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{shading}\"/>");

        // Spacing
        var before = style.TryGetValue("margin-top", out var mt) ? Css.Twips(mt) : null;
        var after = style.TryGetValue("margin-bottom", out var mb) ? Css.Twips(mb) : null;
        string? lineAttr = null;
        if (style.TryGetValue("line-height", out var lh))
        {
            var v = lh.Trim();
            if (double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out var unitless))
                lineAttr = $" w:line=\"{(int)Math.Round(unitless * 240)}\" w:lineRule=\"auto\"";
            else if (v.EndsWith('%') && double.TryParse(v[..^1], NumberStyles.Float, CultureInfo.InvariantCulture, out var pct))
                lineAttr = $" w:line=\"{(int)Math.Round(pct / 100 * 240)}\" w:lineRule=\"auto\"";
            else if (Css.Twips(v) is int exact && v != "normal")
                lineAttr = $" w:line=\"{exact}\" w:lineRule=\"exact\"";
        }
        if (before is not null || after is not null || lineAttr is not null)
        {
            pPr.Append("<w:spacing");
            if (before is int b) pPr.Append(CultureInfo.InvariantCulture, $" w:before=\"{Math.Max(b, 0)}\"");
            if (after is int a) pPr.Append(CultureInfo.InvariantCulture, $" w:after=\"{Math.Max(a, 0)}\"");
            if (lineAttr is not null) pPr.Append(lineAttr);
            pPr.Append("/>");
        }

        // Indentation
        var left = (style.TryGetValue("margin-left", out var ml) ? Css.Twips(ml) : null) ?? 0;
        if (n.Tag == "blockquote") left += 720;
        left += extraIndentTwips;
        var right = style.TryGetValue("margin-right", out var mr) ? Css.Twips(mr) : null;
        var firstLine = style.TryGetValue("text-indent", out var ti) ? Css.Twips(ti) : null;
        if (left != 0 || right is not null || firstLine is not null)
        {
            pPr.Append("<w:ind");
            if (left != 0) pPr.Append(CultureInfo.InvariantCulture, $" w:left=\"{left}\"");
            if (right is int r) pPr.Append(CultureInfo.InvariantCulture, $" w:right=\"{r}\"");
            if (firstLine is int f && f > 0) pPr.Append(CultureInfo.InvariantCulture, $" w:firstLine=\"{f}\"");
            else if (firstLine is int h && h < 0) pPr.Append(CultureInfo.InvariantCulture, $" w:hanging=\"{-h}\"");
            pPr.Append("/>");
        }

        if (style.TryGetValue("text-align", out var align))
        {
            var jc = align.Trim().ToLowerInvariant() switch
            {
                "center" => "center",
                "right" or "end" => "right",
                "justify" => "both",
                "left" or "start" => "left",
                _ => null,
            };
            if (jc is not null) pPr.Append(CultureInfo.InvariantCulture, $"<w:jc w:val=\"{jc}\"/>");
        }

        var sect = n.Attr("data-sect");
        if (sect.Length > 0) pPr.Append(Decode(sect));

        var inherited = RunProps.Empty;
        if (n.Tag == "pre") inherited = inherited with { Font = "Consolas" };
        inherited = Css.RunPropsFor(n, inherited);

        var runs = new StringBuilder();
        var children = n.Children;
        // A trailing <br> is the browser's placeholder for "this block ends here", not a line break.
        var end = children.Count;
        while (end > 0 && !children[end - 1].IsText && children[end - 1].Tag == "br") end--;
        Inline(children.Take(end), inherited, runs);

        sb.Append("<w:p>");
        if (pPr.Length > 0) sb.Append("<w:pPr>").Append(pPr).Append("</w:pPr>");
        sb.Append(runs).Append("</w:p>");
    }

    // ---------------------------------------------------------------------
    // Inline
    // ---------------------------------------------------------------------

    private void Inline(IEnumerable<HtmlNode> nodes, RunProps props, StringBuilder sb, string? link = null)
    {
        foreach (var n in nodes)
        {
            if (n.IsText)
            {
                TextRun(n.Text ?? "", props, sb, link);
                continue;
            }
            if (n.HasAttr("data-docx-raw") && n.Tag != "img")
            {
                AppendRaw(n.Attr("data-docx-raw"), sb);
                continue;
            }
            switch (n.Tag)
            {
                case "br":
                    sb.Append("<w:r>").Append(RPr(props, link)).Append("<w:br/></w:r>");
                    break;
                case "img":
                    Image(n, props, sb);
                    break;
                case "a":
                {
                    var href = n.Attr("href").Trim();
                    if (href.Length == 0)
                    {
                        Inline(n.Children, Css.RunPropsFor(n, props), sb, link);
                        break;
                    }
                    var inner = new StringBuilder();
                    Inline(n.Children, Css.RunPropsFor(n, props), inner, "Hyperlink");
                    if (href.StartsWith('#'))
                        sb.Append("<w:hyperlink w:anchor=\"").Append(Xml.Esc(href[1..])).Append("\">").Append(inner).Append("</w:hyperlink>");
                    else
                    {
                        var rid = AddRel(Ns.RelHyperlink, href, external: true);
                        sb.Append("<w:hyperlink r:id=\"").Append(rid).Append("\">").Append(inner).Append("</w:hyperlink>");
                    }
                    _usedStyles.Add("Hyperlink");
                    break;
                }
                case "table" or "ul" or "ol" or "p" or "div" or "h1" or "h2" or "h3" or "h4" or "h5" or "h6" or "li" or "blockquote" or "pre":
                    // Block content where only inline was expected: flatten to text.
                    Inline(n.Children, Css.RunPropsFor(n, props), sb, link);
                    break;
                default:
                    Inline(n.Children, Css.RunPropsFor(n, props), sb, link);
                    break;
            }
        }
    }

    private static string RPr(RunProps props, string? rStyle)
    {
        var xml = props.ToXml();
        if (rStyle is null) return xml;
        var st = $"<w:rStyle w:val=\"{rStyle}\"/>";
        return xml.Length == 0 ? $"<w:rPr>{st}</w:rPr>" : xml.Replace("<w:rPr>", "<w:rPr>" + st);
    }

    private static void TextRun(string text, RunProps props, StringBuilder sb, string? link)
    {
        if (text.Length == 0) return;
        text = text.Replace("\r\n", "\n").Replace('\r', '\n');
        sb.Append("<w:r>").Append(RPr(props, link));
        var buf = new StringBuilder();
        void FlushText()
        {
            if (buf.Length == 0) return;
            sb.Append("<w:t xml:space=\"preserve\">").Append(Xml.Esc(buf.ToString())).Append("</w:t>");
            buf.Clear();
        }
        foreach (var ch in text)
        {
            switch (ch)
            {
                case '\t':
                    FlushText();
                    sb.Append("<w:tab/>");
                    break;
                case '\n':
                    FlushText();
                    sb.Append("<w:br/>");
                    break;
                case ' ':
                    buf.Append(' ');
                    break;
                default:
                    if (ch < ' ' && ch != '\t') break; // control characters are not valid XML
                    buf.Append(ch);
                    break;
            }
        }
        FlushText();
        sb.Append("</w:r>");
    }

    private void Image(HtmlNode img, RunProps props, StringBuilder sb)
    {
        var raw = img.Attr("data-docx-raw");
        if (raw.Length > 0 && !img.HasAttr("data-resized"))
        {
            AppendRaw(raw, sb);
            return;
        }

        var src = img.Attr("src");
        var media = img.Attr("data-media");
        var alt = img.Attr("alt");
        string? relId = null;
        byte[]? bytes = null;

        if (src.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = src.IndexOf(',');
            var header = comma > 0 ? src[5..comma] : "";
            if (comma < 0 || !header.Contains(";base64", StringComparison.OrdinalIgnoreCase)) return;
            try
            {
                bytes = Convert.FromBase64String(src[(comma + 1)..]);
            }
            catch (FormatException)
            {
                return;
            }
            var mime = header.Split(';')[0].Trim().ToLowerInvariant();
            var ext = mime switch
            {
                "image/png" => "png",
                "image/jpeg" or "image/jpg" => "jpeg",
                "image/gif" => "gif",
                "image/webp" => "webp",
                "image/bmp" => "bmp",
                "image/tiff" => "tiff",
                _ => null,
            };
            if (ext is null || bytes.Length == 0) return; // SVG and the like: Word cannot embed them this way
            var name = NextMediaName(ext);
            _newMedia.Add((name, bytes));
            _newMediaExtensions.Add(ext);
            relId = AddRel(Ns.RelImage, $"media/{name}", external: false);
        }
        else if (media.Length > 0)
        {
            var normalized = media.TrimStart('/');
            if (normalized.StartsWith("word/", StringComparison.OrdinalIgnoreCase)) normalized = normalized[5..];
            var entry = _zip.GetEntry(_partDir + normalized);
            if (entry is null) return;
            relId = FindRel(Ns.RelImage, normalized) ?? AddRel(Ns.RelImage, normalized, external: false);
            if (!img.HasAttr("width") || !img.HasAttr("height"))
            {
                using var s = entry.Open();
                using var ms = new MemoryStream();
                s.CopyTo(ms);
                bytes = ms.ToArray();
            }
        }
        else return;

        var w = RunProps.Int(img.Attr("width"));
        var h = RunProps.Int(img.Attr("height"));
        if ((w is null || h is null) && bytes is not null && ImageInfo.TryReadDimensions(bytes) is { } dims)
        {
            if (w is null && h is null) { w = dims.Width; h = dims.Height; }
            else if (w is null) w = (int)Math.Round((double)h!.Value * dims.Width / Math.Max(dims.Height, 1));
            else h = (int)Math.Round((double)w.Value * dims.Height / Math.Max(dims.Width, 1));
        }
        w ??= 400;
        h ??= 300;
        long cx = (long)w.Value * EmuPerPx;
        long cy = (long)h.Value * EmuPerPx;
        if (cx > _contentWidthEmu)
        {
            cy = cy * _contentWidthEmu / cx;
            cx = _contentWidthEmu;
        }
        cx = Math.Max(cx, 1);
        cy = Math.Max(cy, 1);

        var id = _drawingId++;
        var descr = Xml.Esc(alt.Length > 0 ? alt : $"Picture {id}");
        var drawing = string.Create(CultureInfo.InvariantCulture, $"""
            <w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Picture {id}" descr="{descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="Picture {id}" descr="{descr}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>
            """).Trim();
        sb.Append("<w:r>").Append(props.ToXml()).Append(drawing).Append("</w:r>");
    }

    private string NextMediaName(string ext)
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in _zip.Entries)
        {
            if (e.FullName.StartsWith($"{_partDir}media/", StringComparison.OrdinalIgnoreCase))
                taken.Add(e.FullName[(_partDir.Length + 6)..]);
        }
        foreach (var (name, _) in _newMedia) taken.Add(name);
        for (var i = 1; ; i++)
        {
            var candidate = $"image{i}.{ext}";
            if (!taken.Contains(candidate) && !taken.Contains($"image{i}.png") && !taken.Contains($"image{i}.jpeg") && !taken.Contains($"image{i}.jpg"))
                return candidate;
        }
    }

    private static void AppendRaw(string b64, StringBuilder sb)
    {
        var xml = Decode(b64);
        if (xml.Length > 0) sb.Append(xml);
    }

    private static string Decode(string b64)
    {
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(b64));
        }
        catch (FormatException)
        {
            return "";
        }
    }

    // ---------------------------------------------------------------------
    // Relationships
    // ---------------------------------------------------------------------

    private string? FindRel(string type, string target)
    {
        foreach (var r in _rels.Root!.Elements(Ns.Rel + "Relationship"))
        {
            if (r.Attribute("Type")?.Value != type) continue;
            var t = (r.Attribute("Target")?.Value ?? "").TrimStart('/');
            if (t.StartsWith("word/", StringComparison.OrdinalIgnoreCase)) t = t[5..];
            if (string.Equals(t, target, StringComparison.OrdinalIgnoreCase)) return r.Attribute("Id")?.Value;
        }
        return null;
    }

    private string AddRel(string type, string target, bool external)
    {
        string id;
        do
        {
            id = $"rIdBee{++_relSeed}";
        } while (_relIds.Contains(id));
        _relIds.Add(id);
        var rel = new XElement(Ns.Rel + "Relationship",
            new XAttribute("Id", id),
            new XAttribute("Type", type),
            new XAttribute("Target", target));
        if (external) rel.Add(new XAttribute("TargetMode", "External"));
        _rels.Root!.Add(rel);
        return id;
    }

    // ---------------------------------------------------------------------
    // Lists
    // ---------------------------------------------------------------------

    private void List(HtmlNode listNode, StringBuilder sb, ListContext? parent)
    {
        var ordered = listNode.Tag == "ol";
        var level = parent is null ? 0 : parent.Level + 1;
        int numId;
        var requested = RunProps.Int(listNode.Attr("data-num"));
        if (requested is int req && req > 0 && NumExists(req)) numId = req;
        else if (parent is not null && parent.Ordered == ordered) numId = parent.NumId;
        else numId = NewNum(ordered);
        var ctx = new ListContext(numId, Math.Min(level, 8), ordered);

        foreach (var li in listNode.Children)
        {
            if (li.IsText || li.Tag != "li")
            {
                if (!li.IsText && li.Tag is "ul" or "ol") List(li, sb, ctx);
                continue;
            }
            ListItem(li, sb, ctx);
        }
    }

    private void ListItem(HtmlNode li, StringBuilder sb, ListContext ctx)
    {
        var inline = new List<HtmlNode>();
        var first = true;
        var extraIndent = 720 * (ctx.Level + 1);

        void Flush()
        {
            if (inline.Count == 0) return;
            var meaningful = inline.Any(n => n.IsText ? !string.IsNullOrWhiteSpace(n.Text) : n.Tag is not "br");
            if (meaningful || first)
            {
                var wrapper = new HtmlNode { Tag = "li" };
                foreach (var (k, v) in li.Attrs) wrapper.Attrs[k] = v;
                wrapper.Children.AddRange(inline);
                Paragraph(wrapper, sb, ctx, first ? 0 : extraIndent, suppressNumbering: !first);
                first = false;
            }
            inline.Clear();
        }

        foreach (var child in li.Children)
        {
            if (!child.IsText && (child.Tag is "ul" or "ol"))
            {
                Flush();
                if (first)
                {
                    // A nested list with no item text of its own still needs a numbered paragraph to hang on.
                    var empty = new HtmlNode { Tag = "li" };
                    Paragraph(empty, sb, ctx);
                    first = false;
                }
                List(child, sb, ctx);
            }
            else if (!child.IsText && BlockTags.Contains(child.Tag))
            {
                Flush();
                if (child.Tag == "table") { Table(child, sb); continue; }
                if (child.Tag == "hr") { Block(child, sb, ctx); continue; }
                var wrapper = new HtmlNode { Tag = child.Tag };
                foreach (var (k, v) in child.Attrs) wrapper.Attrs[k] = v;
                wrapper.Children.AddRange(child.Children);
                Paragraph(wrapper, sb, ctx, first ? 0 : extraIndent, suppressNumbering: !first);
                first = false;
            }
            else inline.Add(child);
        }
        Flush();
        if (first)
            Paragraph(new HtmlNode { Tag = "li" }, sb, ctx);
    }

    private bool NumExists(int numId) =>
        _numbering?.Root?.Elements(W + "num").Any(n => RunProps.Int(n.Attribute(W + "numId")?.Value) == numId) == true;

    private int NewNum(bool ordered)
    {
        if (_numbering is null)
        {
            _numbering = new XDocument(new XElement(W + "numbering", new XAttribute(XNamespace.Xmlns + "w", W.NamespaceName)));
            _numberingCreated = true;
        }
        var root = _numbering.Root!;
        var abstractId = FindAbstract(root, ordered) ?? CreateAbstract(root, ordered);
        var numId = root.Elements(W + "num").Select(n => RunProps.Int(n.Attribute(W + "numId")?.Value) ?? 0).DefaultIfEmpty(0).Max() + 1;
        var num = new XElement(W + "num",
            new XAttribute(W + "numId", numId),
            new XElement(W + "abstractNumId", new XAttribute(W + "val", abstractId)));
        if (ordered)
        {
            num.Add(new XElement(W + "lvlOverride",
                new XAttribute(W + "ilvl", 0),
                new XElement(W + "startOverride", new XAttribute(W + "val", 1))));
        }
        root.Add(num);
        _numberingChanged = true;
        return numId;
    }

    private static int? FindAbstract(XElement root, bool ordered)
    {
        foreach (var abs in root.Elements(W + "abstractNum"))
        {
            if (abs.Element(W + "numStyleLink") is not null) continue;
            var lvl0 = abs.Elements(W + "lvl").FirstOrDefault(l => l.Attribute(W + "ilvl")?.Value == "0");
            var fmt = lvl0?.Element(W + "numFmt")?.Attribute(W + "val")?.Value;
            if (ordered ? fmt == "decimal" : fmt == "bullet")
                return RunProps.Int(abs.Attribute(W + "abstractNumId")?.Value);
        }
        return null;
    }

    private static int CreateAbstract(XElement root, bool ordered)
    {
        var id = root.Elements(W + "abstractNum").Select(a => RunProps.Int(a.Attribute(W + "abstractNumId")?.Value) ?? 0).DefaultIfEmpty(-1).Max() + 1;
        var sb = new StringBuilder();
        sb.Append(CultureInfo.InvariantCulture, $"<w:abstractNum xmlns:w=\"{W.NamespaceName}\" w:abstractNumId=\"{id}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>");
        var bullets = new[] { "•", "◦", "▪", "•", "◦", "▪", "•", "◦", "▪" };
        var formats = new[] { "decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman", "decimal", "lowerLetter", "lowerRoman" };
        for (var lvl = 0; lvl < 9; lvl++)
        {
            var left = 720 + lvl * 360;
            if (ordered)
                sb.Append(CultureInfo.InvariantCulture, $"<w:lvl w:ilvl=\"{lvl}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{formats[lvl]}\"/><w:lvlText w:val=\"%{lvl + 1}.\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{left}\" w:hanging=\"360\"/></w:pPr></w:lvl>");
            else
                sb.Append(CultureInfo.InvariantCulture, $"<w:lvl w:ilvl=\"{lvl}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"bullet\"/><w:lvlText w:val=\"{bullets[lvl]}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{left}\" w:hanging=\"360\"/></w:pPr></w:lvl>");
        }
        sb.Append("</w:abstractNum>");
        var el = XElement.Parse(sb.ToString());
        var lastAbstract = root.Elements(W + "abstractNum").LastOrDefault();
        if (lastAbstract is not null) lastAbstract.AddAfterSelf(el);
        else root.AddFirst(el);
        return id;
    }

    // ---------------------------------------------------------------------
    // Tables
    // ---------------------------------------------------------------------

    private void Table(HtmlNode table, StringBuilder sb)
    {
        var rows = new List<HtmlNode>();
        CollectRows(table, rows);
        if (rows.Count == 0) return;

        // Occupancy grid, so rowspans become vMerge continuation cells at the right column.
        var cellsByRow = rows.Select(r => r.Children.Where(c => !c.IsText && c.Tag is "td" or "th").ToList()).ToList();
        var columns = 0;
        var occupied = new Dictionary<(int Row, int Col), (HtmlNode? Cell, int Span)>();
        for (var r = 0; r < rows.Count; r++)
        {
            var col = 0;
            foreach (var cell in cellsByRow[r])
            {
                while (occupied.ContainsKey((r, col))) col++;
                var span = Math.Max(RunProps.Int(cell.Attr("colspan")) ?? 1, 1);
                var rowspan = Math.Max(RunProps.Int(cell.Attr("rowspan")) ?? 1, 1);
                occupied[(r, col)] = (cell, span);
                for (var rr = 1; rr < rowspan; rr++) occupied[(r + rr, col)] = (null, span);
                col += span;
            }
            columns = Math.Max(columns, col);
        }
        if (columns == 0) return;

        var widths = ColumnWidths(table, cellsByRow, columns);
        var style = table.Style();
        var styleId = table.Attr("data-style");
        if (styleId.Length == 0) styleId = "TableGrid";
        _usedStyles.Add(styleId);
        var bordered = table.Attr("data-borders") != "0";

        sb.Append("<w:tbl><w:tblPr>");
        sb.Append(CultureInfo.InvariantCulture, $"<w:tblStyle w:val=\"{Xml.Esc(styleId)}\"/>");
        if (style.TryGetValue("width", out var width) && width.Trim().EndsWith('%')
            && double.TryParse(width.Trim()[..^1], NumberStyles.Float, CultureInfo.InvariantCulture, out var pct))
            sb.Append(CultureInfo.InvariantCulture, $"<w:tblW w:w=\"{(int)Math.Round(pct * 50)}\" w:type=\"pct\"/>");
        else if (style.TryGetValue("width", out var w2) && Css.Twips(w2) is int tw)
            sb.Append(CultureInfo.InvariantCulture, $"<w:tblW w:w=\"{tw}\" w:type=\"dxa\"/>");
        else
            sb.Append("<w:tblW w:w=\"0\" w:type=\"auto\"/>");
        if (style.TryGetValue("margin-left", out var mlv) && mlv.Trim() == "auto")
            sb.Append(style.TryGetValue("margin-right", out var mrv) && mrv.Trim() == "auto" ? "<w:jc w:val=\"center\"/>" : "<w:jc w:val=\"right\"/>");
        if (bordered)
        {
            sb.Append("<w:tblBorders>");
            foreach (var edge in new[] { "top", "left", "bottom", "right", "insideH", "insideV" })
                sb.Append(CultureInfo.InvariantCulture, $"<w:{edge} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>");
            sb.Append("</w:tblBorders>");
        }
        else
        {
            sb.Append("<w:tblBorders>");
            foreach (var edge in new[] { "top", "left", "bottom", "right", "insideH", "insideV" })
                sb.Append(CultureInfo.InvariantCulture, $"<w:{edge} w:val=\"nil\"/>");
            sb.Append("</w:tblBorders>");
        }
        sb.Append("<w:tblLook w:val=\"04A0\" w:firstRow=\"1\" w:lastRow=\"0\" w:firstColumn=\"1\" w:lastColumn=\"0\" w:noHBand=\"0\" w:noVBand=\"1\"/>");
        sb.Append("</w:tblPr><w:tblGrid>");
        foreach (var cw in widths) sb.Append(CultureInfo.InvariantCulture, $"<w:gridCol w:w=\"{cw}\"/>");
        sb.Append("</w:tblGrid>");

        for (var r = 0; r < rows.Count; r++)
        {
            sb.Append("<w:tr>");
            var col = 0;
            while (col < columns)
            {
                if (!occupied.TryGetValue((r, col), out var slot))
                {
                    // Short row: pad with an empty cell.
                    sb.Append(CultureInfo.InvariantCulture, $"<w:tc><w:tcPr><w:tcW w:w=\"{widths[col]}\" w:type=\"dxa\"/></w:tcPr><w:p/></w:tc>");
                    col++;
                    continue;
                }
                var span = slot.Span;
                var cellWidth = widths.Skip(col).Take(span).Sum();
                sb.Append("<w:tc><w:tcPr>");
                sb.Append(CultureInfo.InvariantCulture, $"<w:tcW w:w=\"{cellWidth}\" w:type=\"dxa\"/>");
                if (span > 1) sb.Append(CultureInfo.InvariantCulture, $"<w:gridSpan w:val=\"{span}\"/>");
                if (slot.Cell is null)
                {
                    sb.Append("<w:vMerge/></w:tcPr><w:p/></w:tc>");
                    col += span;
                    continue;
                }
                var cell = slot.Cell;
                if ((RunProps.Int(cell.Attr("rowspan")) ?? 1) > 1) sb.Append("<w:vMerge w:val=\"restart\"/>");
                var cellStyle = cell.Style();
                var fill = cellStyle.TryGetValue("background-color", out var bg) ? Css.Color(bg) : null;
                if (fill is not null) sb.Append(CultureInfo.InvariantCulture, $"<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{fill}\"/>");
                if (cellStyle.TryGetValue("vertical-align", out var va))
                {
                    var v = va.Trim().ToLowerInvariant() switch { "middle" or "center" => "center", "bottom" => "bottom", _ => null };
                    if (v is not null) sb.Append(CultureInfo.InvariantCulture, $"<w:vAlign w:val=\"{v}\"/>");
                }
                sb.Append("</w:tcPr>");

                var inner = new StringBuilder();
                var cellNode = cell;
                if (cell.Tag == "th")
                {
                    cellNode = new HtmlNode { Tag = "td" };
                    foreach (var (k, v) in cell.Attrs) cellNode.Attrs[k] = v;
                    cellNode.Attrs["style"] = (cell.Attr("style") + ";font-weight:bold").TrimStart(';');
                    cellNode.Children.AddRange(cell.Children);
                }
                Blocks(cellNode.Children, inner, null);
                if (inner.Length == 0 || EndsWithTable(inner)) inner.Append("<w:p/>");
                if (cell.Tag == "th")
                {
                    // Bold every run in a header cell — the wrapper style only reached direct text.
                    inner.Replace("<w:r><w:t", "<w:r><w:rPr><w:b/></w:rPr><w:t");
                }
                sb.Append(inner).Append("</w:tc>");
                col += span;
            }
            sb.Append("</w:tr>");
        }
        sb.Append("</w:tbl>");
    }

    private static void CollectRows(HtmlNode node, List<HtmlNode> rows)
    {
        foreach (var child in node.Children)
        {
            if (child.IsText) continue;
            if (child.Tag == "tr") rows.Add(child);
            else if (child.Tag is "thead" or "tbody" or "tfoot") CollectRows(child, rows);
        }
    }

    private List<int> ColumnWidths(HtmlNode table, List<List<HtmlNode>> cellsByRow, int columns)
    {
        var widths = new int?[columns];
        var cols = new List<HtmlNode>();
        foreach (var child in table.Children)
        {
            if (child.IsText) continue;
            if (child.Tag == "col") cols.Add(child);
            else if (child.Tag == "colgroup") cols.AddRange(child.Children.Where(c => !c.IsText && c.Tag == "col"));
        }
        for (var i = 0; i < Math.Min(cols.Count, columns); i++)
        {
            if (cols[i].Style().TryGetValue("width", out var w) && Css.Twips(w) is int tw && tw > 0) widths[i] = tw;
        }
        // Fill from the first row's cell widths where the colgroup did not say.
        foreach (var row in cellsByRow)
        {
            var col = 0;
            foreach (var cell in row)
            {
                var span = Math.Max(RunProps.Int(cell.Attr("colspan")) ?? 1, 1);
                if (span == 1 && col < columns && widths[col] is null
                    && cell.Style().TryGetValue("width", out var w) && Css.Twips(w) is int tw && tw > 0)
                    widths[col] = tw;
                col += span;
            }
        }
        var known = widths.Where(w => w is not null).Sum(w => w!.Value);
        var unknown = widths.Count(w => w is null);
        var remaining = Math.Max(ContentWidthTwips - known, 600 * unknown);
        var each = unknown > 0 ? remaining / unknown : 0;
        return widths.Select(w => w ?? each).ToList();
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    private void EnsureStyles()
    {
        if (_styles is null)
        {
            _styles = XDocument.Parse(DefaultStylesXml());
            _stylesCreated = true;
        }
        var root = _styles.Root!;
        var existing = new HashSet<string>(
            root.Elements(W + "style").Select(s => s.Attribute(W + "styleId")?.Value ?? ""), StringComparer.Ordinal);
        foreach (var id in _usedStyles)
        {
            if (existing.Contains(id)) continue;
            var def = WordStyleDefaults.Find(id);
            if (def is null) continue;
            var xml = def.Xml.Replace("<w:style ", $"<w:style xmlns:w=\"{W.NamespaceName}\" ", StringComparison.Ordinal);
            root.Add(XElement.Parse(xml));
            existing.Add(id);
            _stylesChanged = true;
        }
    }

    private static string DefaultStylesXml() => $"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:styles xmlns:w="{W.NamespaceName}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>
        """;


    // ---------------------------------------------------------------------
    // New documents
    // ---------------------------------------------------------------------

    /// <summary>A minimal, valid .docx with one empty paragraph and Word's gallery styles defined.</summary>
    public static byte[] Blank()
    {
        var styles = XDocument.Parse(DefaultStylesXml());
        foreach (var def in WordStyleDefaults.All)
        {
            var xml = def.Xml.Replace("<w:style ", $"<w:style xmlns:w=\"{W.NamespaceName}\" ", StringComparison.Ordinal);
            styles.Root!.Add(XElement.Parse(xml));
        }

        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteText(zip, "[Content_Types].xml",
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
                + "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>"
                + "</Types>");
            WriteText(zip, "_rels/.rels",
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
                + "</Relationships>");
            WriteText(zip, "word/_rels/document.xml.rels",
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + $"<Relationship Id=\"rId1\" Type=\"{Ns.RelStyles}\" Target=\"styles.xml\"/>"
                + "</Relationships>");
            WriteText(zip, "word/document.xml",
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                + $"<w:document xmlns:w=\"{Ns.W}\" xmlns:r=\"{Ns.R}\" xmlns:wp=\"{Ns.Wp}\" xmlns:a=\"{Ns.A}\" xmlns:pic=\"{Ns.Pic}\">"
                + "<w:body><w:p/>"
                + "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/></w:sectPr>"
                + "</w:body></w:document>");
            WriteText(zip, "word/styles.xml", Serialize(styles));
        }
        return output.ToArray();
    }

    // ---------------------------------------------------------------------
    // Package
    // ---------------------------------------------------------------------

    private byte[] WritePackage(string documentXml)
    {
        var replacements = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [_mainName] = documentXml,
            [_relsName] = Serialize(_rels),
        };

        var stylesName = RelTarget(Ns.RelStyles) ?? $"{_partDir}styles.xml";
        if (_stylesCreated)
        {
            AddRel(Ns.RelStyles, "styles.xml", external: false);
            EnsureOverride($"/{_partDir}styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml");
            replacements[$"{_partDir}styles.xml"] = Serialize(_styles!);
            replacements[_relsName] = Serialize(_rels);
        }
        else if (_stylesChanged) replacements[stylesName] = Serialize(_styles!);

        var numberingName = RelTarget(Ns.RelNumbering) ?? $"{_partDir}numbering.xml";
        if (_numberingCreated)
        {
            AddRel(Ns.RelNumbering, "numbering.xml", external: false);
            EnsureOverride($"/{_partDir}numbering.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml");
            replacements[$"{_partDir}numbering.xml"] = Serialize(_numbering!);
            replacements[_relsName] = Serialize(_rels);
        }
        else if (_numberingChanged) replacements[numberingName] = Serialize(_numbering!);

        foreach (var ext in _newMediaExtensions)
        {
            EnsureDefault(ext, ext switch
            {
                "png" => "image/png",
                "jpeg" or "jpg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "tiff" => "image/tiff",
                _ => "application/octet-stream",
            });
        }
        replacements["[Content_Types].xml"] = Serialize(_contentTypes);

        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in _zip.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue;
                if (replacements.TryGetValue(entry.FullName, out var content))
                {
                    WriteText(zip, entry.FullName, content);
                    written.Add(entry.FullName);
                    continue;
                }
                var level = entry.FullName.StartsWith($"{_partDir}media/", StringComparison.OrdinalIgnoreCase)
                    ? CompressionLevel.NoCompression
                    : CompressionLevel.Fastest;
                var copy = zip.CreateEntry(entry.FullName, level);
                using var src = entry.Open();
                using var dst = copy.Open();
                src.CopyTo(dst);
                written.Add(entry.FullName);
            }
            foreach (var (name, content) in replacements)
            {
                if (!written.Contains(name)) WriteText(zip, name, content);
            }
            foreach (var (name, data) in _newMedia)
            {
                var entry = zip.CreateEntry($"{_partDir}media/{name}", CompressionLevel.NoCompression);
                using var s = entry.Open();
                s.Write(data, 0, data.Length);
            }
        }
        return output.ToArray();
    }

    private static void WriteText(ZipArchive zip, string name, string content)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        using var s = entry.Open();
        var bytes = new UTF8Encoding(false).GetBytes(content);
        s.Write(bytes, 0, bytes.Length);
    }

    private static string Serialize(XDocument doc)
    {
        var sb = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        sb.Append(doc.Root!.ToString(SaveOptions.DisableFormatting));
        return sb.ToString();
    }

    private void EnsureOverride(string partName, string contentType)
    {
        var root = _contentTypes.Root!;
        if (root.Elements(Ns.Ct + "Override").Any(o => string.Equals(o.Attribute("PartName")?.Value, partName, StringComparison.OrdinalIgnoreCase)))
            return;
        root.Add(new XElement(Ns.Ct + "Override", new XAttribute("PartName", partName), new XAttribute("ContentType", contentType)));
    }

    private void EnsureDefault(string extension, string contentType)
    {
        var root = _contentTypes.Root!;
        if (root.Elements(Ns.Ct + "Default").Any(d => string.Equals(d.Attribute("Extension")?.Value, extension, StringComparison.OrdinalIgnoreCase)))
            return;
        var first = root.Elements(Ns.Ct + "Override").FirstOrDefault();
        var el = new XElement(Ns.Ct + "Default", new XAttribute("Extension", extension), new XAttribute("ContentType", contentType));
        if (first is not null) first.AddBeforeSelf(el);
        else root.Add(el);
    }
}

/// <summary>CSS value parsing for the handful of properties the writer maps to WordprocessingML.</summary>
internal static class Css
{
    private static readonly Dictionary<string, string> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["black"] = "000000", ["white"] = "FFFFFF", ["red"] = "FF0000", ["green"] = "008000", ["lime"] = "00FF00",
        ["blue"] = "0000FF", ["yellow"] = "FFFF00", ["cyan"] = "00FFFF", ["aqua"] = "00FFFF", ["magenta"] = "FF00FF",
        ["fuchsia"] = "FF00FF", ["gray"] = "808080", ["grey"] = "808080", ["silver"] = "C0C0C0", ["maroon"] = "800000",
        ["olive"] = "808000", ["navy"] = "000080", ["teal"] = "008080", ["purple"] = "800080", ["orange"] = "FFA500",
        ["darkblue"] = "00008B", ["darkgreen"] = "006400", ["darkred"] = "8B0000", ["lightgray"] = "D3D3D3",
        ["lightgrey"] = "D3D3D3", ["darkgray"] = "A9A9A9", ["darkgrey"] = "A9A9A9", ["pink"] = "FFC0CB",
        ["brown"] = "A52A2A", ["gold"] = "FFD700", ["indigo"] = "4B0082", ["violet"] = "EE82EE", ["turquoise"] = "40E0D0",
    };

    /// <summary>RRGGBB, or null for transparent / inherit / unparseable.</summary>
    public static string? Color(string value)
    {
        var v = value.Trim();
        if (v.Length == 0) return null;
        if (v.StartsWith('#'))
        {
            var hex = v[1..];
            if (hex.Length == 3) hex = string.Concat(hex.Select(c => new string(c, 2)));
            if (hex.Length == 8) hex = hex[..6];
            return hex.Length == 6 && hex.All(Uri.IsHexDigit) ? hex.ToUpperInvariant() : null;
        }
        if (v.StartsWith("rgb", StringComparison.OrdinalIgnoreCase))
        {
            var open = v.IndexOf('(');
            var close = v.IndexOf(')');
            if (open < 0 || close < open) return null;
            var parts = v[(open + 1)..close].Split([',', ' ', '/'], StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3) return null;
            if (parts.Length >= 4 && double.TryParse(parts[3].TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var alpha) && alpha == 0)
                return null;
            var channels = new int[3];
            for (var i = 0; i < 3; i++)
            {
                if (!double.TryParse(parts[i].TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out var c)) return null;
                if (parts[i].EndsWith('%')) c = c * 255 / 100;
                channels[i] = Math.Clamp((int)Math.Round(c), 0, 255);
            }
            return $"{channels[0]:X2}{channels[1]:X2}{channels[2]:X2}";
        }
        return Named.TryGetValue(v, out var named) ? named : null;
    }

    /// <summary>A CSS length in twips (pt, px, in, cm, mm, em at 11pt). Null for unparseable or percentages.</summary>
    public static int? Twips(string value)
    {
        var v = value.Trim().ToLowerInvariant();
        if (v.Length == 0 || v == "auto" || v == "normal" || v.EndsWith('%')) return null;
        double factor;
        string number;
        if (v.EndsWith("pt", StringComparison.Ordinal)) { factor = 20; number = v[..^2]; }
        else if (v.EndsWith("px", StringComparison.Ordinal)) { factor = 15; number = v[..^2]; }
        else if (v.EndsWith("in", StringComparison.Ordinal)) { factor = 1440; number = v[..^2]; }
        else if (v.EndsWith("cm", StringComparison.Ordinal)) { factor = 1440 / 2.54; number = v[..^2]; }
        else if (v.EndsWith("mm", StringComparison.Ordinal)) { factor = 1440 / 25.4; number = v[..^2]; }
        else if (v.EndsWith("em", StringComparison.Ordinal) || v.EndsWith("rem", StringComparison.Ordinal))
        {
            factor = 220; number = v[..(v.EndsWith("rem", StringComparison.Ordinal) ? ^3 : ^2)];
        }
        else { factor = 15; number = v; }
        return double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)
            ? (int)Math.Round(n * factor)
            : null;
    }

    /// <summary>Font size in half-points.</summary>
    public static int? HalfPoints(string value)
    {
        var v = value.Trim().ToLowerInvariant();
        var keyword = v switch
        {
            "xx-small" => 14, "x-small" => 15, "small" => 20, "medium" => 22, "large" => 27,
            "x-large" => 36, "xx-large" => 48, "xxx-large" => 64,
            _ => 0,
        };
        if (keyword > 0) return keyword;
        if (v.EndsWith('%') || v.EndsWith("em", StringComparison.Ordinal) || v is "smaller" or "larger") return null;
        var twips = Twips(v);
        return twips is int t && t > 0 ? Math.Max((int)Math.Round(t / 10.0), 2) : null;
    }

    private static readonly int[] FontTagSizes = [16, 20, 24, 28, 36, 48, 72];

    /// <summary>Formatting an element adds to its content — from its tag, then its inline style.</summary>
    public static RunProps RunPropsFor(HtmlNode el, RunProps inherited)
    {
        var own = el.Tag switch
        {
            "b" or "strong" => new RunProps { Bold = true },
            "i" or "em" or "cite" or "var" => new RunProps { Italic = true },
            "u" or "ins" => new RunProps { Underline = true },
            "s" or "strike" or "del" => new RunProps { Strike = true },
            "sub" => new RunProps { VertAlign = "subscript" },
            "sup" => new RunProps { VertAlign = "superscript" },
            "code" or "kbd" or "samp" or "tt" => new RunProps { Font = "Consolas" },
            "mark" => new RunProps { Highlight = "yellow" },
            "small" => new RunProps { Size = 16 },
            "th" => new RunProps { Bold = true },
            _ => RunProps.Empty,
        };

        if (el.Tag == "font")
        {
            if (el.Attr("color") is { Length: > 0 } c && Color(c) is { } hex) own = own with { Color = hex };
            if (el.Attr("face") is { Length: > 0 } face) own = own with { Font = FirstFamily(face) };
            if (RunProps.Int(el.Attr("size")) is int size && size is >= 1 and <= 7) own = own with { Size = FontTagSizes[size - 1] };
        }

        var style = el.Style();
        if (style.Count > 0)
        {
            if (style.TryGetValue("font-weight", out var fw))
            {
                var w = fw.Trim().ToLowerInvariant();
                if (w is "bold" or "bolder") own = own with { Bold = true };
                else if (w is "normal" or "lighter") own = own with { Bold = false };
                else if (int.TryParse(w, out var n)) own = own with { Bold = n >= 600 };
            }
            if (style.TryGetValue("font-style", out var fs))
                own = own with { Italic = fs.Trim().ToLowerInvariant() is "italic" or "oblique" ? true : false };
            var deco = style.TryGetValue("text-decoration-line", out var dl) ? dl : style.TryGetValue("text-decoration", out var d) ? d : null;
            if (deco is not null)
            {
                var v = deco.ToLowerInvariant();
                if (v.Contains("underline")) own = own with { Underline = true };
                if (v.Contains("line-through")) own = own with { Strike = true };
                if (v.Trim() == "none") own = own with { Underline = false, Strike = false };
            }
            if (style.TryGetValue("color", out var color) && Color(color) is { } hex) own = own with { Color = hex };
            var bg = style.TryGetValue("background-color", out var b1) ? b1 : style.TryGetValue("background", out var b2) ? b2 : null;
            if (bg is not null)
            {
                var hexBg = Color(bg);
                if (hexBg is null && bg.Trim().Equals("transparent", StringComparison.OrdinalIgnoreCase))
                    own = own with { Highlight = null, Shading = null };
                else if (hexBg is not null)
                {
                    var name = RunProps.HighlightForHex(hexBg);
                    own = name is not null ? own with { Highlight = name } : own with { Shading = hexBg };
                }
            }
            if (style.TryGetValue("font-size", out var size) && HalfPoints(size) is int hp) own = own with { Size = hp };
            if (style.TryGetValue("font-family", out var family)) own = own with { Font = FirstFamily(family) };
            if (style.TryGetValue("vertical-align", out var va))
            {
                var v = va.Trim().ToLowerInvariant();
                if (v is "super" or "text-top") own = own with { VertAlign = "superscript" };
                else if (v is "sub" or "text-bottom") own = own with { VertAlign = "subscript" };
                else if (v == "baseline") own = own with { VertAlign = "baseline" };
            }
            if (style.TryGetValue("text-transform", out var tt) && tt.Trim().Equals("uppercase", StringComparison.OrdinalIgnoreCase))
                own = own with { Caps = true };
            if (style.TryGetValue("font-variant", out var fv) && fv.Contains("small-caps", StringComparison.OrdinalIgnoreCase))
                own = own with { SmallCaps = true };
            if (style.TryGetValue("letter-spacing", out var ls) && Twips(ls) is int lt) own = own with { Spacing = lt };
        }

        var merged = inherited.Over(own);
        // "vertical-align: baseline" means back to normal, not a value to write out.
        if (merged.VertAlign == "baseline") merged = merged with { VertAlign = null };
        return merged;
    }

    private static string FirstFamily(string list)
    {
        var first = list.Split(',')[0].Trim().Trim('"', '\'').Trim();
        return first.Length == 0 ? "Calibri" : first;
    }
}
