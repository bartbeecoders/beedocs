using System.Diagnostics;
using System.Text;
using System.Text.Json;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// The AI actions on a repo's context menu: draft a README, developer
/// documentation, a user manual, a summary, or a multi-page documentation
/// book — grounded in the repository itself. The server gathers the context
/// (it has the clone; the browser should not fetch fifty files), builds one
/// or more <see cref="LlmPrompts.DocDraft"/> completions, and returns Markdown
/// for the person to review. Nothing touches the working tree here — saving
/// a single-page draft goes through the ordinary write/commit flow, and a
/// book is published into the library as pages.
/// </summary>
public sealed class GitAssistService(
    GitOptions options,
    IGitRepoService repos,
    ILlmClient llm,
    ILogger<GitAssistService> logger)
{
    public static class Kinds
    {
        public const string Readme = "readme";
        public const string Documentation = "documentation";
        public const string Manual = "manual";
        public const string Summary = "summary";
        public const string Book = "book";

        public static readonly IReadOnlyList<string> All =
            [Readme, Documentation, Manual, Summary, Book];
    }

    // The budget: enough of a repository to write honestly about it, small
    // enough that a local model (or a metered one) is not fed a monorepo.
    private const int MaxTreePaths = 400;
    private const int MaxFileChars = 6000;
    private const int MaxBundleChars = 40_000;
    private const long MaxFileBytes = 256 * 1024;

    private const int MaxBookPages = 8;

    private static readonly HashSet<string> ManifestNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "package.json", "pyproject.toml", "go.mod", "cargo.toml", "composer.json",
        "pom.xml", "build.gradle", "build.gradle.kts", "makefile", "dockerfile",
        "docker-compose.yml", "docker-compose.yaml", "requirements.txt", "gemfile",
    };

    private static readonly HashSet<string> SourceExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt",
        ".rb", ".php", ".swift", ".sh", ".ps1", ".sql", ".html", ".css", ".vue",
        ".yml", ".yaml", ".toml", ".csproj", ".sln",
    };

    public async Task<GitAssistResultDto> AssistAsync(
        string repoId, GitAssistRequest request, CancellationToken ct = default)
    {
        var repo = await repos.GetAsync(repoId, ct)
            ?? throw new KeyNotFoundException($"Repository '{repoId}' not found.");
        if (repo.Status != "ready")
            throw new GitException($"{repo.Name} is not ready ({repo.Status}) — sync or re-add it first.");

        var kind = Normalize(request.Kind)
            ?? throw new ArgumentException(
                $"Unknown assist kind '{request.Kind}'. Use one of: {string.Join(", ", Kinds.All)}.");
        if (kind == Kinds.Book)
        {
            throw new ArgumentException(
                "A documentation book is several pages and must run as a background job. " +
                "POST /api/git/repos/{id}/assist/jobs with kind=book.");
        }

        return await GenerateAsync(repo, kind, request.Instructions, request.ProviderId, request.Model, ct);
    }

    /// <summary>
    /// The generation itself, on an already-validated repo and normalized kind —
    /// shared by the synchronous endpoint above and the background job runner,
    /// so both produce byte-identical drafts from the same parameters.
    /// </summary>
    public async Task<GitAssistResultDto> GenerateAsync(
        GitRepoDto repo, string kind, string? instructions,
        string? providerId, string? model, CancellationToken ct = default)
    {
        var (bundle, contextFiles) = BuildBundle(repo.Name, Path.Combine(options.Root, repo.Id));

        if (kind == Kinds.Book)
            return await GenerateBookAsync(repo, bundle, contextFiles, instructions, providerId, model, ct);

        LlmCompleteResponse completion;
        try
        {
            completion = await llm.CompleteAsync(new LlmCompleteRequest(
                Task: LlmPrompts.DocDraft,
                Prompt: Assignment(kind, repo.Name, instructions),
                Context: bundle,
                Selection: null,
                ProviderId: providerId,
                Model: model,
                MaxTokens: null,
                Temperature: null), ct);
        }
        catch (KeyNotFoundException ex)
        {
            // "No enabled LLM provider is configured." must reach the person as
            // a sentence, not surface as a bare 404 on the repo.
            throw new LlmException(ex.Message);
        }

        if (string.IsNullOrWhiteSpace(completion.Text))
        {
            throw new LlmException(
                $"{completion.ProviderName} returned an empty document" +
                (string.IsNullOrEmpty(completion.Model) ? "" : $" ({completion.Model})") +
                ". The model may have spent its token budget on hidden reasoning. Try again, or pick a different model.");
        }

        return new GitAssistResultDto(
            Kind: kind,
            SuggestedPath: SuggestedPath(kind),
            Markdown: completion.Text,
            ProviderName: completion.ProviderName,
            Model: completion.Model,
            PromptTokens: completion.PromptTokens,
            CompletionTokens: completion.CompletionTokens,
            ElapsedMs: completion.ElapsedMs,
            ContextFiles: contextFiles);
    }

    public static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "readme" => Kinds.Readme,
            "documentation" or "docs" => Kinds.Documentation,
            "manual" or "usermanual" => Kinds.Manual,
            "summary" or "summarize" or "summarise" => Kinds.Summary,
            "book" or "docsbook" or "documentationbook" => Kinds.Book,
            _ => null,
        };

    private static string? SuggestedPath(string kind) => kind switch
    {
        Kinds.Readme => "README.md",
        Kinds.Documentation => "docs/DOCUMENTATION.md",
        Kinds.Manual => "docs/MANUAL.md",
        Kinds.Summary => "docs/SUMMARY.md",
        _ => null,
    };

    /// <summary>The page title a published draft gets in the library.</summary>
    public static string KindTitle(string kind) => kind switch
    {
        Kinds.Readme => "README",
        Kinds.Documentation => "Developer documentation",
        Kinds.Manual => "User manual",
        Kinds.Summary => "Repository summary",
        Kinds.Book => "Documentation book",
        _ => kind,
    };

    private static string Assignment(string kind, string repoName, string? instructions)
    {
        var task = kind switch
        {
            Kinds.Readme =>
                $"Write a complete README.md for the repository '{repoName}': what the project is " +
                "and does, how to install/build/run it (only as far as the files actually show), " +
                "basic usage, and a short structure overview.",
            Kinds.Documentation =>
                $"Write developer documentation for the repository '{repoName}': an architecture " +
                "overview, the main components and how they interact, how to build, run and test, " +
                "and where to start when extending it. Audience: a developer new to the codebase.",
            Kinds.Manual =>
                $"Write an end-user manual for the software in the repository '{repoName}': what it " +
                "is for, getting started, its features, and how to accomplish the main tasks. " +
                "Audience: a user, not a developer — avoid code-level detail unless the user " +
                "genuinely needs it.",
            _ =>
                $"Summarize the repository '{repoName}' in about one page: purpose, technology " +
                "stack, how the code is organised, and anything notable a newcomer should know.",
        };

        var extra = (instructions ?? string.Empty).Trim();
        return extra.Length == 0 ? task : $"{task}\n\nAdditional instructions from the user:\n{extra}";
    }

    /// <summary>
    /// Several DocDraft calls: an outline (JSON), then one completion per page.
    /// The result's Markdown is a <see cref="GitAssistBookDraft"/> JSON envelope
    /// so publishing can create N library pages from one job row.
    /// </summary>
    private async Task<GitAssistResultDto> GenerateBookAsync(
        GitRepoDto repo, string bundle, IReadOnlyList<string> contextFiles,
        string? instructions, string? providerId, string? model, CancellationToken ct)
    {
        var started = Stopwatch.GetTimestamp();
        LlmCompleteResponse outline;
        BookPlan plan;
        try
        {
            outline = await OutlineAttemptAsync(repo.Name, bundle, instructions, providerId, model, ct);
            if (!TryParseOutline(outline.Text, repo.Name, out plan) || plan.Pages.Count == 0)
            {
                logger.LogWarning(
                    "{Provider} {Model} book outline was not usable JSON ({Chars} chars): {Preview}",
                    outline.ProviderName, outline.Model, outline.Text.Length, Preview(outline.Text));
                // One retry: Qwen sometimes still wraps the object, and a second
                // draw with json_object + reasoning off usually lands.
                outline = await OutlineAttemptAsync(repo.Name, bundle, instructions, providerId, model, ct);
            }
        }
        catch (KeyNotFoundException ex)
        {
            throw new LlmException(ex.Message);
        }

        if (!TryParseOutline(outline.Text, repo.Name, out plan) || plan.Pages.Count == 0)
        {
            logger.LogWarning(
                "{Provider} {Model} book outline was not usable JSON after retry ({Chars} chars): {Preview}",
                outline.ProviderName, outline.Model, outline.Text.Length, Preview(outline.Text));
            throw new LlmException(
                string.IsNullOrWhiteSpace(outline.Text)
                    ? $"{outline.ProviderName} returned an empty book outline" +
                      (string.IsNullOrEmpty(outline.Model) ? "" : $" ({outline.Model})") +
                      ". The model may have spent its token budget on hidden reasoning. Try again, or pick a different model."
                    : $"{outline.ProviderName} returned a book outline that was not valid JSON" +
                      (string.IsNullOrEmpty(outline.Model) ? "" : $" ({outline.Model})") +
                      ". Try again, or pick a different model.");
        }

        var pages = new List<GitAssistBookPage>();
        var promptTokens = outline.PromptTokens;
        var completionTokens = outline.CompletionTokens;
        var providerName = outline.ProviderName;
        var usedModel = outline.Model;

        for (var i = 0; i < plan.Pages.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var entry = plan.Pages[i];
            LlmCompleteResponse page;
            try
            {
                page = await llm.CompleteAsync(new LlmCompleteRequest(
                    Task: LlmPrompts.DocDraft,
                    Prompt: BookPageAssignment(repo.Name, plan, i),
                    Context: bundle,
                    Selection: null,
                    ProviderId: providerId,
                    Model: model,
                    MaxTokens: null,
                    Temperature: null), ct);
            }
            catch (KeyNotFoundException ex)
            {
                throw new LlmException(ex.Message);
            }

            promptTokens = AddTokens(promptTokens, page.PromptTokens);
            completionTokens = AddTokens(completionTokens, page.CompletionTokens);
            providerName = page.ProviderName;
            usedModel = page.Model;

            if (string.IsNullOrWhiteSpace(page.Text))
            {
                throw new LlmException(
                    $"{page.ProviderName} returned an empty page '{entry.Title}'" +
                    (string.IsNullOrEmpty(page.Model) ? "" : $" ({page.Model})") +
                    ". The model may have spent its token budget on hidden reasoning. Try again, or pick a different model.");
            }

            pages.Add(new GitAssistBookPage { Title = entry.Title, Markdown = page.Text.Trim() });
        }

        var draft = new GitAssistBookDraft
        {
            Version = 1,
            BookTitle = plan.BookTitle,
            BookDescription = plan.BookDescription,
            Pages = pages,
        };

        return new GitAssistResultDto(
            Kind: Kinds.Book,
            SuggestedPath: null,
            Markdown: draft.ToJson(),
            ProviderName: providerName,
            Model: usedModel,
            PromptTokens: promptTokens,
            CompletionTokens: completionTokens,
            ElapsedMs: (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            ContextFiles: contextFiles);
    }

    private Task<LlmCompleteResponse> OutlineAttemptAsync(
        string repoName, string bundle, string? instructions,
        string? providerId, string? model, CancellationToken ct) =>
        llm.CompleteAsync(new LlmCompleteRequest(
            Task: LlmPrompts.BookOutline,
            Prompt: BookOutlineAssignment(repoName, instructions),
            Context: bundle,
            Selection: null,
            ProviderId: providerId,
            Model: model,
            MaxTokens: null,
            Temperature: null), ct);

    private static string BookOutlineAssignment(string repoName, string? instructions)
    {
        var task =
            $"Plan a documentation book for the repository '{repoName}'. Reply with ONLY the JSON " +
            "object described in your instructions — not the pages themselves.";
        var extra = (instructions ?? string.Empty).Trim();
        return extra.Length == 0 ? task : $"{task}\n\nAdditional instructions from the user:\n{extra}";
    }

    private static string BookPageAssignment(string repoName, BookPlan plan, int index)
    {
        var entry = plan.Pages[index];
        var outline = new StringBuilder();
        for (var i = 0; i < plan.Pages.Count; i++)
        {
            outline.Append("- ").Append(plan.Pages[i].Title);
            if (!string.IsNullOrEmpty(plan.Pages[i].Brief))
                outline.Append(": ").Append(plan.Pages[i].Brief);
            outline.Append('\n');
        }

        return
            $"You are writing page {index + 1} of {plan.Pages.Count} of a documentation book titled " +
            $"'{plan.BookTitle}' about the repository '{repoName}'.\n" +
            $"This page's title: {entry.Title}\n" +
            $"This page must cover: {entry.Brief}\n\n" +
            "The full book outline (do not repeat other pages' content; you may mention them in passing):\n" +
            outline +
            "\nWrite a complete Markdown page starting with a single H1 matching the page title. " +
            "Ground every statement in the source material; where it does not answer something, say so briefly.";
    }

    private static bool TryParseOutline(string text, string repoName, out BookPlan plan)
    {
        plan = new BookPlan(repoName, null, []);
        if (string.IsNullOrWhiteSpace(text)) return false;
        return TryParseOutlineJson(text, repoName, out plan)
            || TryParseOutlineMarkdown(text, repoName, out plan);
    }

    /// <summary>
    /// Models disagree on property names (camelCase vs snake_case, pages vs
    /// chapters) and wrap the object in prose. Walk the JSON rather than
    /// binding a DTO so any of those still become a plan.
    /// </summary>
    private static bool TryParseOutlineJson(string text, string repoName, out BookPlan plan)
    {
        plan = new BookPlan(repoName, null, []);
        if (!TryReadJson(text, out var root)) return false;

        JsonElement pagesEl;
        string? title;
        string? description;
        if (root.ValueKind == JsonValueKind.Array)
        {
            pagesEl = root;
            title = repoName;
            description = null;
        }
        else if (root.ValueKind == JsonValueKind.Object)
        {
            title = FirstString(root, "bookTitle", "book_title", "title", "name") ?? repoName;
            description = FirstString(root, "bookDescription", "book_description", "description", "summary");
            if (!TryGetArray(root, out pagesEl, "pages", "chapters", "outline", "sections", "items"))
                return false;
        }
        else
        {
            return false;
        }

        var pages = ReadPlanPages(pagesEl);
        if (pages.Count == 0) return false;
        plan = new BookPlan(title, description, pages);
        return true;
    }

    private static bool TryParseOutlineMarkdown(string text, string repoName, out BookPlan plan)
    {
        plan = new BookPlan(repoName, null, []);
        var pages = new List<BookPlanPage>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? bookTitle = null;

        foreach (var rawLine in text.Replace("\r\n", "\n").Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0) continue;

            if (bookTitle is null
                && line.StartsWith("# ", StringComparison.Ordinal)
                && !line.StartsWith("##", StringComparison.Ordinal))
            {
                bookTitle = line[2..].Trim();
                continue;
            }

            if (!TryMarkdownItem(line, out var item)) continue;

            var (pageTitle, brief) = SplitTitleBrief(item);
            if (pageTitle.Length == 0) continue;
            if (pages.Count >= MaxBookPages) break;
            if (!seen.Add(pageTitle)) continue;
            pages.Add(new BookPlanPage(pageTitle, brief.Length == 0 ? pageTitle : brief));
        }

        // A couple of random bullets in an error message is not an outline.
        if (pages.Count < 3) return false;
        plan = new BookPlan(
            string.IsNullOrWhiteSpace(bookTitle) ? repoName : bookTitle,
            null,
            pages);
        return true;
    }

    private static bool TryMarkdownItem(string line, out string item)
    {
        item = "";
        if (line.StartsWith("- ", StringComparison.Ordinal)
            || line.StartsWith("* ", StringComparison.Ordinal)
            || line.StartsWith("• ", StringComparison.Ordinal))
        {
            item = line[2..].Trim().Replace("**", "");
            return item.Length > 0;
        }

        if (line.StartsWith("## ", StringComparison.Ordinal))
        {
            item = line[3..].Trim().Replace("**", "");
            return item.Length > 0;
        }

        if (line.Length > 2 && char.IsDigit(line[0]))
        {
            var dot = line.IndexOf('.');
            var paren = line.IndexOf(')');
            var sep = dot > 0 && (paren < 0 || dot < paren) ? dot : paren;
            if (sep > 0 && sep <= 3)
            {
                item = line[(sep + 1)..].Trim().Replace("**", "");
                return item.Length > 0;
            }
        }

        return false;
    }

    private static (string Title, string Brief) SplitTitleBrief(string item)
    {
        foreach (var sep in new[] { ": ", " — ", " – ", " - " })
        {
            var at = item.IndexOf(sep, StringComparison.Ordinal);
            if (at > 0)
                return (item[..at].Trim().Trim('"', '\''), item[(at + sep.Length)..].Trim());
        }

        return (item.Trim().Trim('"', '\''), "");
    }

    private static readonly JsonDocumentOptions OutlineJsonDoc = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
    };

    private static bool TryReadJson(string text, out JsonElement root)
    {
        root = default;
        foreach (var candidate in JsonCandidates(text))
        {
            try
            {
                using var doc = JsonDocument.Parse(candidate, OutlineJsonDoc);
                if (doc.RootElement.ValueKind is JsonValueKind.Object or JsonValueKind.Array)
                {
                    root = doc.RootElement.Clone();
                    return true;
                }
            }
            catch (JsonException)
            {
                // Next candidate.
            }
        }

        return false;
    }

    private static IEnumerable<string> JsonCandidates(string text)
    {
        var obj = GitAssistBookDraft.ExtractJsonObject(text);
        if (obj.Length > 0) yield return obj;

        var start = text.IndexOf('[');
        var end = text.LastIndexOf(']');
        if (start >= 0 && end > start)
            yield return text[start..(end + 1)];
    }

    private static List<BookPlanPage> ReadPlanPages(JsonElement pagesEl)
    {
        var pages = new List<BookPlanPage>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (pagesEl.ValueKind != JsonValueKind.Array) return pages;

        foreach (var raw in pagesEl.EnumerateArray())
        {
            if (pages.Count >= MaxBookPages) break;
            string pageTitle;
            string brief;
            if (raw.ValueKind == JsonValueKind.String)
            {
                pageTitle = (raw.GetString() ?? "").Trim();
                brief = pageTitle;
            }
            else if (raw.ValueKind == JsonValueKind.Object)
            {
                pageTitle = (FirstString(raw, "title", "name", "heading", "pageTitle", "page_title") ?? "").Trim();
                brief = (FirstString(raw, "brief", "summary", "description", "about", "prompt") ?? "").Trim();
            }
            else
            {
                continue;
            }

            if (pageTitle.Length == 0) continue;
            if (!seen.Add(pageTitle)) continue;
            if (brief.Length == 0) brief = pageTitle;
            pages.Add(new BookPlanPage(pageTitle, brief));
        }

        return pages;
    }

    private static string? FirstString(JsonElement obj, params string[] names)
    {
        foreach (var name in names)
        {
            if (TryGetPropertyLoose(obj, name, out var value) && value.ValueKind == JsonValueKind.String)
            {
                var text = value.GetString();
                if (!string.IsNullOrWhiteSpace(text)) return text;
            }
        }

        return null;
    }

    private static bool TryGetArray(JsonElement obj, out JsonElement array, params string[] names)
    {
        foreach (var name in names)
        {
            if (TryGetPropertyLoose(obj, name, out var value) && value.ValueKind == JsonValueKind.Array)
            {
                array = value;
                return true;
            }
        }

        array = default;
        return false;
    }

    private static bool TryGetPropertyLoose(JsonElement obj, string name, out JsonElement value)
    {
        if (obj.TryGetProperty(name, out value)) return true;
        var folded = FoldKey(name);
        foreach (var prop in obj.EnumerateObject())
        {
            if (FoldKey(prop.Name) == folded)
            {
                value = prop.Value;
                return true;
            }
        }

        value = default;
        return false;
    }

    private static string FoldKey(string name) => name.Replace("_", "").Replace("-", "").ToLowerInvariant();

    private static string Preview(string? text)
    {
        var value = (text ?? "").Replace('\n', ' ').Trim();
        if (value.Length == 0) return "(empty)";
        return value.Length <= 400 ? value : value[..400] + "…";
    }

    private static int? AddTokens(int? a, int? b) =>
        a is null && b is null ? null : (a ?? 0) + (b ?? 0);

    private sealed record BookPlan(string BookTitle, string? BookDescription, List<BookPlanPage> Pages);
    private sealed record BookPlanPage(string Title, string Brief);

    /// <summary>
    /// The repository as prompt text: a tree outline, then file excerpts ordered
    /// most-informative-first (README, manifests, existing docs, then shallow
    /// source files) under a hard character budget — truncation must cost the
    /// least useful material, never the README.
    /// </summary>
    private static (string Bundle, IReadOnlyList<string> Files) BuildBundle(string repoName, string repoDir)
    {
        var paths = new List<string>();
        Walk(repoDir, string.Empty, paths);
        paths.Sort(StringComparer.Ordinal);

        var builder = new StringBuilder();
        builder.Append("Repository: ").Append(repoName).Append('\n');
        builder.Append("File tree").Append(paths.Count >= MaxTreePaths ? " (truncated)" : "")
            .Append(":\n");
        foreach (var path in paths.Take(MaxTreePaths))
            builder.Append(path).Append('\n');
        builder.Append('\n');

        var used = new List<string>();
        foreach (var path in paths.OrderBy(p => Score(p)).ThenBy(p => p, StringComparer.Ordinal))
        {
            if (Score(path) == int.MaxValue) continue;
            if (builder.Length >= MaxBundleChars) break;

            string content;
            try
            {
                var info = new FileInfo(Path.Combine(repoDir, path.Replace('/', Path.DirectorySeparatorChar)));
                if (!info.Exists || info.Length == 0 || info.Length > MaxFileBytes) continue;
                content = File.ReadAllText(info.FullName);
            }
            catch (IOException)
            {
                continue;
            }

            if (content.Contains('\0')) continue;
            if (content.Length > MaxFileChars)
                content = content[..MaxFileChars] + "\n… (truncated)";

            builder.Append("===== FILE: ").Append(path).Append(" =====\n")
                .Append(content).Append("\n\n");
            used.Add(path);
        }

        return (builder.ToString(), used);
    }

    /// <summary>Lower reads earlier; MaxValue is never read at all.</summary>
    private static int Score(string path)
    {
        var name = Path.GetFileName(path);
        var depth = path.Count(c => c == '/');

        if (depth == 0 && name.StartsWith("readme", StringComparison.OrdinalIgnoreCase)) return 0;
        if (ManifestNames.Contains(name)) return 1 + depth;
        if (name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) return 10 + depth;
        if (SourceExtensions.Contains(Path.GetExtension(name))) return 100 + depth * 10;
        return int.MaxValue;
    }

    private static void Walk(string dir, string relative, List<string> paths)
    {
        if (paths.Count >= MaxTreePaths * 2) return;

        IEnumerable<string> entries;
        try
        {
            entries = Directory.EnumerateFileSystemEntries(dir);
        }
        catch (IOException)
        {
            return;
        }
        catch (UnauthorizedAccessException)
        {
            return;
        }

        foreach (var entry in entries)
        {
            var name = Path.GetFileName(entry);
            var info = new FileInfo(entry);
            if (info.LinkTarget is not null) continue;

            if (Directory.Exists(entry))
            {
                if (name.Equals(".git", StringComparison.OrdinalIgnoreCase)) continue;
                if (name is "node_modules" or "bin" or "obj" or "dist" or ".venv" or "vendor") continue;
                Walk(entry, relative.Length == 0 ? name : relative + "/" + name, paths);
            }
            else
            {
                paths.Add(relative.Length == 0 ? name : relative + "/" + name);
            }
        }
    }
}
