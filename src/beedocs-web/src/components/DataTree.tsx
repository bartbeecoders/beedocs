import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  countLabel,
  parseJsonTree,
  parseXmlTree,
  type JsonNode,
  type XmlChild,
  type XmlNode,
} from '../dataTree'

/**
 * Collapsible viewer for JSON and XML code blocks.
 *
 * Built on native `<details>`/`<summary>`, which brings keyboard operation,
 * screen-reader semantics and the browser's own find-in-page expansion for free —
 * all of which a div-and-onClick tree would have to reimplement badly. Collapsed
 * subtrees are simply not rendered by the UA, so a large document costs nothing
 * while it is folded.
 *
 * A document that will not parse, or is too large to be useful as a tree, falls
 * back to the plain highlighted block the caller provides.
 */

type Props = {
  code: string
  lang: 'json' | 'xml'
  /** Highlighted code block, shown for the Raw view and as the parse-failure fallback. */
  fallback: React.ReactNode
}

export function DataTree({ code, lang, fallback }: Props) {
  const parsed = useMemo(
    () => (lang === 'json' ? parseJsonTree(code) : parseXmlTree(code)),
    [code, lang],
  )
  const [raw, setRaw] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  const setAllOpen = useCallback((open: boolean) => {
    const root = bodyRef.current
    if (!root) return
    for (const el of Array.from(root.querySelectorAll('details'))) el.open = open
  }, [])

  // Printing a folded document would silently drop its content.
  useEffect(() => {
    if (raw) return
    const expand = () => setAllOpen(true)
    window.addEventListener('beforeprint', expand)
    return () => window.removeEventListener('beforeprint', expand)
  }, [raw, setAllOpen])

  if (!parsed.ok) return <>{fallback}</>

  return (
    <div className="data-tree" data-language={lang}>
      <div className="data-tree-bar">
        <span className="data-tree-lang">{lang}</span>
        {!raw && (
          <>
            <button type="button" className="btn ghost sm" onClick={() => setAllOpen(false)}>
              Collapse all
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setAllOpen(true)}>
              Expand all
            </button>
          </>
        )}
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setRaw((v) => !v)}
          title={raw ? 'Back to the collapsible tree' : 'Show the exact source text for copying'}
        >
          {raw ? 'Tree' : 'Raw'}
        </button>
      </div>

      {raw ? (
        <div className="data-tree-raw">{fallback}</div>
      ) : (
        <div className="data-tree-body" ref={bodyRef}>
          {lang === 'json' ? (
            <JsonValue node={parsed.root as JsonNode} last />
          ) : (
            <XmlElement node={parsed.root as XmlNode} />
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

function JsonValue({
  node,
  name,
  last,
}: {
  node: JsonNode
  /** Quoted key, when this value sits in an object. */
  name?: string
  last: boolean
}) {
  const label = name ? (
    <>
      <span className="tok-key">{name}</span>
      <span className="tok-punc">: </span>
    </>
  ) : null

  if (node.kind === 'scalar') {
    return (
      <div className="dtree-row">
        {label}
        <span className={`tok-${node.type}`}>{node.raw}</span>
        {!last && <span className="tok-punc">,</span>}
      </div>
    )
  }

  const isObject = node.kind === 'object'
  const open = isObject ? '{' : '['
  const close = isObject ? '}' : ']'
  const size = isObject ? node.entries.length : node.items.length

  if (size === 0) {
    return (
      <div className="dtree-row">
        {label}
        <span className="tok-punc">
          {open}
          {close}
        </span>
        {!last && <span className="tok-punc">,</span>}
      </div>
    )
  }

  return (
    <details className="dtree-node" open>
      <summary className="dtree-summary">
        {label}
        <span className="tok-punc">{open}</span>
        <span className="dtree-folded">
          <span className="dtree-count"> {countLabel(size, isObject ? 'key' : 'item')} </span>
          <span className="tok-punc">
            {close}
            {!last ? ',' : ''}
          </span>
        </span>
      </summary>
      <div className="dtree-children">
        {isObject
          ? node.entries.map((entry, i) => (
              <JsonValue
                key={`${entry.key}-${i}`}
                node={entry.value}
                name={entry.key}
                last={i === node.entries.length - 1}
              />
            ))
          : node.items.map((item, i) => (
              <JsonValue key={i} node={item} last={i === node.items.length - 1} />
            ))}
      </div>
      <div className="dtree-row dtree-close">
        <span className="tok-punc">
          {close}
          {!last ? ',' : ''}
        </span>
      </div>
    </details>
  )
}

/* -------------------------------------------------------------------------- */
/* XML                                                                         */
/* -------------------------------------------------------------------------- */

function XmlAttributes({ node }: { node: XmlNode }) {
  return (
    <>
      {node.attributes.map((a) => (
        <span key={a.name}>
          {' '}
          <span className="tok-attr">{a.name}</span>
          <span className="tok-punc">=</span>
          <span className="tok-string">"{a.value}"</span>
        </span>
      ))}
    </>
  )
}

function XmlElement({ node }: { node: XmlNode }) {
  // Empty and text-only elements read better as a single line than as a fold.
  if (node.text !== null) {
    return (
      <div className="dtree-row">
        <span className="tok-punc">&lt;</span>
        <span className="tok-tag">{node.tag}</span>
        <XmlAttributes node={node} />
        {node.text === '' ? (
          <span className="tok-punc"> /&gt;</span>
        ) : (
          <>
            <span className="tok-punc">&gt;</span>
            <span className="tok-text">{node.text}</span>
            <span className="tok-punc">&lt;/</span>
            <span className="tok-tag">{node.tag}</span>
            <span className="tok-punc">&gt;</span>
          </>
        )}
      </div>
    )
  }

  const elementCount = node.children.filter((c) => c.kind === 'element').length

  return (
    <details className="dtree-node" open>
      <summary className="dtree-summary">
        <span className="tok-punc">&lt;</span>
        <span className="tok-tag">{node.tag}</span>
        <XmlAttributes node={node} />
        <span className="tok-punc">&gt;</span>
        <span className="dtree-folded">
          <span className="dtree-count"> {countLabel(elementCount, 'child')} </span>
          <span className="tok-punc">&lt;/</span>
          <span className="tok-tag">{node.tag}</span>
          <span className="tok-punc">&gt;</span>
        </span>
      </summary>
      <div className="dtree-children">
        {node.children.map((child, i) => (
          <XmlChildNode key={i} child={child} />
        ))}
      </div>
      <div className="dtree-row dtree-close">
        <span className="tok-punc">&lt;/</span>
        <span className="tok-tag">{node.tag}</span>
        <span className="tok-punc">&gt;</span>
      </div>
    </details>
  )
}

function XmlChildNode({ child }: { child: XmlChild }) {
  if (child.kind === 'element') return <XmlElement node={child} />
  if (child.kind === 'comment') {
    return <div className="dtree-row tok-comment">&lt;!--{child.text}--&gt;</div>
  }
  return <div className="dtree-row tok-text">{child.text}</div>
}
