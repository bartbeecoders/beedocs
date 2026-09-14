using System.Globalization;
using System.Text;
using System.Xml.Linq;

namespace BeeDocs.Api.Services.Word;

/// <summary>WordprocessingML namespaces, shared by the reader and the writer.</summary>
public static class Ns
{
    public static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    public static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    public static readonly XNamespace Wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    public static readonly XNamespace A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    public static readonly XNamespace Pic = "http://schemas.openxmlformats.org/drawingml/2006/picture";
    public static readonly XNamespace V = "urn:schemas-microsoft-com:vml";
    public static readonly XNamespace Mc = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    public static readonly XNamespace Rel = "http://schemas.openxmlformats.org/package/2006/relationships";
    public static readonly XNamespace Ct = "http://schemas.openxmlformats.org/package/2006/content-types";

    public const string RelImage = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
    public const string RelHyperlink = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
    public const string RelNumbering = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering";
    public const string RelStyles = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles";
}

/// <summary>
/// Run formatting as the editor and Word both understand it. Null means "not
/// set here" so a run can inherit from its style; the reader merges style
/// chains with this, the writer fills it from CSS.
/// </summary>
public sealed record RunProps
{
    public bool? Bold { get; init; }
    public bool? Italic { get; init; }
    public bool? Underline { get; init; }
    public bool? Strike { get; init; }
    public bool? Caps { get; init; }
    public bool? SmallCaps { get; init; }
    /// <summary>Hex RRGGBB without '#'.</summary>
    public string? Color { get; init; }
    /// <summary>One of Word's named highlight colours (yellow, green, …).</summary>
    public string? Highlight { get; init; }
    /// <summary>Hex RRGGBB run shading fill.</summary>
    public string? Shading { get; init; }
    /// <summary>Half-points.</summary>
    public int? Size { get; init; }
    public string? Font { get; init; }
    /// <summary>"superscript" | "subscript" | "baseline".</summary>
    public string? VertAlign { get; init; }
    /// <summary>Character spacing in twentieths of a point.</summary>
    public int? Spacing { get; init; }

    public static readonly RunProps Empty = new();

    public RunProps Over(RunProps? overlay)
    {
        if (overlay is null) return this;
        return new RunProps
        {
            Bold = overlay.Bold ?? Bold,
            Italic = overlay.Italic ?? Italic,
            Underline = overlay.Underline ?? Underline,
            Strike = overlay.Strike ?? Strike,
            Caps = overlay.Caps ?? Caps,
            SmallCaps = overlay.SmallCaps ?? SmallCaps,
            Color = overlay.Color ?? Color,
            Highlight = overlay.Highlight ?? Highlight,
            Shading = overlay.Shading ?? Shading,
            Size = overlay.Size ?? Size,
            Font = overlay.Font ?? Font,
            VertAlign = overlay.VertAlign ?? VertAlign,
            Spacing = overlay.Spacing ?? Spacing,
        };
    }

    public bool IsEmpty =>
        Bold is null && Italic is null && Underline is null && Strike is null && Caps is null && SmallCaps is null
        && Color is null && Highlight is null && Shading is null && Size is null && Font is null
        && VertAlign is null && Spacing is null;

    public static RunProps FromXml(XElement? rPr)
    {
        if (rPr is null) return Empty;
        var w = Ns.W;
        string? Val(string name) => rPr.Element(w + name)?.Attribute(w + "val")?.Value;

        var fonts = rPr.Element(w + "rFonts");
        var font = fonts?.Attribute(w + "ascii")?.Value ?? fonts?.Attribute(w + "hAnsi")?.Value;
        var color = Val("color");
        if (color is not null && !IsHex(color)) color = null;
        var shd = rPr.Element(w + "shd")?.Attribute(w + "fill")?.Value;
        if (shd is not null && !IsHex(shd)) shd = null;
        var underline = Val("u");
        var strike = rPr.Element(w + "strike") ?? rPr.Element(w + "dstrike");

        return new RunProps
        {
            Bold = OnOff(rPr.Element(w + "b")),
            Italic = OnOff(rPr.Element(w + "i")),
            Underline = rPr.Element(w + "u") is null ? null : underline is not ("none" or "0"),
            Strike = OnOff(strike),
            Caps = OnOff(rPr.Element(w + "caps")),
            SmallCaps = OnOff(rPr.Element(w + "smallCaps")),
            Color = color?.ToUpperInvariant(),
            Highlight = Val("highlight") is { } h && h != "none" ? h : null,
            Shading = shd?.ToUpperInvariant(),
            Size = Int(Val("sz")),
            Font = string.IsNullOrWhiteSpace(font) ? null : font,
            VertAlign = Val("vertAlign"),
            Spacing = Int(rPr.Element(w + "spacing")?.Attribute(w + "val")?.Value),
        };
    }

