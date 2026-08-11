using BeeDocs.Api.Models;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// The three fixed roles, ordered. Nothing here is stored as a permission matrix:
/// a docs tool has exactly three interesting answers to "what may this account
/// do", and a role table would be a settings screen nobody edits.
/// </summary>
public static class UserRoles
{
    /// <summary>Everything, plus account management.</summary>
    public const string Admin = "admin";

    /// <summary>Create, edit and delete content. No account management.</summary>
    public const string Editor = "editor";

    /// <summary>Read, search and export. No writes of any kind.</summary>
    public const string Viewer = "viewer";

    public static readonly IReadOnlyList<string> All = [Admin, Editor, Viewer];

    /// <summary>Accepts the spellings a UI or a hand-written request is likely to send.</summary>
    public static string? Normalize(string? raw) =>
        (raw ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "admin" or "administrator" or "owner" => Admin,
            "editor" or "writer" or "author" => Editor,
            "viewer" or "reader" or "read-only" or "readonly" => Viewer,
            _ => null,
        };

    public static bool CanWrite(string role) => role is Admin or Editor;

    public static bool CanManageUsers(string role) => role == Admin;

    /// <summary>Whether <paramref name="role"/> satisfies a requirement for <paramref name="required"/>.</summary>
    public static bool Satisfies(string role, string required) => Rank(role) >= Rank(required);

    private static int Rank(string role) => role switch
    {
        Admin => 3,
        Editor => 2,
        Viewer => 1,
        _ => 0,
    };
}

/// <summary>
/// The caller behind one request. <see cref="User"/> is null for the API-key
/// caller, which is a machine (MCP, a publishing app) rather than an account —
/// it gets admin authority but has no profile to show or password to change.
/// </summary>
/// <param name="Via">session | apiKey | open.</param>
public sealed record CurrentUser(string Via, string Role, UserDto? User)
{
    public bool CanWrite => UserRoles.CanWrite(Role);

    public bool CanManageUsers => UserRoles.CanManageUsers(Role);

    /// <summary>The caller when authentication is switched off: unrestricted, unidentified.</summary>
    public static readonly CurrentUser Open = new("open", UserRoles.Admin, null);

    /// <summary>A machine holding BeeDocs:ApiKey.</summary>
    public static readonly CurrentUser ApiKey = new("apiKey", UserRoles.Admin, null);
}

/// <summary>A freshly issued session: the raw token goes in the cookie, nowhere else.</summary>
public sealed record SessionTicket(string Token, DateTimeOffset ExpiresAt);

/// <summary>Raised when the first-run claim arrives at an instance that already has accounts.</summary>
public sealed class AlreadySetUpException()
    : Exception("This instance already has an account. Sign in instead.");

public interface IUserService
{
    Task<IReadOnlyList<UserDto>> ListAsync(CancellationToken ct = default);

    Task<UserDto?> GetAsync(string id, CancellationToken ct = default);

    /// <exception cref="ArgumentException">Invalid username, role, or too-short password.</exception>
    /// <exception cref="DuplicateUserException">The username is taken.</exception>
    Task<UserDto> CreateAsync(CreateUserRequest request, CancellationToken ct = default);

    /// <exception cref="ArgumentException">Invalid username or role.</exception>
    /// <exception cref="DuplicateUserException">The new username is taken.</exception>
    /// <exception cref="LastAdminException">The edit would leave no enabled admin.</exception>
    Task<UserDto?> UpdateAsync(string id, UpdateUserRequest request, CancellationToken ct = default);

    /// <exception cref="LastAdminException">The delete would leave no enabled admin.</exception>
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>Admin reset. Pass null to have a password generated and returned.</summary>
    /// <exception cref="ArgumentException">The password is too short.</exception>
    Task<SetUserPasswordResultDto?> SetPasswordAsync(
        string id,
        string? password,
        bool mustChange,
        CancellationToken ct = default);

    /// <summary>Self-service change. Returns null when the id is unknown.</summary>
    /// <exception cref="ArgumentException">The new password is too short.</exception>
    /// <exception cref="InvalidPasswordException">The current password does not match.</exception>
    Task<UserDto?> ChangePasswordAsync(
        string id,
        string currentPassword,
        string newPassword,
        CancellationToken ct = default);

