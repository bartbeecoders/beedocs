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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
