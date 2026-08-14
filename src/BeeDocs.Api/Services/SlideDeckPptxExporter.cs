using System.IO.Compression;
using System.Security;
using System.Text;
using System.Text.Json;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// Renders a slide-deck document as a PowerPoint (.pptx) file — plain OOXML
/// built by hand over System.IO.Compression, no Office SDK. The same file
/// imports into Google Slides (Drive converts .pptx natively), so one exporter
/// serves both targets.
/// </summary>
/// <remarks>
/// Geometry maps 1:1: the deck's 1280×720 px canvas is exactly the 16:9 slide
/// at 9525 EMU/px (1280·9525 = 12 192 000 EMU). Element array order is z-order
/// in the document and shape order in a pptx spTree, so it carries over as-is.
/// </remarks>
public sealed class SlideDeckPptxExporter(StorageOptions storage)
{
    private const long EmuPerPx = 9525;
    private const long SlideCx = 1280 * EmuPerPx;
    private const long SlideCy = 720 * EmuPerPx;

    public byte[] Export(SlideDeckDto deck)
    {
        var doc = ParseDeck(deck.Source);
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            var imageParts = new List<(string FileName, byte[] Bytes)>();
            var slideXmls = new List<string>();
            var slideRels = new List<string>();

            for (var i = 0; i < doc.Slides.Count; i++)
            {
                var (xml, rels) = BuildSlide(doc, doc.Slides[i], imageParts);
                slideXmls.Add(xml);
                slideRels.Add(rels);
            }

            AddEntry(zip, "[Content_Types].xml", ContentTypes(doc.Slides.Count, imageParts));
            AddEntry(zip, "_rels/.rels", RootRels());
            AddEntry(zip, "docProps/core.xml", CoreProps(deck.Title));
            AddEntry(zip, "docProps/app.xml", AppProps());
            AddEntry(zip, "ppt/presentation.xml", Presentation(doc.Slides.Count));
            AddEntry(zip, "ppt/_rels/presentation.xml.rels", PresentationRels(doc.Slides.Count));
            AddEntry(zip, "ppt/theme/theme1.xml", Theme(doc.FontFamily));
            AddEntry(zip, "ppt/slideMasters/slideMaster1.xml", SlideMaster());
            AddEntry(zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels", SlideMasterRels());
            AddEntry(zip, "ppt/slideLayouts/slideLayout1.xml", SlideLayout());
            AddEntry(zip, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", SlideLayoutRels());

            for (var i = 0; i < slideXmls.Count; i++)
            {
                AddEntry(zip, $"ppt/slides/slide{i + 1}.xml", slideXmls[i]);
                AddEntry(zip, $"ppt/slides/_rels/slide{i + 1}.xml.rels", slideRels[i]);
            }

            foreach (var (fileName, bytes) in imageParts)
            {
                var entry = zip.CreateEntry($"ppt/media/{fileName}", CompressionLevel.Fastest);
                using var stream = entry.Open();
                stream.Write(bytes);
            }
        }

        return buffer.ToArray();
    }

    // ---- deck document ------------------------------------------------------

    private sealed record DeckDoc(string Background, string Color, string FontFamily, List<JsonElement> Slides);

    /// <summary>
    /// Tolerant like the web editor's parseDeck: a missing or broken document
    /// exports as one empty slide rather than failing the download.
    /// </summary>
    private static DeckDoc ParseDeck(string source)
    {
        var background = "#ffffff";
        var color = "#1f2430";
        var font = "Segoe UI";
        var slides = new List<JsonElement>();
        try
        {
            using var doc = JsonDocument.Parse(source);
            var root = doc.RootElement;
            if (root.TryGetProperty("theme", out var theme) && theme.ValueKind == JsonValueKind.Object)
            {
                background = Str(theme, "background") ?? background;
                color = Str(theme, "color") ?? color;
                font = FirstFont(Str(theme, "fontFamily")) ?? font;
            }

            if (root.TryGetProperty("slides", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                slides.AddRange(arr.EnumerateArray().Select(s => s.Clone()));
            }
        }
        catch (JsonException)
        {
        }

        if (slides.Count == 0)
        {
            using var empty = JsonDocument.Parse("""{"elements":[]}""");
            slides.Add(empty.RootElement.Clone());
        }

        return new DeckDoc(background, color, font, slides);
    }

    /// <summary>"'Segoe UI', system-ui, sans-serif" → "Segoe UI".</summary>
    private static string? FirstFont(string? cssList)
    {
        var first = cssList?.Split(',').FirstOrDefault()?.Trim().Trim('\'', '"');
        return string.IsNullOrWhiteSpace(first) ? null : first;
    }

    // ---- slides -------------------------------------------------------------

    private (string Xml, string Rels) BuildSlide(DeckDoc doc, JsonElement slide, List<(string, byte[])> imageParts)
    {
        var shapes = new StringBuilder();
        var rels = new StringBuilder();
        rels.Append("""<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>""");
        var nextRel = 2;
        var nextShapeId = 2; // 1 is the group shape itself

        if (slide.TryGetProperty("elements", out var elements) && elements.ValueKind == JsonValueKind.Array)
        {
            foreach (var el in elements.EnumerateArray())
            {
                var kind = Str(el, "kind") ?? "text";
                if (kind == "image")
                {
                    var relId = EmbedImage(el, imageParts, rels, ref nextRel);
                    if (relId is not null)
                        shapes.Append(PictureXml(nextShapeId++, el, relId));
                    continue;
                }

                shapes.Append(ShapeXml(nextShapeId++, el, kind, doc.Color));
            }
        }

        var background = Str(slide, "background") ?? doc.Background;
        var xml = $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
            <p:cSld><p:bg><p:bgPr><a:solidFill>{Color(background)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>
            <p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
            <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
            {shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>
            """;
        var relsXml = $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>
            """;
        return (xml, relsXml);
    }

    private string? EmbedImage(JsonElement el, List<(string, byte[])> imageParts, StringBuilder rels, ref int nextRel)
    {
        // Only uploads this instance serves can be embedded; an external URL
        // would need a network fetch during export, so it is skipped instead.
        var url = Str(el, "imageUrl");
        if (url is null || !url.StartsWith("/uploads/", StringComparison.Ordinal)) return null;

        var fileName = Path.GetFileName(url);
        var ext = Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();
        if (ext is not ("png" or "jpg" or "jpeg" or "gif" or "webp")) return null;

        var fullPath = Path.Combine(storage.UploadsRoot, fileName);
        if (!File.Exists(fullPath)) return null;

        var partName = $"image{imageParts.Count + 1}.{ext}";
        imageParts.Add((partName, File.ReadAllBytes(fullPath)));

        var relId = $"rId{nextRel++}";
        rels.Append($"""<Relationship Id="{relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{partName}"/>""");
        return relId;
    }

    private static string PictureXml(int id, JsonElement el, string relId)
    {
        return $"""
            <p:pic><p:nvPicPr><p:cNvPr id="{id}" name="Image {id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
            <p:blipFill><a:blip r:embed="{relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
            <p:spPr>{Xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
            """;
    }

    private static string ShapeXml(int id, JsonElement el, string kind, string themeColor)
    {
        var isShape = kind == "shape";
        var shape = isShape ? Str(el, "shape") ?? "rect" : "rect";
        var geom = shape switch
        {
            "rounded" => "roundRect",
            "ellipse" => "ellipse",
            "triangle" => "triangle",
            "diamond" => "diamond",
            "star" => "star5",
            "arrow" => "rightArrow",
            "line" => "line",
            _ => "rect",
        };

        var opacity = Num(el, "opacity");
        var alpha = opacity is null ? (int?)null : (int)Math.Clamp(opacity.Value * 1000, 0, 100000);

        string fill;
        string outline;
        if (shape == "line")
        {
            // The web renderer draws a horizontal rule through the box's middle.
            fill = "<a:noFill/>";
            outline = Outline(Str(el, "stroke") ?? "#1f2430", Num(el, "strokeWidth") ?? 3, alpha);
        }
        else if (isShape)
        {
            var fillColor = Str(el, "fill") ?? "#f59e0b";
            fill = fillColor == "none" ? "<a:noFill/>" : $"<a:solidFill>{Color(fillColor, alpha)}</a:solidFill>";
            var stroke = Str(el, "stroke");
            outline = stroke is null or "none" ? "" : Outline(stroke, Num(el, "strokeWidth") ?? 2, alpha);
        }
        else
        {
            fill = "<a:noFill/>";
            outline = "";
        }

        return $"""
            <p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{(isShape ? "Shape" : "Text")} {id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
            <p:spPr>{Xfrm(el, lineShape: shape == "line")}<a:prstGeom prst="{geom}"><a:avLst/></a:prstGeom>{fill}{outline}</p:spPr>
            {TextBody(el, themeColor, alpha)}</p:sp>
            """;
    }

    private static string Outline(string stroke, double widthPx, int? alpha) =>
        $"""<a:ln w="{(long)(widthPx * EmuPerPx)}"><a:solidFill>{Color(stroke, alpha)}</a:solidFill></a:ln>""";

    private static string Xfrm(JsonElement el, bool lineShape = false)
    {
        var x = Num(el, "x") ?? 0;
        var y = Num(el, "y") ?? 0;
        var w = Num(el, "w") ?? 100;
        var h = Num(el, "h") ?? 100;
        if (lineShape)
        {
            // Collapse the box to its horizontal midline, matching the renderer.
            y += h / 2;
            h = 0;
        }

        var rotation = Num(el, "rotation") ?? 0;
        var rot = rotation == 0 ? "" : $" rot=\"{(long)Math.Round(((rotation % 360 + 360) % 360) * 60000)}\"";
        return $"""<a:xfrm{rot}><a:off x="{(long)(x * EmuPerPx)}" y="{(long)(y * EmuPerPx)}"/><a:ext cx="{(long)(w * EmuPerPx)}" cy="{(long)(h * EmuPerPx)}"/></a:xfrm>""";
    }

    private static string TextBody(JsonElement el, string themeColor, int? alpha)
    {
        var text = Str(el, "text");
        var anchor = Str(el, "valign") switch { "middle" => "ctr", "bottom" => "b", _ => "t" };
        if (string.IsNullOrEmpty(text))
        {
            return $"""<p:txBody><a:bodyPr anchor="{anchor}" wrap="square"/><a:lstStyle/><a:p/></p:txBody>""";
        }

        var align = Str(el, "align") switch { "center" => "ctr", "right" => "r", _ => "l" };
        // px → hundredths of a point (96 px/in vs 72 pt/in).
        var sz = (int)Math.Round((Num(el, "fontSize") ?? 28) * 0.75 * 100);
        var bold = Bool(el, "bold") ? " b=\"1\"" : "";
        var italic = Bool(el, "italic") ? " i=\"1\"" : "";
        var underline = Bool(el, "underline") ? " u=\"sng\"" : "";
        var color = Str(el, "color") ?? themeColor;
        var font = FirstFont(Str(el, "fontFamily"));
        var latin = font is null ? "" : $"""<a:latin typeface="{Escape(font)}"/>""";
        var rPr = $"""<a:rPr lang="en-US" sz="{sz}"{bold}{italic}{underline} dirty="0"><a:solidFill>{Color(color, alpha)}</a:solidFill>{latin}</a:rPr>""";

        var paragraphs = new StringBuilder();
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            paragraphs.Append(line.Length == 0
                ? $"""<a:p><a:pPr algn="{align}"/><a:endParaRPr lang="en-US" sz="{sz}"/></a:p>"""
                : $"""<a:p><a:pPr algn="{align}"/><a:r>{rPr}<a:t>{Escape(line)}</a:t></a:r></a:p>""");
        }

        return $"""<p:txBody><a:bodyPr anchor="{anchor}" wrap="square"/><a:lstStyle/>{paragraphs}</p:txBody>""";
    }

    // ---- fixed parts --------------------------------------------------------

    private static string ContentTypes(int slideCount, List<(string FileName, byte[])> images)
    {
        var overrides = new StringBuilder();
        for (var i = 1; i <= slideCount; i++)
        {
            overrides.Append($"""<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>""");
        }

        var imageDefaults = new StringBuilder();
        foreach (var ext in images.Select(m => Path.GetExtension(m.FileName).TrimStart('.')).Distinct())
        {
            var mime = ext switch { "jpg" or "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => "image/png" };
            imageDefaults.Append($"""<Default Extension="{ext}" ContentType="{mime}"/>""");
        }

        return $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>{imageDefaults}
            <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
            <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
            <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
            <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
            <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
            <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
            {overrides}</Types>
            """;
    }

    private static string RootRels() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
        </Relationships>
        """;

    private static string CoreProps(string title) => $"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <dc:title>{Escape(title)}</dc:title><dc:creator>BeeDocs</dc:creator>
        <dcterms:created xsi:type="dcterms:W3CDTF">{DateTimeOffset.UtcNow:yyyy-MM-ddTHH:mm:ssZ}</dcterms:created>
        </cp:coreProperties>
        """;

    private static string AppProps() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
        <Application>BeeDocs</Application></Properties>
        """;

    private static string Presentation(int slideCount)
    {
        var slideIds = new StringBuilder();
        for (var i = 0; i < slideCount; i++)
        {
            slideIds.Append($"""<p:sldId id="{256 + i}" r:id="rId{i + 2}"/>""");
        }

        return $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
            <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
            <p:sldIdLst>{slideIds}</p:sldIdLst>
            <p:sldSz cx="{SlideCx}" cy="{SlideCy}"/><p:notesSz cx="{SlideCy}" cy="{SlideCx}"/>
            </p:presentation>
            """;
    }

    private static string PresentationRels(int slideCount)
    {
        var rels = new StringBuilder();
        rels.Append("""<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>""");
        for (var i = 0; i < slideCount; i++)
        {
            rels.Append($"""<Relationship Id="rId{i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i + 1}.xml"/>""");
        }

        rels.Append($"""<Relationship Id="rId{slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>""");
        return $"""
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>
            """;
    }

    private static string SlideMaster() => $"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
        <p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
        </p:spTree></p:cSld>
        <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
        <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
        </p:sldMaster>
        """;

    private static string SlideMasterRels() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
        </Relationships>
        """;

    private static string SlideLayout() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
        <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
        </p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>
        """;

    private static string SlideLayoutRels() => """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
        </Relationships>
        """;

    private static string Theme(string fontFamily) => $"""
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="BeeDocs">
        <a:themeElements>
        <a:clrScheme name="BeeDocs"><a:dk1><a:srgbClr val="1F2430"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2430"/></a:dk2><a:lt2><a:srgbClr val="F4F4F5"/></a:lt2><a:accent1><a:srgbClr val="F59E0B"/></a:accent1><a:accent2><a:srgbClr val="34D399"/></a:accent2><a:accent3><a:srgbClr val="60A5FA"/></a:accent3><a:accent4><a:srgbClr val="F472B6"/></a:accent4><a:accent5><a:srgbClr val="A78BFA"/></a:accent5><a:accent6><a:srgbClr val="FBBF24"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
        <a:fontScheme name="BeeDocs"><a:majorFont><a:latin typeface="{Escape(fontFamily)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="{Escape(fontFamily)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
        <a:fmtScheme name="BeeDocs">
        <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
        <a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
        <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
        <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
        </a:fmtScheme></a:themeElements></a:theme>
        """;

    // ---- primitives ---------------------------------------------------------

    private static void AddEntry(ZipArchive zip, string path, string xml)
    {
        var entry = zip.CreateEntry(path, CompressionLevel.Fastest);
        using var stream = entry.Open();
        // The parts are authored with newlines for readability; OOXML ignores
        // inter-element whitespace, but a leading newline before the XML
        // declaration would not be ignored, so trim it.
        stream.Write(Encoding.UTF8.GetBytes(xml.TrimStart()));
    }

    private static string Color(string hex, int? alpha = null)
    {
        var clean = hex.TrimStart('#');
        if (clean.Length == 3)
            clean = string.Concat(clean.Select(c => $"{c}{c}"));
        if (clean.Length != 6 || !clean.All(Uri.IsHexDigit))
            clean = "000000";
        var alphaXml = alpha is null or >= 100000 ? "" : $"""<a:alpha val="{alpha}"/>""";
        return $"""<a:srgbClr val="{clean.ToUpperInvariant()}">{alphaXml}</a:srgbClr>""";
    }

    private static string Escape(string value) => SecurityElement.Escape(value);

    private static string? Str(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString()
            : null;

    private static double? Num(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number
            ? p.GetDouble()
            : null;

    private static bool Bool(JsonElement el, string name) =>
        el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.True;
}