    /// <summary>Null for an unknown user, a wrong password, or a disabled account — the caller cannot tell which.</summary>
    Task<UserDto?> AuthenticateAsync(string username, string password, CancellationToken ct = default);

    Task<SessionTicket> CreateSessionAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// Resolve a cookie token to its account, sliding the expiry when the session
    /// is past halfway. Null when the token is unknown, expired, or its account
    /// has since been disabled or deleted.
    /// </summary>
    Task<UserDto?> ResolveSessionAsync(string token, CancellationToken ct = default);

    Task RevokeSessionAsync(string token, CancellationToken ct = default);

    /// <summary>Drop every session for one account — what a disable, a delete or a password change means.</summary>
    Task RevokeAllSessionsAsync(string userId, CancellationToken ct = default);

    Task<int> CountAsync(CancellationToken ct = default);

    /// <summary>
    /// Claim the instance: create its first admin, with a password the person
    /// setting it up chose. The emptiness check and the insert are one statement,
    /// so two callers racing to claim a fresh instance cannot both win.
    /// </summary>
    /// <exception cref="ArgumentException">Invalid username, or too-short password.</exception>
    /// <exception cref="AlreadySetUpException">An account already exists.</exception>
    Task<UserDto> CreateFirstAdminAsync(
        string username,
        string password,
        string? displayName,
        CancellationToken ct = default);
}

public sealed class DuplicateUserException(string username)
    : Exception($"The username '{username}' is already taken.");

public sealed class LastAdminException(string message) : Exception(message);

public sealed class InvalidPasswordException() : Exception("The current password is incorrect.");

/// <summary>
/// CRUD over <c>app_user</c> plus the session table behind the sign-in cookie.
/// The password column is selected in exactly one place —
/// <see cref="AuthenticateAsync"/> and <see cref="ChangePasswordAsync"/>, both of
/// which compare it and discard it — and never reaches a DTO.
/// </summary>
public sealed class UserService(SqliteConnectionFactory db, ILogger<UserService> logger) : IUserService
{
    private const string SelectColumns =
        "id, username, display_name, email, role, enabled, must_change_password, last_login_at, created_at, updated_at";

    /// <summary>The same columns, aliased for the session join. Kept in step with <see cref="SelectColumns"/> by hand — ten columns, one reader.</summary>
    private const string SelectColumnsFromUser =
        "u.id, u.username, u.display_name, u.email, u.role, u.enabled, u.must_change_password, u.last_login_at, u.created_at, u.updated_at";

    /// <summary>Letters, digits, and the three separators a login name is ever spelled with.</summary>
    private const string UsernamePattern = "abcdefghijklmnopqrstuvwxyz0123456789._-";

    private static readonly TimeSpan SessionLifetimeFallback = TimeSpan.FromHours(168);

    /// <summary>
    /// Set from configuration at startup so the session table and the cookie agree
    /// on a lifetime without threading options through every call.
    /// </summary>
    public TimeSpan SessionLifetime { get; set; } = SessionLifetimeFallback;

    public async Task<IReadOnlyList<UserDto>> ListAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        // Admins first, then alphabetically — the list is read to answer "who can
        // do what", and that question starts at the top of the hierarchy.
        cmd.CommandText = $"""
            SELECT {SelectColumns} FROM app_user
            ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, username
            """;

