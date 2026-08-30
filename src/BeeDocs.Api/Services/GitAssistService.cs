using System.Text;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// The AI actions on a repo's context menu: draft a README, developer
/// documentation, a user manual, or a summary — grounded in the repository
/// itself. The server gathers the context (it has the clone; the browser
/// should not fetch fifty files), builds one <see cref="LlmPrompts.DocDraft"/>
/// completion, and returns Markdown for the person to review. Nothing touches
/// the working tree here — saving the draft goes through the ordinary
/// write/commit flow, so every AI word is reviewed like any other edit.
/// </summary>
public sealed class GitAssistService(
    GitOptions options,
    IGitRepoService repos,
    ILlmClient llm)
{
    public static class Kinds
    {
        public const string Readme = "readme";
        public const string Documentation = "documentation";
        public const string Manual = "manual";
        public const string Summary = "summary";

        public static readonly IReadOnlyList<string> All = [Readme, Documentation, Manual, Summary];
    }

    // The budget: enough of a repository to write honestly about it, small
    // enough that a local model (or a metered one) is not fed a monorepo.
    private const int MaxTreePaths = 400;
    private const int MaxFileChars = 6000;
    private const int MaxBundleChars = 40_000;
    private const long MaxFileBytes = 256 * 1024;

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

        var (bundle, contextFiles) = BuildBundle(repo.Name, Path.Combine(options.Root, repoId));

        LlmCompleteResponse completion;
        try
        {
            completion = await llm.CompleteAsync(new LlmCompleteRequest(
                Task: LlmPrompts.DocDraft,
                Prompt: Assignment(kind, repo.Name, request.Instructions),
                Context: bundle,
                Selection: null,
                ProviderId: request.ProviderId,
                Model: request.Model,
                MaxTokens: null,
                Temperature: null), ct);
        }
        catch (KeyNotFoundException ex)
        {
            // "No enabled LLM provider is configured." must reach the person as
            // a sentence, not surface as a bare 404 on the repo.
            throw new LlmException(ex.Message);
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

    private static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "readme" => Kinds.Readme,
            "documentation" or "docs" => Kinds.Documentation,
            "manual" or "usermanual" => Kinds.Manual,
            "summary" or "summarize" or "summarise" => Kinds.Summary,
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
