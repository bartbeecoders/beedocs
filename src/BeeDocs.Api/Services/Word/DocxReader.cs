using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Xml.Linq;

namespace BeeDocs.Api.Services.Word;

/// <summary>Page size and margins in twips (1/1440 in), the unit `w:sectPr` uses.</summary>
public sealed record WordPageSetup(int Width, int Height, int Top, int Right, int Bottom, int Left)
{
    public static readonly WordPageSetup A4 = new(11906, 16838, 1440, 1440, 1440, 1440);
}

/// <summary>What the reader hands the editor: HTML for the body, CSS for the document's own styles, and the page.</summary>
public sealed record DocxReadResult(
    string Html,
    string Css,
    WordPageSetup Page,
    bool HasHeaderFooter,
    IReadOnlyList<string> StyleGallery);

/// <summary>The caller's file cannot be opened as a Word document — wrong format, or a broken package.</summary>
public sealed class WordDocumentException(string message, int status = 422) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>
/// Turns the body of a .docx into HTML the browser can edit natively.
///
/// The translation is shaped by the way back: everything emitted is something
/// <see cref="DocxDocumentWriter"/> can turn into WordprocessingML again, and
/// what has no HTML shape — fields, footnote references, text boxes, content
/// controls — is carried through as an opaque chunk (<c>data-docx-raw</c>, the
/// original XML base64-encoded) that renders read-only and is written back
/// verbatim. Style definitions are not flattened into the HTML: paragraphs keep
/// their style id (<c>data-style</c>) and the document's styles.xml becomes a
/// stylesheet, so a heading looks like *this document's* heading and is saved
/// as one.
/// </summary>
public sealed class DocxReader
{
    private static readonly XNamespace W = Ns.W;

    private sealed record Rel(string Type, string Target, bool External);

    private sealed class StyleInfo
    {
        public string Id = "";
        public string Type = "paragraph";
        public string Name = "";
        public string? BasedOn;
        public bool IsDefault;
        public ParaProps Para = ParaProps.Empty;
        public RunProps Run = RunProps.Empty;
        public int? NumId;
        public int? Ilvl;
        public bool? TableBorders;
    }

    private sealed record Level(string Format, string Text);

    private readonly Dictionary<string, Rel> _rels = new(StringComparer.Ordinal);
    private readonly Dictionary<string, StyleInfo> _styles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (ParaProps Para, RunProps Run, int? NumId, int? Ilvl, bool? Borders)> _resolved = new(StringComparer.Ordinal);
    private readonly Dictionary<int, int> _numToAbstract = [];
    private readonly Dictionary<int, Dictionary<int, Level>> _abstractLevels = [];
    private RunProps _defaultRun = RunProps.Empty;
    private ParaProps _defaultPara = ParaProps.Empty;
    private string _defaultParaStyle = "Normal";
    private readonly string _mediaUrlBase;

    private DocxReader(string mediaUrlBase)
    {
        _mediaUrlBase = mediaUrlBase;
    }

    /// <param name="mediaUrlBase">URL prefix an image part name is appended to, e.g. <c>/api/attachments/{id}/word/media/</c>.</param>
    public static DocxReadResult Read(Stream docx, string mediaUrlBase)
    {
        ZipArchive zip;
        try
        {
            zip = new ZipArchive(docx, ZipArchiveMode.Read, leaveOpen: true);
        }
        catch (InvalidDataException)
        {
            throw new WordDocumentException("The file is not a valid Word document (not a zip package).");
        }

        using (zip)
        {
            var reader = new DocxReader(mediaUrlBase);
            return reader.ReadPackage(zip);
        }
    }

    /// <summary>The entry name of the main document part, resolved through the package relationships.</summary>
    public static string MainPartName(ZipArchive zip)
    {
        var rels = zip.GetEntry("_rels/.rels");
        if (rels is not null)
        {
            try
            {
                using var s = rels.Open();
                var doc = XDocument.Load(s);
                var main = doc.Root?.Elements(Ns.Rel + "Relationship")
                    .FirstOrDefault(r => (r.Attribute("Type")?.Value ?? "").EndsWith("/officeDocument", StringComparison.Ordinal));
                var target = main?.Attribute("Target")?.Value;
                if (!string.IsNullOrWhiteSpace(target)) return target.TrimStart('/');
            }
            catch (System.Xml.XmlException)
            {
            }
        }
        return "word/document.xml";
    }

    private DocxReadResult ReadPackage(ZipArchive zip)
    {
        var mainName = MainPartName(zip);
        var main = zip.GetEntry(mainName)
            ?? throw new WordDocumentException("The file is not a Word document: no document part.");
        var partDir = mainName.Contains('/') ? mainName[..(mainName.LastIndexOf('/') + 1)] : "";
        var partFile = mainName[partDir.Length..];

        LoadRels(zip.GetEntry($"{partDir}_rels/{partFile}.rels"));
        LoadStyles(zip.GetEntry(RelTarget(partDir, Ns.RelStyles) ?? $"{partDir}styles.xml"));
        LoadNumbering(zip.GetEntry(RelTarget(partDir, Ns.RelNumbering) ?? $"{partDir}numbering.xml"));

        XDocument document;
        try
        {
            using var s = main.Open();
            document = XDocument.Load(s);
        }
        catch (System.Xml.XmlException e)
        {
            throw new WordDocumentException($"The document part is not well-formed XML: {e.Message}");
        }

        var body = document.Root?.Element(W + "body")
            ?? throw new WordDocumentException("The document has no body.");

        var html = new StringBuilder();
        RenderBlocks(body.Elements(), html);

        var sectPr = body.Element(W + "sectPr");
        var page = ReadPage(sectPr);
        var hasHeaderFooter = sectPr is not null
            && (sectPr.Elements(W + "headerReference").Any() || sectPr.Elements(W + "footerReference").Any());

        return new DocxReadResult(html.ToString(), BuildCss(), page, hasHeaderFooter, WordStyleDefaults.Gallery);
    }

