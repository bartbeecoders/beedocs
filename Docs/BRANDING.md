# Branding & themes

BeeDocs can be re-branded per instance: an admin renames it, swaps the 🐝 mark
for a custom logo (uploaded or AI-generated), and every user picks from a wider
set of color themes — including one that follows the Omarchy desktop theme when
the server runs on an Omarchy machine.

## Instance name & logo

Settings → Branding (admin only).

- **Title** replaces "BeeDocs" in the workspace header, the login/setup
  screens, the browser tab, and PDF exports. Stored in `app_setting`
  (`branding.settings`); empty resets to the default. Capped at 60 characters.
- **Logo** replaces the 🐝 emoji in the header, the login screens, and the
  favicon. SVG, PNG, JPEG, or WebP, up to 2 MB; one logo at a time, stored as a
  single file under `BeeDocs:BrandingPath` (default `data/branding` next to the
  SQLite/uploads dirs — point the same persistent volume at it in containers).
- **Generate with AI** drafts an SVG mark through the default LLM provider
  (Settings → AI providers; the `claude-cli` kind works well and spends no API
  key). The result is a preview — nothing is stored until the admin clicks
  *Use this logo*.

### API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/branding` | anonymous | Title, logo URL, Omarchy palette. |
| `GET /api/branding/logo?v=N` | anonymous | The logo file (`v` cache-busts). |
| `GET/PUT /api/settings/branding` | admin | Read status / set title (null clears). |
| `POST /api/settings/branding/logo` | admin | Multipart upload. |
| `PUT /api/settings/branding/logo` | admin | Store an SVG (`{ "svg": "<svg…" }`). |
| `DELETE /api/settings/branding/logo` | admin | Back to the 🐝. |
| `POST /api/settings/branding/logo/generate` | admin | `{ prompt?, providerId?, model? }` → `{ svg, providerName, model }`, preview only. |

The reads are anonymous on purpose: the login screen renders the name and logo
before there is a session. That is also why the logo does **not** live under
`/uploads` — that path only opens to anonymous readers while a shelf is
published.

### SVG safety

The logo is served to every visitor and the generated variant is model output,
so `BrandingService.SanitizeSvg` gates both the AI and the upload path: a lone
`<svg>` element, no `<script>`/`<foreignObject>`/`<image>`/event handlers, no
references outside the document (`href` may only point at `#ids`), 512 KB cap.
An SVG that fails validation is rejected with the reason; a generated one maps
to a 502 "the model did not return a usable logo".

## Themes

Thirteen built-in themes (Settings → Appearance), each a CSS variable block in
`src/beedocs-web/src/index.css` keyed by `html[data-theme='…']` and a row in
`THEMES` (`src/beedocs-web/src/theme.tsx`): the original seven plus Nord,
Gruvbox, Catppuccin (mocha), Tokyo Night, Rosé Pine, and Solarized Light. The
choice is per-browser (`beedocs-theme` in localStorage). Adding another theme
is those two edits plus a swatch rule for the settings grid.

## The Omarchy theme

When the API process runs on a machine with [Omarchy](https://omarchy.org)
(the local install via `scripts/install-omarchy.sh`, or plain `dotnet run`),
`GET /api/branding` also reports the **active desktop theme**: the server reads
`~/.local/state/omarchy/current/theme/colors.toml` (canonical palette — mode,
accent, background shades) and falls back to
`~/.config/omarchy/current/theme/alacritty.toml` for older Omarchy releases,
shipping only the raw colors (cached for 5 s server-side).

The web app then offers an extra **Omarchy** card in the theme grid.
`omarchyTheme.ts` derives the full BeeDocs token set from the raw palette
(accent = the theme's declared accent, else the most saturated terminal color)
and applies it as inline custom properties — it is the one theme with no CSS
block, which is also why it only appears when the palette exists. Switching
the desktop theme (`omarchy theme set …`) is picked up on the next app load.

A browser that never chose a theme adopts the desktop theme automatically on
first load; any explicit choice — before or after — wins and is never
overridden. The last-seen palette is cached in localStorage so an
`omarchy`-themed reload doesn't flash the default colors.
