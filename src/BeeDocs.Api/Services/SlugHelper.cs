using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace BeeDocs.Api.Services;

public static partial class SlugHelper
{
    public static string Slugify(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return "untitled";

        var normalized = value.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalized.Length);
        foreach (var c in normalized)
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            if (category != UnicodeCategory.NonSpacingMark)
                sb.Append(c);
        }

        var cleaned = NonSlugChars().Replace(sb.ToString().Normalize(NormalizationForm.FormC), "-");
        cleaned = MultiDash().Replace(cleaned, "-").Trim('-');
        return string.IsNullOrEmpty(cleaned) ? "untitled" : cleaned;
    }

    [GeneratedRegex(@"[^a-z0-9]+")]
    private static partial Regex NonSlugChars();

    [GeneratedRegex(@"-+")]
    private static partial Regex MultiDash();
}