    private string? RelTarget(string partDir, string type)
    {
        foreach (var rel in _rels.Values)
        {
            if (rel.Type == type && !rel.External)
                return ResolvePartPath(partDir, rel.Target);
        }
        return null;
    }

    private static string ResolvePartPath(string partDir, string target)
    {
        if (target.StartsWith('/')) return target[1..];
        var segments = new List<string>(partDir.Split('/', StringSplitOptions.RemoveEmptyEntries));
        foreach (var seg in target.Split('/'))
        {
            if (seg == "..") { if (segments.Count > 0) segments.RemoveAt(segments.Count - 1); }
            else if (seg != "." && seg.Length > 0) segments.Add(seg);
        }
        return string.Join('/', segments);
    }

    // ---------------------------------------------------------------------
    // Package parts
    // ---------------------------------------------------------------------

    private void LoadRels(ZipArchiveEntry? entry)
    {
        if (entry is null) return;
        XDocument doc;
        try
        {
            using var s = entry.Open();
            doc = XDocument.Load(s);
        }
        catch (System.Xml.XmlException)
        {
            return;
        }
        foreach (var r in doc.Root?.Elements(Ns.Rel + "Relationship") ?? [])
        {
            var id = r.Attribute("Id")?.Value;
            var type = r.Attribute("Type")?.Value ?? "";
            var target = r.Attribute("Target")?.Value ?? "";
            if (id is null) continue;
            var external = string.Equals(r.Attribute("TargetMode")?.Value, "External", StringComparison.OrdinalIgnoreCase);
            _rels[id] = new Rel(type, target, external);
        }
    }

    private void LoadStyles(ZipArchiveEntry? entry)
    {
        if (entry is null) return;
        XDocument doc;
        try
        {
            using var s = entry.Open();
            doc = XDocument.Load(s);
        }
        catch (System.Xml.XmlException)
        {
            return;
        }
        var root = doc.Root;
        if (root is null) return;

        var defaults = root.Element(W + "docDefaults");
        _defaultRun = RunProps.FromXml(defaults?.Element(W + "rPrDefault")?.Element(W + "rPr"));
        _defaultPara = ParaProps.FromXml(defaults?.Element(W + "pPrDefault")?.Element(W + "pPr"));

        foreach (var st in root.Elements(W + "style"))
        {
            var id = st.Attribute(W + "styleId")?.Value;
            if (string.IsNullOrEmpty(id)) continue;
            var pPr = st.Element(W + "pPr");
            var numPr = pPr?.Element(W + "numPr");
            var info = new StyleInfo
            {
                Id = id,
                Type = st.Attribute(W + "type")?.Value ?? "paragraph",
                Name = st.Element(W + "name")?.Attribute(W + "val")?.Value ?? id,
                BasedOn = st.Element(W + "basedOn")?.Attribute(W + "val")?.Value,
                IsDefault = st.Attribute(W + "default")?.Value is "1" or "true",
                Para = ParaProps.FromXml(pPr),
                Run = RunProps.FromXml(st.Element(W + "rPr")),
                NumId = RunProps.Int(numPr?.Element(W + "numId")?.Attribute(W + "val")?.Value),
                Ilvl = RunProps.Int(numPr?.Element(W + "ilvl")?.Attribute(W + "val")?.Value),
                TableBorders = HasBorders(st.Element(W + "tblPr")?.Element(W + "tblBorders")),
            };
            _styles[id] = info;
            if (info.IsDefault && info.Type == "paragraph") _defaultParaStyle = id;
        }
    }

    private static bool? HasBorders(XElement? borders)
    {
        if (borders is null) return null;
        foreach (var edge in borders.Elements())
        {
            var val = edge.Attribute(W + "val")?.Value;
            if (val is not null && val is not ("nil" or "none")) return true;
        }
        return false;
    }

    private void LoadNumbering(ZipArchiveEntry? entry)
    {
        if (entry is null) return;
        XDocument doc;
        try
        {
            using var s = entry.Open();
            doc = XDocument.Load(s);
        }
        catch (System.Xml.XmlException)
        {
            return;
        }
        var root = doc.Root;
        if (root is null) return;

        foreach (var abs in root.Elements(W + "abstractNum"))
        {
            var id = RunProps.Int(abs.Attribute(W + "abstractNumId")?.Value);
            if (id is null) continue;
            var levels = new Dictionary<int, Level>();
            foreach (var lvl in abs.Elements(W + "lvl"))
            {
                var ilvl = RunProps.Int(lvl.Attribute(W + "ilvl")?.Value);
                if (ilvl is null) continue;
                levels[ilvl.Value] = new Level(
                    lvl.Element(W + "numFmt")?.Attribute(W + "val")?.Value ?? "decimal",
                    lvl.Element(W + "lvlText")?.Attribute(W + "val")?.Value ?? "");
            }
            _abstractLevels[id.Value] = levels;
        }
        foreach (var num in root.Elements(W + "num"))
        {
            var id = RunProps.Int(num.Attribute(W + "numId")?.Value);
            var abs = RunProps.Int(num.Element(W + "abstractNumId")?.Attribute(W + "val")?.Value);
            if (id is null || abs is null) continue;
            _numToAbstract[id.Value] = abs.Value;
        }
    }

