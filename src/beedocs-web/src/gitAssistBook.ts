/** JSON envelope a `book` assist job stores in its markdown column. */

export type GitAssistBookPage = {
  title: string
  markdown: string
}

export type GitAssistBookDraft = {
  version: number
  bookTitle: string
  bookDescription?: string | null
  pages: GitAssistBookPage[]
}

export function parseGitAssistBookDraft(markdown: string | null | undefined): GitAssistBookDraft | null {
  if (!markdown) return null
  const trimmed = markdown.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<GitAssistBookDraft>
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return null
    const pages = parsed.pages
      .map((p) => ({
        title: (p.title ?? '').trim(),
        markdown: (p.markdown ?? '').trim(),
      }))
      .filter((p) => p.title.length > 0 && p.markdown.length > 0)
    if (pages.length === 0) return null
    return {
      version: typeof parsed.version === 'number' && parsed.version > 0 ? parsed.version : 1,
      bookTitle: (parsed.bookTitle ?? '').trim(),
      bookDescription: parsed.bookDescription ?? null,
      pages,
    }
  } catch {
    return null
  }
}

/** Flatten a book draft for the clipboard — one Markdown document, pages separated. */
export function flattenGitAssistBookDraft(draft: GitAssistBookDraft): string {
  const parts: string[] = []
  if (draft.bookTitle) parts.push(`# ${draft.bookTitle}`)
  if (draft.bookDescription) parts.push(draft.bookDescription)
  for (const page of draft.pages) {
    parts.push(page.markdown)
  }
  return parts.join('\n\n---\n\n')
}
