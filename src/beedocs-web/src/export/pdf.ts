import mermaid from 'mermaid'
import { api } from '../api'
import type { Chapter, Page } from '../types'
import { beeDiagramToSvg } from './beeDiagramSvg'

export type ExportProgress = (message: string) => void

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
})

/** Resolve `beediagram-ref` fences, caching each diagram for the whole export. */
function makeDiagramResolver() {
  const cache = new Map<string, { title: string; source: string; kind: string }>()
  return async (diagramId: string) => {
    if (!cache.has(diagramId)) {
      try {
        const d = await api.getDiagram(diagramId)
        cache.set(diagramId, { title: d.title, source: d.source, kind: d.kind })
      } catch {
        cache.set(diagramId, { title: diagramId, source: '', kind: 'beediagram' })
      }
    }
    return cache.get(diagramId)!
  }
}

/** Open the rendered HTML in a new tab, which auto-triggers the print dialog. */
function openPrintWindow(html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    URL.revokeObjectURL(url)
    throw new Error('Pop-up blocked. Allow pop-ups for this site to export PDF.')
  }
  // Revoke after the print window has loaded
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const AUTO_PRINT_SCRIPT = `
  <script>
    // Auto-open print dialog after layout
    window.addEventListener('load', function () {
      setTimeout(function () {
        window.focus();
        window.print();
      }, 400);
    });
  </script>`

/**
 * Load a single page and open a print-ready document so the user can save as
 * PDF (browser Print → “Save as PDF”).
 */
export async function exportPageToPdf(pageId: string, onProgress?: ExportProgress): Promise<void> {
  onProgress?.('Loading page…')
  const page = await api.getPage(pageId)

  onProgress?.('Rendering content…')
  const body = await markdownToExportHtml(page.content, makeDiagramResolver())

  const generated = new Date().toLocaleString()
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(page.title)} — PDF export</title>
  <style>${PRINT_CSS}</style>
</head>
<body>
  <section class="export-page">
    <h1 class="export-page-title">${esc(page.title)}</h1>
    <p class="export-meta">Exported from BeeDocs ${esc(generated)}</p>
    <div class="export-page-body">${body}</div>
  </section>
  ${AUTO_PRINT_SCRIPT}
</body>
</html>`

  onProgress?.('Opening print dialog…')
  openPrintWindow(html)
}

/**
 * Load a book and open a print-ready document so the user can save as PDF
 * (browser Print → “Save as PDF”).
 */
export async function exportBookToPdf(bookId: string, onProgress?: ExportProgress): Promise<void> {
  onProgress?.('Loading book…')
  const [book, pageList, chapters] = await Promise.all([
    api.getBook(bookId),
    api.listPages(bookId),
    api.listChapters(bookId).catch(() => [] as Chapter[]),
  ])

  const sorted = [...pageList].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
  )

  onProgress?.(`Loading ${sorted.length} page(s)…`)
  const pages: Page[] = []
  for (const p of sorted) {
    pages.push(await api.getPage(p.id))
  }

  const resolveDiagram = makeDiagramResolver()

  onProgress?.('Rendering content…')
  const pageHtml: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    onProgress?.(`Rendering “${page.title}” (${i + 1}/${pages.length})…`)
    const body = await markdownToExportHtml(page.content, resolveDiagram)
    pageHtml.push(`
      <section class="export-page" id="page-${esc(page.id)}">
        <h1 class="export-page-title">${esc(page.title)}</h1>
        <div class="export-page-body">${body}</div>
      </section>
    `)
  }

  const toc =
    pages.length > 0
      ? `<nav class="export-toc">
          <h2>Contents</h2>
          <ol>
            ${pages.map((p) => `<li><a href="#page-${esc(p.id)}">${esc(p.title)}</a></li>`).join('')}
          </ol>
        </nav>`
      : '<p class="muted">This book has no pages yet.</p>'

  const chapterNote =
    chapters.length > 0
      ? `<p class="export-meta">${chapters.length} chapter(s) · ${pages.length} page(s)</p>`
      : `<p class="export-meta">${pages.length} page(s)</p>`

  const generated = new Date().toLocaleString()
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(book.title)} — PDF export</title>
  <style>${PRINT_CSS}</style>
</head>
<body>
  <header class="export-cover">
    <p class="export-brand">BeeDocs</p>
    <h1>${esc(book.title)}</h1>
    ${book.description ? `<p class="export-desc">${esc(book.description)}</p>` : ''}
    ${chapterNote}
    <p class="export-meta">Exported ${esc(generated)}</p>
  </header>
  ${toc}
  ${pageHtml.join('\n')}
  ${AUTO_PRINT_SCRIPT}
</body>
</html>`

  onProgress?.('Opening print dialog…')
  openPrintWindow(html)
}