    private Level LevelOf(int numId, int ilvl)
    {
        if (_numToAbstract.TryGetValue(numId, out var abs) && _abstractLevels.TryGetValue(abs, out var levels))
        {
            if (levels.TryGetValue(ilvl, out var level)) return level;
            if (levels.TryGetValue(0, out var first)) return first;
        }
        return new Level("bullet", "•");
    }

    private (ParaProps Para, RunProps Run, int? NumId, int? Ilvl, bool? Borders) Resolve(string? styleId)
    {
        if (styleId is null || !_styles.ContainsKey(styleId))
            return (ParaProps.Empty, RunProps.Empty, null, null, null);
        if (_resolved.TryGetValue(styleId, out var cached)) return cached;

        var chain = new List<StyleInfo>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var cursor = styleId;
        while (cursor is not null && seen.Add(cursor) && _styles.TryGetValue(cursor, out var info) && chain.Count < 20)
        {
            chain.Add(info);
            cursor = info.BasedOn;
        }
        chain.Reverse();

        var para = ParaProps.Empty;
        var run = RunProps.Empty;
        int? numId = null, ilvl = null;
        bool? borders = null;
        foreach (var s in chain)
        {
            para = para.Over(s.Para);
            run = run.Over(s.Run);
            numId = s.NumId ?? numId;
            ilvl = s.Ilvl ?? ilvl;
            borders = s.TableBorders ?? borders;
        }
        var result = (para, run, numId, ilvl, borders);
        _resolved[styleId] = result;
        return result;
    }

    // ---------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------

    private sealed class ListState
    {
        public readonly List<(int NumId, int Ilvl, string Tag, bool LiOpen)> Stack = [];
    }

    private void RenderBlocks(IEnumerable<XElement> elements, StringBuilder html)
    {
        var lists = new ListState();
        foreach (var el in elements)
            RenderBlock(el, html, lists);
        CloseLists(lists, html, 0);
    }

    private void RenderBlock(XElement el, StringBuilder html, ListState lists)
    {
        if (el.Name.Namespace != W)
        {
            // Anything from another namespace at block level — keep it whole.
            CloseLists(lists, html, 0);
            RawBlock(el, html);
            return;
        }

        switch (el.Name.LocalName)
        {
            case "p":
                RenderParagraph(el, html, lists);
                break;
            case "tbl":
                CloseLists(lists, html, 0);
                RenderTable(el, html);
                break;
            case "sdt":
            {
                CloseLists(lists, html, 0);
                var content = el.Element(W + "sdtContent");
                var isDocPart = el.Element(W + "sdtPr")?.Element(W + "docPartObj") is not null;
                if (content is null) break;
                if (isDocPart)
                {
                    // A table of contents or similar building block: Word rebuilds
                    // it from its field, so it is shown but kept as-is.
                    var inner = new StringBuilder();
                    RenderBlocks(content.Elements(), inner);
                    RawBlock(el, html, inner.ToString());
                }
                else
                {
                    foreach (var child in content.Elements()) RenderBlock(child, html, lists);
                }
                break;
            }
            case "customXml":
            case "ins":
            case "moveTo":
                foreach (var child in el.Elements()) RenderBlock(child, html, lists);
                break;
            case "sectPr":
            case "bookmarkStart":
            case "bookmarkEnd":
            case "proofErr":
            case "commentRangeStart":
            case "commentRangeEnd":
            case "del":
            case "moveFrom":
            case "permStart":
            case "permEnd":
                break;
            default:
                CloseLists(lists, html, 0);
                RawBlock(el, html);
                break;
        }
    }

    private void RawBlock(XElement el, StringBuilder html, string? innerHtml = null)
    {
        html.Append("<div class=\"docx-raw docx-raw-block\" contenteditable=\"false\" data-docx-raw=\"")
            .Append(B64(el.ToString(SaveOptions.DisableFormatting)))
            .Append("\">");
        if (innerHtml is not null) html.Append(innerHtml);
        else
        {
            var text = string.Concat(el.Descendants(W + "t").Select(t => t.Value));
            html.Append("<p>").Append(Enc(text.Length > 0 ? text : "[kept content]")).Append("</p>");
        }
        html.Append("</div>");
    }

    private void CloseLists(ListState lists, StringBuilder html, int keepDepth)
    {
        while (lists.Stack.Count > keepDepth)
        {
            var top = lists.Stack[^1];
            if (top.LiOpen) html.Append("</li>");
            html.Append("</").Append(top.Tag).Append('>');
            lists.Stack.RemoveAt(lists.Stack.Count - 1);
        }
    }

