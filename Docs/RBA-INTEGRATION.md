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
