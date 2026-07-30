# Hosting the BeeDocs MCP server

How the MCP server runs on K3S, and how to put Cloudflare Access in front of it.

This document is about **operating** the hosted instance. For wiring a client up
to it — or to a local server, over either transport — see
[MCP-SERVER.md](MCP-SERVER.md).

---

## What is deployed

The MCP server runs as a sidecar container in the same pod as the API:

```
┌─ pod: beedocs ────────────────────────────────┐
│                                               │
│  container: beedocs          container: mcp   │
│  ASP.NET Core :8080  ◄────────  Node :5090    │
│  /  /api  /uploads   loopback   /mcp          │
│                                 /healthz      │
└───────────────────────────────────────────────┘
        │                              │
   NodePort 32095               NodePort 32096
        │                              │
   docs.<domain>                 mcp.<domain>
   (Access: SSO)             (Access: service token)
```

The MCP container reaches BeeDocs at `http://localhost:8080` over the pod
loopback, so the REST API never needs to be published to the cluster network on
its behalf.

**Transport:** Streamable HTTP, stateless. Every request builds its own
`McpServer` and discards it — there are no sessions to pin to a pod, and a
dropped connection through the tunnel costs nothing. Endpoint is `POST /mcp`.

**Why a separate hostname and not `docs.<domain>/mcp`?** The two need different
authentication. A human opening the web UI can complete an interactive SSO
login; an agent cannot. Splitting them lets each get the policy it needs without
path-based exceptions.

### Two layers of auth

| Layer | Mechanism | Set up by |
|---|---|---|
| Edge | Cloudflare Access service token | you, in the Zero Trust dashboard |
| Origin | `Authorization: Bearer <token>` checked by the MCP server | `deploy-k3s.sh` on first deploy |

The bearer token is generated on the VPS (`openssl rand -hex 32`), stored in the
`beedocs-mcp-auth` secret, and never written to this repo. Read it with:

```bash
./scripts/deploy-k3s.sh mcp-token
```

The origin check is deliberate redundancy. If an Access policy is ever
misconfigured, or the NodePort is reachable directly (see the warning below),
the bearer token is the thing still standing between the internet and
write access to every document.

---

## Firewall the NodePorts first

> ⚠️ Do this before pointing a public hostname at the service.

Cloudflare Access enforces at Cloudflare's edge. It does nothing for traffic
that reaches your VPS by another route. If `212.47.77.32:32095` and `:32096` are
open to the internet, anyone can hit them directly and skip Access entirely.

`cloudflared` runs on the node and connects outbound, so the NodePorts only ever
need to be reachable from the node itself:

```bash
# Allow the tunnel (local) and block everything else.
sudo ufw deny 32095/tcp
sudo ufw deny 32096/tcp
```

Verify from a machine that is not the VPS — both should hang or refuse:

```bash
curl --max-time 5 http://212.47.77.32:32095/api/health
curl --max-time 5 http://212.47.77.32:32096/healthz
```

If either returns a response, Access is decorative. Fix this before pointing a
public hostname at the service.

---

## 1. Cloudflare Tunnel ingress

Two hostnames, one tunnel. In the Zero Trust dashboard under
**Networks → Tunnels → your tunnel → Public Hostname**, or in
`~/.cloudflared/config.yml`:

```yaml
ingress:
  - hostname: docs.example.com
    service: http://localhost:32095
  - hostname: mcp.example.com
    service: http://localhost:32096
  - service: http_status:404
```

Both DNS records must exist as proxied (orange-cloud) CNAMEs to
`<tunnel-id>.cfargotunnel.com`; adding the hostname through the dashboard
creates them for you.

Check the tunnel path works before adding Access — at this point both hostnames
are public, so do this and then move straight on to step 2:

```bash
curl -s https://docs.example.com/api/health
curl -s https://mcp.example.com/healthz
```

---

## 2. Cloudflare Access for the web UI (interactive SSO)

Zero Trust dashboard → **Access → Applications → Add an application →
Self-hosted**.

1. **Application name:** `BeeDocs`
2. **Session duration:** 24 hours is a reasonable default.
3. **Public hostname:** subdomain `docs`, domain `example.com`, path empty.
4. **Next**, then add a policy:
   - **Policy name:** `BeeDocs team`
   - **Action:** `Allow`
   - **Include:** `Emails ending in` → `@yourdomain.com`
     (or `Emails` → an explicit list, or an Access group)
5. Save.

If you have no identity provider configured, Cloudflare's **One-time PIN** is
enabled by default and emails a code — enough to start. Add Google/GitHub/Entra
under **Settings → Authentication** when you want real SSO.

Now `https://docs.example.com` redirects to a login page, and `/api/*` is
covered by the same session cookie, so the SPA keeps working once you are in.

---

## 3. Cloudflare Access for MCP (service token)

Agents cannot complete a browser login, so this application uses a **service
token**: a client ID/secret pair sent as headers.

### 3a. Create the service token

Zero Trust dashboard → **Access → Service Auth → Service Tokens → Create
Service Token**.

