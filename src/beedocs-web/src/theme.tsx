import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeId =
  | 'honey-light'
  | 'honey-dark'
  | 'slate'
  | 'ocean'
  | 'forest'
  | 'violet'
  | 'high-contrast'

export type ThemeDef = {
  id: ThemeId
  label: string
  description: string
  scheme: 'light' | 'dark'
}

export const THEMES: ThemeDef[] = [
  { id: 'honey-light', label: 'Honey Light', description: 'Warm paper, amber accents', scheme: 'light' },
  { id: 'honey-dark', label: 'Honey Dark', description: 'Warm charcoal + gold', scheme: 'dark' },
  { id: 'slate', label: 'Slate', description: 'Cool professional gray', scheme: 'dark' },
  { id: 'ocean', label: 'Ocean', description: 'Blue steel workspace', scheme: 'dark' },
  { id: 'forest', label: 'Forest', description: 'Soft green editorial', scheme: 'light' },
  { id: 'violet', label: 'Violet', description: 'Modern purple UI', scheme: 'dark' },
  { id: 'high-contrast', label: 'High contrast', description: 'Maximum readability', scheme: 'dark' },
]

type ThemeCtx = {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
  themeDef: ThemeDef
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

function resolveInitialTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId
  // migrate old light/dark
  if (saved === 'light') return 'honey-light'
  if (saved === 'dark') return 'honey-dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'honey-dark' : 'honey-light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(resolveInitialTheme)
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const def = THEMES.find((t) => t.id === theme) ?? THEMES[0]
    document.documentElement.dataset.scheme = def.scheme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

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

  const themeDef = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeState,
      themeDef,
      density,
      setDensity: setDensityState,
      showPreviewDefault,
      setShowPreviewDefault: setShowPreviewDefaultState,
      autoSaveEnabled,
      setAutoSaveEnabled: setAutoSaveEnabledState,
    }),
    [theme, themeDef, density, showPreviewDefault, autoSaveEnabled],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme outside provider')
  return ctx
}
