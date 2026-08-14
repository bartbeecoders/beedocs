import { createContext, useContext } from 'react'
import type { Diagram } from '../types'

/**
 * Optional overrides for Markdown rendering on a bookshelf website: rewrite
 * workspace `/books/…` links to site URLs, and load diagrams from the
 * public site API instead of `/api/diagrams`.
 */
export type MarkdownSite = {
  resolveHref?: (href: string) => string
  getDiagram?: (id: string) => Promise<Diagram>
}

export const MarkdownSiteContext = createContext<MarkdownSite>({})

export function useMarkdownSite(): MarkdownSite {
  return useContext(MarkdownSiteContext)
}
