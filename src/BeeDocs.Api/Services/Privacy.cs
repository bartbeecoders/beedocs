using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// Owner-only visibility for shelves, books and the documents inside them.
/// <para>
/// A private item is hidden from every signed-in account except its owner.
/// Administrators still see it — they administer the instance — as does the
/// shared API key (a machine, not an account) and anyone at all when sign-in
/// is off, because there is then no identity to be "the owner". The published
/// bookshelf website never shows private items, whoever is looking.
/// </para>
/// Privacy inherits down: a private shelf hides its books, a private book
/// hides its pages. Direct URLs 404 rather than 403 so existence is not leaked.
/// </summary>
public static class Privacy
{
    /// <summary>
    /// Admins, the API key, and an open instance skip the filter. A signed-in
    /// editor or viewer does not, even if they can write everything else.
    /// </summary>
    public static bool Bypass(CurrentActor actor) => actor.IsAdmin;

    public static bool CanSee(CurrentActor actor, bool isPrivate, string? ownerId)
    {
        if (Bypass(actor) || !isPrivate) return true;
        return actor.Id is not null && string.Equals(actor.Id, ownerId, StringComparison.Ordinal);
    }

    /// <summary>
    /// Who may flip the private flag. Same gate as page change-tracking: the
    /// item's owner, or an admin.
    /// </summary>
    public static bool CanSet(CurrentActor actor, string? ownerId) =>
        Bypass(actor)
        || (actor.Id is not null && string.Equals(actor.Id, ownerId, StringComparison.Ordinal));

    public static void EnsureCanSet(CurrentActor actor, string? ownerId)
    {
        if (!CanSet(actor, ownerId))
            throw new UnauthorizedAccessException(
                "Only the owner or an admin can change this item's privacy.");
    }

    public static void EnsurePrivateHasOwner(bool isPrivate, string? ownerId)
    {
        if (isPrivate && string.IsNullOrWhiteSpace(ownerId))
            throw new ArgumentException(
                "Assign an owner before making this item private.", nameof(isPrivate));
    }

    /// <summary>
    /// Apply an optional owner edit and an optional privacy edit. Clearing the
    /// owner while the item is private drops the flag — otherwise the row would
    /// vanish for everyone except admins. A *change* to privacy is owner-gated.
    /// </summary>
    public static (string? OwnerId, bool IsPrivate) Apply(
        CurrentActor actor,
        string? currentOwnerId,
        bool currentPrivate,
        string? requestedOwnerId,
        bool? requestedPrivate)
    {
        var ownerId = requestedOwnerId is null
            ? currentOwnerId
            : string.IsNullOrWhiteSpace(requestedOwnerId) ? null : requestedOwnerId.Trim();
        var isPrivate = requestedPrivate ?? currentPrivate;
        if (ownerId is null) isPrivate = false;
        if (isPrivate != currentPrivate)
            EnsureCanSet(actor, currentOwnerId);
        EnsurePrivateHasOwner(isPrivate, ownerId);
        return (ownerId, isPrivate);
    }

    /// <summary>
    /// SQL fragment: the aliased row itself is visible. Empty when the caller
    /// bypasses the filter. Bind <c>$viewer_id</c> via <see cref="BindViewer"/>.
    /// </summary>
    public static string ItemSql(string alias, CurrentActor actor) =>
        Bypass(actor) ? "" : $" AND ({alias}.is_private = 0 OR {alias}.owner_id = $viewer_id)";

    /// <summary>
    /// Like <see cref="ItemSql"/> but safe on a LEFT JOIN: a NULL alias (wrong
    /// kind) does not hide the row.
    /// </summary>
    public static string OptionalItemSql(string alias, CurrentActor actor) =>
        Bypass(actor) ? "" : $" AND ({alias}.id IS NULL OR {alias}.is_private = 0 OR {alias}.owner_id = $viewer_id)";

    /// <summary>The book named by <paramref name="bookIdExpr"/> is visible.</summary>
    public static string BookSql(string bookIdExpr, CurrentActor actor) =>
        Bypass(actor) ? "" : $"""
             AND NOT EXISTS (
               SELECT 1 FROM book _pb
               WHERE _pb.id = {bookIdExpr} AND _pb.is_private = 1
                 AND (_pb.owner_id IS NULL OR _pb.owner_id != $viewer_id))
            """;

    /// <summary>The shelf the named book sits on, if any, is visible.</summary>
    public static string ShelfViaBookSql(string bookIdExpr, CurrentActor actor) =>
        Bypass(actor) ? "" : $"""
             AND NOT EXISTS (
               SELECT 1 FROM book _psb
               JOIN shelf _ps ON _ps.id = _psb.shelf_id
               WHERE _psb.id = {bookIdExpr} AND _ps.is_private = 1
                 AND (_ps.owner_id IS NULL OR _ps.owner_id != $viewer_id))
            """;

    /// <summary>The shelf named by <paramref name="shelfIdExpr"/> is visible (NULL shelf is fine).</summary>
    public static string ShelfSql(string shelfIdExpr, CurrentActor actor) =>
        Bypass(actor) ? "" : $"""
             AND ({shelfIdExpr} IS NULL OR NOT EXISTS (
               SELECT 1 FROM shelf _ps
               WHERE _ps.id = {shelfIdExpr} AND _ps.is_private = 1
                 AND (_ps.owner_id IS NULL OR _ps.owner_id != $viewer_id)))
            """;

