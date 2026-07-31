# Migrate BeeDocs from SurrealDB to SQLite

Completed. Persistence in `BeeDocs.Api` now uses **Microsoft.Data.Sqlite**
instead of embedded SurrealDB/RocksDB.

## What changed

- NuGet: dropped `SurrealDb.*`, added `Microsoft.Data.Sqlite`
- Entities are plain POCOs with `string Id` (GUID `N` format at create time)
- Schema: `CREATE TABLE IF NOT EXISTS` for book / chapter / page /
  page_revision / diagram / shape_collection (+ indexes, WAL mode)
- Services rewritten to parameterized SQL; REST DTOs and interfaces unchanged
- Default store: `BeeDocs:DataPath` → `data/sqlite/beedocs.db`
  (override with `ConnectionStrings:Sqlite`)
- Docker / compose / K3S / Host supervisor point at `/data/sqlite`

## Existing data

There is **no** Surreal→SQLite converter. On first boot you get an empty DB.

To move content from an old Surreal instance:

1. Export: `GET /api/books/{id}/export?format=archive` → `.beedocs`
2. Deploy / start the SQLite build
3. Import: `POST /api/import` with the archive

Uploads under `data/uploads` are unchanged and can stay on the same volume.
