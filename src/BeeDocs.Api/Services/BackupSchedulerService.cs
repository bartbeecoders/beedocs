namespace BeeDocs.Api.Services;

/// <summary>
/// Starts scheduled backups. Ticks once a minute and asks
/// <see cref="BackupService"/> whether one is due — "due" is derived from the
/// newest backup row rather than kept as timer state, so a restart (or a
/// restore, which replaces the history) never loses or doubles a run, and the
/// same computation feeds the "next backup" shown in Settings.
/// </summary>
public sealed class BackupSchedulerService(BackupService backups, ILogger<BackupSchedulerService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await NextTickAsync(timer, stoppingToken))
        {
            try
            {
                var next = await backups.NextScheduledAtAsync(stoppingToken);
                if (next is null || next > DateTimeOffset.UtcNow) continue;
                if (backups.StartBackup("scheduled", startedBy: null) is { } runId)
                    logger.LogInformation("Scheduled backup {RunId} started.", runId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Backup scheduler tick failed.");
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
}
