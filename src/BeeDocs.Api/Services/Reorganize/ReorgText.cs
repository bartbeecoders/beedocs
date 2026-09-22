using System.Text;
using System.Text.RegularExpressions;

namespace BeeDocs.Api.Services.Reorganize;

/// <summary>
/// Markdown handling for the reorganiser: page excerpts for the analysis, and
/// the placeholder round trip that keeps embedded blocks away from the model.
/// <para>
/// A fenced block on a BeeDocs page is often not prose at all — a BeeDiagram's
/// JSON, a kanban board, a spreadsheet, a <c>beediagram-ref</c> id. A model
/// asked to "make this simpler" will happily reformat any of those into
/// something that no longer parses. So before a merge or rewrite every fence is
/// swapped for a <c>&lt;&lt;&lt;BLOCK n&gt;&gt;&gt;</c> line, and afterwards the
/// originals are put back byte for byte; any placeholder the model lost is
/// appended at the end rather than silently dropped.
/// </para>
/// </summary>
public static partial class ReorgText
{
    /// <summary>One fenced block, verbatim, fence lines included.</summary>
    public sealed record Block(string Lang, string Raw);

    /// <summary>A grid page (pageLayout.ts) keeps its cells in HTML comment markers a rewrite would lose.</summary>
    public static bool HasGridLayout(string content) =>
        content.Contains("<!-- bee:layout", StringComparison.Ordinal);

    public static int WordCount(string content)
    {
        var prose = StripFences(content, static b => " ");
        return WordRegex().Count(prose);
    }

    /// <summary>
    /// Prose for the analysis bundle: fences become <c>[embedded lang]</c>,
    /// layout markers and runs of blank lines go, and the result is cut at
    /// <paramref name="maxChars"/> with a note of how much was left out.
    /// </summary>
    public static string Excerpt(string content, int maxChars)
    {
        var text = StripFences(content, static b => $"[embedded {(b.Lang.Length == 0 ? "code" : b.Lang)}]");
        text = LayoutMarkerRegex().Replace(text, "");
        text = BlankRunRegex().Replace(text.Replace("\r\n", "\n"), "\n\n").Trim();
        if (text.Length <= maxChars) return text;
        var cut = text.LastIndexOf('\n', maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        return text[..cut].TrimEnd() + $"\n… ({text.Length - cut} more characters)";
    }

    /// <summary>Swap every fence for a numbered placeholder line, collecting the originals.</summary>
    public static string Protect(string content, List<Block> blocks) =>
        StripFences(content, b =>
        {
            blocks.Add(b);
            return $"<<<BLOCK {blocks.Count}>>>";
        });

    /// <summary>
    /// Put the originals back. A placeholder the model repeated is kept once; one
    /// it dropped is appended, so nothing embedded is ever lost to a rewrite.
    /// </summary>
    public static string Restore(string text, IReadOnlyList<Block> blocks)
    {
        var used = new HashSet<int>();
        var restored = PlaceholderRegex().Replace(text, m =>
        {
            if (!int.TryParse(m.Groups[1].Value, out var n) || n < 1 || n > blocks.Count) return "";
            return used.Add(n) ? blocks[n - 1].Raw : "";
        });

        var missing = Enumerable.Range(1, blocks.Count).Where(n => !used.Contains(n)).ToList();
        if (missing.Count == 0) return BlankRunRegex().Replace(restored, "\n\n").Trim() + "\n";

        var sb = new StringBuilder(restored.TrimEnd());
        foreach (var n in missing)
            sb.Append("\n\n").Append(blocks[n - 1].Raw);
        return BlankRunRegex().Replace(sb.ToString(), "\n\n").Trim() + "\n";
    }

    /// <summary>
    /// Walk the Markdown line by line and hand each fenced block (``` or ~~~, at
    /// least three, closed by the same character at least as long) to
    /// <paramref name="replace"/>. An unclosed fence runs to the end, as in
    /// CommonMark.
    /// </summary>
    private static string StripFences(string content, Func<Block, string> replace)
    {
        var lines = content.Replace("\r\n", "\n").Split('\n');
        var sb = new StringBuilder(content.Length);
        for (var i = 0; i < lines.Length; i++)
        {
            var open = FenceOpenRegex().Match(lines[i]);
            if (!open.Success)
            {
                sb.Append(lines[i]);
                if (i < lines.Length - 1) sb.Append('\n');
                continue;
            }

            var marker = open.Groups[1].Value;
            var lang = open.Groups[2].Value.Trim().Split(' ', 2)[0];
            var raw = new StringBuilder(lines[i]);
            var j = i + 1;
            for (; j < lines.Length; j++)
            {
                raw.Append('\n').Append(lines[j]);
                var close = lines[j].TrimStart();
                if (close.Length >= marker.Length
                    && close.TrimEnd().All(c => c == marker[0])
                    && close.TrimEnd().Length >= marker.Length)
                {
                    break;
                }
            }

            sb.Append(replace(new Block(lang, raw.ToString())));
            i = Math.Min(j, lines.Length - 1);
            if (i < lines.Length - 1) sb.Append('\n');
        }

        return sb.ToString();
    }

    [GeneratedRegex(@"^ {0,3}(`{3,}|~{3,})(.*)$")]
    private static partial Regex FenceOpenRegex();

    [GeneratedRegex(@"<<<\s*BLOCK\s+(\d+)\s*>>>")]
    private static partial Regex PlaceholderRegex();

    [GeneratedRegex(@"^\s*<!--\s*bee:[^>]*-->\s*$", RegexOptions.Multiline)]
    private static partial Regex LayoutMarkerRegex();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex BlankRunRegex();

    [GeneratedRegex(@"[\p{L}\p{N}][\p{L}\p{N}'’-]*")]
    private static partial Regex WordRegex();
}