        var list = new List<UserDto>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadDto(reader));
        return list;
    }

    public async Task<UserDto?> GetAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        return await SelectAsync(conn, id, ct);
    }

    public async Task<UserDto> CreateAsync(CreateUserRequest request, CancellationToken ct = default)
    {
        var username = NormalizeUsername(request.Username);
        var role = ParseRole(request.Role) ?? UserRoles.Viewer;
        RequireStrongEnoughPassword(request.Password);

        var now = DateTimeOffset.UtcNow;
        var id = SqliteHelpers.NewId();

        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO app_user
              (id, username, display_name, email, role, password_hash, enabled, must_change_password, created_at, updated_at)
            VALUES
              ($id, $username, $display_name, $email, $role, $password_hash, $enabled, $must_change, $created_at, $updated_at)
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        SqliteHelpers.Add(cmd, "$username", username);
        SqliteHelpers.Add(cmd, "$display_name", Trimmed(request.DisplayName));
        SqliteHelpers.Add(cmd, "$email", Trimmed(request.Email));
        SqliteHelpers.Add(cmd, "$role", role);
        SqliteHelpers.Add(cmd, "$password_hash", PasswordHasher.Hash(request.Password));
        SqliteHelpers.Add(cmd, "$enabled", (request.Enabled ?? true) ? 1 : 0);
        SqliteHelpers.Add(cmd, "$must_change", (request.MustChangePassword ?? false) ? 1 : 0);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(now));
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(now));

        try
        {
            await cmd.ExecuteNonQueryAsync(ct);
        }
        catch (SqliteException e) when (IsUniqueViolation(e))
        {
            throw new DuplicateUserException(username);
        }

        return (await SelectAsync(conn, id, ct))!;
    }

    public async Task<UserDto?> UpdateAsync(string id, UpdateUserRequest request, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return null;

        var username = request.Username is null ? existing.Username : NormalizeUsername(request.Username);
        var role = request.Role is null ? existing.Role : ParseRole(request.Role)
            ?? throw new ArgumentException(
                $"Unknown role '{request.Role}'. Use one of: {string.Join(", ", UserRoles.All)}.");
        var enabled = request.Enabled ?? existing.Enabled;

        // Losing the last admin locks everyone out of account management with no
        // way back short of editing the database by hand, so the two edits that
        // can cause it are refused rather than warned about.
        var staysAdmin = role == UserRoles.Admin && enabled;
        if (existing is { Role: UserRoles.Admin, Enabled: true } && !staysAdmin
            && await CountEnabledAdminsAsync(conn, excludingId: id, ct) == 0)
        {
            throw new LastAdminException(
                "This is the only enabled admin. Promote another account to admin before changing this one.");
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE app_user SET username = $username, display_name = $display_name, email = $email,
              role = $role, enabled = $enabled, updated_at = $updated_at
            WHERE id = $id
            """;
        SqliteHelpers.Add(cmd, "$id", id);
        SqliteHelpers.Add(cmd, "$username", username);
        SqliteHelpers.Add(cmd, "$display_name", request.DisplayName is null ? existing.DisplayName : Trimmed(request.DisplayName));
        SqliteHelpers.Add(cmd, "$email", request.Email is null ? existing.Email : Trimmed(request.Email));
        SqliteHelpers.Add(cmd, "$role", role);
        SqliteHelpers.Add(cmd, "$enabled", enabled ? 1 : 0);
        SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));

        try
        {
            await cmd.ExecuteNonQueryAsync(ct);
        }
        catch (SqliteException e) when (IsUniqueViolation(e))
        {
            throw new DuplicateUserException(username);
        }

        // A disabled account keeping a live cookie is the whole point of the flag
        // going away, so the sessions go with it.
        if (!enabled && existing.Enabled)
            await DeleteSessionsAsync(conn, id, ct);

        return await SelectAsync(conn, id, ct);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        var existing = await SelectAsync(conn, id, ct);
        if (existing is null) return false;

        if (existing is { Role: UserRoles.Admin, Enabled: true }
            && await CountEnabledAdminsAsync(conn, excludingId: id, ct) == 0)
        {
            throw new LastAdminException(
                "This is the only enabled admin. Create another admin before deleting this account.");
        }

        await DeleteSessionsAsync(conn, id, ct);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM app_user WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<SetUserPasswordResultDto?> SetPasswordAsync(
        string id,
        string? password,
        bool mustChange,
        CancellationToken ct = default)
    {
        // A generated password is the only one this method hands back; anything
        // the admin typed is already known to them and is not echoed.
        var generated = string.IsNullOrWhiteSpace(password);
        var value = generated ? PasswordHasher.GeneratePassword() : password!;
        if (!generated) RequireStrongEnoughPassword(value);

        await using var conn = await db.OpenConnectionAsync(ct);
        if (await SelectAsync(conn, id, ct) is null) return null;

        await WritePasswordAsync(conn, id, value, mustChange, ct);
        await DeleteSessionsAsync(conn, id, ct);

        var updated = (await SelectAsync(conn, id, ct))!;
        return new SetUserPasswordResultDto(updated, generated ? value : null);
    }

    public async Task<UserDto?> ChangePasswordAsync(
        string id,
        string currentPassword,
        string newPassword,
        CancellationToken ct = default)
    {
        RequireStrongEnoughPassword(newPassword);

        await using var conn = await db.OpenConnectionAsync(ct);

        string? hash;
        await using (var read = conn.CreateCommand())
        {
            read.CommandText = "SELECT password_hash FROM app_user WHERE id = $id LIMIT 1";
            SqliteHelpers.Add(read, "$id", id);
            hash = await read.ExecuteScalarAsync(ct) as string;
        }

        if (hash is null) return null;
        if (!PasswordHasher.Verify(currentPassword, hash)) throw new InvalidPasswordException();

        await WritePasswordAsync(conn, id, newPassword, mustChange: false, ct);

        // Every other browser holding this account's cookie is now stale — a
        // password change is usually a response to one of them being somewhere
        // it should not be.
        await DeleteSessionsAsync(conn, id, ct);

        return await SelectAsync(conn, id, ct);
    }

    public async Task<UserDto?> AuthenticateAsync(string username, string password, CancellationToken ct = default)
    {
        var normalized = (username ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0 || string.IsNullOrEmpty(password)) return null;

        await using var conn = await db.OpenConnectionAsync(ct);

        string? id = null;
        string? hash = null;
        var enabled = false;
        await using (var read = conn.CreateCommand())
        {
            read.CommandText = "SELECT id, password_hash, enabled FROM app_user WHERE username = $username LIMIT 1";
            SqliteHelpers.Add(read, "$username", normalized);
            await using var reader = await read.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
            {
                id = reader.GetString(0);
                hash = reader.GetString(1);
                enabled = reader.GetInt64(2) != 0;
            }
        }

        // Verify even when there is no such user, against a hash of the same shape:
        // returning early would make "no such account" measurably faster than "wrong
        // password" and turn the login endpoint into a username oracle.
        var ok = PasswordHasher.Verify(password, hash ?? DummyHash.Value);
        if (id is null || !ok || !enabled) return null;

        // The stored cost travels with the hash, so raising the iteration count is
        // a one-line change plus this: everyone is upgraded as they sign in.
        if (PasswordHasher.NeedsRehash(hash))
            await WritePasswordAsync(conn, id, password, mustChange: false, ct, touchUpdatedAt: false);

        await using (var touch = conn.CreateCommand())
        {
            touch.CommandText = "UPDATE app_user SET last_login_at = $now WHERE id = $id";
            SqliteHelpers.Add(touch, "$id", id);
            SqliteHelpers.Add(touch, "$now", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
            await touch.ExecuteNonQueryAsync(ct);
        }

        return await SelectAsync(conn, id, ct);
    }

    public async Task<SessionTicket> CreateSessionAsync(string userId, CancellationToken ct = default)
    {
        var token = PasswordHasher.GenerateToken();
        var now = DateTimeOffset.UtcNow;
        var expires = now.Add(SessionLifetime);

        await using var conn = await db.OpenConnectionAsync(ct);

        // Cheap enough to do on the one request per session that can afford it.
        await using (var sweep = conn.CreateCommand())
        {
            sweep.CommandText = "DELETE FROM user_session WHERE expires_at < $now";
            SqliteHelpers.Add(sweep, "$now", SqliteHelpers.FormatTimestamp(now));
            await sweep.ExecuteNonQueryAsync(ct);
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO user_session (token_hash, user_id, created_at, expires_at, last_seen_at)
            VALUES ($token_hash, $user_id, $created_at, $expires_at, $last_seen_at)
            """;
        SqliteHelpers.Add(cmd, "$token_hash", PasswordHasher.HashToken(token));
        SqliteHelpers.Add(cmd, "$user_id", userId);
        SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(now));
        SqliteHelpers.Add(cmd, "$expires_at", SqliteHelpers.FormatTimestamp(expires));
        SqliteHelpers.Add(cmd, "$last_seen_at", SqliteHelpers.FormatTimestamp(now));
        await cmd.ExecuteNonQueryAsync(ct);

        return new SessionTicket(token, expires);
    }

    public async Task<UserDto?> ResolveSessionAsync(string token, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;

        var tokenHash = PasswordHasher.HashToken(token);
        var now = DateTimeOffset.UtcNow;

        await using var conn = await db.OpenConnectionAsync(ct);

        // One join: an account disabled or deleted mid-session must stop working
        // on the very next request, not when its cookie eventually expires.
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"""
            SELECT s.expires_at, {SelectColumnsFromUser}
            FROM user_session s JOIN app_user u ON u.id = s.user_id
            WHERE s.token_hash = $token_hash AND u.enabled = 1
            LIMIT 1
            """;
        SqliteHelpers.Add(cmd, "$token_hash", tokenHash);

        DateTimeOffset expiresAt;
        UserDto user;
        await using (var reader = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await reader.ReadAsync(ct)) return null;
            expiresAt = SqliteHelpers.ReadTimestamp(reader, 0);
            user = ReadDto(reader, offset: 1);
        }

        if (expiresAt <= now)
        {
            await DeleteSessionAsync(conn, tokenHash, ct);
            return null;
        }

        // Sliding, but only past halfway: writing on every request would turn each
        // read of the workspace into a database write.
        if (expiresAt - now < SessionLifetime / 2)
        {
            await using var extend = conn.CreateCommand();
            extend.CommandText =
                "UPDATE user_session SET expires_at = $expires_at, last_seen_at = $now WHERE token_hash = $token_hash";
            SqliteHelpers.Add(extend, "$token_hash", tokenHash);
            SqliteHelpers.Add(extend, "$expires_at", SqliteHelpers.FormatTimestamp(now.Add(SessionLifetime)));
            SqliteHelpers.Add(extend, "$now", SqliteHelpers.FormatTimestamp(now));
            await extend.ExecuteNonQueryAsync(ct);
        }

        return user;
    }

    public async Task RevokeSessionAsync(string token, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(token)) return;
        await using var conn = await db.OpenConnectionAsync(ct);
        await DeleteSessionAsync(conn, PasswordHasher.HashToken(token), ct);
    }

    public async Task RevokeAllSessionsAsync(string userId, CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await DeleteSessionsAsync(conn, userId, ct);
    }

    public async Task<int> CountAsync(CancellationToken ct = default)
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM app_user";
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
    }

    public async Task<UserDto> CreateFirstAdminAsync(
        string username,
        string password,
        string? displayName,
        CancellationToken ct = default)
    {
        // Closed-ness beats input validation: on an instance that is already
        // claimed, every request here gets the same "sign in instead" answer
        // rather than a critique of a username that was never going to be used.
        // The real guard is still the conditional INSERT below — this is only the
        // fast path, and it is the one that cannot be raced.
        if (await CountAsync(ct) > 0) throw new AlreadySetUpException();

        var name = NormalizeUsername(username);
        RequireStrongEnoughPassword(password);

        var now = DateTimeOffset.UtcNow;
        var id = SqliteHelpers.NewId();

        await using var conn = await db.OpenConnectionAsync(ct);
        await using (var cmd = conn.CreateCommand())
        {
            // INSERT … SELECT … WHERE NOT EXISTS, not "count then insert": the
            // check and the write have to be one statement, or two people opening
            // the setup page at once could each be told the instance was theirs.
            cmd.CommandText = """
                INSERT INTO app_user
                  (id, username, display_name, email, role, password_hash, enabled, must_change_password, created_at, updated_at)
                SELECT $id, $username, $display_name, NULL, $role, $password_hash, 1, 0, $created_at, $updated_at
                WHERE NOT EXISTS (SELECT 1 FROM app_user)
                """;
            SqliteHelpers.Add(cmd, "$id", id);
            SqliteHelpers.Add(cmd, "$username", name);
            SqliteHelpers.Add(cmd, "$display_name", Trimmed(displayName));
            SqliteHelpers.Add(cmd, "$role", UserRoles.Admin);
            SqliteHelpers.Add(cmd, "$password_hash", PasswordHasher.Hash(password));
            SqliteHelpers.Add(cmd, "$created_at", SqliteHelpers.FormatTimestamp(now));
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(now));

            if (await cmd.ExecuteNonQueryAsync(ct) == 0)
                throw new AlreadySetUpException();
        }

        logger.LogInformation("First-run setup complete — admin account '{Username}' created.", name);
        return (await SelectAsync(conn, id, ct))!;
    }

    // --- internals ---

    private static async Task WritePasswordAsync(
        SqliteConnection conn,
        string id,
        string password,
        bool mustChange,
        CancellationToken ct,
        bool touchUpdatedAt = true)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = touchUpdatedAt
            ? """
              UPDATE app_user SET password_hash = $hash, must_change_password = $must_change, updated_at = $updated_at
              WHERE id = $id
              """
            : "UPDATE app_user SET password_hash = $hash, must_change_password = $must_change WHERE id = $id";
        SqliteHelpers.Add(cmd, "$id", id);
        SqliteHelpers.Add(cmd, "$hash", PasswordHasher.Hash(password));
        SqliteHelpers.Add(cmd, "$must_change", mustChange ? 1 : 0);
        if (touchUpdatedAt)
            SqliteHelpers.Add(cmd, "$updated_at", SqliteHelpers.FormatTimestamp(DateTimeOffset.UtcNow));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<UserDto?> SelectAsync(SqliteConnection conn, string id, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT {SelectColumns} FROM app_user WHERE id = $id LIMIT 1";
        SqliteHelpers.Add(cmd, "$id", id);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        return await reader.ReadAsync(ct) ? ReadDto(reader) : null;
    }

    private static async Task<int> CountEnabledAdminsAsync(
        SqliteConnection conn,
        string excludingId,
        CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM app_user WHERE role = 'admin' AND enabled = 1 AND id <> $id";
        SqliteHelpers.Add(cmd, "$id", excludingId);
        return Convert.ToInt32(await cmd.ExecuteScalarAsync(ct));
    }

    private static async Task DeleteSessionAsync(SqliteConnection conn, string tokenHash, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM user_session WHERE token_hash = $token_hash";
        SqliteHelpers.Add(cmd, "$token_hash", tokenHash);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task DeleteSessionsAsync(SqliteConnection conn, string userId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM user_session WHERE user_id = $user_id";
        SqliteHelpers.Add(cmd, "$user_id", userId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static UserDto ReadDto(SqliteDataReader reader, int offset = 0) => new(
        Id: reader.GetString(offset),
        Username: reader.GetString(offset + 1),
        DisplayName: SqliteHelpers.GetNullableString(reader, offset + 2),
        Email: SqliteHelpers.GetNullableString(reader, offset + 3),
        Role: reader.GetString(offset + 4),
        Enabled: !reader.IsDBNull(offset + 5) && reader.GetInt64(offset + 5) != 0,
        MustChangePassword: !reader.IsDBNull(offset + 6) && reader.GetInt64(offset + 6) != 0,
        LastLoginAt: reader.IsDBNull(offset + 7) ? null : SqliteHelpers.ReadTimestamp(reader, offset + 7),
        CreatedAt: SqliteHelpers.ReadTimestamp(reader, offset + 8),
        UpdatedAt: SqliteHelpers.ReadTimestamp(reader, offset + 9));

    private static string? Trimmed(string? raw) =>
        string.IsNullOrWhiteSpace(raw) ? null : raw.Trim();

    private static string NormalizeUsername(string? raw)
    {
        var value = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (value.Length is < 2 or > 64)
            throw new ArgumentException("Username must be between 2 and 64 characters.");
        if (value.Any(c => !UsernamePattern.Contains(c)))
            throw new ArgumentException("Username may contain only letters, digits, dot, underscore and hyphen.");
        return value;
    }

    private static string? ParseRole(string? raw) =>
        raw is null ? null : UserRoles.Normalize(raw)
            ?? throw new ArgumentException(
                $"Unknown role '{raw}'. Use one of: {string.Join(", ", UserRoles.All)}.");

    private static void RequireStrongEnoughPassword(string? password)
    {
        if ((password ?? string.Empty).Length < PasswordHasher.MinimumPasswordLength)
        {
            throw new ArgumentException(
                $"Password must be at least {PasswordHasher.MinimumPasswordLength} characters.");
        }
    }

    private static bool IsUniqueViolation(SqliteException e) =>
        e.SqliteErrorCode == 19; // SQLITE_CONSTRAINT

    /// <summary>
    /// A real hash of a throwaway password, computed once. Verifying against it
    /// costs the same as verifying a real account, which is what keeps a missing
    /// username indistinguishable from a wrong password.
    /// </summary>
    private static class DummyHash
    {
        public static readonly string Value = PasswordHasher.Hash("beedocs-no-such-account");
    }
}