    private void RenderParagraph(XElement p, StringBuilder html, ListState lists)
    {
        var pPr = p.Element(W + "pPr");
        var styleId = pPr?.Element(W + "pStyle")?.Attribute(W + "val")?.Value;
        var own = ParaProps.FromXml(pPr);
        var styleProps = Resolve(styleId);

        var numPr = pPr?.Element(W + "numPr");
        var numId = RunProps.Int(numPr?.Element(W + "numId")?.Attribute(W + "val")?.Value) ?? styleProps.NumId;
        var ilvl = RunProps.Int(numPr?.Element(W + "ilvl")?.Attribute(W + "val")?.Value) ?? styleProps.Ilvl ?? 0;
        var isList = numId is > 0;

        var segments = RenderInlineSegments(p);
        var hasText = segments.Any(s => s.Length > 0);

        // A paragraph that is nothing but page breaks is the break itself; a
        // break at the very end of a paragraph does not open an empty one after.
        if (!isList && !hasText && segments.Count > 1)
        {
            CloseLists(lists, html, 0);
            for (var i = 1; i < segments.Count; i++) html.Append("<hr data-break=\"page\">");
            return;
        }
        if (segments.Count > 1 && segments[^1].Length == 0)
        {
            segments.RemoveAt(segments.Count - 1);
            segments.Add(null!);
        }

        // A rule: an empty paragraph whose only feature is a bottom border.
        if (!isList && !hasText && segments.Count == 1 && own.BottomBorder == true)
        {
            CloseLists(lists, html, 0);
            html.Append("<hr>");
            return;
        }

        var attrs = new StringBuilder();
        if (styleId is not null && styleId != _defaultParaStyle && !(isList && styleId == "ListParagraph"))
            attrs.Append(" data-style=\"").Append(Enc(styleId)).Append('"');
        if (own.PageBreakBefore == true) attrs.Append(" data-pagebreak=\"before\"");
        var sect = pPr?.Element(W + "sectPr");
        if (sect is not null) attrs.Append(" data-sect=\"").Append(B64(sect.ToString(SaveOptions.DisableFormatting))).Append('"');

        var cssProps = isList ? own with { IndLeft = null, IndHanging = null, IndFirstLine = null } : own;
        var css = cssProps.ToCss();
        if (css.Length > 0) attrs.Append(" style=\"").Append(Enc(css)).Append('"');

        if (isList)
        {
            var level = LevelOf(numId!.Value, ilvl);
            var tag = level.Format is "bullet" or "none" ? "ul" : "ol";
            var stack = lists.Stack;
            while (stack.Count > 0 && (stack[^1].Ilvl > ilvl || (stack[^1].Ilvl == ilvl && stack[^1].NumId != numId)))
                CloseLists(lists, html, stack.Count - 1);
            if (stack.Count == 0 || stack[^1].Ilvl < ilvl)
            {
                html.Append('<').Append(tag).Append(" data-num=\"").Append(numId.Value).Append('"');
                var type = level.Format switch
                {
                    "lowerLetter" => "a",
                    "upperLetter" => "A",
                    "lowerRoman" => "i",
                    "upperRoman" => "I",
                    _ => null,
                };
                if (type is not null) html.Append(" type=\"").Append(type).Append('"');
                html.Append('>');
                stack.Add((numId.Value, ilvl, tag, false));
            }
            else if (stack[^1].LiOpen)
            {
                html.Append("</li>");
                stack[^1] = stack[^1] with { LiOpen = false };
            }
            html.Append("<li").Append(attrs).Append('>');
            AppendSegments(segments, html, "li", attrs.ToString(), hasText, closeContainer: false);
            stack[^1] = stack[^1] with { LiOpen = true };
            return;
        }

        CloseLists(lists, html, 0);
        var blockTag = styleId is not null && styleId.Length == 8 && styleId.StartsWith("Heading", StringComparison.Ordinal)
                       && char.IsDigit(styleId[7]) && styleId[7] is >= '1' and <= '6'
            ? "h" + styleId[7]
            : "p";
        html.Append('<').Append(blockTag).Append(attrs).Append('>');
        AppendSegments(segments, html, blockTag, attrs.ToString(), hasText, closeContainer: true);
    }

    /// <summary>
    /// Emit the paragraph's segments, one block per page break: text before the
    /// break closes the block, a page-break rule follows, and the remainder
    /// reopens the same block. An empty block gets a <c>&lt;br&gt;</c> so the
    /// caret has somewhere to land.
    /// </summary>
    private static void AppendSegments(
        List<string> segments, StringBuilder html, string tag, string attrs, bool hasText, bool closeContainer)
    {
        var trailingBreak = false;
        for (var i = 0; i < segments.Count; i++)
        {
            var seg = segments[i];
            if (seg is null)
            {
                // Sentinel: a page break ended the paragraph.
                trailingBreak = true;
                break;
            }
            if (i > 0)
            {
                html.Append("</").Append(tag).Append('>');
                html.Append("<hr data-break=\"page\">");
                html.Append('<').Append(tag).Append(attrs).Append('>');
            }
            html.Append(seg.Length > 0 ? seg : "<br>");
        }
        _ = hasText;
        if (closeContainer) html.Append("</").Append(tag).Append('>');
        if (trailingBreak && closeContainer) html.Append("<hr data-break=\"page\">");
    }

    // ---------------------------------------------------------------------
    // Inline content
    // ---------------------------------------------------------------------

    /// <summary>Inline HTML of a paragraph, split at page breaks.</summary>
    private List<string> RenderInlineSegments(XElement p)
    {
        var segments = new List<StringBuilder> { new() };
        RenderInlineChildren(p, segments, RunProps.Empty);
        return segments.Select(s => s.ToString()).ToList();
    }

