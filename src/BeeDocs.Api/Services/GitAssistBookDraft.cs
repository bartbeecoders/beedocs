using System.Text.Json;

namespace BeeDocs.Api.Services;

/// <summary>
/// A multi-page documentation book stored on a git-assist job as JSON in the
/// existing <c>markdown</c> column (single-page kinds stay plain Markdown).
/// Publishing turns each entry into a library page; re-publishing matches by
/// title so the same book is updated in place.
/// </summary>
public sealed class GitAssistBookDraft
{
    public int Version { get; set; } = 1;
    public string BookTitle { get; set; } = "";
    public string? BookDescription { get; set; }
    public List<GitAssistBookPage> Pages { get; set; } = [];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static bool TryParse(string? raw, out GitAssistBookDraft draft)
    {
        draft = new GitAssistBookDraft();
        if (string.IsNullOrWhiteSpace(raw)) return false;

        var json = ExtractJsonObject(raw);
        GitAssistBookDraft? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<GitAssistBookDraft>(json, Json);
        }
        catch (JsonException)
        {
            return false;
        }

        if (parsed is null || parsed.Pages.Count == 0) return false;

        var pages = new List<GitAssistBookPage>();
        foreach (var page in parsed.Pages)
        {
            var title = (page.Title ?? "").Trim();
            var markdown = (page.Markdown ?? "").Trim();
            if (title.Length == 0 || markdown.Length == 0) continue;
            pages.Add(new GitAssistBookPage { Title = title, Markdown = markdown });
        }

        if (pages.Count == 0) return false;

        draft = new GitAssistBookDraft
        {
            Version = parsed.Version > 0 ? parsed.Version : 1,
            BookTitle = string.IsNullOrWhiteSpace(parsed.BookTitle) ? "" : parsed.BookTitle.Trim(),
            BookDescription = string.IsNullOrWhiteSpace(parsed.BookDescription)
                ? null
                : parsed.BookDescription.Trim(),
            Pages = pages,
        };
        return true;
    }

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    /// <summary>
    /// Models wrap JSON in prose or a fence despite being told not to; the
    /// object is whatever sits between the first '{' and the last '}'.
    /// </summary>
    public static string ExtractJsonObject(string text)
    {
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return text.Trim();
        return text[start..(end + 1)];
    }
}

public sealed class GitAssistBookPage
{
    public string Title { get; set; } = "";
    public string Markdown { get; set; } = "";
}
