namespace BeeDocs.Api.Services;

/// <summary>Marks an endpoint that keeps answering while a restore is in progress — the restore status itself, health.</summary>
public sealed record AllowDuringMaintenance;

/// <summary>
/// The instance-wide "not right now" a restore raises. While it is active the
/// <c>/api</c> group filter answers 503 to everything not marked
/// <see cref="AllowDuringMaintenance"/>, because a page saved halfway through
/// the database copy would land in whichever of the two databases the page
/// write happened to reach. A restore is the only thing that raises it.
/// </summary>
public sealed class MaintenanceGate
{
    private volatile string? _reason;

    public bool Active => _reason is not null;

    public string? Reason => _reason;

    public void Enter(string reason) => _reason = reason;

    public void Exit() => _reason = null;
}
