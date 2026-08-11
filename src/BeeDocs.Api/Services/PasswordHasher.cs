using System.Security.Cryptography;

namespace BeeDocs.Api.Services;

/// <summary>
/// PBKDF2-HMAC-SHA256 with a per-user random salt.
///
/// The stored string carries its own parameters —
/// <c>pbkdf2-sha256$&lt;iterations&gt;$&lt;salt&gt;$&lt;hash&gt;</c> — so raising
/// <see cref="DefaultIterations"/> later still verifies every password written
/// before the change; <see cref="NeedsRehash"/> then says which rows to upgrade
/// on their owner's next successful sign-in.
///
/// PBKDF2 rather than bcrypt/argon2 because it is in the BCL: BeeDocs.Api ships
/// with two NuGet references and no crypto dependency, and a password hash is a
/// bad place to take one on for a self-hosted app that must build offline.
/// </summary>
public static class PasswordHasher
{
    /// <summary>OWASP's floor for PBKDF2-HMAC-SHA256 (2023).</summary>
    public const int DefaultIterations = 210_000;

    private const string Algorithm = "pbkdf2-sha256";
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    /// <summary>
    /// No look-alikes (0/O, 1/l/I) — a generated password is read off a terminal
    /// and typed back in at least once.
    /// </summary>
    private const string PasswordAlphabet =
        "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

    /// <summary>Shortest password the API accepts. Long enough to matter, short enough to type.</summary>
    public const int MinimumPasswordLength = 8;

    public static string Hash(string password, int iterations = DefaultIterations)
    {
        ArgumentException.ThrowIfNullOrEmpty(password);

        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, HashBytes);
        return $"{Algorithm}${iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    /// <summary>
    /// Constant-time compare against a stored hash. A malformed or missing hash is
    /// a failed verification, never an exception — a corrupt row must not be able
    /// to take a login endpoint down.
    /// </summary>
    public static bool Verify(string? password, string? stored)
    {
        if (string.IsNullOrEmpty(password) || !TryParse(stored, out var iterations, out var salt, out var expected))
            return false;

        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>True when the stored hash is unreadable or below the current cost.</summary>
    public static bool NeedsRehash(string? stored) =>
        !TryParse(stored, out var iterations, out _, out _) || iterations < DefaultIterations;

    /// <summary>A random password for the seeded admin, and for admin-initiated resets.</summary>
    public static string GeneratePassword(int length = 20) =>
        RandomNumberGenerator.GetString(PasswordAlphabet, length);

    /// <summary>An opaque session token. URL-safe so it survives a cookie round trip untouched.</summary>
    public static string GenerateToken() =>
        Base64Url(RandomNumberGenerator.GetBytes(32));

    /// <summary>
    /// What goes in the database for a session. The raw token only ever exists in
    /// the cookie, so a leaked database still cannot be replayed as a session.
    /// </summary>
    public static string HashToken(string token) =>
        Base64Url(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token)));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    private static bool TryParse(string? stored, out int iterations, out byte[] salt, out byte[] hash)
    {
        iterations = 0;
        salt = [];
        hash = [];

        if (string.IsNullOrWhiteSpace(stored)) return false;

        var parts = stored.Split('$');
        if (parts.Length != 4 || parts[0] != Algorithm) return false;
        if (!int.TryParse(parts[1], out iterations) || iterations <= 0) return false;

        try
        {
            salt = Convert.FromBase64String(parts[2]);
            hash = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException)
        {
            return false;
        }

        return salt.Length > 0 && hash.Length > 0;
    }
}
