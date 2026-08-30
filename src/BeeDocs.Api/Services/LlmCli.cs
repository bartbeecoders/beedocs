using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using BeeDocs.Api.Models;

namespace BeeDocs.Api.Services;

/// <summary>
/// Completion backend for the CLI provider kinds: instead of an HTTP call signed
/// with a stored key, the request is handed to a locally installed agent CLI —
/// <c>claude</c> from Claude Code, <c>grok</c> from Grok CLI — which answers with
/// whatever account and default model it is signed in with. That is the whole
/// point of these kinds: a machine that already runs Claude Code or Grok needs no
/// second API key and no model picking to get writing help. It is also their
/// limit: the command must exist on the machine the <em>API</em> runs on, so they
/// are for local and desktop installs, not for a hosted deployment.
/// </summary>
internal static class LlmCli
{
    /// <summary>CLI startup (a Node process) plus one model round trip.</summary>
    private static readonly TimeSpan VersionTimeout = TimeSpan.FromSeconds(15);

    public static async Task<(string Text, int? PromptTokens, int? CompletionTokens)> CompleteAsync(
        LlmProviderSecret provider,
        string model,
        string system,
        string user,
        TimeSpan timeout,
        CancellationToken ct)
    {
        List<string> args;
        string? stdin = null;
        string? promptFile = null;

        if (provider.Kind == LlmProviderKinds.ClaudeCli)
        {
            // Print mode with a JSON envelope: `result` carries the answer and
            // `usage` the token counts. The user text goes over stdin so page
            // content never shows up in the world-readable process arg list.
            args = ["-p", "--output-format", "json", "--append-system-prompt", system];
            stdin = user;
        }
        else
        {
            // Grok's single-turn mode reads no stdin, so the page text goes
            // through a 0600 temp file instead of argv; `--rules` appends the
            // task instructions to its system prompt.
            promptFile = await WritePromptFileAsync(user, ct);
            args = ["--prompt-file", promptFile, "--rules", system];
        }

        // Empty means "whatever the CLI's own default model is" — deliberately
        // no flag at all, so a CLI-side default change is picked up unasked.
        if (model.Length > 0)
        {
            args.Add("--model");
            args.Add(model);
        }

        try
        {
            var (exit, stdout, stderr) = await RunAsync(provider.Kind, args, stdin, timeout, ct);
            if (exit != 0)
                throw new LlmException(FailureMessage(provider.Kind, exit, stdout, stderr));

            return provider.Kind == LlmProviderKinds.ClaudeCli
                ? ParseClaudeResult(stdout)
                : (stdout.Trim(), null, null);
        }
        finally
        {
            if (promptFile is not null)
                File.Delete(promptFile);
        }
    }

    /// <summary>Owner-only temp file holding the prompt for CLIs that cannot read stdin.</summary>
    private static async Task<string> WritePromptFileAsync(string content, CancellationToken ct)
    {
        var path = Path.Combine(Path.GetTempPath(), $"beedocs-llm-{Guid.NewGuid():N}.txt");
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;

        await using var writer = new StreamWriter(new FileStream(path, options));
        await writer.WriteAsync(content.AsMemory(), ct);
        return path;
    }

    /// <summary>Proves the command exists and starts. Free — no model call is made.</summary>
    public static async Task<string> ProbeAsync(string kind, CancellationToken ct)
    {
        var (exit, stdout, stderr) = await RunAsync(kind, ["--version"], null, VersionTimeout, ct);
        if (exit != 0)
            throw new LlmException(FailureMessage(kind, exit, stdout, stderr));

        var version = stdout.Trim();
        var firstLine = version.Split('\n', 2)[0].Trim();
        var name = DisplayName(kind);
        return firstLine.Length == 0
            ? $"{name} is installed. Completions use the account and model the CLI itself is configured with."
            : $"{name} is installed ({firstLine}). Completions use the account and model the CLI itself is configured with.";
    }

