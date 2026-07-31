using System.Globalization;
using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

internal static class SqliteHelpers
{
    public static string NewId() => Guid.NewGuid().ToString("N");

    public static string FormatTimestamp(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    public static DateTimeOffset ReadTimestamp(SqliteDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal))
            return DateTimeOffset.UtcNow;

        var raw = reader.GetString(ordinal);
        if (DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out var dto))
            return dto;

        return DateTimeOffset.UtcNow;
    }

    public static string? GetNullableString(SqliteDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    public static void Add(SqliteCommand cmd, string name, object? value) =>
        cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
}
