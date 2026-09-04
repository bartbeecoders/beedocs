import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { LANGUAGES, type Lang } from './langs'
import { common } from './messages/common'
import { auth } from './messages/auth'
import { settings } from './messages/settings'
import { nav } from './messages/nav'
import { search } from './messages/search'
import { dialogs } from './messages/dialogs'
import { shell } from './messages/shell'
import { users } from './messages/users'
import { stats } from './messages/stats'
import { props } from './messages/props'
import { git } from './messages/git'
import { gitadmin } from './messages/gitadmin'
import { canvas } from './messages/canvas'
import { providers } from './messages/providers'
import { editor } from './messages/editor'
import { studio } from './messages/studio'
import { isometric } from './messages/isometric'
import { slidesEditor } from './messages/slidesEditor'
import { helpdoc } from './messages/helpdoc'
import { site } from './messages/site'
import { kanban } from './messages/kanban'

export { LANGUAGES, type Lang, type LangDef } from './langs'

/**
 * The UI's translation layer — hand-rolled like theme.tsx, no i18n library.
 *
 * Messages live in per-feature files under messages/, each exporting all seven
 * languages for its keys; every non-English dictionary in those files is typed
 * `Record<keyof typeof en, string>`, so an untranslated key is a compile error
 * in the file that owns it, not a silent English fallback at runtime. English
 * remains the runtime fallback anyway, for keys added while a language file is
 * mid-edit in dev.
 *
 * Keys are flat, namespaced strings ('nav.newBook'); `{name}` placeholders are
 * interpolated by t(). Adding a namespace: create messages/<ns>.ts (copy the
 * shape of common.ts) and register it in MESSAGES below — nothing else.
 */
const MESSAGES = {
  common,
  auth,
  settings,
  nav,
  search,
  dialogs,
  shell,
  users,
  stats,
  props,
  git,
  gitadmin,
  canvas,
  providers,
  editor,
  studio,
  isometric,
  slidesEditor,
  helpdoc,
  site,
  kanban,
} as const

type NsMap = typeof MESSAGES
/** Union of every key in every namespace — what t() accepts. */
export type MessageKey = { [K in keyof NsMap]: keyof NsMap[K]['en'] }[keyof NsMap] & string

const LANG_KEY = 'beedocs-lang'

const dictCache: Partial<Record<Lang, Record<string, string>>> = {}

function dictFor(lang: Lang): Record<string, string> {
  let dict = dictCache[lang]
  if (!dict) {
    dict = {}
    for (const ns of Object.values(MESSAGES)) Object.assign(dict, ns[lang])
    dictCache[lang] = dict
  }
  return dict
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

/** Look a key up outside React (module-scope helpers, non-component code). */
export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictFor(lang)[key] ?? dictFor('en')[key] ?? key
  return interpolate(text, vars)
}

function resolveInitialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY)
  if (saved && LANGUAGES.some((l) => l.id === saved)) return saved as Lang
  // First visit: follow the browser, most-preferred first. 'zh-CN' → 'zh'.
  for (const pref of navigator.languages ?? [navigator.language]) {
    const primary = pref?.toLowerCase().split('-')[0]
    const match = LANGUAGES.find((l) => l.id === primary)
    if (match) return match.id
  }
  return 'en'
}

export type TFunction = (key: MessageKey, vars?: Record<string, string | number>) => string

type I18nCtx = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFunction
}

const Ctx = createContext<I18nCtx | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(resolveInitialLang)

  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang)
    document.documentElement.lang = LANGUAGES.find((l) => l.id === lang)?.tag ?? 'en'
  }, [lang])

  const t = useCallback<TFunction>((key, vars) => translate(lang, key, vars), [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useI18n outside provider')
  return ctx
}
