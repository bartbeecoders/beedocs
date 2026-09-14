using System.Net;
using System.Text;

namespace BeeDocs.Api.Services.Word;

/// <summary>One node of a parsed HTML fragment: an element, or text when <see cref="Tag"/> is empty.</summary>
public sealed class HtmlNode
{
    public string Tag { get; init; } = "";
    public string? Text { get; init; }
    public Dictionary<string, string> Attrs { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<HtmlNode> Children { get; } = [];

    public bool IsText => Tag.Length == 0;

    public string Attr(string name) => Attrs.TryGetValue(name, out var v) ? v : "";

    public bool HasAttr(string name) => Attrs.ContainsKey(name);

    /// <summary>Concatenated text of the subtree — what a `&lt;td&gt;` says, ignoring markup.</summary>
    public string InnerText()
    {
        var sb = new StringBuilder();
        Collect(this, sb);
        return sb.ToString();

        static void Collect(HtmlNode n, StringBuilder sb)
        {
            if (n.IsText) sb.Append(n.Text);
            foreach (var c in n.Children) Collect(c, sb);
        }
    }

    /// <summary>The inline `style=""` attribute as a property map, lower-cased names, trimmed values.</summary>
    public Dictionary<string, string> Style()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var raw = Attr("style");
        if (raw.Length == 0) return map;
        foreach (var decl in raw.Split(';'))
        {
            var colon = decl.IndexOf(':');
            if (colon <= 0) continue;
            var name = decl[..colon].Trim().ToLowerInvariant();
            var value = decl[(colon + 1)..].Trim();
            if (name.Length > 0 && value.Length > 0) map[name] = value;
        }
        return map;
    }
}

