# LLM providers — writing help in the page editor

BeeDocs can call a language model while you write: inline autocomplete after a
typing pause, and rewrite / grammar / Markdown / summarise on a selection.

Nothing is enabled until you add a provider. The feature is invisible in the
editor until one exists, is enabled, and answers.

**Prefix:** `/api/llm` · **Configured in:** Settings → **AI providers**

---

## Supported providers

All four speak the OpenAI chat-completions API, so there is one client in the
API (`Services/LlmClient.cs`) and the providers differ only in base URL and
whether a key is required.

| Kind | Default base URL | Key | Default model |
|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | required | `openai/gpt-4o-mini` |
| `xai` | `https://api.x.ai/v1` | required | `grok-3-mini` |
| `openai` | `https://api.openai.com/v1` | required | `gpt-4o-mini` |
| `lmstudio` | `http://localhost:1234/v1` | none | _(whatever is loaded)_ |

The default model is a starting point only — the settings UI fills a picker from
the provider's own `/models`. A blank model means "the first model the provider
lists", which is the normal case for LM Studio.

Anything OpenAI-compatible works if you point one of these kinds at it: add the
provider, then edit its **Base URL**. `kind` only decides the defaults and
whether a key is demanded.

---

## Adding a provider

Settings → **AI providers** → pick a kind. The name and base URL are filled in;
you add the key, pick a model, and press **Test connection**.

- **Key** — write-only. It is stored on the server and never sent back, so the
  box is empty every time the card opens. Leaving it empty on save keeps the
  stored key; **Remove key** deletes it.
- **Test connection** — lists the provider's models, which proves reachability
  and credentials without spending anything. On OpenRouter it also calls the
  free `/key` endpoint, because that provider's `/models` is public and would
  otherwise pass with a bad key.
- **Default** is not a stored flag. The API answers with the first *enabled*
  provider by `sortOrder`, so **Make default** moves that provider to the top.
- **Enabled** off keeps the row and its key but takes it out of the rotation.

---

## Where the keys live

In the `llm_provider` table of the SQLite file (`data/sqlite/beedocs.db` by
default, `BeeDocs:DataPath`), in the `api_key` column, **in plain text**. The
protection is file permissions on the database — treat it like any other secrets
file, and keep it out of backups you would not put a key in.

The column is selected in exactly one place, `LlmProviderService.ResolveAsync`,
which hands it to `LlmClient` for a single upstream call. No DTO carries it:
`LlmProviderDto` has `hasKey` and `keyHint` (the last four characters) and no key
field at all, so the browser never receives it. Every provider call is proxied by
the API for the same reason.

---

## Security: these routes spend money

`/api/llm` sits behind the same `ApiKeyEndpointFilter` as `/api/v1` — and that
filter does nothing until `BeeDocs:ApiKey` is set.

**A default install has no API key.** With a provider key stored, anyone who can
reach the API port can POST `/api/llm/complete` and bill it to you. The API logs
a warning at startup when it finds a stored provider key and no `BeeDocs:ApiKey`.

| Config | Env var | Effect |
|---|---|---|
| `BeeDocs:ApiKey` | `BeeDocs__ApiKey` | When set, `/api/llm` and `/api/v1` require `Authorization: Bearer <key>` or `X-Api-Key: <key>` |

There is a trade-off, and it is worth knowing before you set the key: **the web
UI cannot send it.** The browser client has no place to hold a shared secret, so
on a deployment with `BeeDocs:ApiKey` set, the AI providers section reports
"Not available on this deployment" and the editor's writing help stays off.
`/api/llm` is then reachable only from something that can send the header
(`curl`, a script).

Pick one:

- **Localhost only** — bind the API to loopback and leave `BeeDocs:ApiKey`
  unset. The UI works, and nothing off the machine can reach the routes.
- **Behind an authenticating proxy** — Cloudflare Access or equivalent in front,
  the port firewalled so the proxy cannot be bypassed (see
  [MCP-HOSTING.md](./MCP-HOSTING.md), which has the same shape of problem). The
  UI works, and the proxy is what keeps strangers out.
- **`BeeDocs:ApiKey` set** — safe on an open port, but the in-editor writing help
  is off for everyone.

