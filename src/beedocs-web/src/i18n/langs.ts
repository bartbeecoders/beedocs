/**
 * The languages the UI ships in. `label` is the language's own name — a picker
 * that says "Japans" to someone who reads only Japanese has failed at its one
 * job, so the list is never translated.
 */
export type Lang = 'en' | 'fr' | 'de' | 'es' | 'nl' | 'ja' | 'zh'

export type LangDef = {
  id: Lang
  /** Native name, shown untranslated in the picker. */
  label: string
  /** BCP 47 tag for <html lang> and Intl APIs. */
  tag: string
}

export const LANGUAGES: LangDef[] = [
  { id: 'en', label: 'English', tag: 'en' },
  { id: 'fr', label: 'Français', tag: 'fr' },
  { id: 'de', label: 'Deutsch', tag: 'de' },
  { id: 'es', label: 'Español', tag: 'es' },
  { id: 'nl', label: 'Nederlands', tag: 'nl' },
  { id: 'ja', label: '日本語', tag: 'ja' },
  { id: 'zh', label: '中文（简体）', tag: 'zh-Hans' },
]
