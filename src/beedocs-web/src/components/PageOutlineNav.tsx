import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildPageOutline,
  scrollToOutlineTarget,
  type PageOutlineItem,
} from '../pageOutline'

const COLLAPSE_KEY = 'beedocs-page-outline-collapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

type Props = {
  content: string
  /** Scope for querySelector when multiple pages could exist (usually the page canvas). */
  rootRef?: React.RefObject<HTMLElement | null>
  className?: string
}

/**
 * Compact “On this page” outline for quick jumps to headings and major blocks.
 * Collapses to a thin rail (like Library / Properties) so the editor can use the space.
 */
export function PageOutlineNav({ content, rootRef, className = '' }: Props) {
  const items = useMemo(() => buildPageOutline(content), [content])
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [activeId, setActiveId] = useState<string | null>(null)

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const go = useCallback(
    (item: PageOutlineItem) => {
      setActiveId(item.id)
      scrollToOutlineTarget(item.id, rootRef?.current ?? null)
    },
    [rootRef],
  )

  // Track which outline target is nearest the top of the viewport / scroll parent.
  useEffect(() => {
    if (items.length === 0 || collapsed) return

    const nodes = items
      .map((it) => document.getElementById(it.id) ?? document.querySelector(`[data-outline-id="${it.id}"]`))
      .filter((n): n is Element => n instanceof Element)

    if (nodes.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        // Prefer the intersecting entry closest to the top of the viewport.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]?.target) {
          const id =
            visible[0].target.id ||
            (visible[0].target as HTMLElement).dataset.outlineId ||
            null
          if (id) setActiveId(id)
        }
      },
      {
        root: null,
        // Band near the top of the viewport counts as “current section”.
        rootMargin: '-10% 0px -70% 0px',
        threshold: [0, 0.1, 0.25],
      },
    )

    for (const n of nodes) observer.observe(n)
    return () => observer.disconnect()
  }, [items, collapsed, content])

  if (collapsed) {
    return (
      <aside className={`page-outline is-collapsed ${className}`.trim()} aria-label="On this page">
        <button
          type="button"
          className="page-outline-rail-btn"
          onClick={toggle}
          aria-expanded={false}
          title="Show On this page"
        >
          <span className="page-outline-rail-label">On this page</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className={`page-outline ${className}`.trim()} aria-label="On this page">
      <div className="page-outline-head">
        <span className="page-outline-title">On this page</span>
        <button
          type="button"
          className="page-outline-toggle"
          onClick={toggle}
          aria-expanded
          aria-label="Collapse On this page"
          title="Collapse On this page"
        >
          ›
        </button>
      </div>
      {items.length === 0 ? (
        <p className="page-outline-empty muted sm">Add headings to build a quick map of this page.</p>
      ) : (
        <nav className="page-outline-nav">
          <ul className="page-outline-list">
            {items.map((item) => (
              <li
                key={item.id}
                className={`page-outline-item level-${Math.min(item.level, 4)} kind-${item.kind}${
                  activeId === item.id ? ' is-active' : ''
                }`}
              >
                <button type="button" className="page-outline-link" onClick={() => go(item)} title={item.label}>
                  {item.kind !== 'heading' && (
                    <span className="page-outline-kind" aria-hidden>
                      {kindGlyph(item.kind)}
                    </span>
                  )}
                  <span className="page-outline-label">{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </aside>
  )
}

function kindGlyph(kind: PageOutlineItem['kind']): string {
  switch (kind) {
    case 'diagram':
      return '◈'
    case 'freedraw':
      return '✎'
    case 'media':
      return '▣'
    case 'code':
      return '⟨⟩'
    default:
      return '·'
  }
}
