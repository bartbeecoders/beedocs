/**
 * Public URL path bases for a strip-prefix reverse proxy
 * (e.g. CapDev ReverseProxy: https://server/beedocs → http://localhost:8210/).
 *
 * The BeeDocs backend always serves at root (/api, /uploads, SPA). The browser
 * still sees /beedocs/... — these helpers prefix fetch/asset/router URLs so the
 * proxy can strip them before they hit the upstream.
 *
 * UI base  — Vite `base` / `import.meta.env.BASE_URL` (e.g. "/beedocs")
 * API base — `VITE_BEEDOCS_API_PATH_BASE` (e.g. "/beedocs" or "/beedocs-api");
 *            falls back to the UI base when unset
 */

function normalizeBase(raw: string | undefined): string {
  if (!raw) return ''
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed === '/' ? '' : trimmed
}

/** SPA / asset path base (no trailing slash). Empty = site at domain root. */
export function getBasePath(): string {
  return normalizeBase(import.meta.env.BASE_URL || '/')
}

/**
 * REST + uploads public path base (no trailing slash).
 * Defaults to the UI base when `VITE_BEEDOCS_API_PATH_BASE` is unset.
 */
export function getApiBasePath(): string {
  const fromEnv = normalizeBase(import.meta.env.VITE_BEEDOCS_API_PATH_BASE as string | undefined)
  return fromEnv || getBasePath()
}

function prefixWith(base: string, path: string): string {
  if (!path.startsWith('/')) return path
  if (!base) return path
  if (path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/** Prefix a UI/asset path with the SPA public base. */
export function withBase(path: string): string {
  return prefixWith(getBasePath(), path)
}

/** Prefix an API or uploads path (`/api/...`, `/uploads/...`) with the API public base. */
export function withApiBase(path: string): string {
  return prefixWith(getApiBasePath(), path)
}

/** React Router basename (no trailing slash), or undefined at root. */
export function getRouterBasename(): string | undefined {
  const base = getBasePath()
  return base || undefined
}