- **Name:** `beedocs-mcp-agents`
- **Duration:** 1 year (the maximum; non-expiring is also offered)

Cloudflare shows the **Client ID** and **Client Secret exactly once**. Copy both
now — the secret cannot be retrieved later, only regenerated.



### 3b. Create the application

**Access → Applications → Add an application → Self-hosted**.

1. **Application name:** `BeeDocs MCP`
2. **Public hostname:** subdomain `mcp`, domain `example.com`
3. Add a policy:
   - **Policy name:** `MCP service token`
   - **Action:** **`Service Auth`** — not `Allow`. `Service Auth` skips the
     identity prompt entirely, which is what makes non-interactive clients work.
   - **Include:** `Service Token` → `beedocs-mcp-agents`
4. Save.

> If you pick `Allow` instead of `Service Auth`, Cloudflare still evaluates the
> token but will fall through to the login page for anything that does not
> match, and some clients follow the redirect and hang. Use `Service Auth`.

### 3c. Let the health endpoint through (optional)

If you want uptime monitoring to reach `/healthz` without a token, add a second
policy to the same application:

- **Action:** `Bypass`
- **Include:** `Everyone`
- and set the application path to `/healthz`

Only do this for `/healthz` — it exposes nothing but a status string and the
configured API URL.

---

## 4. Connect an agent

Three headers: two for Cloudflare Access, one for the MCP server itself.

```bash
claude mcp add --transport http beedocs https://mcp.example.com/mcp \
  -H "CF-Access-Client-Id: <client-id>.access" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  -H "Authorization: Bearer <token from ./scripts/deploy-k3s.sh mcp-token>"
```

The client ID always ends in `.access` — include that suffix.

For clients configured by file (Cursor, Claude Desktop, VS Code):

```json
{
  "mcpServers": {
    "beedocs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "CF-Access-Client-Id": "<client-id>.access",
        "CF-Access-Client-Secret": "<client-secret>",
        "Authorization": "Bearer <mcp-token>"
      }
    }
  }
}
```

Verify with curl before wiring up a client:

```bash
curl -s https://mcp.example.com/mcp \
  -H "CF-Access-Client-Id: <client-id>.access" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  -H "Authorization: Bearer <mcp-token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A JSON-RPC result listing the `beedocs_*` tools means both layers passed.

---

## Rotating credentials

**MCP bearer token** — delete the secret and redeploy; a new one is generated:

```bash
ssh <vps> "kubectl -n beedocs delete secret beedocs-mcp-auth"
./scripts/deploy-k3s.sh deploy
./scripts/deploy-k3s.sh mcp-token
```

**Cloudflare service token** — regenerate or delete it under **Access → Service
Auth**. Deleting revokes access immediately for every client using it.

Both rotations break existing agent configs, so update clients in the same pass.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| HTML login page instead of JSON | Policy action is `Allow`, not `Service Auth`; or the `CF-Access-*` headers are missing |
| `403` from Cloudflare | Service token not included in the policy, expired, or the client ID is missing its `.access` suffix |
| `401` with a JSON-RPC error body | Reached the MCP server, but `Authorization: Bearer` is wrong — re-read `deploy-k3s.sh mcp-token` |
| `404 Not found. MCP endpoint is /mcp.` | URL is missing the `/mcp` path |
| `502` from Cloudflare | Tunnel is up but the NodePort is not — check `./scripts/deploy-k3s.sh status` |
| MCP tools return API errors | Sidecar is fine, API container is not — `./scripts/deploy-k3s.sh logs` |

Container logs, split by container:

```bash
./scripts/deploy-k3s.sh logs
```

The MCP container logs `auth enabled` or a loud `auth DISABLED` warning at
startup — a quick way to confirm the secret was mounted.

---

## Local development

`MCP_TRANSPORT` defaults to `stdio`, so the existing local setup in
[MCP-SERVER.md](MCP-SERVER.md) keeps working untouched.

`./scripts/start.sh` now also runs the HTTP transport on `:5090` with the bearer
token `dev-token`, alongside the API and Vite. Use `SKIP_MCP=1` to leave it out,
or `MCP_PORT` / `MCP_AUTH_TOKEN` to override.

To run it by hand instead:

```bash
cd src/beedocs-mcp && pnpm build
MCP_TRANSPORT=http MCP_HTTP_PORT=5090 MCP_AUTH_TOKEN=dev-token node dist/index.js
```

```bash
claude mcp add --transport http beedocs-local http://localhost:5090/mcp \
  -H "Authorization: Bearer dev-token"
```

Omitting `MCP_AUTH_TOKEN` disables the origin check and logs a warning. That is
fine on localhost and never fine anywhere else.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `5090` | Listen port (http only) |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address (http only) |
| `MCP_AUTH_TOKEN` | _(unset)_ | Required bearer token; unset = no origin auth |
| `BEEDOCS_API_URL` | `http://localhost:5080` | BeeDocs API base URL (`http://localhost:8080` in-pod) |