    private void RenderInlineChildren(XElement container, List<StringBuilder> segments, RunProps inherited)
    {
        var children = container.Elements().ToList();
        for (var i = 0; i < children.Count; i++)
        {
            var el = children[i];
            if (el.Name.Namespace != W)
            {
                if (el.Name.Namespace == Ns.Mc && el.Name.LocalName == "AlternateContent")
                    RawInline(el, segments[^1], DescendantText(el));
                else
                    RawInline(el, segments[^1], DescendantText(el));
                continue;
            }

            switch (el.Name.LocalName)
            {
                case "r":
                {
                    if (IsFieldBegin(el))
                    {
                        var end = FindFieldEnd(children, i);
                        if (end > i)
                        {
                            RawField(children, i, end, segments[^1]);
                            i = end;
                            break;
                        }
                    }
                    RenderRun(el, segments, inherited);
                    break;
                }
                case "hyperlink":
                {
                    var rid = el.Attribute(Ns.R + "id")?.Value;
                    var anchor = el.Attribute(W + "anchor")?.Value;
                    string? href = null;
                    if (rid is not null && _rels.TryGetValue(rid, out var rel) && rel.External) href = rel.Target;
                    else if (!string.IsNullOrEmpty(anchor)) href = "#" + anchor;
                    if (href is not null)
                    {
                        segments[^1].Append("<a href=\"").Append(Enc(href)).Append("\">");
                        RenderInlineChildren(el, segments, inherited);
                        segments[^1].Append("</a>");
                    }
                    else RenderInlineChildren(el, segments, inherited);
                    break;
                }
                case "sdt":
                {
                    var content = el.Element(W + "sdtContent");
                    if (content is not null) RenderInlineChildren(content, segments, inherited);
                    break;
                }
                case "ins":
                case "moveTo":
                case "smartTag":
                case "customXml":
                case "dir":
                case "bdo":
                    RenderInlineChildren(el, segments, inherited);
                    break;
                case "fldSimple":
                    RawInline(el, segments[^1], DescendantText(el));
                    break;
                case "pPr":
                case "bookmarkStart":
                case "bookmarkEnd":
                case "proofErr":
                case "commentRangeStart":
                case "commentRangeEnd":
                case "del":
                case "moveFrom":
                case "permStart":
                case "permEnd":
                case "moveFromRangeStart":
                case "moveFromRangeEnd":
                case "moveToRangeStart":
                case "moveToRangeEnd":
                    break;
                default:
                    RawInline(el, segments[^1], DescendantText(el));
                    break;
            }
        }
    }

    private static bool IsFieldBegin(XElement run) =>
        run.Elements(W + "fldChar").Any(f => f.Attribute(W + "fldCharType")?.Value == "begin");

    private static int FindFieldEnd(List<XElement> siblings, int start)
    {
        var depth = 0;
        for (var i = start; i < siblings.Count; i++)
        {
            foreach (var f in siblings[i].Descendants(W + "fldChar"))
            {
                var type = f.Attribute(W + "fldCharType")?.Value;
                if (type == "begin") depth++;
                else if (type == "end")
                {
                    depth--;
                    if (depth == 0) return i;
                }
            }
        }
        return -1;
    }

    /// <summary>A complex field — its runs from begin to end, kept as one chunk that shows the cached result.</summary>
    private void RawField(List<XElement> siblings, int start, int end, StringBuilder html)
    {
        var xml = new StringBuilder();
        var display = new StringBuilder();
        var afterSeparate = false;
        for (var i = start; i <= end; i++)
        {
            xml.Append(siblings[i].ToString(SaveOptions.DisableFormatting));
            foreach (var d in siblings[i].DescendantsAndSelf())
            {
                if (d.Name == W + "fldChar")
                {
                    var type = d.Attribute(W + "fldCharType")?.Value;
                    if (type == "separate") afterSeparate = true;
                    else if (type == "begin") afterSeparate = false;
                }
                else if (afterSeparate && d.Name == W + "t") display.Append(d.Value);
                else if (afterSeparate && d.Name == W + "tab") display.Append('\t');
            }
        }
        var instr = string.Concat(siblings.Skip(start).Take(end - start + 1)
            .SelectMany(s => s.Descendants(W + "instrText")).Select(t => t.Value)).Trim();
        var shown = display.Length > 0 ? display.ToString() : (instr.Length > 0 ? "{" + instr + "}" : "{field}");
        html.Append("<span class=\"docx-raw\" contenteditable=\"false\" data-docx-raw=\"")
            .Append(B64(xml.ToString()))
            .Append("\" title=\"").Append(Enc("Field: " + instr)).Append("\">")
            .Append(Enc(shown))
            .Append("</span>");
    }

    private static void RawInline(XElement el, StringBuilder html, string display)
    {
        html.Append("<span class=\"docx-raw\" contenteditable=\"false\" data-docx-raw=\"")
            .Append(B64(el.ToString(SaveOptions.DisableFormatting)))
            .Append("\" title=\"").Append(Enc(el.Name.LocalName)).Append("\">")
            .Append(Enc(display.Length > 0 ? display : "◆"))
            .Append("</span>");
    }

    private static string DescendantText(XElement el) =>
        string.Concat(el.Descendants(W + "t").Select(t => t.Value));