    /// <summary>CSS declarations for this formatting, ready for a `style=""` attribute.</summary>
    public string ToCss(bool includeInherited = true)
    {
        var sb = new StringBuilder();
        if (Font is not null) sb.Append("font-family:").Append(CssFont(Font)).Append(';');
        if (Size is int sz) sb.Append("font-size:").Append(Pt(sz / 2.0)).Append("pt;");
        if (Bold is bool b) sb.Append(b ? "font-weight:bold;" : "font-weight:normal;");
        if (Italic is bool i) sb.Append(i ? "font-style:italic;" : "font-style:normal;");
        var deco = new List<string>();
        if (Underline == true) deco.Add("underline");
        if (Strike == true) deco.Add("line-through");
        if (deco.Count > 0) sb.Append("text-decoration:").Append(string.Join(' ', deco)).Append(';');
        else if (Underline == false || Strike == false) sb.Append("text-decoration:none;");
        if (Color is not null) sb.Append("color:#").Append(Color).Append(';');
        if (Highlight is not null && HighlightHex.TryGetValue(Highlight, out var hh)) sb.Append("background-color:#").Append(hh).Append(';');
        else if (Shading is not null) sb.Append("background-color:#").Append(Shading).Append(';');
        if (VertAlign == "superscript") sb.Append("vertical-align:super;font-size:smaller;");
        else if (VertAlign == "subscript") sb.Append("vertical-align:sub;font-size:smaller;");
        if (Caps == true) sb.Append("text-transform:uppercase;");
        if (SmallCaps == true) sb.Append("font-variant:small-caps;");
        if (Spacing is int sp && sp != 0) sb.Append("letter-spacing:").Append(Pt(sp / 20.0)).Append("pt;");
        _ = includeInherited;
        return sb.ToString();
    }

    /// <summary>The `w:rPr` element, children in schema order (Word is picky about it).</summary>
    public string ToXml()
    {
        var sb = new StringBuilder();
        if (Font is not null)
        {
            var f = Xml.Esc(Font);
            sb.Append(CultureInfo.InvariantCulture, $"<w:rFonts w:ascii=\"{f}\" w:hAnsi=\"{f}\" w:cs=\"{f}\"/>");
        }
        if (Bold == true) sb.Append("<w:b/><w:bCs/>");
        else if (Bold == false) sb.Append("<w:b w:val=\"0\"/><w:bCs w:val=\"0\"/>");
        if (Italic == true) sb.Append("<w:i/><w:iCs/>");
        else if (Italic == false) sb.Append("<w:i w:val=\"0\"/><w:iCs w:val=\"0\"/>");
        if (Caps == true) sb.Append("<w:caps/>");
        if (SmallCaps == true) sb.Append("<w:smallCaps/>");
        if (Strike == true) sb.Append("<w:strike/>");
        else if (Strike == false) sb.Append("<w:strike w:val=\"0\"/>");
        if (Color is not null) sb.Append(CultureInfo.InvariantCulture, $"<w:color w:val=\"{Color}\"/>");
        if (Spacing is int sp) sb.Append(CultureInfo.InvariantCulture, $"<w:spacing w:val=\"{sp}\"/>");
        if (Size is int sz) sb.Append(CultureInfo.InvariantCulture, $"<w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/>");
        if (Highlight is not null) sb.Append(CultureInfo.InvariantCulture, $"<w:highlight w:val=\"{Highlight}\"/>");
        if (Underline == true) sb.Append("<w:u w:val=\"single\"/>");
        else if (Underline == false) sb.Append("<w:u w:val=\"none\"/>");
        if (Shading is not null && Highlight is null)
            sb.Append(CultureInfo.InvariantCulture, $"<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"{Shading}\"/>");
        if (VertAlign is "superscript" or "subscript")
            sb.Append(CultureInfo.InvariantCulture, $"<w:vertAlign w:val=\"{VertAlign}\"/>");
        return sb.Length == 0 ? "" : $"<w:rPr>{sb}</w:rPr>";
    }

