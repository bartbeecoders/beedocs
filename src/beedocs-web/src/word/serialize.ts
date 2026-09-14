import { withApiBase } from '../basePath'

/**
 * Everything the editor adds to the DOM for its own purposes, stripped before
 * the HTML goes back to the server:
 *   • pagination pushes (`data-bee-push`, with the block's own margin kept in
 *     `data-bee-mt`) — layout, not content;
 *   • the selected-image outline (`data-bee-selected`);
 *   • blob: image sources still being read.
 */
export function serializeBody(body: HTMLElement): string {
  const clone = body.cloneNode(true) as HTMLElement
  clone.querySelectorAll<HTMLElement>('[data-bee-push]').forEach((el) => {
    const original = el.getAttribute('data-bee-mt') ?? ''
    if (original) el.style.marginTop = original
    else el.style.removeProperty('margin-top')
    if (!el.getAttribute('style')) el.removeAttribute('style')
    el.removeAttribute('data-bee-push')
    el.removeAttribute('data-bee-mt')
  })
  clone.querySelectorAll('[data-bee-selected]').forEach((el) => el.removeAttribute('data-bee-selected'))
  clone.querySelectorAll('img[src^="blob:"]').forEach((el) => el.remove())
  // The "current cell" marker and any leftover find highlight.
  clone.querySelectorAll('[data-bee-cell]').forEach((el) => el.removeAttribute('data-bee-cell'))
  return clone.innerHTML
}

/**
 * Prepare server HTML for the editable body: media URLs go through the API
 * base (a reverse-proxy prefix), and an empty document gets one paragraph so
 * there is somewhere to type.
 */
export function prepareForEdit(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll<HTMLImageElement>('img[src^="/api/"]').forEach((img) => {
    img.setAttribute('src', withApiBase(img.getAttribute('src') ?? ''))
  })
  if (!tpl.content.firstElementChild) {
    tpl.innerHTML = '<p><br></p>'
  }
  return tpl.innerHTML
}

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'colgroup', 'col', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sub', 'sup', 'span', 'a', 'br', 'img',
  'hr', 'blockquote', 'pre', 'code', 'font', 'div', 'mark', 'small',
])

const ALLOWED_STYLES = new Set([
  'font-weight', 'font-style', 'text-decoration', 'text-decoration-line', 'color', 'background-color', 'font-size',
  'font-family', 'text-align', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'text-indent',
  'vertical-align', 'line-height', 'width', 'letter-spacing', 'text-transform', 'font-variant',
])

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'width', 'height', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['type', 'start'],
  col: [],
  table: ['data-borders'],
  hr: ['data-break'],
}

/**
 * Pasted HTML, reduced to what the document format can hold. Word's clipboard
 * HTML in particular arrives with `mso-*` styles, `<o:p>` wrappers, classes
 * and comments, none of which the writer would read anyway; stripping them
 * here keeps the pasted text editable like the rest of the page.
 */
export function sanitizePastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = doc.body
  // Fragment markers Word/Chrome leave in the clipboard.
  root.querySelectorAll('meta, style, script, link, title, head, o\\:p').forEach((el) => el.remove())
  clean(root)
  // Word pastes a trailing empty paragraph more often than not.
  const last = root.lastElementChild
  if (last && last.tagName === 'P' && !last.textContent?.trim() && !last.querySelector('img')) last.remove()
  return root.innerHTML

  function clean(node: Element) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove()
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        el.remove()
        continue
      }
      clean(el)
      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: keep the content, drop the element.
        while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
        el.remove()
        continue
      }
      const keep = new Set(['style', ...(ALLOWED_ATTRS[tag] ?? [])])
      for (const attr of Array.from(el.attributes)) {
        if (!keep.has(attr.name)) el.removeAttribute(attr.name)
      }
      if (tag === 'a') {
        const href = el.getAttribute('href') ?? ''
        if (!/^(https?:|mailto:|#)/i.test(href)) el.removeAttribute('href')
      }
      if (tag === 'img') {
        const src = el.getAttribute('src') ?? ''
        if (!/^(data:image\/|https?:)/i.test(src)) {
          el.remove()
          continue
        }
      }
      const style = el.getAttribute('style')
      if (style) {
        const kept: string[] = []
        for (const decl of style.split(';')) {
          const colon = decl.indexOf(':')
          if (colon < 0) continue
          const name = decl.slice(0, colon).trim().toLowerCase()
          const value = decl.slice(colon + 1).trim()
          if (!ALLOWED_STYLES.has(name) || !value) continue
          if (name === 'font-family' && /symbol|wingdings/i.test(value)) continue
          kept.push(`${name}:${value}`)
        }
        if (kept.length) el.setAttribute('style', kept.join(';'))
        else el.removeAttribute('style')
      }
    }
  }
}

/** Plain text pasted or dropped: one paragraph per line, so it reads as Word would paste it. */
export function plainTextToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (lines.length === 1) return esc(lines[0])
  return lines.map((l) => `<p>${l ? esc(l) : '<br>'}</p>`).join('')
}
