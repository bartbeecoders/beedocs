using Microsoft.Data.Sqlite;

namespace BeeDocs.Api.Services;

/// <summary>
/// Opens SQLite connections against the configured BeeDocs database file.
/// Uses Cache=Shared so concurrent request-scoped connections share the same store.
/// </summary>
public sealed class SqliteConnectionFactory
{
    private readonly string _connectionString;

    public SqliteConnectionFactory(IConfiguration configuration, IHostEnvironment environment)
    {
        var configured = configuration.GetConnectionString("Sqlite");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            _connectionString = EnsureCacheShared(configured);
            EnsureParentDirectory(_connectionString);
            return;
        }

        var dataDir = configuration["BeeDocs:DataPath"]
            ?? Path.Combine(environment.ContentRootPath, "data", "sqlite");
        dataDir = Path.GetFullPath(dataDir, environment.ContentRootPath);
        Directory.CreateDirectory(dataDir);

        var dbPath = Path.Combine(dataDir, "beedocs.db");
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        }.ToString();
    }

    public string ConnectionString => _connectionString;

    /// <summary>Open a connection ready for commands. Caller must dispose.</summary>
    public SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }

    public async Task<SqliteConnection> OpenConnectionAsync(CancellationToken ct = default)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);
        return connection;
    }

    private static string EnsureCacheShared(string connectionString)
    {
        var builder = new SqliteConnectionStringBuilder(connectionString)
        {
            Cache = SqliteCacheMode.Shared,
        };
        if (builder.Mode == SqliteOpenMode.ReadOnly)
            builder.Mode = SqliteOpenMode.ReadWriteCreate;
        return builder.ToString();
    }

    private static void EnsureParentDirectory(string connectionString)
    {
        var builder = new SqliteConnectionStringBuilder(connectionString);
        var path = builder.DataSource;
        if (string.IsNullOrWhiteSpace(path) || path is ":memory:" or "file::memory:")
            return;

        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
    }
}
