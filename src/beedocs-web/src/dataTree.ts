/**
 * Structure behind the collapsible JSON / XML viewers.
 *
 * JSON is parsed by hand rather than with `JSON.parse` so that what is displayed
 * is what the document says: scalars keep their exact source text (a 20-digit id
 * is not rounded to a float) and object keys keep their written order (`JSON.parse`
 * hoists integer-like keys). The editor already refuses to reformat those
 * documents for the same reason — the viewer must not quietly disagree with it.
 */

export type JsonNode =
  | { kind: 'object'; entries: { key: string; value: JsonNode }[] }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'scalar'; raw: string; type: 'string' | 'number' | 'boolean' | 'null' }

/** Above this a tree is more burden than help, and rendering it stalls the page. */
export const MAX_TREE_NODES = 4000

export type ParseResult<T> = { ok: true; root: T; nodes: number } | { ok: false }

class JsonParser {
  private i = 0
  private count = 0

  constructor(private readonly src: string) {}

  parse(): { root: JsonNode; nodes: number } {
    this.skipWs()
    const root = this.value()
    this.skipWs()
    if (this.i < this.src.length) throw new Error('Trailing content')
    return { root, nodes: this.count }
  }

  private skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i += 1
  }

  private expect(ch: string): void {
    if (this.src[this.i] !== ch) throw new Error(`Expected ${ch} at ${this.i}`)
    this.i += 1
  }

  private value(): JsonNode {
    this.count += 1
    if (this.count > MAX_TREE_NODES) throw new Error('Too many nodes')

    const ch = this.src[this.i]
    if (ch === '{') return this.object()
    if (ch === '[') return this.array()
    if (ch === '"') return { kind: 'scalar', raw: this.string(), type: 'string' }
    return this.literal()
  }

  private object(): JsonNode {
    this.expect('{')
    const entries: { key: string; value: JsonNode }[] = []
    this.skipWs()
    if (this.src[this.i] === '}') {
      this.i += 1
      return { kind: 'object', entries }
    }
    for (;;) {
      this.skipWs()
      const key = this.string()
      this.skipWs()
      this.expect(':')
      this.skipWs()
      entries.push({ key, value: this.value() })
      this.skipWs()
      if (this.src[this.i] === ',') {
        this.i += 1
        continue
      }
      this.expect('}')
      return { kind: 'object', entries }
    }
  }

  private array(): JsonNode {
    this.expect('[')
    const items: JsonNode[] = []
    this.skipWs()
    if (this.src[this.i] === ']') {
      this.i += 1
      return { kind: 'array', items }
    }
    for (;;) {
      this.skipWs()
      items.push(this.value())
      this.skipWs()
      if (this.src[this.i] === ',') {
        this.i += 1
        continue
      }
      this.expect(']')
      return { kind: 'array', items }
    }
  }

  /** Returns the string *including* its quotes, so escapes survive verbatim. */
  private string(): string {
    const start = this.i
    this.expect('"')
    while (this.i < this.src.length) {
      const ch = this.src[this.i]
      if (ch === '\\') {
        this.i += 2
        continue
      }
      if (ch === '"') {
        this.i += 1
        return this.src.slice(start, this.i)
      }
      this.i += 1
    }
    throw new Error('Unterminated string')
  }

  private literal(): JsonNode {
    const rest = this.src.slice(this.i)
    for (const word of ['true', 'false', 'null'] as const) {
      if (rest.startsWith(word)) {
        this.i += word.length
        return { kind: 'scalar', raw: word, type: word === 'null' ? 'null' : 'boolean' }
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (!num) throw new Error(`Unexpected token at ${this.i}`)
    this.i += num[0].length
    return { kind: 'scalar', raw: num[0], type: 'number' }
  }
}

export function parseJsonTree(text: string): ParseResult<JsonNode> {
  try {
    const { root, nodes } = new JsonParser(text.trim()).parse()
    // Only containers are worth a tree; a bare scalar reads better as code.
    if (root.kind === 'scalar') return { ok: false }
    return { ok: true, root, nodes }
  } catch {
    return { ok: false }
  }
}

export type XmlNode = {
  kind: 'element'
  tag: string
  attributes: { name: string; value: string }[]
  children: XmlChild[]
  /** Text when the element holds nothing but text, so it can render on one line. */
  text: string | null
}

export type XmlChild =
  | XmlNode
  | { kind: 'text'; text: string }
  | { kind: 'comment'; text: string }

export function parseXmlTree(text: string): ParseResult<XmlNode> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<')) return { ok: false }

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(trimmed, 'application/xml')
  } catch {
    return { ok: false }
  }
  if (doc.querySelector('parsererror') || !doc.documentElement) return { ok: false }

  let count = 0
  const convert = (el: Element): XmlNode => {
    count += 1
    if (count > MAX_TREE_NODES) throw new Error('Too many nodes')

    const children: XmlChild[] = []
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        children.push(convert(node as Element))
      } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
        const value = node.textContent ?? ''
        if (value.trim()) children.push({ kind: 'text', text: value.trim() })
      } else if (node.nodeType === Node.COMMENT_NODE) {
        children.push({ kind: 'comment', text: node.textContent ?? '' })
      }
    }

    const onlyText =
      children.length === 1 && children[0]!.kind === 'text' ? (children[0] as { text: string }).text : null

    return {
      kind: 'element',
      tag: el.nodeName,
      attributes: Array.from(el.attributes).map((a) => ({ name: a.name, value: a.value })),
      children,
      text: children.length === 0 ? '' : onlyText,
    }
  }

  try {
    const root = convert(doc.documentElement)
    return { ok: true, root, nodes: count }
  } catch {
    return { ok: false }
  }
}

/** Summary shown on a collapsed node, e.g. `3 keys` / `12 items`. */
export function countLabel(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : singular + 's'}`
}
