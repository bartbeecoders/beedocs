import { PAGE_GAP_PX, type PageGeometry } from './wordModel'

/**
 * Print layout without splitting the DOM: the body stays one editable flow,
 * and any block that would straddle a page boundary is pushed down to the
 * next page's content area with an extra top margin. The page backgrounds are
 * drawn underneath at fixed intervals, so what the eye sees is a stack of
 * pages, while the caret, selection and typing behave exactly as in one long
 * document. Blocks taller than a page (a big table) are left to overlap the
 * gap — Word would split them mid-way, which a browser cannot do to a table
 * without breaking it apart.
 *
 * Runs once per edit (debounced by the caller): one write pass to clear old
 * pushes, one read pass over the blocks' rectangles, one write pass to apply
 * the new pushes. Positions are measured relative to the body's content box
 * and corrected for the CSS zoom the workspace applies.
 */
export function paginate(body: HTMLElement, geom: PageGeometry, zoom: number, enabled: boolean): number {
  const blocks = Array.from(body.children) as HTMLElement[]

  for (const el of blocks) {
    if (el.hasAttribute('data-bee-push')) {
      const original = el.getAttribute('data-bee-mt') ?? ''
      if (original) el.style.marginTop = original
      else el.style.removeProperty('margin-top')
      if (!el.getAttribute('style')) el.removeAttribute('style')
      el.removeAttribute('data-bee-push')
      el.removeAttribute('data-bee-mt')
    }
  }
  if (!enabled || blocks.length === 0) return 1

  const gapTotal = geom.mBottom + PAGE_GAP_PX + geom.mTop
  const period = geom.contentH + gapTotal
  const bodyRect = body.getBoundingClientRect()
  const contentTop = bodyRect.top / zoom + geom.mTop

  const rects = blocks.map((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top / zoom - contentTop, height: r.height / zoom }
  })

  const pushes = new Map<HTMLElement, number>()
  let shift = 0
  let lastBottom = 0
  // A manual page break sends whatever follows it to the next page; the
  // marker itself stays at the foot of the page it ends, as in Word.
  let forceBreak = false
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i]
    const top = rects[i].top + shift
    const height = rects[i].height
    const page = Math.max(0, Math.floor(top / period))
    const pageStart = page * period
    const pageEnd = pageStart + geom.contentH
    const startsOnPage = top - pageStart > 1
    const isBreak = el.tagName === 'HR' && el.getAttribute('data-break') === 'page'
    const overflows = height <= geom.contentH && top + height > pageEnd + 0.5 && startsOnPage
    if (!isBreak && startsOnPage && (forceBreak || overflows)) {
      const push = (page + 1) * period - top
      pushes.set(el, push)
      shift += push
      lastBottom = top + push + height
    } else {
      lastBottom = top + height
    }
    forceBreak = isBreak
  }

  for (const [el, push] of pushes) {
    const own = getComputedStyle(el).marginTop
    el.setAttribute('data-bee-mt', el.style.marginTop || '')
    el.setAttribute('data-bee-push', String(Math.round(push)))
    el.style.marginTop = `${parseFloat(own) + push}px`
  }

  return Math.max(1, Math.floor(Math.max(lastBottom - 1, 0) / period) + 1)
}

/** Which page (1-based) a point at `y` px below the body's content top falls on. */
export function pageOfOffset(y: number, geom: PageGeometry): number {
  const period = geom.contentH + geom.mBottom + PAGE_GAP_PX + geom.mTop
  return Math.max(1, Math.floor(y / period) + 1)
}

/** Total height of the page stack, for the container that draws the backgrounds. */
export function stackHeight(pages: number, geom: PageGeometry): number {
  return pages * geom.pageH + (pages - 1) * PAGE_GAP_PX
}
