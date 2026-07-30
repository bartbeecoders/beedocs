import type { BeeEdge, BeeNode } from '../types'
import { uid } from './beeModel'
import { remapClonedParents, restackContainers } from './containers'

/** Clipboard-shaped multi-shape snippet used by book collections. */
export type CollectionFragment = {
  version: 1
  nodes: BeeNode[]
  edges: BeeEdge[]
}

/** Shift nodes/edges so the selection's top-left sits at the origin. */
export function normalizeFragment(nodes: BeeNode[], edges: BeeEdge[]): CollectionFragment {
  if (nodes.length === 0) {
    return { version: 1, nodes: [], edges: structuredClone(edges) }
  }
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
  }
  if (!Number.isFinite(minX)) minX = 0
  if (!Number.isFinite(minY)) minY = 0
  return {
    version: 1,
    nodes: nodes.map((n) => ({
      ...structuredClone(n),
      x: Math.round(n.x - minX),
      y: Math.round(n.y - minY),
    })),
    edges: edges.map((e) => ({
      ...structuredClone(e),
      waypoints: e.waypoints?.map((p) => ({
        x: Math.round(p.x - minX),
        y: Math.round(p.y - minY),
      })),
    })),
  }
}

export function serializeFragment(fragment: CollectionFragment): string {
  return JSON.stringify(fragment)
}

export function parseFragment(source: string): CollectionFragment | null {
  try {
    const parsed = JSON.parse(source) as Partial<CollectionFragment>
    if (!Array.isArray(parsed.nodes)) return null
    return {
      version: 1,
      nodes: parsed.nodes as BeeNode[],
      edges: Array.isArray(parsed.edges) ? (parsed.edges as BeeEdge[]) : [],
    }
  } catch {
    return null
  }
}

export function fragmentBounds(fragment: CollectionFragment): { w: number; h: number } {
  if (fragment.nodes.length === 0) return { w: 40, h: 40 }
  let maxX = 0
  let maxY = 0
  for (const n of fragment.nodes) {
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
  }
  return { w: Math.max(1, maxX), h: Math.max(1, maxY) }
}

/**
 * Clone a fragment into fresh node/edge ids, placing the origin at `at`
 * (top-left of the normalised bounds). Parent links inside the fragment are
 * remapped; external parents are dropped.
 */
export function instantiateFragment(
  fragment: CollectionFragment,
  at: { x: number; y: number },
  existingNodeIds: Iterable<string>,
): { nodes: BeeNode[]; edges: BeeEdge[] } {
  const idMap = new Map<string, string>()
  const cloned = fragment.nodes.map((n) => {
    const id = uid('n')
    idMap.set(n.id, id)
    return {
      ...structuredClone(n),
      id,
      x: Math.round(n.x + at.x),
      y: Math.round(n.y + at.y),
    }
  })
  const existing = new Set(existingNodeIds)
  const nodes = remapClonedParents(cloned, idMap, existing)
  const edges = fragment.edges
    .filter((e) => idMap.has(e.from) && idMap.has(e.to))
    .map((e) => ({
      ...structuredClone(e),
      id: uid('e'),
      from: idMap.get(e.from)!,
      to: idMap.get(e.to)!,
      waypoints: e.waypoints?.map((p) => ({
        x: Math.round(p.x + at.x),
        y: Math.round(p.y + at.y),
      })),
    }))
  return { nodes: restackContainers(nodes), edges }
}
