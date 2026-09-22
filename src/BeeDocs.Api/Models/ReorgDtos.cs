using System.ComponentModel.DataAnnotations;

namespace BeeDocs.Api.Models;

// AI reorganisation of a book or shelf (ReorganizeService). A job analyses the
// content into a *proposal*, a person reviews and trims it, and applying it is
// a second background run. See Docs/REORGANIZE.md.

/// <param name="Scope">"book" or "shelf".</param>
/// <param name="Instructions">Optional steer for the AI ("group by audience", "keep the FAQ separate"…).</param>
public sealed record StartReorgRequest(
    [property: Required] string Scope,
    [property: Required] string ScopeId,
    string? Instructions = null,
    string? ProviderId = null,
    string? Model = null
);

/// <summary>What to apply: the ids of the proposal's items the person kept ticked.</summary>
/// <param name="Items">Proposed pages (<see cref="ReorgPagePlanDto.Id"/>) to create/move/merge/rewrite.</param>
/// <param name="Removals">Duplicates (<see cref="ReorgRemovalDto.Id"/>) to archive.</param>
/// <param name="RenameBooks">Books whose proposed new title should be applied.</param>
public sealed record ApplyReorgRequest(
    IReadOnlyList<string>? Items,
    IReadOnlyList<string>? Removals,
    IReadOnlyList<string>? RenameBooks
);

/// <param name="Status">queued | analyzing | proposed | applying | applied | failed.</param>
/// <param name="Progress">Human-readable step while analyzing/applying.</param>
public sealed record ReorgJobDto(
    string Id,
    string Scope,
    string ScopeId,
    string ScopeTitle,
    string Status,
    string? Progress,
    string? Error,
    string? Instructions,
    string? ProviderName,
    string? Model,
    int? PromptTokens,
    int? CompletionTokens,
    int? ElapsedMs,
    string? CreatedByName,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt,
    ReorgProposalDto? Proposal,
    ReorgSnapshotDto? Current,
    IReadOnlyList<ReorgLogEntryDto>? Log
);

// ----- the structure as it was when analysed -----

public sealed record ReorgSnapshotDto(IReadOnlyList<ReorgSnapshotBookDto> Books);

public sealed record ReorgSnapshotBookDto(
    string Id,
    string Title,
    IReadOnlyList<ReorgSnapshotFolderDto> Folders,
    IReadOnlyList<ReorgSnapshotPageDto> Pages
);

public sealed record ReorgSnapshotFolderDto(string Id, string Title, int SortOrder);

/// <param name="Excluded">Left out of the analysis (private) — never touched.</param>
public sealed record ReorgSnapshotPageDto(
    string Id,
    string Title,
    string? FolderId,
    int SortOrder,
    int Words,
    DateTimeOffset UpdatedAt,
    bool Excluded
);

// ----- the proposal -----

/// <param name="Untouched">Pages the plan did not mention — they stay exactly where they are.</param>
public sealed record ReorgProposalDto(
    string Summary,
    IReadOnlyList<ReorgBookPlanDto> Books,
    IReadOnlyList<ReorgRemovalDto> Removals,
    IReadOnlyList<ReorgSourceDto> Untouched
);

/// <param name="NewTitle">A proposed better title for the book, or null to keep it.</param>
public sealed record ReorgBookPlanDto(
    string BookId,
    string CurrentTitle,
    string? NewTitle,
    IReadOnlyList<ReorgFolderPlanDto> Folders
);

/// <param name="Title">Folder title; null is the top level of the book.</param>
/// <param name="Exists">A folder of this title is already in the book (it is reused, not duplicated).</param>
public sealed record ReorgFolderPlanDto(string? Title, bool Exists, IReadOnlyList<ReorgPagePlanDto> Pages);

/// <param name="Action">keep | merge | rewrite.</param>
/// <param name="Moved">The (first) source changes book or folder.</param>
/// <param name="Renamed">The (first) source gets a new title.</param>
public sealed record ReorgPagePlanDto(
    string Id,
    string Title,
    string Action,
    bool Moved,
    bool Renamed,
    IReadOnlyList<ReorgSourceDto> Sources,
    string? Reason
);

public sealed record ReorgSourceDto(string PageId, string BookId, string Title, string? FolderTitle, int Words);

/// <param name="DuplicateOf">The proposed page (item id) that already holds this content, if the AI named one.</param>
public sealed record ReorgRemovalDto(string Id, ReorgSourceDto Page, string? Reason, string? DuplicateOf);

// ----- what applying did -----

/// <param name="Status">ok | skipped | failed.</param>
public sealed record ReorgLogEntryDto(
    string? ItemId,
    string Status,
    string Message,
    string? BookId = null,
    string? PageId = null
);