    /// <summary>Word's sixteen highlighter colours, as it renders them.</summary>
    public static readonly Dictionary<string, string> HighlightHex = new(StringComparer.OrdinalIgnoreCase)
    {
        ["yellow"] = "FFFF00", ["green"] = "00FF00", ["cyan"] = "00FFFF", ["magenta"] = "FF00FF",
        ["blue"] = "0000FF", ["red"] = "FF0000", ["darkBlue"] = "000080", ["darkCyan"] = "008080",
        ["darkGreen"] = "008000", ["darkMagenta"] = "800080", ["darkRed"] = "800000", ["darkYellow"] = "808000",
        ["darkGray"] = "808080", ["lightGray"] = "C0C0C0", ["black"] = "000000", ["white"] = "FFFFFF",
    };

    public static string? HighlightForHex(string hex)
    {
        foreach (var (name, value) in HighlightHex)
            if (string.Equals(value, hex, StringComparison.OrdinalIgnoreCase)) return name;
        return null;
    }

    internal static bool? OnOff(XElement? el)
    {
        if (el is null) return null;
        var v = el.Attribute(Ns.W + "val")?.Value;
        return v is null || v is "1" or "true" or "on";
    }

    internal static int? Int(string? s) =>
        int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;

    internal static bool IsHex(string s) =>
        s.Length == 6 && s.All(Uri.IsHexDigit);

    internal static string Pt(double v) =>
        v.ToString("0.##", CultureInfo.InvariantCulture);

    internal static string CssFont(string font)
    {
        var f = font.Replace("\"", "").Replace("'", "");
        var stack = f switch
        {
            "Calibri" or "Aptos" => $"'{f}', Carlito, 'Segoe UI', Arial, sans-serif",
            "Calibri Light" or "Aptos Display" => $"'{f}', Carlito, 'Segoe UI', Arial, sans-serif",
            "Cambria" or "Georgia" => $"'{f}', Caladea, Georgia, serif",
            "Times New Roman" => $"'{f}', 'Liberation Serif', Tinos, serif",
            "Arial" => "Arial, 'Liberation Sans', Arimo, sans-serif",
            "Consolas" or "Courier New" => $"'{f}', 'Liberation Mono', Cousine, monospace",
            _ => f.Contains(' ') ? $"'{f}'" : f,
        };
        return stack;
    }
}

/// <summary>Paragraph formatting, same conventions as <see cref="RunProps"/>.</summary>
public sealed record ParaProps
{
    /// <summary>left | center | right | both.</summary>
    public string? Jc { get; init; }
    /// <summary>Twips.</summary>
    public int? IndLeft { get; init; }
    public int? IndRight { get; init; }
    public int? IndHanging { get; init; }
    public int? IndFirstLine { get; init; }
    public int? SpaceBefore { get; init; }
    public int? SpaceAfter { get; init; }
    /// <summary>Line spacing value; meaning depends on <see cref="LineRule"/>.</summary>
    public int? Line { get; init; }
    /// <summary>auto (240ths of a line) | exact | atLeast (twips).</summary>
    public string? LineRule { get; init; }
    public bool? KeepNext { get; init; }
    public bool? PageBreakBefore { get; init; }
    public bool? ContextualSpacing { get; init; }
    public string? Shading { get; init; }
    public bool? BottomBorder { get; init; }

    public static readonly ParaProps Empty = new();

    public ParaProps Over(ParaProps? o)
    {
        if (o is null) return this;
        return new ParaProps
        {
            Jc = o.Jc ?? Jc,
            IndLeft = o.IndLeft ?? IndLeft,
            IndRight = o.IndRight ?? IndRight,
            IndHanging = o.IndHanging ?? IndHanging,
            IndFirstLine = o.IndFirstLine ?? IndFirstLine,
            SpaceBefore = o.SpaceBefore ?? SpaceBefore,
            SpaceAfter = o.SpaceAfter ?? SpaceAfter,
            Line = o.Line ?? Line,
            LineRule = o.LineRule ?? LineRule,
            KeepNext = o.KeepNext ?? KeepNext,
            PageBreakBefore = o.PageBreakBefore ?? PageBreakBefore,
            ContextualSpacing = o.ContextualSpacing ?? ContextualSpacing,
            Shading = o.Shading ?? Shading,
            BottomBorder = o.BottomBorder ?? BottomBorder,
        };
    }

