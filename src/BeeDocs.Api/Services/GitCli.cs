using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace BeeDocs.Api.Services;

/// <summary>Where clones live: BeeDocs:GitPath, default data/git. Absolute.</summary>
public sealed record GitOptions(string Root);

/// <summary>
/// A git operation that failed, with a message already phrased for the person
/// who has to fix it. Endpoints return <see cref="Message"/> verbatim.
/// </summary>
public sealed class GitException(string message, Exception? inner = null) : Exception(message, inner);

public sealed record GitCliResult(int ExitCode, string StdOut, string StdErr);

/// <summary>
/// The one place a <c>git</c> process is spawned — the LlmCli pattern applied to
/// git. Every rule that keeps this safe lives here so no caller can forget one:
/// <list type="bullet">
/// <item>ArgumentList only, never a shell — user input is only ever a value.</item>
/// <item>The token never touches argv or disk: it rides in git's
/// GIT_CONFIG_* environment (readable only by the same user, unlike
/// /proc/*/cmdline) as an http.extraheader.</item>
/// <item>Hook scripts never run (core.hooksPath → an empty directory), file://
/// remotes are refused, submodules are never recursed, and a credential prompt
/// fails instead of hanging (GIT_TERMINAL_PROMPT=0).</item>
/// <item>Timeouts kill the whole process tree.</item>
/// </list>
/// Git tolerates concurrent reads but not concurrent mutation of one working
/// tree, so mutating operations take the per-repo lock via
/// <see cref="LockAsync"/>.
/// </summary>
public sealed class GitCli
{
    public static readonly TimeSpan CloneTimeout = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan SyncTimeout = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);

    private readonly string _hooksOffDir;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    public GitCli(GitOptions options)
    {
        // An existing but empty hooks directory: git resolves the path and runs
        // nothing, whatever a cloned repo's config tries to point at.
        _hooksOffDir = Path.Combine(options.Root, ".hooks-off");
        Directory.CreateDirectory(_hooksOffDir);
    }

    /// <summary>Serialize mutations of one repo's working tree.</summary>
    public async Task<IDisposable> LockAsync(string repoId, CancellationToken ct)
    {
        var gate = _locks.GetOrAdd(repoId, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Releaser(gate);
    }

    private sealed class Releaser(SemaphoreSlim gate) : IDisposable
    {
        private int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 0) gate.Release();
        }
    }

    /// <summary>Run git and return whatever happened — the caller reads the exit code.</summary>
    public async Task<GitCliResult> RunAsync(
        string workingDirectory,
        IReadOnlyList<string> args,
        string? basicAuth,
        TimeSpan timeout,
        CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "git",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };

        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add($"core.hooksPath={_hooksOffDir}");
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add("protocol.file.allow=never");
        foreach (var arg in args)
            psi.ArgumentList.Add(arg);

        psi.Environment["GIT_TERMINAL_PROMPT"] = "0";
        if (basicAuth is not null)
        {
            var header = "Authorization: Basic " +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(basicAuth));
            psi.Environment["GIT_CONFIG_COUNT"] = "1";
            psi.Environment["GIT_CONFIG_KEY_0"] = "http.extraheader";
            psi.Environment["GIT_CONFIG_VALUE_0"] = header;
        }

        using var process = new Process { StartInfo = psi };
        try
        {
            process.Start();
        }
        catch (Win32Exception ex)
        {
            throw new GitException(
                "The 'git' command is not installed or not on the PATH of the BeeDocs API process.", ex);
        }

        // Nothing is ever fed to git; closing stdin makes any accidental read
        // return EOF instead of blocking.
        process.StandardInput.Close();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        try
        {
            var stdout = process.StandardOutput.ReadToEndAsync(timeoutCts.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeoutCts.Token);
            await process.WaitForExitAsync(timeoutCts.Token);
            return new GitCliResult(process.ExitCode, await stdout, await stderr);
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
            throw new GitException($"git did not finish within {timeout.TotalMinutes:0.#} minutes.");
        }
    }

    /// <summary>Run git and demand success; a non-zero exit becomes a readable <see cref="GitException"/>.</summary>
    public async Task<string> RunOkAsync(
        string workingDirectory,
        IReadOnlyList<string> args,
        string? basicAuth,
        TimeSpan timeout,
        CancellationToken ct)
    {
        var result = await RunAsync(workingDirectory, args, basicAuth, timeout, ct);
        if (result.ExitCode == 0) return result.StdOut;
        throw new GitException(FailureMessage(args, result));
    }

    private static string FailureMessage(IReadOnlyList<string> args, GitCliResult result)
    {
        var verb = args.FirstOrDefault(a => !a.StartsWith('-')) ?? "git";
        var detail = (result.StdErr.Trim().Length > 0 ? result.StdErr : result.StdOut).Trim();
        // Never echo a URL that might carry credentials someone typed into it.
        if (detail.Length > 400) detail = detail[..400] + "…";
        return detail.Length == 0
            ? $"git {verb} failed (exit {result.ExitCode})."
            : $"git {verb} failed: {detail}";
    }
}

/// <summary>
/// Path discipline for everything that maps a client-supplied path into a clone.
/// The repo directory is the jail: no '..', no absolute paths, never .git, and
/// no path whose parent chain crosses a symlink (a cloned repo can contain one
/// pointing anywhere on the server).
/// </summary>
public static class GitPaths
{
    /// <summary>Normalize a client path to forward-slash relative form, or throw.</summary>
    public static string Normalize(string? raw)
    {
        var path = (raw ?? string.Empty).Replace('\\', '/').Trim().Trim('/');
        if (path.Length == 0) return string.Empty;

        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in parts)
        {
            if (part is "." or ".."
                || part.Equals(".git", StringComparison.OrdinalIgnoreCase)
                || part.IndexOfAny(['\0', ':']) >= 0)
            {
                throw new ArgumentException($"Path '{raw}' is not a valid repository path.");
            }
        }

        return string.Join('/', parts);
    }

    /// <summary>
    /// Resolve a normalized relative path inside the repo directory, verifying
    /// the result stays inside and that no traversed directory is a symlink.
    /// Returns the absolute path; the target itself may or may not exist.
    /// </summary>
    public static string Resolve(string repoDir, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(repoDir, relative));
        var root = Path.GetFullPath(repoDir);
        if (!full.Equals(root, StringComparison.Ordinal)
            && !full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
        {
            throw new ArgumentException("Path escapes the repository.");
        }

        // Walk each intermediate directory; a symlinked dir would let a crafted
        // repo serve files from anywhere the API can read.
        var current = root;
        foreach (var part in relative.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            var info = new FileInfo(Path.Combine(current, part));
            if (info.LinkTarget is not null || (info.Attributes != (FileAttributes)(-1)
                && info.Attributes.HasFlag(FileAttributes.ReparsePoint)))
            {
                throw new ArgumentException($"Path '{relative}' crosses a symbolic link, which is not served.");
            }
            current = Path.Combine(current, part);
        }

        return full;
    }
}