    /// <summary>
    /// The CLIs list nothing, so these are suggestions only: the ids their
    /// <c>--model</c> flag documents. Blank stays the recommended value — it means
    /// the CLI's own default.
    /// </summary>
    public static IReadOnlyList<LlmModelDto> Models(string kind) => kind switch
    {
        LlmProviderKinds.ClaudeCli =>
        [
            new("sonnet", "Claude Sonnet (CLI alias)", null),
            new("opus", "Claude Opus (CLI alias)", null),
            new("haiku", "Claude Haiku (CLI alias)", null),
        ],
        LlmProviderKinds.GrokCli =>
        [
            new("grok-4-latest", "Grok 4", null),
            new("grok-4-fast", "Grok 4 Fast", null),
            new("grok-code-fast-1", "Grok Code Fast", null),
            new("grok-3-latest", "Grok 3", null),
        ],
        _ => [],
    };

    private static async Task<(int ExitCode, string StdOut, string StdErr)> RunAsync(
        string kind,
        IReadOnlyList<string> args,
        string? stdin,
        TimeSpan timeout,
        CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = LlmProviderKinds.CliCommand(kind),
            RedirectStandardInput = stdin is not null,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            // A neutral directory: `claude -p` loads project context (CLAUDE.md,
            // .claude/ settings) from wherever it starts, and the API's content
            // root is a project of its own that has nothing to do with the page
            // being edited.
            WorkingDirectory = Path.GetTempPath(),
        };
        foreach (var arg in args)
            psi.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = psi };
        try
        {
            process.Start();
        }
        catch (Win32Exception ex)
        {
            throw new LlmException(
                $"The '{psi.FileName}' command is not installed or not on the PATH of the BeeDocs API process.", ex);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        try
        {
            if (stdin is not null)
            {
                try
                {
                    await process.StandardInput.WriteAsync(stdin.AsMemory(), timeoutCts.Token);
                }
                catch (IOException)
                {
                    // Broken pipe: the process died before reading. Its exit code
                    // and stderr below say why, which beats a transport error.
                }
                process.StandardInput.Close();
            }

            var stdout = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeoutCts.Token);
            await process.WaitForExitAsync(timeoutCts.Token);
            return (process.ExitCode, await stdout, await stderr);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Exited between the timeout and the kill.
            }

            if (ct.IsCancellationRequested)
                throw;
            throw new LlmException($"{DisplayName(kind)} did not answer within {timeout.TotalSeconds:0}s.");
        }
    }

    private static (string Text, int? PromptTokens, int? CompletionTokens) ParseClaudeResult(string stdout)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(stdout);
        }
        catch (JsonException)
        {
            // An older CLI without the JSON envelope: stdout is the answer itself.
            return (stdout.Trim(), null, null);
        }

        using (document)
        {
            var root = document.RootElement;
            var text = root.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.String
                ? result.GetString() ?? string.Empty
                : string.Empty;

            if (root.TryGetProperty("is_error", out var isError) && isError.ValueKind == JsonValueKind.True)
                throw new LlmException($"Claude Code reported an error: {Truncate(text.Length > 0 ? text : stdout)}");

            int? prompt = null;
            int? completion = null;
            if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
            {
                if (usage.TryGetProperty("input_tokens", out var p) && p.TryGetInt32(out var pv)) prompt = pv;
                if (usage.TryGetProperty("output_tokens", out var c) && c.TryGetInt32(out var cv)) completion = cv;
            }

            return (text, prompt, completion);
        }
    }

    private static string DisplayName(string kind) =>
        kind == LlmProviderKinds.ClaudeCli ? "Claude Code" : "Grok CLI";

    private static string FailureMessage(string kind, int exitCode, string stdout, string stderr)
    {
        var detail = Truncate(stderr.Trim().Length > 0 ? stderr.Trim() : stdout.Trim());
        var reason = $"{DisplayName(kind)} exited with code {exitCode}";
        return string.IsNullOrEmpty(detail) ? reason + "." : $"{reason}: {detail}";
    }

    private static string? Truncate(string? value)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        return text.Length <= 300 ? text : text[..300] + "…";
    }
}
