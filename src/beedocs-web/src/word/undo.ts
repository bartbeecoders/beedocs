/**
 * The editor's own undo history: snapshots of the body HTML with the selection
 * saved as paths from the body root, so restoring one puts the caret back
 * where it was. The browser's native stack is not used because the ribbon's
 * paragraph commands mutate the DOM directly, which the native stack cannot
 * see — mixing the two produces undos that skip or re-apply steps.
 *
 * Typing is coalesced: keystrokes within a second of each other share one
 * entry, so Ctrl+Z steps back a burst at a time, the way Word does.
 */

export type SavedSelection = {
  anchor: number[]
  anchorOffset: number
  focus: number[]
  focusOffset: number
}

type Entry = { html: string; sel: SavedSelection | null; kind: 'typing' | 'command'; at: number }

const MAX_ENTRIES = 200
const TYPING_COALESCE_MS = 1000

export class UndoHistory {
  private entries: Entry[] = []
  private index = -1

  reset(html: string, sel: SavedSelection | null) {
    this.entries = [{ html, sel, kind: 'command', at: Date.now() }]
    this.index = 0
  }

  record(html: string, sel: SavedSelection | null, kind: 'typing' | 'command') {
    const now = Date.now()
    if (this.index < this.entries.length - 1) this.entries.length = this.index + 1
    const top = this.entries[this.index]
    if (top && top.html === html) {
      top.sel = sel
      return
    }
    if (kind === 'typing' && top && top.kind === 'typing' && now - top.at < TYPING_COALESCE_MS) {
      top.html = html
      top.sel = sel
      top.at = now
      return
    }
    this.entries.push({ html, sel, kind, at: now })
    if (this.entries.length > MAX_ENTRIES) this.entries.shift()
    this.index = this.entries.length - 1
  }

  get canUndo() {
    return this.index > 0
  }

  get canRedo() {
    return this.index < this.entries.length - 1
  }

  undo(): Entry | null {
    if (!this.canUndo) return null
    this.index -= 1
    return this.entries[this.index]
  }

  redo(): Entry | null {
    if (!this.canRedo) return null
    this.index += 1
    return this.entries[this.index]
  }
}

function pathOf(root: Node, node: Node): number[] | null {
  const path: number[] = []
  let cur: Node | null = node
  while (cur && cur !== root) {
    const parent: Node | null = cur.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, cur))
    cur = parent
  }
  return cur === root ? path : null
}

function nodeAt(root: Node, path: number[]): Node | null {
  let cur: Node = root
  for (const i of path) {
    const next = cur.childNodes[i]
    if (!next) return null
    cur = next
  }
  return cur
}

export function saveSelection(root: HTMLElement): SavedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null
  const anchor = pathOf(root, sel.anchorNode)
  const focus = pathOf(root, sel.focusNode)
  if (!anchor || !focus) return null
  return { anchor, anchorOffset: sel.anchorOffset, focus, focusOffset: sel.focusOffset }
}

export function restoreSelection(root: HTMLElement, saved: SavedSelection | null) {
  const sel = window.getSelection()
  if (!sel) return
  if (saved) {
    const anchor = nodeAt(root, saved.anchor)
    const focus = nodeAt(root, saved.focus)
    if (anchor && focus) {
      try {
        sel.setBaseAndExtent(
          anchor,
          Math.min(saved.anchorOffset, lengthOf(anchor)),
          focus,
          Math.min(saved.focusOffset, lengthOf(focus)),
        )
        return
      } catch {
        // fall through to the end of the document
      }
    }
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

function lengthOf(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : node.childNodes.length
}
