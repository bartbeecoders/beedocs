using System.Text;
using System.Text.RegularExpressions;

namespace BeeDocs.Api.Services;

/// <summary>
/// A small block/inline model for the GFM subset BeeDocs pages actually use.
/// It exists so the DOCX writer has something structured to walk; it is not a
/// general-purpose Markdown implementation.
///
/// Deliberately flat: nested lists are emitted as separate items rather than
/// nested ones, matching what the browser-side PDF exporter does.
/// </summary>
public static partial class MarkdownDoc
{
    public abstract record Block;

    public sealed record HeadingBlock(int Level, IReadOnlyList<Inline> Inlines) : Block;

    public sealed record ParagraphBlock(IReadOnlyList<Inline> Inlines) : Block;

    public sealed record QuoteBlock(IReadOnlyList<Inline> Inlines) : Block;

    /// <param name="Language">Fence info string, lowercased. Empty for plain fences.</param>
    public sealed record CodeBlock(string Language, string Text) : Block;

    public sealed record ListItem(IReadOnlyList<Inline> Inlines, int Depth);

    public sealed record ListBlock(bool Ordered, IReadOnlyList<ListItem> Items) : Block;

    public sealed record TableBlock(
        IReadOnlyList<IReadOnlyList<Inline>> Header,
        IReadOnlyList<IReadOnlyList<IReadOnlyList<Inline>>> Rows
    ) : Block;

    public sealed record RuleBlock : Block;

    public abstract record Inline;

    public sealed record TextRun(
        string Text,
        bool Bold = false,
        bool Italic = false,
        bool Code = false,
        bool Strike = false
    ) : Inline;

    public sealed record LinkRun(string Text, string Url) : Inline;

    public sealed record ImageRun(string Alt, string Url) : Inline;

    [GeneratedRegex(@"^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$", RegexOptions.Multiline)]
    private static partial Regex FenceRegex();

    [GeneratedRegex(@"^(#{1,6})\s+(.*)$")]
    private static partial Regex HeadingRegex();

    [GeneratedRegex(@"^(\s*)([-*+])\s+(.*)$")]
    private static partial Regex BulletRegex();

    [GeneratedRegex(@"^(\s*)(\d+)[.)]\s+(.*)$")]
    private static partial Regex OrderedRegex();

    [GeneratedRegex(@"^(-{3,}|\*{3,}|_{3,})$")]
    private static partial Regex RuleRegex();

    [GeneratedRegex(@"^:?-{2,}:?$")]
    private static partial Regex TableSeparatorRegex();

    /// <summary>Split Markdown into blocks, keeping fenced code verbatim.</summary>
    public static List<Block> Parse(string markdown)
    {
        var src = (markdown ?? string.Empty).Replace("\r\n", "\n");
        var blocks = new List<Block>();
        var last = 0;

        foreach (Match m in FenceRegex().Matches(src))
        {
            if (m.Index > last)
                ParseProse(src[last..m.Index], blocks);

            var lang = (m.Groups[1].Value ?? string.Empty).Trim().Split(' ', '\t')[0].ToLowerInvariant();
            var body = m.Groups[2].Value.TrimEnd('\n');
            blocks.Add(new CodeBlock(lang, body));
            last = m.Index + m.Length;
        }

        if (last < src.Length)
            ParseProse(src[last..], blocks);

        return blocks;
    }

    private static void ParseProse(string text, List<Block> blocks)
    {
        if (string.IsNullOrWhiteSpace(text)) return;

        var lines = text.Split('\n');
        var i = 0;

        while (i < lines.Length)
        {
            var raw = lines[i];
            var line = raw.Trim();

            if (line.Length == 0)
            {
                i++;
                continue;
            }

            // Table: a run of lines that start and end with a pipe.
            if (line.StartsWith('|') && line.EndsWith('|') && line.Length > 1)
            {
                var rows = new List<List<string>>();
                while (i < lines.Length)
                {
                    var t = lines[i].Trim();
                    if (!t.StartsWith('|') || !t.EndsWith('|') || t.Length <= 1) break;
                    rows.Add(SplitTableRow(t));
                    i++;
                }
                if (rows.Count > 0)
                    blocks.Add(BuildTable(rows));
                continue;
            }

            var heading = HeadingRegex().Match(line);
            if (heading.Success)
            {
                blocks.Add(new HeadingBlock(heading.Groups[1].Value.Length, ParseInlines(heading.Groups[2].Value)));
                i++;
                continue;
            }

            if (RuleRegex().IsMatch(line))
            {
                blocks.Add(new RuleBlock());
                i++;
                continue;
            }

            if (line.StartsWith('>'))
            {
                var quote = new List<string>();
                while (i < lines.Length && lines[i].Trim().StartsWith('>'))
                {
                    quote.Add(lines[i].Trim().TrimStart('>').TrimStart());
                    i++;
                }
                blocks.Add(new QuoteBlock(ParseInlines(string.Join(" ", quote))));
                continue;
            }

            var bullet = BulletRegex().Match(raw);
            var ordered = OrderedRegex().Match(raw);
            if (bullet.Success || ordered.Success)
            {
                var isOrdered = ordered.Success;
                var items = new List<ListItem>();
                while (i < lines.Length)
                {
                    var b = BulletRegex().Match(lines[i]);
                    var o = OrderedRegex().Match(lines[i]);
                    var match = isOrdered ? o : b;
                    // A different marker type ends the list.
                    if (!match.Success || (isOrdered ? b.Success && !o.Success : o.Success && !b.Success))
                        break;

                    var indent = match.Groups[1].Value.Replace("\t", "    ").Length;
                    var content = match.Groups[isOrdered ? 3 : 3].Value;
                    items.Add(new ListItem(ParseInlines(content), Math.Min(indent / 2, 4)));
                    i++;
                }
                blocks.Add(new ListBlock(isOrdered, items));
                continue;
            }

            // Paragraph: consume until a blank line or a line that starts a new block.
            var para = new List<string> { line };
            i++;
            while (i < lines.Length)
            {
                var t = lines[i].Trim();
                if (t.Length == 0) break;
                if (HeadingRegex().IsMatch(t) || RuleRegex().IsMatch(t) || t.StartsWith('>')
                    || t.StartsWith('|') || BulletRegex().IsMatch(lines[i]) || OrderedRegex().IsMatch(lines[i]))
                    break;
                para.Add(t);
                i++;
            }
            blocks.Add(new ParagraphBlock(ParseInlines(string.Join(" ", para))));
        }
    }

