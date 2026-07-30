import type { BeeNode } from '../types'
import { nodeRect, rectContains, type Rect } from './studioOps'

/**
 * Container nesting for the studio canvas.
 *
 * A node dropped inside a `container` shape records `parentId`. Children keep
 * **absolute** coordinates — nesting only affects:
 *   • moving a container (its descendants move with it)
 *   • deleting / copying a container (its descendants come along)
 *   • z-order (a child always renders above its container)
 *
 * Keeping coordinates absolute means every existing geometry path — hit
 * testing, edge routing, guides, resize — needs no knowledge of the hierarchy.
 */

export function isContainer(n: BeeNode): boolean {
  return n.shape === 'container'
}

export function childrenOf(nodes: BeeNode[], parentId: string): BeeNode[] {
  return nodes.filter((n) => n.parentId === parentId)
}

/** All descendants of `id`, depth-first. Cycle-safe. */
export function descendantIds(nodes: BeeNode[], id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const n of nodes) {
      if (n.parentId !== current || seen.has(n.id)) continue
      seen.add(n.id)
      out.push(n.id)
      queue.push(n.id)
    }
  }
  return out
}

/** Expand a selection to include everything nested inside it. */
export function withDescendants(nodes: BeeNode[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    for (const d of descendantIds(nodes, id)) out.add(d)
  }
  return out
}

/**
 * The nodes in `ids` that are not nested inside another node in `ids` — the
 * ones a drag actually re-parents (their children just follow along).
 */
export function topLevelOf(nodes: BeeNode[], ids: Set<string>): BeeNode[] {
  return nodes.filter((n) => ids.has(n.id) && !(n.parentId && ids.has(n.parentId)))
}

/** Would making `parentId` the parent of `childId` create a loop? */
export function wouldCycle(nodes: BeeNode[], childId: string, parentId: string): boolean {
  if (childId === parentId) return true
  let cursor: string | undefined = parentId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === childId) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = nodes.find((n) => n.id === cursor)?.parentId
  }
  return false
}

/**
 * Topmost container that would accept a node dropped at `rect`, or null.
 *
 * "Accept" means the container fully contains the rect — a shape straddling the
 * border stays where it is, which makes the interaction predictable when
 * containers are packed together. `exclude` holds the dragged nodes and their
 * descendants so a container can never be dropped into itself.
 */
export function containerAt(
  nodes: BeeNode[],
  rect: Rect,
  exclude: Set<string> = new Set(),
): BeeNode | null {
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  // Last match wins: later in the array means drawn on top.
  let found: BeeNode | null = null
  for (const n of nodes) {
    if (!isContainer(n) || exclude.has(n.id)) continue
    const box = nodeRect(n)
    const contained =
      rectContains(box, rect) ||
      (center.x >= box.x && center.x <= box.x + box.w && center.y >= box.y && center.y <= box.y + box.h)
    if (contained) found = n
  }
  return found
}

/**
 * The container that should adopt a dragged set, or null for "no container".
 *
 * Only the top-level nodes of the drag are tested — their children travel with
 * them and keep the parent they already have. Every root must land in the *same*
 * container, otherwise a straddling multi-selection would be half-adopted.
 *
 * @param rectOf where each node will be once the drag is applied
 */
export function dropTargetFor(
  nodes: BeeNode[],
  movingIds: Set<string>,
  rectOf: (n: BeeNode) => Rect,
): string | null {
  const roots = topLevelOf(nodes, movingIds)
  if (roots.length === 0) return null

  let target: string | null = null
  for (const n of roots) {
    const hit = containerAt(nodes, rectOf(n), movingIds)
    if (!hit) return null
    if (target && target !== hit.id) return null
    target = hit.id
  }
  return target
}

/**
 * Set (or clear, with `null`) the parent of `ids`, then restack so every child
 * sits after its container. Returns the original array when nothing changes so
 * callers can skip a re-render.
 */
export function reparentNodes(
  nodes: BeeNode[],
  ids: Iterable<string>,
  parentId: string | null,
): BeeNode[] {
  const idSet = new Set(ids)
  if (idSet.size === 0) return nodes

  let changed = false
  const next = nodes.map((n) => {
    if (!idSet.has(n.id)) return n
    const target = parentId ?? undefined
    if (n.parentId === target) return n
    if (parentId && wouldCycle(nodes, n.id, parentId)) return n
    changed = true
    const copy = { ...n }
    if (target) copy.parentId = target
    else delete copy.parentId
    return copy
  })

  return changed ? restackContainers(next) : nodes
}

/**
 * Order nodes so a container is immediately followed by its descendants.
 * Without this a child dropped into an older container renders behind it.
 */
export function restackContainers(nodes: BeeNode[]): BeeNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId))
  const out: BeeNode[] = []
  const emitted = new Set<string>()

  const emit = (node: BeeNode) => {
    if (emitted.has(node.id)) return
    emitted.add(node.id)
    out.push(node)
    // Preserve relative order among siblings.
    for (const child of nodes) {
      if (child.parentId === node.id) emit(child)
    }
  }

  for (const root of roots) emit(root)
  // Anything left is part of a cycle — append it so nodes are never dropped.
  for (const n of nodes) if (!emitted.has(n.id)) out.push(n)

  const same = out.length === nodes.length && out.every((n, i) => n === nodes[i])
  return same ? nodes : out
}

/** Drop parent links pointing at nodes that no longer exist (after a delete). */
export function remapParents(nodes: BeeNode[]): BeeNode[] {
  const present = new Set(nodes.map((n) => n.id))
  let changed = false
  const next = nodes.map((n) => {
    if (!n.parentId || present.has(n.parentId)) return n
    changed = true
    const copy = { ...n }
    delete copy.parentId
    return copy
  })
  return changed ? next : nodes
}

/**
 * Fix up parent links on freshly cloned nodes (paste / duplicate).
 *
 * Only the clones are rewritten — remapping the whole document would also
 * re-point existing nodes whose parent happens to be a copy source.
 *
 * @param idMap original id → clone id, for nodes cloned in this batch
 * @param existingIds ids already in the document
 */
export function remapClonedParents(
  clones: BeeNode[],
  idMap: Map<string, string>,
  existingIds: Set<string>,
): BeeNode[] {
  return clones.map((n) => {
    if (!n.parentId) return n
    // Parent was cloned too — point at the clone.
    const mapped = idMap.get(n.parentId)
    if (mapped) return { ...n, parentId: mapped }
    // Parent was not part of the batch but is still on the canvas — stay in it.
    if (existingIds.has(n.parentId)) return n
    const copy = { ...n }
    delete copy.parentId
    return copy
  })
}