    public static ParaProps FromXml(XElement? pPr)
    {
        if (pPr is null) return Empty;
        var w = Ns.W;
        var ind = pPr.Element(w + "ind");
        var spacing = pPr.Element(w + "spacing");
        var shd = pPr.Element(w + "shd")?.Attribute(w + "fill")?.Value;
        var bottom = pPr.Element(w + "pBdr")?.Element(w + "bottom");
        return new ParaProps
        {
            Jc = pPr.Element(w + "jc")?.Attribute(w + "val")?.Value switch
            {
                "center" => "center",
                "right" or "end" => "right",
                "both" or "distribute" => "both",
                "left" or "start" => "left",
                _ => null,
            },
            IndLeft = RunProps.Int(ind?.Attribute(w + "left")?.Value ?? ind?.Attribute(w + "start")?.Value),
            IndRight = RunProps.Int(ind?.Attribute(w + "right")?.Value ?? ind?.Attribute(w + "end")?.Value),
            IndHanging = RunProps.Int(ind?.Attribute(w + "hanging")?.Value),
            IndFirstLine = RunProps.Int(ind?.Attribute(w + "firstLine")?.Value),
            SpaceBefore = RunProps.Int(spacing?.Attribute(w + "before")?.Value),
            SpaceAfter = RunProps.Int(spacing?.Attribute(w + "after")?.Value),
            Line = RunProps.Int(spacing?.Attribute(w + "line")?.Value),
            LineRule = spacing?.Attribute(w + "lineRule")?.Value,
            KeepNext = RunProps.OnOff(pPr.Element(w + "keepNext")),
            PageBreakBefore = RunProps.OnOff(pPr.Element(w + "pageBreakBefore")),
            ContextualSpacing = RunProps.OnOff(pPr.Element(w + "contextualSpacing")),
            Shading = shd is not null && RunProps.IsHex(shd) ? shd.ToUpperInvariant() : null,
            BottomBorder = bottom is not null && bottom.Attribute(w + "val")?.Value is not ("nil" or "none") ? true : null,
        };
    }

    public string ToCss()
    {
        var sb = new StringBuilder();
        if (Jc is not null) sb.Append("text-align:").Append(Jc == "both" ? "justify" : Jc).Append(';');
        if (IndLeft is int l) sb.Append("margin-left:").Append(RunProps.Pt(l / 20.0)).Append("pt;");
        if (IndRight is int r) sb.Append("margin-right:").Append(RunProps.Pt(r / 20.0)).Append("pt;");
        if (IndHanging is int h && h != 0) sb.Append("text-indent:-").Append(RunProps.Pt(h / 20.0)).Append("pt;");
        else if (IndFirstLine is int f && f != 0) sb.Append("text-indent:").Append(RunProps.Pt(f / 20.0)).Append("pt;");
        if (SpaceBefore is int b) sb.Append("margin-top:").Append(RunProps.Pt(b / 20.0)).Append("pt;");
        if (SpaceAfter is int a) sb.Append("margin-bottom:").Append(RunProps.Pt(a / 20.0)).Append("pt;");
        if (Line is int line && line > 0)
        {
            if (LineRule is null or "auto") sb.Append("line-height:").Append(RunProps.Pt(line / 240.0)).Append(';');
            else sb.Append("line-height:").Append(RunProps.Pt(line / 20.0)).Append("pt;");
        }
        if (Shading is not null) sb.Append("background-color:#").Append(Shading).Append(';');
        return sb.ToString();
    }
}

/// <summary>
/// The styles Word ships in every new document, so the editor's gallery always
/// has something to apply and a document written by another tool still gets a
/// real heading style rather than a bold paragraph. Values follow Word's
/// Calibri-era defaults; theme references are avoided because the package may
/// not carry a theme part.
/// </summary>
public static class WordStyleDefaults
{
    public sealed record StyleDef(string Id, string Name, string Type, string Xml, string Css);

    private static StyleDef P(string id, string name, string pPr, string rPr, string css, string? next = "Normal", int? priority = null) =>
        new(id, name, "paragraph",
            $"<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/>"
            + (next is null ? "" : $"<w:next w:val=\"{next}\"/>")
            + (priority is int pr ? $"<w:uiPriority w:val=\"{pr}\"/>" : "")
            + "<w:qFormat/>"
            + (pPr.Length > 0 ? $"<w:pPr>{pPr}</w:pPr>" : "")
            + (rPr.Length > 0 ? $"<w:rPr>{rPr}</w:rPr>" : "")
            + "</w:style>",
            css);

    private const string HeadingFont = "<w:rFonts w:ascii=\"Calibri Light\" w:hAnsi=\"Calibri Light\" w:cs=\"Times New Roman\"/>";
    private const string HeadingFontCss = "font-family:'Calibri Light','Aptos Display',Carlito,'Segoe UI',Arial,sans-serif;";

