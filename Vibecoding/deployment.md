## Main project hosting
The main projects will be hosted on our K3S server.
I added a deploy-k3s.sh script to the scripts folder. This is a copy from another project, but you can use it as a starting point.
I will use cloudflare tunnel to expose the web site (I will do that config)
Expose the web site on the K3S on port 32095


## Local windows server hosting
Host BeeDocs on a Windows server with **`BeeDocs.Host`** — a .NET worker that supervises the API (UI + REST) and MCP child processes. One folder, one service.

### Build a deploy folder

On a build machine with .NET 10 SDK, Node 20+, and pnpm:

```powershell
.\scripts\publish-windows.ps1
# optional: -OutputDir C:\deploy\beedocs -SelfContained -NoBump -Sign
```

The script bumps the **build** digit in `<Version>` inside `src/BeeDocs.Api/BeeDocs.Api.csproj` before every build (same as `deploy-k3s.sh`). Use `-NoBump` or `$env:NO_BUMP = '1'` to rebuild the current version unchanged. Commit the bumped csproj after deploying so the header version pill maps to a known build.

**Code signing (`-Sign`):** uses `scripts/CodeCertificates/signtool.exe` and the first `*.pfx` in that folder (or `-CertificatePath`). Password via `-CertificatePassword` or `$env:SIGN_CERT_PASSWORD`. Signs `BeeDocs.Host.exe` and `BeeDocs.Api.exe` before zipping.

This produces `dist/windows/` and `dist/beedocs-<version>-win-x64.zip`.
.\scripts\publish-windows.ps1 -UiPathBase /beedocs -ApiPathBase /beedocs-api -McpPathBase /beedocs-mcp -Sign -CertificatePath F:\Tools\CodeSign.pfx

.\scripts\publish-windows.ps1 -UiPathBase /beedocs -ApiPathBase /beedocs -McpPathBase /beedocs-mcp
$env:SIGN_CERT_PASSWORD = '...'

| Path | Role |
|------|------|
| `BeeDocs.Host.exe` | Run this under NSSM or `sc create` |
| `api/` | Published `BeeDocs.Api` + baked `wwwroot` |
| `mcp/` | MCP HTTP server (`node dist/index.js`) |
| `data/` | Created at runtime (SurrealDB + uploads) |
| `logs/` | `api.log`, `mcp.log` from child processes |

**Server prerequisites:** .NET 10 runtime, Node 20+ on `PATH`. Edit `appsettings.json` before go-live — especially `BeeDocsHost:McpAuthToken`.

### Ports and reverse proxy

BeeDocs listens at **root** on local ports. CapDev ReverseProxy maps public path
prefixes onto those ports with **`strip_prefix` on**.

| Setting | Default | Role |
|---------|---------|------|
| `UiPort` | `8080` | Upstream for the SPA |
| `ApiPort` | `8081` | Upstream for REST + uploads (same process; binds both ports when different) |
| `McpPort` | `5090` | Upstream for MCP HTTP (`/mcp`, `/healthz`) |
| `UiPathBase` | `""` | Public SPA prefix baked into the web build, e.g. `/beedocs` |
| `ApiPathBase` | `""` | Public API prefix for browser fetches, e.g. `/beedocs-api`. Empty = same as `UiPathBase`. |
| `McpPathBase` | `""` | Public MCP prefix (docs/logging), e.g. `/beedocs-mcp` |

Set `ApiPort` equal to `UiPort` if you want a single upstream for UI+API.

Example ReverseProxy mappings:

| Public URL | Upstream |
|------------|----------|
| `https://server/beedocs` | `http://localhost:8210` |
| `https://server/beedocs-api` | `http://localhost:8211` |
| `https://server/beedocs-mcp` | `http://localhost:5090` |

```json
"BeeDocsHost": {
  "UiPort": 8210,
  "ApiPort": 8211,
  "McpPort": 5090,
  "UiPathBase": "/beedocs",
  "ApiPathBase": "/beedocs-api",
  "McpPathBase": "/beedocs-mcp",
  "McpAuthToken": "change-me"
}
```

Bake the public prefixes into the web build:

```powershell
.\scripts\publish-windows.ps1 -UiPathBase /beedocs -ApiPathBase /beedocs-api -McpPathBase /beedocs-mcp
```

Browser calls go to `/beedocs-api/api/...`; the proxy strips `/beedocs-api` and
forwards to `http://localhost:8211/api/...`.

### Install with NSSM

```powershell
nssm install BeeDocs C:\BeeDocs\BeeDocs.Host.exe
nssm set BeeDocs AppDirectory C:\BeeDocs
nssm set BeeDocs AppStdout C:\BeeDocs\logs\host.log
nssm set BeeDocs AppStderr C:\BeeDocs\logs\host.err.log
nssm start BeeDocs
```

`BeeDocs.Host` also registers as a native Windows service (`sc create BeeDocs binPath= "C:\BeeDocs\BeeDocs.Host.exe" start= auto`) if you prefer not to use NSSM.