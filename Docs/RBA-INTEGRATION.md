# RBA integration

BeeDocs can delegate sign-in to the central **RBA** service (role-based access,
backed by ADFS/Entra). BeeDocs is registered in RBA as application **`DOC`**.
RBA replaces only two things: how a password is verified, and where a role comes
from. Everything else — session cookies, the `/api` endpoint filter, `/uploads`
gating, ownership, the machine API key for MCP — keeps working unchanged,
because a successful RBA login is turned into an ordinary `app_user` row plus an
ordinary BeeDocs session.

## Configuration

RBA is a **switchable login provider**. The normal way to turn it on or off is
**Settings → Sign-in provider** (admin-only): toggle, base URL, application
code, optional plant filter, role sync, and a connection test (without
credentials it checks reachability; with credentials it reports the role that
account would get, creating nothing). Saved settings live in `app_setting`
(key `rba.settings`, `RbaSettingsService`), apply to the **next login** with no
restart, and are served by `GET/PUT /api/settings/rba` — `DELETE` reverts to
the server configuration. The admin's own session survives the switch, which
is what makes flipping it back after a misconfiguration possible.

`BeeDocs:Rba` in configuration remains as the fallback for deployments that
manage this outside the app; stored settings always win once saved. RBA layers
on top of the existing sign-in wall, so `BeeDocs:Auth:Enabled` must be on:

```jsonc
"BeeDocs": {
  "Auth": { "Enabled": true },          // the wall itself
  "Rba": {                               // fallback — the Settings page overrides this
    "Enabled": true,
    "BaseUrl": "https://rba.example.com", // login goes to {BaseUrl}/v1/auth/token/basic
    "ApplicationCd": "DOC",
    "PlantCd": "",                        // empty = accept a DOC role from any plant
    "SyncRoles": true,                    // re-derive the role from RBA on every login
    "TimeoutSeconds": 15
  }
}
```

Env-var form: `BeeDocs__Rba__Enabled=true`, `BeeDocs__Rba__BaseUrl=…`, etc.

## Login flow (client-side)

The RBA connection is made by the **browser**, not by the BeeDocs API — the
password never transits BeeDocs:

1. `/api/auth/me` tells the SPA `rbaEnabled` and `rbaBaseUrl`.
2. The login form posts the credentials **directly to RBA**
   (`POST {rbaBaseUrl}/v1/auth/token/basic`, `api.rbaBasicLogin`) and receives
   the `MultiAuthuser` answer including RBA's RS256-signed JWT.
3. The browser hands only that token to `POST /api/auth/rba`.
4. The BeeDocs server verifies the token itself
   (`RbaTokenValidator`: RS256 signature against RBA's
   `/.well-known/jwks.json`, expiry; JWKS cached 10 min with a refetch on
   unknown `kid`). This check matters: RBA's own token lookup does not verify
   signatures on its self-issued tokens, so BeeDocs' JWKS check is what stops a
   hand-crafted token. Identity comes from the *verified* claims
   (`preferred_username`), never from anything else the browser sent.
5. The DOC roles are **not** in the JWT (its `roles` claims are STASID-mapped
   strings), and browser-supplied roles cannot be trusted — so the server
   fetches the authoritative `MultiAuthuser` from RBA with the token
   (`{username, adfsToken}` variant of the same endpoint) and maps the role:
   - group ending `_ADMIN`, or action `DOC_USER_MANAGE` → **admin**
   - group ending `_EDITOR`, or any `*_WRITE` action → **editor**
   - anything else granted under DOC → **viewer**
   - nothing granted under DOC at all → **403 "no BeeDocs access"**
6. The account is provisioned (first login) or refreshed (every login after)
   in `app_user` — `IUserService.ProvisionExternalUserAsync` — with an
   unusable random password, then a normal session cookie is issued.

### Local (integrated) accounts stay a sign-in path

The login dialog offers "Use a local BeeDocs account instead" while RBA is on,
and `POST /api/auth/login` checks **local credentials first**, then falls back
to forwarding them to RBA. This is deliberate break-glass: an unreachable or
misconfigured RBA (an on-prem service an Azure instance cannot see, a typo'd
URL) must never lock the local admin out of the very instance that configured
it — sign in locally, then fix or disable RBA in Settings. It grants nothing
to RBA-provisioned accounts, whose stored password is an unusable random token.
For the same reason, self-service password change (`/api/auth/password`) is
*not* blocked in RBA mode — the current-password check already makes it
unusable for RBA-provisioned accounts.

Outcomes the form can show: 401 (RBA rejected the credentials, or the token
did not verify), 403 (no DOC group), 503 (RBA unreachable).

**Reachability**: the RBA base URL must be reachable from users' browsers
(steps 2) *and* from the BeeDocs server (steps 4–5), and RBA's `CorsUrls`
configuration must include the BeeDocs origin, or the browser's direct call
is blocked by CORS.

## What changes in RBA mode