/// <summary>
/// A small, forgiving HTML parser for the fragments the Word editor sends back.
///
/// The browser's <c>innerHTML</c> is nearly XHTML already, but "nearly" is the
/// problem: void elements without a slash, unquoted attributes, bare ampersands
/// in text, and — from an AI agent writing HTML by hand — unclosed paragraphs
/// and list items. Rather than demand well-formed XML of every caller, this
/// tokenizer builds a tree the way a browser would for the subset that matters:
/// unknown tags nest normally, a block opening implicitly closes an open
/// paragraph, a new <c>li</c>/<c>td</c>/<c>tr</c> closes the previous one, and
/// a stray close tag with no match is ignored. Scripts and styles are dropped
/// whole.
/// </summary>
public static class HtmlLite
{
    private static readonly HashSet<string> VoidTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
    };

    private static readonly HashSet<string> DroppedTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "script", "style", "head", "title", "meta", "link", "template", "noscript",
    };

    private static readonly HashSet<string> BlockTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot",
        "tr", "td", "th", "blockquote", "pre", "hr", "section", "article", "header", "footer", "figure",
    };

    private static readonly HashSet<string> InlineTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "font", "i", "ins", "kbd", "mark",
        "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var", "img", "br",
    };

    public static HtmlNode Parse(string html)
    {
        var root = new HtmlNode { Tag = "#root" };
        var stack = new List<HtmlNode> { root };
        var i = 0;
        var text = new StringBuilder();

        void FlushText()
        {
            if (text.Length == 0) return;
            var decoded = WebUtility.HtmlDecode(text.ToString());
            stack[^1].Children.Add(new HtmlNode { Text = decoded });
            text.Clear();
        }

        while (i < html.Length)
        {
            var c = html[i];
            if (c != '<')
            {
                text.Append(c);
                i++;
                continue;
            }

            // Comments and doctype/processing instructions.
            if (html.AsSpan(i).StartsWith("<!--", StringComparison.Ordinal))
            {
                var end = html.IndexOf("-->", i + 4, StringComparison.Ordinal);
                i = end < 0 ? html.Length : end + 3;
                continue;
            }
            if (i + 1 < html.Length && (html[i + 1] == '!' || html[i + 1] == '?'))
            {
                var end = html.IndexOf('>', i + 2);
                i = end < 0 ? html.Length : end + 1;
                continue;
            }

            // Close tag.
            if (i + 1 < html.Length && html[i + 1] == '/')
            {
                var end = html.IndexOf('>', i + 2);
                if (end < 0) { i = html.Length; break; }
                var name = html[(i + 2)..end].Trim().ToLowerInvariant();
                i = end + 1;
                FlushText();
                CloseTo(stack, name);
                continue;
            }

            // Open tag: a '<' not followed by a letter is literal text.
            if (i + 1 >= html.Length || !char.IsLetter(html[i + 1]))
            {
                text.Append(c);
                i++;
                continue;
            }

            var (node, selfClosing, next) = ReadOpenTag(html, i);
            i = next;
            if (node is null) continue;
            FlushText();

            var tag = node.Tag;
            if (DroppedTags.Contains(tag))
            {
                // Skip to the matching close tag; there is no useful content inside.
                var close = html.IndexOf($"</{tag}", i, StringComparison.OrdinalIgnoreCase);
                if (close < 0) { i = html.Length; break; }
                var end = html.IndexOf('>', close);
                i = end < 0 ? html.Length : end + 1;
                continue;
            }

            ImplicitClose(stack, tag);
            stack[^1].Children.Add(node);
            if (!selfClosing && !VoidTags.Contains(tag)) stack.Add(node);
        }

        FlushText();
        return root;
    }

    private static (HtmlNode? Node, bool SelfClosing, int Next) ReadOpenTag(string html, int start)
    {
        var i = start + 1;
        var nameStart = i;
        while (i < html.Length && (char.IsLetterOrDigit(html[i]) || html[i] is '-' or ':')) i++;
        var tag = html[nameStart..i].ToLowerInvariant();
        var node = new HtmlNode { Tag = tag };
        var selfClosing = false;

        while (i < html.Length)
        {
            while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
            if (i >= html.Length) break;
            if (html[i] == '>') { i++; return (node, selfClosing, i); }
            if (html[i] == '/')
            {
                selfClosing = true;
                i++;
                continue;
            }

            var attrStart = i;
            while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '=' && html[i] != '>' && html[i] != '/') i++;
            var attrName = html[attrStart..i].ToLowerInvariant();
            if (attrName.Length == 0) { i++; continue; }

            while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
            var value = "";
            if (i < html.Length && html[i] == '=')
            {
                i++;
                while (i < html.Length && char.IsWhiteSpace(html[i])) i++;
                if (i < html.Length && (html[i] == '"' || html[i] == '\''))
                {
                    var quote = html[i];
                    var end = html.IndexOf(quote, i + 1);
                    if (end < 0) end = html.Length;
                    value = html[(i + 1)..end];
                    i = Math.Min(end + 1, html.Length);
                }
                else
                {
                    var valueStart = i;
                    while (i < html.Length && !char.IsWhiteSpace(html[i]) && html[i] != '>') i++;
                    value = html[valueStart..i];
                }
            }
            node.Attrs[attrName] = WebUtility.HtmlDecode(value);
        }

        return (node, selfClosing, i);
    }

    /// <summary>Pop the stack to (and including) the nearest open element named <paramref name="tag"/>; ignore when none.</summary>
    private static void CloseTo(List<HtmlNode> stack, string tag)
    {
        for (var k = stack.Count - 1; k >= 1; k--)
        {
            if (string.Equals(stack[k].Tag, tag, StringComparison.OrdinalIgnoreCase))
            {
                stack.RemoveRange(k, stack.Count - k);
                return;
            }
        }
    }

    /// <summary>
    /// The handful of "a new X closes the old X" rules a browser applies:
    /// a block opening closes an open paragraph, a list item closes the
    /// previous item in the same list, a cell closes the previous cell in the
    /// row, a row closes the previous row in the table.
    /// </summary>
    private static void ImplicitClose(List<HtmlNode> stack, string tag)
    {
        if (BlockTags.Contains(tag))
            CloseNearest(stack, static t => t == "p", static t => InlineTags.Contains(t));

        switch (tag)
        {
            case "li":
                CloseNearest(stack, static t => t == "li", static t => t is not ("ul" or "ol"));
                break;
            case "td" or "th":
                CloseNearest(stack, static t => t is "td" or "th", static t => t is not ("tr" or "table" or "tbody" or "thead" or "tfoot"));
                break;
            case "tr":
                CloseNearest(stack, static t => t is "td" or "th", static t => t is not ("tr" or "table" or "tbody" or "thead" or "tfoot"));
                CloseNearest(stack, static t => t == "tr", static t => t is not ("table" or "tbody" or "thead" or "tfoot"));
                break;
            case "thead" or "tbody" or "tfoot":
                CloseNearest(stack, static t => t is "td" or "th", static t => t is not "table");
                CloseNearest(stack, static t => t == "tr", static t => t is not "table");
                CloseNearest(stack, static t => t is "thead" or "tbody" or "tfoot", static t => t is not "table");
                break;
        }
    }

    private static void CloseNearest(List<HtmlNode> stack, Func<string, bool> target, Func<string, bool> mayPass)
    {
        for (var k = stack.Count - 1; k >= 1; k--)
        {
            var t = stack[k].Tag;
            if (target(t))
            {
                stack.RemoveRange(k, stack.Count - k);
                return;
            }
            if (!mayPass(t)) return;
        }
    }
}
