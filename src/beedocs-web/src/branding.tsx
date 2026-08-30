import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { withApiBase } from './basePath'
import { storedThemeAtBoot, useTheme } from './theme'
import type { Branding } from './types'

/**
 * Instance branding, fetched once from the anonymous /api/branding: the title
 * that replaces "BeeDocs", the custom logo, and the Omarchy desktop palette
 * when the server runs on an Omarchy machine. Sits inside ThemeProvider (it
 * feeds the palette into the theme layer) and outside the router/auth — the
 * login screen is a consumer.
 */
const DEFAULT_BRANDING: Branding = {
  title: 'BeeDocs',
  customTitle: false,
  logoUrl: null,
  omarchy: null,
}

type BrandingCtx = {
  branding: Branding
  /** Re-fetch after an admin saved changes, so the header updates in place. */
  refresh: () => Promise<void>
}

const Ctx = createContext<BrandingCtx | null>(null)

// Module-level mirror for non-React consumers (the PDF exporter stamps the
// instance name into documents it builds outside the component tree).
let currentTitle = DEFAULT_BRANDING.title
export function getBrandTitle(): string {
  return currentTitle
}

function applyFavicon(logoUrl: string | null) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  // The 🐝 data URI from index.html, remembered the first time so removing a
  // custom logo restores it.
  if (!link.dataset.defaultHref) link.dataset.defaultHref = link.href
  link.href = logoUrl ? withApiBase(logoUrl) : link.dataset.defaultHref
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)
  const { setOmarchy, setTheme } = useTheme()
  // Adopt the desktop theme at most once per page load, and only for a user
  // who never picked a theme themselves — their explicit choice always wins.
  const adoptedOmarchy = useRef(false)

  const refresh = useCallback(async () => {
    let next: Branding
    try {
      next = await api.getBranding()
    } catch {
      // Branding is a nicety: an unreachable API leaves the defaults standing,
      // and whatever made it unreachable will surface louder elsewhere.
      return
    }

    setBranding(next)
    currentTitle = next.title
    document.title = next.title
    applyFavicon(next.logoUrl)
    setOmarchy(next.omarchy)
    if (next.omarchy && !storedThemeAtBoot && !adoptedOmarchy.current) {
      adoptedOmarchy.current = true
      setTheme('omarchy')
    }
  }, [setOmarchy, setTheme])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ branding, refresh }), [branding, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useBranding() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useBranding outside provider')
  return ctx
}