    private void RenderRun(XElement run, List<StringBuilder> segments, RunProps inherited)
    {
        var rPr = run.Element(W + "rPr");
        var rStyle = rPr?.Element(W + "rStyle")?.Attribute(W + "val")?.Value;
        var props = RunProps.Empty;
        if (rStyle is not null) props = props.Over(Resolve(rStyle).Run);
        props = props.Over(RunProps.FromXml(rPr));

        // Runs that only make sense as a whole: notes, comments, embedded
        // objects, shapes, anything this reader has no HTML for — and a run
        // mixing text with a picture, which would otherwise be written twice.
        var children = run.Elements().ToList();
        var hasField = children.Any(e => e.Name == W + "fldChar" || e.Name == W + "instrText");
        var hasMedia = children.Any(e => e.Name == W + "drawing" || e.Name == W + "pict");
        var hasText = children.Any(e => e.Name == W + "t" && e.Value.Length > 0);
        var understood = children.All(e => e.Name.Namespace == W && e.Name.LocalName is
            "t" or "tab" or "ptab" or "br" or "cr" or "noBreakHyphen" or "softHyphen" or "sym" or "drawing" or "pict"
            or "rPr" or "lastRenderedPageBreak" or "delText" or "delInstrText" or "fldChar" or "instrText");
        if (hasField)
        {
            // A stray field char outside a matched begin/end pair — drop it.
            return;
        }
        if (!understood || (hasMedia && hasText))
        {
            var glyph = run.Element(W + "footnoteReference") is not null || run.Element(W + "endnoteReference") is not null
                ? "†" : run.Element(W + "commentReference") is not null ? "◎" : DescendantText(run);
            RawInline(run, segments[^1], glyph);
            return;
        }

        var css = props.ToCss();
        var open = css.Length > 0 ? "<span style=\"" + Enc(css) + "\">" : "";
        var close = css.Length > 0 ? "</span>" : "";
        var text = new StringBuilder();

        void Flush()
        {
            if (text.Length == 0) return;
            segments[^1].Append(open).Append(text).Append(close);
            text.Clear();
        }

        foreach (var child in run.Elements())
        {
            if (child.Name.Namespace != W)
            {
                Flush();
                RawInline(child, segments[^1], DescendantText(child));
                continue;
            }
            switch (child.Name.LocalName)
            {
                case "t":
                    text.Append(Enc(child.Value));
                    break;
                case "tab":
                case "ptab":
                    text.Append('\t');
                    break;
                case "br":
                    if (child.Attribute(W + "type")?.Value == "page")
                    {
                        Flush();
                        segments.Add(new StringBuilder());
                    }
                    else text.Append("<br>");
                    break;
                case "cr":
                    text.Append("<br>");
                    break;
                case "noBreakHyphen":
                    text.Append('‑');
                    break;
                case "softHyphen":
                    text.Append('­');
                    break;
                case "sym":
                {
                    var code = child.Attribute(W + "char")?.Value;
                    if (code is not null && int.TryParse(code, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var cp))
                    {
                        if (cp >= 0xF000 && cp <= 0xF0FF) cp -= 0xF000;
                        text.Append(Enc(char.ConvertFromUtf32(cp)));
                    }
                    break;
                }
                case "drawing":
                    Flush();
                    RenderDrawing(run, child, segments[^1]);
                    break;
                case "pict":
                    Flush();
                    RenderPict(run, child, segments[^1]);
                    break;
                case "rPr":
                case "lastRenderedPageBreak":
                case "delText":
                case "delInstrText":
                    break;
                default:
                    Flush();
                    RawInline(child, segments[^1], DescendantText(child));
                    break;
            }
        }
        Flush();
        _ = inherited;
    }

    private void RenderDrawing(XElement run, XElement drawing, StringBuilder html)
    {
        var frame = drawing.Element(Ns.Wp + "inline") ?? drawing.Element(Ns.Wp + "anchor");
        var blip = drawing.Descendants(Ns.A + "blip").FirstOrDefault();
        var embed = blip?.Attribute(Ns.R + "embed")?.Value ?? blip?.Attribute(Ns.R + "link")?.Value;
        var extent = frame?.Element(Ns.Wp + "extent");
        var cx = RunProps.Int(extent?.Attribute("cx")?.Value);
        var cy = RunProps.Int(extent?.Attribute("cy")?.Value);
        var descr = frame?.Element(Ns.Wp + "docPr")?.Attribute("descr")?.Value ?? "";
        var raw = run.ToString(SaveOptions.DisableFormatting);
        if (embed is null || !_rels.TryGetValue(embed, out var rel) || rel.External)
        {
            RawInline(run, html, "[drawing]");
            return;
        }
        EmitImage(html, rel.Target, cx is int w ? w / 9525.0 : null, cy is int h ? h / 9525.0 : null, descr, raw,
            drawing.Element(Ns.Wp + "anchor") is not null);
    }

    private void RenderPict(XElement run, XElement pict, StringBuilder html)
    {
        var data = pict.Descendants(Ns.V + "imagedata").FirstOrDefault();
        var rid = data?.Attribute(Ns.R + "id")?.Value;
        if (rid is null || !_rels.TryGetValue(rid, out var rel) || rel.External)
        {
            RawInline(run, html, DescendantText(pict).Length > 0 ? DescendantText(pict) : "[shape]");
            return;
        }
        double? w = null, h = null;
        var shape = data!.Parent;
        var style = shape?.Attribute("style")?.Value ?? "";
        foreach (var decl in style.Split(';'))
        {
            var colon = decl.IndexOf(':');
            if (colon < 0) continue;
            var name = decl[..colon].Trim();
            var value = decl[(colon + 1)..].Trim();
            if (name == "width") w = CssLengthPx(value);
            else if (name == "height") h = CssLengthPx(value);
        }
        EmitImage(html, rel.Target, w, h, data.Attribute("title")?.Value ?? "", run.ToString(SaveOptions.DisableFormatting), false);
    }

    private static double? CssLengthPx(string value)
    {
        value = value.Trim().ToLowerInvariant();
        double factor;
        string number;
        if (value.EndsWith("pt", StringComparison.Ordinal)) { factor = 96.0 / 72; number = value[..^2]; }
        else if (value.EndsWith("px", StringComparison.Ordinal)) { factor = 1; number = value[..^2]; }
        else if (value.EndsWith("in", StringComparison.Ordinal)) { factor = 96; number = value[..^2]; }
        else if (value.EndsWith("cm", StringComparison.Ordinal)) { factor = 96 / 2.54; number = value[..^2]; }
        else if (value.EndsWith("mm", StringComparison.Ordinal)) { factor = 96 / 25.4; number = value[..^2]; }
        else { factor = 1; number = value; }
        return double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n * factor : null;
    }

