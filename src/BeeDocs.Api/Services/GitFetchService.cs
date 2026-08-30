namespace BeeDocs.Api.Services;

/// <summary>BeeDocs:GitFetchMinutes — 0 (the default) means no background fetching.</summary>
public sealed record GitFetchOptions(int Minutes);

/// <summary>
/// Opt-in background <c>git fetch</c> across the ready repos, so the toolbar's
/// behind-the-remote count stays honest without anyone pressing Pull. Fetch
/// only — it moves remote-tracking refs and never touches the shared working
/// tree, so it is safe to run under people's feet; pulling remains a person's
/// explicit verb. Off by default: on a hosted box every cycle spends PAT rate
/// limit and bandwidth, which is an operator's choice to make.
/// </summary>
public sealed class GitFetchService(
    GitFetchOptions options,
    GitCli git,
    GitOptions gitOptions,
    IGitRepoService repos,
    IGitConnectionService connections,
    ILogger<GitFetchService> logger
) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.Minutes <= 0) return;

        var interval = TimeSpan.FromMinutes(Math.Max(1, options.Minutes));
        logger.LogInformation("Background git fetch is on: every {Minutes} minute(s).", interval.TotalMinutes);

        using var timer = new PeriodicTimer(interval);
        while (await NextTickAsync(timer, stoppingToken))
        {
            try
            {
                await FetchAllAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Background git fetch cycle failed.");
            }
        }
    }

    private static async Task<bool> NextTickAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try
        {
            return await timer.WaitForNextTickAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private async Task FetchAllAsync(CancellationToken ct)
    {
        foreach (var repo in await repos.ListAsync(ct))
        {
            if (ct.IsCancellationRequested) return;
            if (repo.Status != "ready") continue;

            var connection = await connections.ResolveAsync(repo.ConnectionId, ct);
            if (connection is null) continue;

            try
            {
                using (await git.LockAsync(repo.Id, ct))
                {
                    await git.RunOkAsync(
                        Path.Combine(gitOptions.Root, repo.Id),
                        ["fetch", "--no-recurse-submodules"],
                        connection.BasicAuth, GitCli.SyncTimeout, ct);
                }
            }
            catch (GitException ex)
            {
                // One unreachable remote must not spam the log every cycle at
                // warning level, nor stop the other repos from fetching.
                logger.LogDebug(ex, "Background fetch of git repo {RepoId} failed.", repo.Id);
            }
        }
    }
}