    /// <summary>Item + owning book + that book's shelf. For pages, diagrams, decks, boards, plans, files.</summary>
    public static string DocumentSql(string alias, CurrentActor actor) =>
        ItemSql(alias, actor) + BookSql($"{alias}.book_id", actor) + ShelfViaBookSql($"{alias}.book_id", actor);

    public static void BindViewer(SqliteCommand cmd, CurrentActor actor)
    {
        if (Bypass(actor)) return;
        SqliteHelpers.Add(cmd, "$viewer_id", actor.Id ?? "");
    }

    public static async Task<bool> IsBookVisibleAsync(
        SqliteConnection conn, CurrentActor actor, string bookId, CancellationToken ct)
    {
        if (Bypass(actor)) return true;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT b.is_private, b.owner_id, s.is_private, s.owner_id
            FROM book b
            LEFT JOIN shelf s ON s.id = b.shelf_id
            WHERE b.id = $id
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", bookId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return false;
        if (!CanSee(actor, ReadFlag(reader, 0), SqliteHelpers.GetNullableString(reader, 1)))
            return false;
        if (reader.IsDBNull(2)) return true;
        return CanSee(actor, ReadFlag(reader, 2), SqliteHelpers.GetNullableString(reader, 3));
    }

    public static async Task<bool> IsShelfVisibleAsync(
        SqliteConnection conn, CurrentActor actor, string shelfId, CancellationToken ct)
    {
        if (Bypass(actor)) return true;

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT is_private, owner_id FROM shelf WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", shelfId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return false;
        return CanSee(actor, ReadFlag(reader, 0), SqliteHelpers.GetNullableString(reader, 1));
    }

    public static async Task<bool> IsDocumentVisibleAsync(
        SqliteConnection conn,
        CurrentActor actor,
        bool isPrivate,
        string? ownerId,
        string bookId,
        CancellationToken ct) =>
        CanSee(actor, isPrivate, ownerId)
        && await IsBookVisibleAsync(conn, actor, bookId, ct);

    /// <summary>The book's owner, or null when the book is missing or unowned.</summary>
    public static async Task<string?> OwnerNameAsync(
        SqliteConnection conn, string? ownerId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(ownerId)) return null;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT COALESCE(NULLIF(TRIM(display_name), ''), username)
            FROM app_user WHERE id = $id LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$id", ownerId);
        return await cmd.ExecuteScalarAsync(ct) as string;
    }

    public static async Task<string?> BookOwnerIdAsync(
        SqliteConnection conn, string bookId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT owner_id FROM book WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", bookId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return SqliteHelpers.GetNullableString(reader, 0);
    }

    public static bool ReadFlag(SqliteDataReader reader, int ordinal) =>
        !reader.IsDBNull(ordinal) && reader.GetInt32(ordinal) != 0;

    /// <summary>
    /// Search-time filter over <c>search_doc d</c>. <paramref name="publicOnly"/>
    /// hides every private row (the published website); otherwise the viewer's
    /// own private items stay visible. Empty when the caller bypasses.
    /// </summary>
    public static string SearchSql(CurrentActor actor, bool publicOnly)
    {
        if (publicOnly)
        {
            return """
                 AND NOT EXISTS (SELECT 1 FROM shelf x WHERE d.kind = 'shelf' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM book x WHERE d.kind = 'book' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM page x WHERE d.kind = 'page' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM diagram x WHERE d.kind = 'diagram' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM slide_deck x WHERE d.kind = 'slides' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM kanban_board x WHERE d.kind = 'kanban' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM project_plan x WHERE d.kind = 'project' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM attachment x WHERE d.kind = 'attachment' AND x.id = d.entity_id AND x.is_private = 1)
                 AND NOT EXISTS (SELECT 1 FROM note x WHERE d.kind = 'note' AND x.id = d.entity_id AND x.is_private = 1)
                 AND (d.book_id IS NULL OR NOT EXISTS (SELECT 1 FROM book x WHERE x.id = d.book_id AND x.is_private = 1))
                 AND (d.book_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM book x JOIN shelf s ON s.id = x.shelf_id
                   WHERE x.id = d.book_id AND s.is_private = 1))
                """;
        }

        if (Bypass(actor)) return "";

        return """
             AND NOT EXISTS (SELECT 1 FROM shelf x WHERE d.kind = 'shelf' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM book x WHERE d.kind = 'book' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM page x WHERE d.kind = 'page' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM diagram x WHERE d.kind = 'diagram' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM slide_deck x WHERE d.kind = 'slides' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM kanban_board x WHERE d.kind = 'kanban' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM project_plan x WHERE d.kind = 'project' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM attachment x WHERE d.kind = 'attachment' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND NOT EXISTS (SELECT 1 FROM note x WHERE d.kind = 'note' AND x.id = d.entity_id AND x.is_private = 1 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id))
             AND (d.book_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM book x WHERE x.id = d.book_id AND x.is_private = 1
                 AND (x.owner_id IS NULL OR x.owner_id != $viewer_id)))
             AND (d.book_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM book x JOIN shelf s ON s.id = x.shelf_id
               WHERE x.id = d.book_id AND s.is_private = 1
                 AND (s.owner_id IS NULL OR s.owner_id != $viewer_id)))
            """;
    }
}
