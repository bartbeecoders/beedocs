using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// "Cloud points": the most common words across the documents of a book or a
/// shelf, for the word cloud on their overview pages.
/// <para>
/// Counted from the search index rather than from the entities themselves:
/// <c>search_doc</c> already holds every document kind as plain text — Markdown
/// reduced to prose, diagrams to their shape labels, PDFs and Word files to
/// their extracted text — so the cloud covers exactly what search covers and
/// needs no second extractor. Visibility is search's too
/// (<see cref="Privacy.SearchSql"/>): a word only counts from documents the
/// caller could find.
/// </para>
/// <para>
/// Results are cached per scope and viewer, keyed by a cheap signature of the
/// scope's index rows (count + newest <c>indexed_at</c>), so a book is only
/// re-counted after something in it changed.
/// </para>
/// </summary>
public sealed partial class WordCloudService(
    SqliteConnectionFactory db,
    ISearchIndexService search,
    ICurrentUserAccessor currentUser)
{
    public const int DefaultLimit = 60;
    private const int MaxLimit = 150;

    /// <summary>Per document: enough for any real page, a ceiling on a 256 KB extracted PDF.</summary>
    private const int MaxCharsPerDocument = 200_000;

    /// <summary>The documents a book holds — not the book/folder/shelf rows, whose text is only a description.</summary>
    private const string DocumentKinds = "'page', 'diagram', 'slides', 'kanban', 'project', 'note', 'attachment'";

    private readonly ConcurrentDictionary<string, (string Signature, WordCloudDto Cloud)> _cache = new();

    public Task<WordCloudDto> ForBookAsync(string bookId, int? limit, CancellationToken ct = default) =>
        BuildAsync("book", bookId, "d.book_id = $scope_id", limit, ct);

    public Task<WordCloudDto> ForShelfAsync(string shelfId, int? limit, CancellationToken ct = default) =>
        BuildAsync("shelf", shelfId, "d.book_id IN (SELECT id FROM book WHERE shelf_id = $scope_id)", limit, ct);

    private async Task<WordCloudDto> BuildAsync(
        string scope, string scopeId, string scopeSql, int? limit, CancellationToken ct)
    {
        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var actor = currentUser.Current;
        var privacy = Privacy.SearchSql(actor, publicOnly: false);

        // The index is only as fresh as its queue; normally a no-op.
        await search.DrainAsync(ct);

        await using var conn = await db.OpenConnectionAsync(ct);

        string signature;
        await using (var sig = conn.CreateCommand())
        {
            sig.CommandText = $"""
                SELECT COUNT(*), COALESCE(MAX(d.indexed_at), '')
                FROM search_doc d
                WHERE d.kind IN ({DocumentKinds}) AND {scopeSql}{privacy}
                """;
            SqliteHelpers.Add(sig, "$scope_id", scopeId);
            Privacy.BindViewer(sig, actor);
            await using var r = await sig.ExecuteReaderAsync(ct);
            await r.ReadAsync(ct);
            signature = $"{r.GetInt64(0)}|{r.GetString(1)}|{take}";
        }

        // Different viewers can see different documents, so they get different clouds.
        var cacheKey = $"{scope}:{scopeId}:{(Privacy.Bypass(actor) ? "*" : actor.Id ?? "")}";
        if (_cache.TryGetValue(cacheKey, out var cached) && cached.Signature == signature)
            return cached.Cloud;

        var counts = new Dictionary<string, WordTally>(StringComparer.Ordinal);
        var documents = 0;
        var totalWords = 0;
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = $"""
                SELECT d.title, d.body
                FROM search_doc d
                WHERE d.kind IN ({DocumentKinds}) AND {scopeSql}{privacy}
                """;
            SqliteHelpers.Add(cmd, "$scope_id", scopeId);
            Privacy.BindViewer(cmd, actor);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                documents++;
                var text = reader.GetString(0) + "\n" + reader.GetString(1);
                if (text.Length > MaxCharsPerDocument) text = text[..MaxCharsPerDocument];
                foreach (Match m in WordRegex().Matches(text))
                {
                    var surface = TrimWord(m.Value);
                    if (!IsCandidate(surface)) continue;
                    totalWords++;
                    var key = surface.ToLower(CultureInfo.InvariantCulture);
                    if (Stopwords.Contains(key)) continue;
                    if (!counts.TryGetValue(key, out var tally))
                        counts[key] = tally = new WordTally();
                    tally.Count++;
                    tally.Forms[surface] = tally.Forms.GetValueOrDefault(surface) + 1;
                    tally.DocIds.Add(documents);
                }
            }
        }

        FoldPlurals(counts);

        var words = counts
            .OrderByDescending(kv => kv.Value.Count)
            .ThenByDescending(kv => kv.Value.DocIds.Count)
            .ThenBy(kv => kv.Key, StringComparer.Ordinal)
            .Take(take)
            // Show the spelling people actually use most: "API", not "api".
            .Select(kv => new WordCloudEntryDto(
                kv.Value.Forms.OrderByDescending(f => f.Value).ThenBy(f => f.Key, StringComparer.Ordinal).First().Key,
                kv.Value.Count,
                kv.Value.DocIds.Count))
            .ToList();

        var cloud = new WordCloudDto(scope, scopeId, documents, totalWords, words);
        _cache[cacheKey] = (signature, cloud);
        return cloud;
    }

    private sealed class WordTally
    {
        public int Count;
        /// <summary>Which documents (by read order) use the word — a set, so folding two words stays exact.</summary>
        public HashSet<int> DocIds { get; } = [];
        public Dictionary<string, int> Forms { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>
    /// "microservices" counts as "microservice", "policies" as "policy" — but
    /// only when the singular occurs too, so words that merely end in s
    /// ("status", "Kubernetes") are left alone. English only; other languages'
    /// plurals are too irregular to guess without a real stemmer.
    /// </summary>
    private static void FoldPlurals(Dictionary<string, WordTally> counts)
    {
        foreach (var key in counts.Keys.ToList())
        {
            if (key.Length < 5 || !key.EndsWith('s') || key.EndsWith("ss", StringComparison.Ordinal)) continue;
            var singular = key.EndsWith("ies", StringComparison.Ordinal) && counts.ContainsKey(key[..^3] + "y")
                ? key[..^3] + "y"
                : key[..^1];
            if (!counts.TryGetValue(singular, out var target)) continue;
            var plural = counts[key];
            target.Count += plural.Count;
            target.DocIds.UnionWith(plural.DocIds);
            // Displayed in the singular's own most common spelling.
            counts.Remove(key);
        }
    }

    private static string TrimWord(string word)
    {
        // Possessives count as the word itself: "BeeDocs's" → "BeeDocs".
        if (word.EndsWith("'s", StringComparison.OrdinalIgnoreCase) || word.EndsWith("’s", StringComparison.OrdinalIgnoreCase))
            word = word[..^2];
        return word.Trim('\'', '’', '-', '_');
    }

    /// <summary>
    /// Three letters or more, and mostly letters — ids, hashes, version strings
    /// and port numbers are noise in a cloud even when they repeat.
    /// </summary>
    private static bool IsCandidate(string word)
    {
        if (word.Length < 3 || word.Length > 40) return false;
        var letters = 0;
        var digits = 0;
        foreach (var c in word)
        {
            if (char.IsLetter(c)) letters++;
            else if (char.IsDigit(c)) digits++;
        }
        return letters >= 3 && digits * 2 <= letters;
    }

    [GeneratedRegex(@"\p{L}[\p{L}\p{M}\p{N}'’_-]*")]
    private static partial Regex WordRegex();

    /// <summary>
    /// Function words for the UI's languages that have them spelled out (English,
    /// French, German, Spanish, Dutch), plus the leftovers of links and file
    /// names that survive into indexed text.
    /// </summary>
    private static readonly HashSet<string> Stopwords = new(StringComparer.Ordinal)
    {
        // English
        "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one", "our",
        "out", "has", "have", "had", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two",
        "way", "who", "did", "get", "got", "let", "put", "say", "she", "too", "use", "used", "uses", "using",
        "with", "this", "that", "from", "they", "them", "then", "than", "there", "their", "these", "those",
        "what", "when", "where", "which", "while", "will", "would", "could", "should", "shall", "must",
        "been", "being", "were", "does", "done", "doing", "into", "onto", "about", "above", "below",
        "after", "before", "again", "also", "just", "only", "very", "more", "most", "much", "many",
        "some", "such", "each", "every", "other", "another", "same", "both", "either", "neither", "own",
        "here", "why", "because", "until", "over", "under", "between", "through", "during", "without",
        "within", "upon", "via", "per", "your", "yours", "ours", "mine", "whose", "whom", "itself",
        "yourself", "ourselves", "themselves", "himself", "herself", "myself", "ever", "never", "always",
        "often", "still", "yet", "even", "well", "like", "make", "makes", "made", "need", "needs",
        "want", "wants", "first", "last", "next", "back", "down", "off", "able", "etc", "e.g", "i.e",
        "one's", "don't", "doesn't", "isn't", "aren't", "can't", "won't", "it's", "that's", "there's",
        "you're", "we're", "they're", "i'm", "you'll", "we'll", "will", "shan't", "wasn't", "weren't",
        // French
        "les", "des", "une", "est", "pas", "que", "qui", "dans", "pour", "par", "sur", "avec", "sans",
        "sont", "ont", "aux", "ces", "ses", "son", "sa", "leur", "leurs", "mais", "donc", "car", "comme",
        "plus", "moins", "tout", "tous", "toute", "toutes", "cette", "cet", "nous", "vous", "ils", "elles",
        "elle", "être", "avoir", "fait", "faire", "peut", "entre", "vers", "chez", "aussi", "très",
        // German
        "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "einen", "einem", "einer", "eines",
        "mit", "von", "für", "auf", "den", "dem", "des", "sich", "auch", "als", "wie", "aus", "bei",
        "nach", "oder", "aber", "wenn", "noch", "nur", "sind", "wird", "werden", "wurde", "kann",
        "können", "hat", "haben", "sie", "wir", "ihr", "ihre", "sein", "seine", "zum", "zur", "über",
        "unter", "durch", "gegen", "ohne", "dass", "diese", "dieser", "dieses", "hier", "dort", "sehr",
        // Spanish
        "los", "las", "del", "una", "uno", "unos", "unas", "por", "para", "con", "sin", "que", "como",
        "más", "pero", "sus", "este", "esta", "estos", "estas", "ese", "esa", "son", "está", "están",
        "ser", "hay", "entre", "sobre", "también", "muy", "todo", "todos", "cuando", "donde", "desde",
        // Dutch
        "het", "een", "van", "voor", "met", "zijn", "niet", "ook", "maar", "als", "bij", "naar", "uit",
        "aan", "dat", "deze", "dit", "die", "wordt", "worden", "kan", "kunnen", "heeft", "hebben", "om",
        "tot", "over", "onder", "door", "zoals", "wel", "nog", "geen", "meer", "veel", "waar", "wanneer",
        // Link, markup and file-name leftovers
        "http", "https", "www", "com", "org", "net", "html", "png", "jpg", "jpeg", "gif", "svg", "webp",
        "uploads", "nbsp", "amp", "quot",
    };
}
