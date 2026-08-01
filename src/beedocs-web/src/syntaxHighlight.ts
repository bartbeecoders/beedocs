import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * Syntax highlighting for fenced code blocks.
 *
 * Built from `highlight.js/lib/core` with an explicit language list rather than
 * the full bundle, which would add roughly a megabyte for grammars no
 * architecture document is going to use. Everything registered here is
 * something these docs actually contain: config, schemas, shell, and the
 * languages of the stack.
 *
 * Detection is never automatic. An unlabelled fence is left alone, because
 * guessing gets short snippets wrong and mislabelled colour is worse than none.
 */

const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  plaintext,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}

type LanguageFn = Parameters<typeof hljs.registerLanguage>[1]

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language)
}

/** Fence labels people actually write, mapped onto a registered grammar. */
const ALIASES: Record<string, string> = {
  c: 'plaintext',
  'c#': 'csharp',
  cs: 'csharp',
  dotnet: 'csharp',
  html: 'xml',
  htm: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  zsh: 'bash',
  console: 'shell',
  terminal: 'shell',
  yml: 'yaml',
  toml: 'ini',
  conf: 'ini',
  config: 'ini',
  properties: 'ini',
  psql: 'sql',
  postgres: 'sql',
  sqlite: 'sql',
  md: 'markdown',
  patch: 'diff',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  docker: 'dockerfile',
  text: 'plaintext',
  txt: 'plaintext',
  jsonc: 'json',
  geojson: 'json',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
  rss: 'xml',
  atom: 'xml',
  plist: 'xml',
  wsdl: 'xml',
}

/** Resolve a fence label to a registered grammar, or null when unsupported. */
export function resolveLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null
  const key = lang.trim().toLowerCase()
  if (!key) return null
  const resolved = ALIASES[key] ?? key
  return Object.prototype.hasOwnProperty.call(LANGUAGES, resolved) ? resolved : null
}

/**
 * Highlight one block.
 *
 * Returns HTML that highlight.js has already escaped — it emits only its own
 * `<span class="hljs-…">` wrappers and escapes everything from the document, so
 * markup inside a code block stays inert text. Null means "render as plain
 * text": no grammar, or the grammar threw on malformed input.
 */
export function highlightCode(code: string, lang: string | null | undefined): string | null {
  const language = resolveLanguage(lang)
  if (!language) return null
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

/** Languages a fence can name and get colour for. Used by the help panel. */
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES).sort()