    private void EmitImage(StringBuilder html, string target, double? widthPx, double? heightPx, string alt, string rawRun, bool anchored)
    {
        var name = target.TrimStart('/');
        if (name.StartsWith("word/", StringComparison.OrdinalIgnoreCase)) name = name[5..];
        var url = _mediaUrlBase + string.Join('/', name.Split('/').Select(Uri.EscapeDataString));
        html.Append("<img src=\"").Append(Enc(url))
            .Append("\" data-media=\"").Append(Enc(name)).Append('"');
        if (widthPx is double w && w > 0) html.Append(" width=\"").Append(Math.Round(w).ToString(CultureInfo.InvariantCulture)).Append('"');
        if (heightPx is double h && h > 0) html.Append(" height=\"").Append(Math.Round(h).ToString(CultureInfo.InvariantCulture)).Append('"');
        if (alt.Length > 0) html.Append(" alt=\"").Append(Enc(alt)).Append('"');
        if (anchored) html.Append(" data-anchored=\"1\"");
        html.Append(" data-docx-raw=\"").Append(B64(rawRun)).Append("\">");
    }

    // ---------------------------------------------------------------------
    // Tables
    // ---------------------------------------------------------------------

    private void RenderTable(XElement tbl, StringBuilder html)
    {
        var tblPr = tbl.Element(W + "tblPr");
        var styleId = tblPr?.Element(W + "tblStyle")?.Attribute(W + "val")?.Value;
        // Table-level borders, else the style's, else any cell drawing its own
        // (LibreOffice and older Word versions write them per cell).
        var borders = HasBorders(tblPr?.Element(W + "tblBorders")) ?? Resolve(styleId).Borders
            ?? tbl.Elements(W + "tr").SelectMany(r => r.Elements(W + "tc"))
                .Select(c => HasBorders(c.Element(W + "tcPr")?.Element(W + "tcBorders")))
                .Any(b => b == true);

        html.Append("<table data-borders=\"").Append(borders ? '1' : '0').Append('"');
        if (styleId is not null) html.Append(" data-style=\"").Append(Enc(styleId)).Append('"');
        var tblW = tblPr?.Element(W + "tblW");
        var css = new StringBuilder();
        if (tblW is not null)
        {
            var type = tblW.Attribute(W + "type")?.Value;
            var w = RunProps.Int(tblW.Attribute(W + "w")?.Value) ?? 0;
            if (type == "pct" && w > 0) css.Append("width:").Append(RunProps.Pt(w / 50.0)).Append("%;");
            else if (type == "dxa" && w > 0) css.Append("width:").Append(RunProps.Pt(w / 20.0)).Append("pt;");
        }
        var jc = tblPr?.Element(W + "jc")?.Attribute(W + "val")?.Value;
        if (jc is "center") css.Append("margin-left:auto;margin-right:auto;");
        else if (jc is "right" or "end") css.Append("margin-left:auto;");
        if (css.Length > 0) html.Append(" style=\"").Append(Enc(css.ToString())).Append('"');
        html.Append('>');

        var grid = tbl.Element(W + "tblGrid")?.Elements(W + "gridCol").ToList();
        if (grid is { Count: > 0 })
        {
            html.Append("<colgroup>");
            foreach (var col in grid)
            {
                var w = RunProps.Int(col.Attribute(W + "w")?.Value);
                html.Append("<col");
                if (w is int tw && tw > 0) html.Append(" style=\"width:").Append(RunProps.Pt(tw / 20.0)).Append("pt\"");
                html.Append('>');
            }
            html.Append("</colgroup>");
        }

        var rows = tbl.Elements(W + "tr").ToList();
        html.Append("<tbody>");
        for (var r = 0; r < rows.Count; r++)
        {
            html.Append("<tr>");
            var col = 0;
            foreach (var tc in rows[r].Elements(W + "tc"))
            {
                var tcPr = tc.Element(W + "tcPr");
                var span = RunProps.Int(tcPr?.Element(W + "gridSpan")?.Attribute(W + "val")?.Value) ?? 1;
                var vMerge = tcPr?.Element(W + "vMerge");
                if (vMerge is not null && vMerge.Attribute(W + "val")?.Value != "restart")
                {
                    col += span;
                    continue; // covered by a rowspan above
                }
                var rowSpan = 1;
                if (vMerge is not null)
                {
                    for (var rr = r + 1; rr < rows.Count; rr++)
                    {
                        var below = CellAtColumn(rows[rr], col);
                        var bm = below?.Element(W + "tcPr")?.Element(W + "vMerge");
                        if (bm is null || bm.Attribute(W + "val")?.Value == "restart") break;
                        rowSpan++;
                    }
                }

                html.Append("<td");
                if (span > 1) html.Append(" colspan=\"").Append(span).Append('"');
                if (rowSpan > 1) html.Append(" rowspan=\"").Append(rowSpan).Append('"');
                var cellCss = new StringBuilder();
                var tcW = tcPr?.Element(W + "tcW");
                if (tcW?.Attribute(W + "type")?.Value == "dxa" && RunProps.Int(tcW.Attribute(W + "w")?.Value) is int cw && cw > 0)
                    cellCss.Append("width:").Append(RunProps.Pt(cw / 20.0)).Append("pt;");
                var fill = tcPr?.Element(W + "shd")?.Attribute(W + "fill")?.Value;
                if (fill is not null && RunProps.IsHex(fill)) cellCss.Append("background-color:#").Append(fill).Append(';');
                var vAlign = tcPr?.Element(W + "vAlign")?.Attribute(W + "val")?.Value;
                if (vAlign is "center") cellCss.Append("vertical-align:middle;");
                else if (vAlign is "bottom") cellCss.Append("vertical-align:bottom;");
                if (cellCss.Length > 0) html.Append(" style=\"").Append(Enc(cellCss.ToString())).Append('"');
                html.Append('>');

                var inner = new StringBuilder();
                RenderBlocks(tc.Elements().Where(e => e.Name != W + "tcPr"), inner);
                html.Append(inner.Length > 0 ? inner.ToString() : "<p><br></p>");
                html.Append("</td>");
                col += span;
            }
            html.Append("</tr>");
        }
        html.Append("</tbody></table>");
    }