- **No first-run setup.** `setupRequired` is always false and
  `POST /api/auth/setup` answers 409 — the first admin is whoever first signs
  in holding `DOC_ADMIN`.
- **RBA accounts have no local password.** Provisioned accounts store an
  unusable random token, so password change and local login can never work for
  them; genuinely local accounts keep both (see the break-glass section below).
- **Roles follow RBA.** With `SyncRoles` on (default), a role edited on the
  Users page is overwritten at that person's next sign-in. Turn `SyncRoles`
  off to let local edits stick.
- **Disabling still works locally.** A locally disabled account is refused at
  login even with valid RBA credentials (folded into the generic 401), and its
  live sessions die on the next request — the local block outranks RBA.
- **Machines are untouched.** `BeeDocs:ApiKey` still authenticates MCP and
  publishing apps as admin; RBA is only consulted for browser logins.

## RBA-side setup

`scripts/rba/create-rba-doc-data.sql` (idempotent, SQL Server `Alpha` DB,
written against the live schema: GUID keys, `datetimeoffset` dates, action
names unique per application, groups unique per application + name + plant)
creates the application `DOC`, twenty `DOC_*` actions, the three groups
`DOC_VIEWER` / `DOC_EDITOR` / `DOC_ADMIN` with their `role_action` links, and a
commented template for granting a user a group. Adjust `@plant_cd` before
running; re-run with another value to create the same groups on another plant.
Leave `BeeDocs:Rba:PlantCd` empty unless one BeeDocs instance must only honour
one plant's grants.

Custom RBA groups work too: name them with an `_ADMIN` / `_EDITOR` / `_VIEWER`
suffix, or rely on the action fallback (any `*_WRITE` action ⇒ editor).

## Offline mode: cloud-hosted BeeDocs, on-prem RBA

When the API is hosted where it has no route to RBA (e.g. BeeDocs in Azure, RBA
on the intranet) but the users' browsers reach both, the standard design cannot
work: the server can neither fetch the JWKS nor run the role lookup. **Offline
mode** (Settings → Sign-in provider → "Offline mode", or `BeeDocs:Rba:Offline`
plus `BeeDocs:Rba:Jwks`) restructures the trust so nothing server→RBA remains:

- **Sign-in is unchanged for users**: the browser still posts credentials to
  RBA and hands BeeDocs the JWT.
- **Signature verification uses pinned keys**: the admin pastes the JSON from
  `{baseUrl}/.well-known/jwks.json` into the settings (the panel has a
  "Fetch via this browser" button — the browser is on RBA's network, so it can
  fill the field itself). The JWKS is public key material, not a secret, and
  changes only when RBA rotates keys — after a rotation, update the paste once.
  This keeps the load-bearing property intact: a hand-crafted token still dies
  on the signature check.
- **Roles are managed locally**: the DOC groups live in a database the server
  cannot reach, so the role lookup is skipped. New accounts are provisioned as
  **viewer** and an admin promotes them on the Users page; `SyncRoles` is
  forced off so a login never demotes a promoted account. The admin who enables
  offline mode already has an account (the settings are admin-gated), so there
  is no bootstrap gap.
- **The server never dials the base URL** — it exists only so the login screen
  can hand it to browsers. Server-side RBA credential login answers 503; the
  connection test reports on the pinned keys instead of probing.

Pinned keys also work in online mode: when set, they are tried first (saving
the JWKS round trip), with the live fetch as fallback after a rotation.

## Troubleshooting: 401 on `POST /api/auth/rba`

The login is two hops that fail independently: the browser reaching RBA (step
one — if this worked, the login dialog got past the credential prompt) and the
**BeeDocs server** reaching RBA (step two — signature check against the JWKS,
then the `adfsToken` role lookup). A 401 on `/api/auth/rba` means step two
rejected the token, and "RBA works from other apps" only proves step one: those
apps talk to RBA from the user's machine, while BeeDocs talks to it from
wherever the API is hosted — different DNS, different proxy, different
certificate trust.

The API log names the exact reason (`RbaTokenValidator` / `RbaAuthService`
warnings), and Settings → Sign-in provider → **Test** probes the JWKS from the
server and reports it in the result. The usual causes:

- **The server cannot fetch `{BaseUrl}/.well-known/jwks.json`** — a short
  intranet hostname the server (or its container) cannot resolve, an internal
  CA certificate the server does not trust, or a proxy in between. With no key
  to verify against, every login is refused (503 "sign-in service is
  unavailable"). Verify from the API host itself, not from a workstation.
- **RBA does not serve a JWKS at that path** (older RBA build) — same symptom;
  open the URL in a browser to check what answers.
- **The token is not RS256** — the log shows the actual `alg`; only RS256 is
  accepted.
- **RBA refuses the `adfsToken` lookup** despite a valid signature — the log
  says so explicitly; check the RBA version supports the
  `{username, adfsToken}` variant of `/v1/auth/token/basic`.
