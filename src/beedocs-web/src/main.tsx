import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getBasePath } from './basePath'

// When the app is opened directly (not via the strip-prefix reverse proxy) the
// URL may lack the public base the router was built for — e.g. "/" instead of
// "/beedocs". The server serves the SPA either way; align the URL so the router
// renders. No-op when the base is empty or already present.
const base = getBasePath()
if (base && !window.location.pathname.startsWith(base)) {
  window.history.replaceState(null, '', base + window.location.pathname + window.location.search + window.location.hash)
}

// A window left open across an upgrade still runs the old bundle, whose lazy
// chunks (the isometric editor, Mermaid diagrams…) were deleted with it — the
// first one it needs 404s. Vite reports that as `vite:preloadError`; reloading
// fetches the new index.html and bundle. Once per minute at most, so a chunk
// that is genuinely missing shows its error instead of reloading forever.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'beedocs-chunk-reload'
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    // No storage: still worth one reload rather than a broken screen.
  }
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