    private static XElement? CellAtColumn(XElement row, int column)
    {
        var col = 0;
        foreach (var tc in row.Elements(W + "tc"))
        {
            var span = RunProps.Int(tc.Element(W + "tcPr")?.Element(W + "gridSpan")?.Attribute(W + "val")?.Value) ?? 1;
            if (column >= col && column < col + span) return tc;
            col += span;
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Page + stylesheet
    // ---------------------------------------------------------------------

    private static WordPageSetup ReadPage(XElement? sectPr)
    {
        if (sectPr is null) return WordPageSetup.A4;
        var size = sectPr.Element(W + "pgSz");
        var mar = sectPr.Element(W + "pgMar");
        var a4 = WordPageSetup.A4;
        return new WordPageSetup(
            RunProps.Int(size?.Attribute(W + "w")?.Value) ?? a4.Width,
            RunProps.Int(size?.Attribute(W + "h")?.Value) ?? a4.Height,
            RunProps.Int(mar?.Attribute(W + "top")?.Value) ?? a4.Top,
            RunProps.Int(mar?.Attribute(W + "right")?.Value) ?? a4.Right,
            RunProps.Int(mar?.Attribute(W + "bottom")?.Value) ?? a4.Bottom,
            RunProps.Int(mar?.Attribute(W + "left")?.Value) ?? a4.Left);
    }

    private string BuildCss()
    {
        var css = new StringBuilder();
        var normal = Resolve(_defaultParaStyle);
        var baseRun = _defaultRun.Over(normal.Run);
        var basePara = _defaultPara.Over(normal.Para);

        css.Append(".docx-body{");
        css.Append("font-family:").Append(RunProps.CssFont(baseRun.Font ?? "Calibri")).Append(';');
        css.Append("font-size:").Append(RunProps.Pt((baseRun.Size ?? 22) / 2.0)).Append("pt;");
        css.Append("color:#").Append(baseRun.Color ?? "000000").Append(';');
        if (baseRun.Bold == true) css.Append("font-weight:bold;");
        if (baseRun.Italic == true) css.Append("font-style:italic;");
        css.Append('}');

        css.Append(".docx-body p,.docx-body h1,.docx-body h2,.docx-body h3,.docx-body h4,.docx-body h5,.docx-body h6,.docx-body ul,.docx-body ol{");
        css.Append("margin-top:").Append(RunProps.Pt((basePara.SpaceBefore ?? 0) / 20.0)).Append("pt;");
        css.Append("margin-bottom:").Append(RunProps.Pt((basePara.SpaceAfter ?? 0) / 20.0)).Append("pt;");
        if (basePara.Line is int line && line > 0)
        {
            if (basePara.LineRule is null or "auto") css.Append("line-height:").Append(RunProps.Pt(line / 240.0)).Append(';');
            else css.Append("line-height:").Append(RunProps.Pt(line / 20.0)).Append("pt;");
        }
        else css.Append("line-height:1.15;");
        if (basePara.Jc is not null) css.Append("text-align:").Append(basePara.Jc == "both" ? "justify" : basePara.Jc).Append(';');
        css.Append('}');
        // List items follow Word's "no space between paragraphs of the same
        // style": the spacing sits on the list as a whole, not between items.
        css.Append(".docx-body li{margin:0;line-height:inherit}.docx-body li ul,.docx-body li ol{margin:0}");

        // Every paragraph style the document defines, resolved through its chain.
        foreach (var style in _styles.Values)
        {
            if (style.Type != "paragraph" || style.Id == _defaultParaStyle) continue;
            var resolved = Resolve(style.Id);
            var rule = resolved.Run.ToCss() + resolved.Para.ToCss();
            if (rule.Length == 0) continue;
            css.Append(Selector(style.Id)).Append('{').Append(rule).Append('}');
        }

        // Gallery styles the document lacks render (and, once used, save) as Word's defaults.
        foreach (var def in WordStyleDefaults.All)
        {
            if (def.Type != "paragraph" || _styles.ContainsKey(def.Id) || def.Css.Length == 0) continue;
            css.Append(Selector(def.Id)).Append('{').Append(def.Css).Append('}');
        }

        // Hyperlinks: the document's own style if it has one, Word's blue otherwise.
        var link = _styles.ContainsKey("Hyperlink") ? Resolve("Hyperlink").Run.ToCss() : WordStyleDefaults.Find("Hyperlink")!.Css;
        css.Append(".docx-body a{").Append(link.Length > 0 ? link : "color:#0563C1;text-decoration:underline;").Append('}');

        return css.ToString();
    }

    private static string Selector(string styleId)
    {
        var sel = $".docx-body [data-style=\"{styleId}\"]";
        if (styleId.Length == 8 && styleId.StartsWith("Heading", StringComparison.Ordinal) && char.IsDigit(styleId[7]))
            sel += $",.docx-body h{styleId[7]}:not([data-style])";
        return sel;
    }

    // ---------------------------------------------------------------------

    private static string Enc(string s) => WebUtility.HtmlEncode(s);

    private static string B64(string xml) => Convert.ToBase64String(Encoding.UTF8.GetBytes(xml));
}