    private static List<string> SplitTableRow(string line)
    {
        var inner = line[1..^1];
        return [.. inner.Split('|').Select(c => c.Trim())];
    }

    private static TableBlock BuildTable(List<List<string>> rows)
    {
        var header = rows[0].Select(ParseInlines).Cast<IReadOnlyList<Inline>>().ToList();
        var body = new List<IReadOnlyList<IReadOnlyList<Inline>>>();
        foreach (var row in rows.Skip(1))
        {
            // Skip the |---|---| separator row.
            if (row.Count > 0 && row.All(c => TableSeparatorRegex().IsMatch(c.Trim()) || c.Trim() is "-" or ":-" or "-:" or ":-:"))
                continue;
            body.Add([.. row.Select(ParseInlines).Cast<IReadOnlyList<Inline>>()]);
        }
        return new TableBlock(header, body);
    }

    /// <summary>Inline emphasis, code spans, links and images.</summary>
    public static List<Inline> ParseInlines(string text)
    {
        var result = new List<Inline>();
        if (string.IsNullOrEmpty(text)) return result;

        var buffer = new StringBuilder();
        var bold = false;
        var italic = false;
        var strike = false;
        var i = 0;

        void Flush()
        {
            if (buffer.Length == 0) return;
            result.Add(new TextRun(buffer.ToString(), bold, italic, false, strike));
            buffer.Clear();
        }

        while (i < text.Length)
        {
            var c = text[i];

            // Escaped character
            if (c == '\\' && i + 1 < text.Length)
            {
                buffer.Append(text[i + 1]);
                i += 2;
                continue;
            }

            // Code span
            if (c == '`')
            {
                var end = text.IndexOf('`', i + 1);
                if (end > i)
                {
                    Flush();
                    result.Add(new TextRun(text[(i + 1)..end], bold, italic, true, strike));
                    i = end + 1;
                    continue;
                }
            }

            // Image ![alt](url)
            if (c == '!' && i + 1 < text.Length && text[i + 1] == '[')
            {
                var parsed = TryParseLink(text, i + 1, out var alt, out var url, out var next);
                if (parsed)
                {
                    Flush();
                    result.Add(new ImageRun(alt, url));
                    i = next;
                    continue;
                }
            }

            // Link [text](url)
            if (c == '[')
            {
                var parsed = TryParseLink(text, i, out var label, out var url, out var next);
                if (parsed)
                {
                    Flush();
                    result.Add(new LinkRun(label, url));
                    i = next;
                    continue;
                }
            }

            if (c == '*' || c == '_')
            {
                var doubled = i + 1 < text.Length && text[i + 1] == c;
                if (doubled)
                {
                    Flush();
                    bold = !bold;
                    i += 2;
                    continue;
                }
                Flush();
                italic = !italic;
                i++;
                continue;
            }

            if (c == '~' && i + 1 < text.Length && text[i + 1] == '~')
            {
                Flush();
                strike = !strike;
                i += 2;
                continue;
            }

            buffer.Append(c);
            i++;
        }

        Flush();
        return result;
    }

    /// <summary>
    /// Parse <c>[label](url)</c> starting at the '['. Handles nested brackets in
    /// the label and balanced parentheses in the URL.
    /// </summary>
    private static bool TryParseLink(string text, int start, out string label, out string url, out int next)
    {
        label = string.Empty;
        url = string.Empty;
        next = start;

        var depth = 0;
        var close = -1;
        for (var i = start; i < text.Length; i++)
        {
            if (text[i] == '[') depth++;
            else if (text[i] == ']')
            {
                depth--;
                if (depth == 0) { close = i; break; }
            }
        }
        if (close < 0 || close + 1 >= text.Length || text[close + 1] != '(') return false;

        var paren = 0;
        var end = -1;
        for (var i = close + 1; i < text.Length; i++)
        {
            if (text[i] == '(') paren++;
            else if (text[i] == ')')
            {
                paren--;
                if (paren == 0) { end = i; break; }
            }
        }
        if (end < 0) return false;

        label = text[(start + 1)..close];
        var target = text[(close + 2)..end].Trim();

        // Strip an optional title: (/img.png "Caption")
        var space = target.IndexOf(' ');
        if (space > 0) target = target[..space];

        url = target;
        next = end + 1;
        return true;
    }

    /// <summary>Flatten inlines to plain text (used for headings, alt text, TOC entries).</summary>
    public static string ToPlainText(IEnumerable<Inline> inlines)
    {
        var sb = new StringBuilder();
        foreach (var inline in inlines)
        {
            switch (inline)
            {
                case TextRun t: sb.Append(t.Text); break;
                case LinkRun l: sb.Append(l.Text); break;
                case ImageRun img: sb.Append(img.Alt); break;
            }
        }
        return sb.ToString();
    }
}