async function markdownToExportHtml(
  md: string,
  resolveDiagram: (id: string) => Promise<{ title: string; source: string; kind: string }>,
): Promise<string> {
  const src = md.replace(/\r\n/g, '\n')
  const parts: string[] = []
  // Split by fenced code blocks
  const fenceRe = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm
  let last = 0
  let m: RegExpExecArray | null
  let fenceIdx = 0
  while ((m = fenceRe.exec(src)) !== null) {
    if (m.index > last) {
      parts.push(renderProse(src.slice(last, m.index)))
    }
    const lang = (m[1] ?? '').trim().split(/\s+/)[0]?.toLowerCase() || ''
    const body = (m[2] ?? '').replace(/\n$/, '')
    parts.push(await renderFence(lang, body, fenceIdx++, resolveDiagram))
    last = m.index + m[0].length
  }
  if (last < src.length) {
    parts.push(renderProse(src.slice(last)))
  }
  return parts.join('\n') || '<p></p>'
}

async function renderFence(
  lang: string,
  body: string,
  index: number,
  resolveDiagram: (id: string) => Promise<{ title: string; source: string; kind: string }>,
): Promise<string> {
  if (lang === 'mermaid' || lang === 'c4') {
    try {
      const id = `export-mmd-${index}-${Math.random().toString(36).slice(2, 8)}`
      const { svg } = await mermaid.render(id, body)
      return `<div class="export-mermaid">${svg}</div>`
    } catch (e) {
      return `<pre class="export-error">Mermaid error: ${esc(String(e))}\n${esc(body)}</pre>`
    }
  }
  if (lang === 'beediagram') {
    return beeDiagramToSvg(body)
  }
  if (lang === 'beediagram-ref') {
    const id = body.trim().split(/\s+/)[0] ?? ''
    const d = await resolveDiagram(id)
    if (!d.source) {
      return `<div class="export-error">Missing diagram ${esc(id)}</div>`
    }
    return beeDiagramToSvg(d.source, d.title)
  }
  if (lang === 'plantuml') {
    return `<pre class="export-code"><code>${esc(body)}</code></pre>`
  }
  return `<pre class="export-code"><code class="language-${esc(lang)}">${esc(body)}</code></pre>`
}

/** Lightweight markdown → HTML for export (GFM-ish subset). */
function renderProse(text: string): string {
  if (!text.trim()) return ''
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  let inUl = false
  let inOl = false
  let inTable = false
  let tableRows: string[][] = []

  const closeLists = () => {
    if (inUl) {
      out.push('</ul>')
      inUl = false
    }
    if (inOl) {
      out.push('</ol>')
      inOl = false
    }
  }
  const flushTable = () => {
    if (!inTable || tableRows.length === 0) {
      inTable = false
      tableRows = []
      return
    }
    const [header, ...rest] = tableRows
    // skip separator row |---|
    const body = rest.filter((r) => !r.every((c) => /^:?-+:?$/.test(c.trim())))
    out.push('<table><thead><tr>')
    for (const c of header) out.push(`<th>${inlineMd(c.trim())}</th>`)
    out.push('</tr></thead><tbody>')
    for (const row of body) {
      out.push('<tr>')
      for (const c of row) out.push(`<td>${inlineMd(c.trim())}</td>`)
      out.push('</tr>')
    }
    out.push('</tbody></table>')
    inTable = false
    tableRows = []
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeLists()
      inTable = true
      tableRows.push(trimmed.slice(1, -1).split('|'))
      i++
      continue
    } else if (inTable) {
      flushTable()
    }

    if (!trimmed) {
      closeLists()
      i++
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      closeLists()
      const level = h[1].length
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`)
      i++
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      closeLists()
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`)
      continue
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      if (inOl) {
        out.push('</ol>')
        inOl = false
      }
      if (!inUl) {
        out.push('<ul>')
        inUl = true
      }
      out.push(`<li>${inlineMd(trimmed.replace(/^[-*+]\s+/, ''))}</li>`)
      i++
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      if (inUl) {
        out.push('</ul>')
        inUl = false
      }
      if (!inOl) {
        out.push('<ol>')
        inOl = true
      }
      out.push(`<li>${inlineMd(trimmed.replace(/^\d+\.\s+/, ''))}</li>`)
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeLists()
      out.push('<hr/>')
      i++
      continue
    }

    closeLists()
    // paragraph: consume consecutive non-empty non-special lines
    const para: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const t = lines[i].trim()
      if (!t || /^(#{1,6}\s|```|[-*+]\s|\d+\.\s|>\s?|\|)/.test(t)) break
      para.push(t)
      i++
    }
    out.push(`<p>${inlineMd(para.join(' '))}</p>`)
  }
  closeLists()
  flushTable()
  return out.join('\n')
}