    public static readonly IReadOnlyList<StyleDef> All =
    [
        P("Heading1", "heading 1", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"240\" w:after=\"0\"/><w:outlineLvl w:val=\"0\"/>",
            HeadingFont + "<w:color w:val=\"2F5496\"/><w:sz w:val=\"32\"/><w:szCs w:val=\"32\"/>",
            HeadingFontCss + "color:#2F5496;font-size:16pt;margin-top:12pt;margin-bottom:0;", priority: 9),
        P("Heading2", "heading 2", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"40\" w:after=\"0\"/><w:outlineLvl w:val=\"1\"/>",
            HeadingFont + "<w:color w:val=\"2F5496\"/><w:sz w:val=\"26\"/><w:szCs w:val=\"26\"/>",
            HeadingFontCss + "color:#2F5496;font-size:13pt;margin-top:2pt;margin-bottom:0;", priority: 9),
        P("Heading3", "heading 3", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"40\" w:after=\"0\"/><w:outlineLvl w:val=\"2\"/>",
            HeadingFont + "<w:color w:val=\"1F3763\"/><w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/>",
            HeadingFontCss + "color:#1F3763;font-size:12pt;margin-top:2pt;margin-bottom:0;", priority: 9),
        P("Heading4", "heading 4", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"40\" w:after=\"0\"/><w:outlineLvl w:val=\"3\"/>",
            HeadingFont + "<w:i/><w:iCs/><w:color w:val=\"2F5496\"/>",
            HeadingFontCss + "color:#2F5496;font-style:italic;margin-top:2pt;margin-bottom:0;", priority: 9),
        P("Heading5", "heading 5", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"40\" w:after=\"0\"/><w:outlineLvl w:val=\"4\"/>",
            HeadingFont + "<w:color w:val=\"2F5496\"/>",
            HeadingFontCss + "color:#2F5496;margin-top:2pt;margin-bottom:0;", priority: 9),
        P("Heading6", "heading 6", "<w:keepNext/><w:keepLines/><w:spacing w:before=\"40\" w:after=\"0\"/><w:outlineLvl w:val=\"5\"/>",
            HeadingFont + "<w:color w:val=\"1F3763\"/>",
            HeadingFontCss + "color:#1F3763;margin-top:2pt;margin-bottom:0;", priority: 9),
        P("Title", "Title", "<w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/><w:contextualSpacing/>",
            HeadingFont + "<w:spacing w:val=\"-10\"/><w:kern w:val=\"28\"/><w:sz w:val=\"56\"/><w:szCs w:val=\"56\"/>",
            HeadingFontCss + "font-size:28pt;letter-spacing:-0.5pt;line-height:1;margin-bottom:0;", priority: 10),
        P("Subtitle", "Subtitle", "<w:numPr><w:ilvl w:val=\"1\"/></w:numPr><w:spacing w:after=\"160\"/>",
            "<w:color w:val=\"5A5A5A\"/><w:spacing w:val=\"15\"/>",
            "color:#5A5A5A;letter-spacing:0.75pt;margin-bottom:8pt;", priority: 11),
        P("Quote", "Quote", "<w:spacing w:before=\"200\"/><w:jc w:val=\"center\"/>",
            "<w:i/><w:iCs/><w:color w:val=\"404040\"/>",
            "font-style:italic;color:#404040;text-align:center;margin-top:10pt;", priority: 29),
        P("NoSpacing", "No Spacing", "<w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/>", "",
            "margin-bottom:0;line-height:1.15;", priority: 1),
        P("ListParagraph", "List Paragraph", "<w:ind w:left=\"720\"/><w:contextualSpacing/>", "",
            "", priority: 34),
        new("TableGrid", "Table Grid", "table",
            "<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:basedOn w:val=\"TableNormal\"/><w:uiPriority w:val=\"39\"/><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/></w:tblBorders></w:tblPr></w:style>",
            ""),
        new("Hyperlink", "Hyperlink", "character",
            "<w:style w:type=\"character\" w:styleId=\"Hyperlink\"><w:name w:val=\"Hyperlink\"/><w:uiPriority w:val=\"99\"/><w:unhideWhenUsed/><w:rPr><w:color w:val=\"0563C1\"/><w:u w:val=\"single\"/></w:rPr></w:style>",
            "color:#0563C1;text-decoration:underline;"),
    ];

    public static StyleDef? Find(string id) =>
        All.FirstOrDefault(s => string.Equals(s.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>Gallery order the editor offers, matching Word's Home ribbon.</summary>
    public static readonly string[] Gallery =
        ["Normal", "NoSpacing", "Heading1", "Heading2", "Heading3", "Title", "Subtitle", "Quote"];
}

internal static class Xml
{
    public static string Esc(string s) => System.Security.SecurityElement.Escape(s) ?? "";
}
