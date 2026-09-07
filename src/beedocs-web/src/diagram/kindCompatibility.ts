import { EMPTY_BEE_DOC, serializeBeeDoc } from './beeModel'
import { EMPTY_ISO_DOC, serializeIsoDoc } from '../isometric/isoModel'

/** Kinds the canvas switcher offers. PlantUML is stored but not switched to in the UI. */
export type SwitchableKind = 'beediagram' | 'isometric' | 'mermaid' | 'c4'

const MERMAID_START =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey|C4Context|C4Container|C4Component|C4Deployment|requirementDiagram|gitGraph)\b/im

function isJsonObject(source: string): boolean {
  const t = source.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return false
  try {
    const raw = JSON.parse(t) as unknown
    return !!raw && typeof raw === 'object' && !Array.isArray(raw)
  } catch {
    return false
  }
}

function looksLikeBee(source: string): boolean {
  try {
    const raw = JSON.parse(source) as { nodes?: unknown }
    return !!raw && typeof raw === 'object' && Array.isArray(raw.nodes)
  } catch {
    return false
  }
}

function looksLikeIso(source: string): boolean {
  try {
    const raw = JSON.parse(source) as { items?: unknown }
    return !!raw && typeof raw === 'object' && Array.isArray(raw.items)
  } catch {
    return false
  }
}

/** True when `source` can be interpreted as `kind` without wiping the document. */
export function sourceFitsKind(source: string, kind: string): boolean {
  const t = source.trim()
  if (!t) return true
  switch (kind) {
    case 'beediagram':
      return looksLikeBee(t)
    case 'isometric':
      return looksLikeIso(t)
    case 'mermaid':
    case 'c4':
      return !isJsonObject(t) || MERMAID_START.test(t)
    case 'plantuml':
      return !isJsonObject(t)
    default:
      return true
  }
}

/** Empty starter for a kind so a confirmed switch never leaves incompatible source in place. */
export function emptySourceForKind(kind: string): string {
  switch (kind) {
    case 'beediagram':
      return serializeBeeDoc(structuredClone(EMPTY_BEE_DOC))
    case 'isometric':
      return serializeIsoDoc(structuredClone(EMPTY_ISO_DOC))
    default:
      return ''
  }
}

export function isSwitchableKind(value: string): value is SwitchableKind {
  return value === 'beediagram' || value === 'isometric' || value === 'mermaid' || value === 'c4'
}