function inlineMd(s: string): string {
  let t = esc(s)
  // images first
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_m, alt, url) => {
      const src = absoluteUrl(url)
      return `<img src="${esc(src)}" alt="${esc(alt)}" class="export-img"/>`
    },
  )
  // links
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text, url) => `<a href="${esc(absoluteUrl(url))}">${text}</a>`,
  )
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  t = t.replace(/_([^_]+)_/g, '<em>$1</em>')
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return t
}

function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  if (url.startsWith('/')) return `${window.location.origin}${url}`
  return url
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", system-ui, sans-serif;
    font-size: 11pt;
    line-height: 1.45;
    color: #1a1a1a;
    margin: 0;
    padding: 0 4mm 12mm;
  }
  .export-cover {
    page-break-after: always;
    padding: 40mm 8mm 20mm;
    text-align: center;
  }
  .export-brand {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 0.85rem;
    color: #666;
  }
  .export-cover h1 {
    font-size: 2rem;
    margin: 0.4em 0;
    letter-spacing: -0.02em;
  }
  .export-desc { color: #444; max-width: 36em; margin: 0.75em auto; }
  .export-meta { color: #777; font-size: 0.9rem; }
  .export-toc {
    page-break-after: always;
    padding: 8mm 4mm;
  }
  .export-toc h2 { margin-top: 0; }
  .export-toc ol { padding-left: 1.4em; }
  .export-toc a { color: #111; text-decoration: none; }
  .export-page {
    page-break-before: always;
    break-inside: avoid-page;
  }
  .export-page:first-of-type { page-break-before: auto; }
  .export-page-title {
    font-size: 1.45rem;
    border-bottom: 2px solid #ddd;
    padding-bottom: 0.35em;
    margin-top: 0;
  }
  .export-page-body h1 { font-size: 1.25rem; }
  .export-page-body h2 { font-size: 1.12rem; margin-top: 1.2em; }
  .export-page-body h3 { font-size: 1.02rem; }
  .export-page-body pre, .export-code {
    background: #f4f4f5;
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    padding: 0.65em 0.8em;
    font-size: 0.85em;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .export-page-body code {
    font-family: ui-monospace, "Cascadia Code", monospace;
    font-size: 0.9em;
  }
  .export-page-body blockquote {
    margin: 0.8em 0;
    padding: 0.2em 0 0.2em 0.9em;
    border-left: 3px solid #c9920a;
    color: #444;
  }
  .export-page-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    font-size: 0.95em;
  }
  .export-page-body th, .export-page-body td {
    border: 1px solid #ccc;
    padding: 0.35em 0.5em;
    text-align: left;
  }
  .export-page-body th { background: #f4f4f5; }
  .export-mermaid, .export-diagram {
    margin: 1em 0;
    page-break-inside: avoid;
  }
  .export-diagram figcaption {
    font-size: 0.9rem;
    color: #555;
    margin-bottom: 0.35em;
  }
  .export-diagram svg, .export-mermaid svg {
    max-width: 100%;
    height: auto;
  }
  .export-img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    border: 1px solid #ddd;
    margin: 0.5em 0;
  }
  .export-error {
    color: #b42318;
    background: #fef3f2;
    padding: 0.5em;
    border-radius: 6px;
    font-size: 0.9em;
  }
  @media print {
    body { padding: 0; }
    a { color: inherit; }
  }
`