Do not expose an unauthenticated BeeDocs port to the internet with a provider key
stored. LM Studio is the exception worth remembering: no key, no bill, so the
worst case there is a stranger using your GPU.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/llm/providers` | List providers (never includes keys) |
| `POST` | `/api/llm/providers` | Create one — `kind` is the only required field |
| `GET` | `/api/llm/providers/{id}` | One provider |
| `PUT` | `/api/llm/providers/{id}` | Update. `apiKey`: omit = keep, `""` = delete, else replace |
| `DELETE` | `/api/llm/providers/{id}` | Delete it and its key |
| `POST` | `/api/llm/providers/{id}/test` | Reachability + credentials. Always `200`; read `ok` and `message` |
| `GET` | `/api/llm/providers/{id}/models` | Models the provider advertises, sorted by id |
| `POST` | `/api/llm/complete` | Run one task |

An upstream failure comes back as **`502`** with `{"error":"…"}`. The message is
already written for the person who has to fix it (`"xAI rejected the API key"`,
`"LM Studio is not running on http://localhost:1234/v1."`) — show it verbatim.

```bash
# add OpenRouter (base URL and name default from the kind)
curl -sS -X POST http://localhost:5080/api/llm/providers \
  -H 'Content-Type: application/json' \
  -d '{"kind":"openrouter","apiKey":"sk-or-…","model":"openai/gpt-4o-mini"}'

# prove it works
curl -sS -X POST http://localhost:5080/api/llm/providers/<id>/test

# one completion, using the first enabled provider
curl -sS -X POST http://localhost:5080/api/llm/complete \
  -H 'Content-Type: application/json' \
  -d '{"task":"grammar","selection":"teh API dont respond"}'
```

Add `-H "Authorization: Bearer <key>"` when `BeeDocs:ApiKey` is set.

### `/api/llm/complete`

| Field | Notes |
|---|---|
| `task` | `continue`, `rewrite`, `grammar`, `format`, `summarize`. Aliases are accepted (`autocomplete`, `proofread`, `markdown`, `summarise`…) |
| `prompt` | For `continue`: the text immediately before the caret. Otherwise an optional extra instruction |
| `context` | Surrounding document text, for grounding. Never echoed back |
| `selection` | What the selection tasks operate on |
| `providerId` | Omit for the first enabled provider |
| `model` | Omit for the provider's configured model |
| `maxTokens`, `temperature` | Omit for the per-task defaults |

Input is truncated server-side — context to the last 6000 characters (the end is
what matters), prompt to 4000, selection to 16000. `continue` is capped at 128
output tokens because an autocomplete is a sentence, not an essay; `summarize`
at 512; the rest scale with the input up to 4096. On OpenRouter/xAI/OpenAI,
`continue` / `grammar` / `format` also send `reasoning.effort: "none"` so a
reasoning model does not spend hundreds of tokens thinking before a short phrase;
`rewrite` / `summarize` use `"low"`. Timeouts: 90s for a completion, 20s for a
model list, 15s for a test.

The response `text` is cleaned before it is returned — wrapping code fences,
surrounding quotes and the `<think>` block that local reasoning models emit are
all stripped, since models add them despite being told not to.

---

## Pointing it at LM Studio

Local models, no key, no bill.

1. In LM Studio: load a model, then start the server on the **Developer** tab
   (**Server** in older builds). It listens on `http://localhost:1234` and its
   OpenAI-compatible routes are under `/v1`.
2. In BeeDocs: Settings → AI providers → **LM Studio**. The base URL is filled in
   as `http://localhost:1234/v1`. Leave **Model** blank to use whatever is
   loaded, or pick one from the list.
3. **Test connection.** "LM Studio is not running on …" means the server is
   stopped, not that the model is wrong.

Instruct-tuned models handle these tasks; base-completion models tend to ramble.
Small models are fine for `grammar` and `continue` and noticeably worse at
`rewrite`.

**In a container:** `localhost` inside the container is the container. Point the
base URL at `http://host.docker.internal:1234/v1` (Docker Desktop / Podman) or
the host's LAN address, and set LM Studio to serve on the network rather than
loopback only.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| No AI controls in the editor | No provider is enabled, or the list call failed. The bar is hidden rather than shown broken |
| "Not available on this deployment" | `BeeDocs:ApiKey` is set — see the trade-off above |
| Ghost text never appears | Inline suggestions toggled off in the editor bar (off until you enable them under **AI help**), the field is empty, a text selection is active (that is for rewrite/grammar instead), or the provider is in backoff after a failure (the AI help pill says **Paused** — use **Resume now**, or wait) |
| Continuations are very slow / empty | A reasoning model is thinking for hundreds of tokens before answering. BeeDocs sends `reasoning.effort: none` for `continue` on OpenRouter/xAI/OpenAI; pick a non-reasoning or "flash" instruct model if it is still slow |
| `502` "rejected the API key" | Wrong or expired key, or a model the key has no access to |
| `502` "returned 404 … check the base URL and the model id" | Base URL missing `/v1`, or a model id that provider does not serve |
| `502` "reports no remaining credit" | Out of credit upstream |
| Completion is empty | The model answered with nothing usable; `continue` legitimately returns empty when no sensible continuation exists |
