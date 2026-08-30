import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OmarchyTheme } from './types'
import { deriveOmarchyVars, OMARCHY_VAR_KEYS } from './omarchyTheme'

export type ThemeId =
  | 'honey-light'
  | 'honey-dark'
  | 'slate'
  | 'ocean'
  | 'forest'
  | 'violet'
  | 'nord'
  | 'gruvbox'
  | 'catppuccin'
  | 'tokyo-night'
  | 'rose-pine'
  | 'solarized-light'
  | 'high-contrast'
  | 'omarchy'

export type ThemeDef = {
  id: ThemeId
  label: string
  description: string
  scheme: 'light' | 'dark'
}

/**
 * The static themes — each one is a variable block in index.css. `omarchy` is
 * deliberately not here: it only exists when /api/branding reports a desktop
 * palette, its colors are computed (omarchyTheme.ts) rather than declared in
 * CSS, and the settings grid renders its card separately for both reasons.
 */
export const THEMES: ThemeDef[] = [
  { id: 'honey-light', label: 'Honey Light', description: 'Warm paper, amber accents', scheme: 'light' },
  { id: 'honey-dark', label: 'Honey Dark', description: 'Warm charcoal + gold', scheme: 'dark' },
  { id: 'slate', label: 'Slate', description: 'Cool professional gray', scheme: 'dark' },
  { id: 'ocean', label: 'Ocean', description: 'Blue steel workspace', scheme: 'dark' },
  { id: 'forest', label: 'Forest', description: 'Soft green editorial', scheme: 'light' },
  { id: 'violet', label: 'Violet', description: 'Modern purple UI', scheme: 'dark' },
  { id: 'nord', label: 'Nord', description: 'Arctic blue-gray calm', scheme: 'dark' },
  { id: 'gruvbox', label: 'Gruvbox', description: 'Retro warm terminal', scheme: 'dark' },
  { id: 'catppuccin', label: 'Catppuccin', description: 'Soothing pastel mocha', scheme: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', description: 'Downtown neon blues', scheme: 'dark' },
  { id: 'rose-pine', label: 'Rosé Pine', description: 'Muted rose & iris', scheme: 'dark' },
  { id: 'solarized-light', label: 'Solarized Light', description: 'Classic low-glare paper', scheme: 'light' },
  { id: 'high-contrast', label: 'High contrast', description: 'Maximum readability', scheme: 'dark' },
]

type ThemeCtx = {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
  themeDef: ThemeDef
  /** Desktop palette from /api/branding — null off Omarchy machines. */
  omarchy: OmarchyTheme | null
  setOmarchy: (palette: OmarchyTheme | null) => void
  density: 'comfortable' | 'compact'
  setDensity: (d: 'comfortable' | 'compact') => void
  showPreviewDefault: boolean
  setShowPreviewDefault: (v: boolean) => void
  autoSaveEnabled: boolean
  setAutoSaveEnabled: (v: boolean) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

const THEME_KEY = 'beedocs-theme'
const DENSITY_KEY = 'beedocs-density'
const PREVIEW_KEY = 'beedocs-preview-default'
const AUTOSAVE_KEY = 'beedocs-autosave'
/** Last seen desktop palette, so an 'omarchy' boot doesn't flash the default theme. */
const OMARCHY_KEY = 'beedocs-omarchy-palette'

/**
 * Whether a theme was already chosen when this page loaded — captured before
 * the provider's first persist writes the key. BrandingProvider reads it to
 * decide whether to adopt the Omarchy desktop theme automatically: only a user
 * who never picked a theme gets switched.
 */
export const storedThemeAtBoot: string | null = localStorage.getItem(THEME_KEY)

function resolveInitialTheme(): ThemeId {
  const saved = storedThemeAtBoot
  if (saved && (saved === 'omarchy' || THEMES.some((t) => t.id === saved))) return saved as ThemeId
  // migrate old light/dark
  if (saved === 'light') return 'honey-light'
  if (saved === 'dark') return 'honey-dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'honey-dark' : 'honey-light'
}

function loadCachedOmarchy(): OmarchyTheme | null {
  try {
    const raw = localStorage.getItem(OMARCHY_KEY)
    return raw ? (JSON.parse(raw) as OmarchyTheme) : null
  } catch {
    return null
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(resolveInitialTheme)
  const [omarchy, setOmarchyState] = useState<OmarchyTheme | null>(loadCachedOmarchy)
  const [density, setDensityState] = useState<'comfortable' | 'compact'>(() => {
    const d = localStorage.getItem(DENSITY_KEY)
    return d === 'compact' ? 'compact' : 'comfortable'
  })
  const [showPreviewDefault, setShowPreviewDefaultState] = useState(() => {
    const v = localStorage.getItem(PREVIEW_KEY)
    return v !== 'false'
  })
  const [autoSaveEnabled, setAutoSaveEnabledState] = useState(() => {
    const v = localStorage.getItem(AUTOSAVE_KEY)
    return v !== 'false'
  })

  const scheme: 'light' | 'dark' =
    theme === 'omarchy'
      ? (omarchy?.scheme ?? 'dark')
      : (THEMES.find((t) => t.id === theme) ?? THEMES[0]).scheme

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.dataset.scheme = scheme
    localStorage.setItem(THEME_KEY, theme)

    // The static themes are CSS blocks; the omarchy one is computed, so its
    // tokens go on as inline custom properties — and come off again in full
    // when another theme is picked, or its block would shine through it.
    const vars = theme === 'omarchy' && omarchy ? deriveOmarchyVars(omarchy) : null
    if (vars) {
      for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
      root.style.colorScheme = omarchy!.scheme
    } else {
      for (const key of OMARCHY_VAR_KEYS) root.style.removeProperty(key)
      root.style.removeProperty('color-scheme')
    }
  }, [theme, scheme, omarchy])

  useEffect(() => {
    document.documentElement.dataset.density = density
    localStorage.setItem(DENSITY_KEY, density)
  }, [density])

  useEffect(() => {
    localStorage.setItem(PREVIEW_KEY, String(showPreviewDefault))
  }, [showPreviewDefault])

  useEffect(() => {
    localStorage.setItem(AUTOSAVE_KEY, String(autoSaveEnabled))
  }, [autoSaveEnabled])

  const themeDef: ThemeDef = useMemo(
    () =>
      theme === 'omarchy'
        ? {
            id: 'omarchy',
            label: 'Omarchy',
            description: omarchy ? `Desktop theme · ${omarchy.name}` : 'Desktop theme',
            scheme,
          }
        : (THEMES.find((t) => t.id === theme) ?? THEMES[0]),
    [theme, omarchy, scheme],
  )

  // Stable identity: BrandingProvider's fetch effect depends on it, and a new
  // closure per render would re-run that fetch on every theme change.
  const setOmarchy = useCallback((palette: OmarchyTheme | null) => {
    setOmarchyState(palette)
    try {
      if (palette) localStorage.setItem(OMARCHY_KEY, JSON.stringify(palette))
      else localStorage.removeItem(OMARCHY_KEY)
    } catch {
      // Storage full or blocked — the palette just won't survive a reload.
    }
  }, [])

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeState,
      themeDef,
      omarchy,
      setOmarchy,
      density,
      setDensity: setDensityState,
      showPreviewDefault,
      setShowPreviewDefault: setShowPreviewDefaultState,
      autoSaveEnabled,
      setAutoSaveEnabled: setAutoSaveEnabledState,
    }),
    [theme, themeDef, omarchy, setOmarchy, density, showPreviewDefault, autoSaveEnabled],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme outside provider')
  return ctx
}
