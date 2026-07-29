import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BeeDiagramDoc,
  BeeEdge,
  BeeEdgeStyle,
  BeeNode,
  BeeNodeStyle,
  BeePoint,
} from '../../types'
import { parseBeeDoc, serializeBeeDoc, uid } from '../../diagram/beeModel'
import {
  alignNodes,
  bringForward,
  bringToFront,
  distributeNodes,
  sendBackward,
  sendToBack,
  type AlignMode,
} from '../../diagram/studioOps'

export type StudioSelection = { nodes: string[]; edges: string[] }

export type StudioPrefs = {
  grid: boolean
  snap: boolean
  guides: boolean
  paletteOpen: boolean
  formatOpen: boolean
}

const PREFS_KEY = 'beedocs-studio-prefs'
const CLIPBOARD_KEY = 'beedocs-studio-clipboard'
const HISTORY_LIMIT = 120

const DEFAULT_PREFS: StudioPrefs = {
  grid: true,
  snap: true,
  guides: true,
  paletteOpen: true,
  formatOpen: true,
}

function loadPrefs(): StudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<StudioPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

export type ClipboardPayload = { nodes: BeeNode[]; edges: BeeEdge[] }

export type StudioController = ReturnType<typeof useStudioController>

type Options = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
}

/**
 * Document state for the draw.io-style editor: undo/redo, selection,
 * clipboard and all mutations. Viewport (pan/zoom) lives in the canvas so
 * navigating never marks the diagram dirty.
 */
export function useStudioController({ source, onChange, readOnly }: Options) {
  const [doc, setDocState] = useState<BeeDiagramDoc>(() => parseBeeDoc(source))
  const [selection, setSelectionState] = useState<StudioSelection>({ nodes: [], edges: [] })
  const [prefs, setPrefsState] = useState<StudioPrefs>(loadPrefs)
  const [historyTick, setHistoryTick] = useState(0)

  const docRef = useRef(doc)
  docRef.current = doc
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const undoStack = useRef<BeeDiagramDoc[]>([])
  const redoStack = useRef<BeeDiagramDoc[]>([])
  const lastEmitted = useRef(source)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // External source changes (load / other editor) re-hydrate the document.
  useEffect(() => {
    if (source === lastEmitted.current) return
    lastEmitted.current = source
    const next = parseBeeDoc(source)
    docRef.current = next
    setDocState(next)
    undoStack.current = []
    redoStack.current = []
    setHistoryTick((t) => t + 1)
  }, [source])

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  const emit = useCallback((next: BeeDiagramDoc) => {
    const serialized = serializeBeeDoc(next)
    lastEmitted.current = serialized
    onChangeRef.current(serialized)
  }, [])

  /** Apply a change. `history: false` folds into the previous entry (drags). */
  const apply = useCallback(
    (updater: (prev: BeeDiagramDoc) => BeeDiagramDoc, opts?: { history?: boolean }) => {
      if (readOnly) return
      const prev = docRef.current
      const next = updater(prev)
      if (next === prev) return
      if (opts?.history !== false) {
        undoStack.current.push(prev)
        if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
        redoStack.current = []
        setHistoryTick((t) => t + 1)
      }
      docRef.current = next
      setDocState(next)
      emit(next)
    },
    [emit, readOnly],
  )

  /** Snapshot before an interactive gesture (drag/resize) so undo restores it. */
  const beginGesture = useCallback(() => {
    if (readOnly) return
    undoStack.current.push(docRef.current)
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift()
    redoStack.current = []
    setHistoryTick((t) => t + 1)
  }, [readOnly])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(docRef.current)
    docRef.current = prev
    setDocState(prev)
    emit(prev)
    setHistoryTick((t) => t + 1)
    // Drop selection entries that no longer exist
    setSelectionState((s) => ({
      nodes: s.nodes.filter((id) => prev.nodes.some((n) => n.id === id)),
      edges: s.edges.filter((id) => prev.edges.some((e) => e.id === id)),
    }))
  }, [emit])

  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(docRef.current)
    docRef.current = next
    setDocState(next)
    emit(next)
    setHistoryTick((t) => t + 1)
  }, [emit])

  const canUndo = undoStack.current.length > 0
  const canRedo = redoStack.current.length > 0

  // ── Selection ──────────────────────────────────────────────────────────────

  const setSelection = useCallback((next: StudioSelection) => {
    selectionRef.current = next
    setSelectionState(next)
  }, [])

  const selectNodes = useCallback(
    (ids: string[], additive = false) => {
      const cur = selectionRef.current
      if (!additive) {
        setSelection({ nodes: ids, edges: [] })
        return
      }
      const set = new Set(cur.nodes)
      for (const id of ids) {
        if (set.has(id)) set.delete(id)
        else set.add(id)
      }
      setSelection({ nodes: [...set], edges: cur.edges })
    },
    [setSelection],
  )

  const selectEdges = useCallback(
    (ids: string[], additive = false) => {
      const cur = selectionRef.current
      if (!additive) {
        setSelection({ nodes: [], edges: ids })
        return
      }
      const set = new Set(cur.edges)
      for (const id of ids) {
        if (set.has(id)) set.delete(id)
        else set.add(id)
      }
      setSelection({ nodes: cur.nodes, edges: [...set] })
    },
    [setSelection],
  )

  const clearSelection = useCallback(() => setSelection({ nodes: [], edges: [] }), [setSelection])

  const selectAll = useCallback(() => {
    setSelection({
      nodes: docRef.current.nodes.map((n) => n.id),
      edges: docRef.current.edges.map((e) => e.id),
    })
  }, [setSelection])

  const selectedNodes = useMemo(
    () => doc.nodes.filter((n) => selection.nodes.includes(n.id)),
    [doc.nodes, selection.nodes],
  )
  const selectedEdges = useMemo(
    () => doc.edges.filter((e) => selection.edges.includes(e.id)),
    [doc.edges, selection.edges],
  )

  // ── Mutations ──────────────────────────────────────────────────────────────

  const addNodes = useCallback(
    (nodes: BeeNode[], opts?: { select?: boolean }) => {
      if (nodes.length === 0) return
      apply((prev) => ({ ...prev, nodes: [...prev.nodes, ...nodes] }))
      if (opts?.select !== false) setSelection({ nodes: nodes.map((n) => n.id), edges: [] })
    },
    [apply, setSelection],
  )

  const updateNodes = useCallback(
    (
      ids: string[],
      patch: Partial<BeeNode> | ((n: BeeNode) => Partial<BeeNode>),
      opts?: { history?: boolean },
    ) => {
      const idSet = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            idSet.has(n.id) ? { ...n, ...(typeof patch === 'function' ? patch(n) : patch) } : n,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const updateNodeStyle = useCallback(
    (ids: string[], stylePatch: Partial<BeeNodeStyle>) => {
      updateNodes(ids, (n) => ({ style: { ...(n.style ?? {}), ...stylePatch } }))
    },
    [updateNodes],
  )

  const updateEdges = useCallback(
    (ids: string[], patch: Partial<BeeEdge> | ((e: BeeEdge) => Partial<BeeEdge>), opts?: { history?: boolean }) => {
      const idSet = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          edges: prev.edges.map((e) =>
            idSet.has(e.id) ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const updateEdgeStyle = useCallback(
    (ids: string[], stylePatch: Partial<BeeEdgeStyle>) => {
      updateEdges(ids, (e) => ({ style: { ...(e.style ?? {}), ...stylePatch } }))
    },
    [updateEdges],
  )

  const addEdge = useCallback(
    (edge: Omit<BeeEdge, 'id'> & { id?: string }, opts?: { select?: boolean }) => {
      const id = edge.id ?? uid('e')
      apply((prev) => ({ ...prev, edges: [...prev.edges, { ...edge, id }] }))
      if (opts?.select) setSelection({ nodes: [], edges: [id] })
      return id
    },
    [apply, setSelection],
  )

  const deleteSelection = useCallback(() => {
    const { nodes, edges } = selectionRef.current
    if (nodes.length === 0 && edges.length === 0) return
    const nodeSet = new Set(nodes)
    const edgeSet = new Set(edges)
    apply((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => !nodeSet.has(n.id)),
      edges: prev.edges.filter(
        (e) => !edgeSet.has(e.id) && !nodeSet.has(e.from) && !nodeSet.has(e.to),
      ),
    }))
    clearSelection()
  }, [apply, clearSelection])

  const deleteNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      apply((prev) => ({
        ...prev,
        nodes: prev.nodes.filter((n) => !set.has(n.id)),
        edges: prev.edges.filter((e) => !set.has(e.from) && !set.has(e.to)),
      }))
      setSelection({
        nodes: selectionRef.current.nodes.filter((id) => !set.has(id)),
        edges: selectionRef.current.edges,
      })
    },
    [apply, setSelection],
  )

  const deleteEdges = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      apply((prev) => ({ ...prev, edges: prev.edges.filter((e) => !set.has(e.id)) }))
      setSelection({
        nodes: selectionRef.current.nodes,
        edges: selectionRef.current.edges.filter((id) => !set.has(id)),
      })
    },
    [apply, setSelection],
  )

  // ── Clipboard ──────────────────────────────────────────────────────────────

  const clipboardRef = useRef<ClipboardPayload | null>(null)

  const collectSelectionPayload = useCallback((): ClipboardPayload | null => {
    const { nodes, edges } = selectionRef.current
    const nodeSet = new Set(nodes)
    const pickedNodes = docRef.current.nodes.filter((n) => nodeSet.has(n.id))
    const pickedEdges = docRef.current.edges.filter(
      (e) => edges.includes(e.id) || (nodeSet.has(e.from) && nodeSet.has(e.to)),
    )
    if (pickedNodes.length === 0 && pickedEdges.length === 0) return null
    return {
      nodes: structuredClone(pickedNodes),
      edges: structuredClone(pickedEdges),
    }
  }, [])

  const copySelection = useCallback(() => {
    const payload = collectSelectionPayload()
    if (!payload) return
    clipboardRef.current = payload
    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload))
    } catch {
      /* ignore */
    }
  }, [collectSelectionPayload])

  const cutSelection = useCallback(() => {
    copySelection()
    deleteSelection()
  }, [copySelection, deleteSelection])

  const readClipboard = useCallback((): ClipboardPayload | null => {
    if (clipboardRef.current) return clipboardRef.current
    try {
      const raw = localStorage.getItem(CLIPBOARD_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as ClipboardPayload
      if (!Array.isArray(parsed.nodes)) return null
      return parsed
    } catch {
      return null
    }
  }, [])

  /** Paste at an offset, or centred on a world point. */
  const pasteClipboard = useCallback(
    (at?: BeePoint) => {
      const payload = readClipboard()
      if (!payload || payload.nodes.length === 0) return
      const idMap = new Map<string, string>()
      let minX = Infinity
      let minY = Infinity
      for (const n of payload.nodes) {
        minX = Math.min(minX, n.x)
        minY = Math.min(minY, n.y)
      }
      const dx = at ? at.x - minX : 20
      const dy = at ? at.y - minY : 20
      const nodes = payload.nodes.map((n) => {
        const id = uid('n')
        idMap.set(n.id, id)
        return { ...n, id, x: Math.round(n.x + dx), y: Math.round(n.y + dy) }
      })
      const edges = payload.edges
        .filter((e) => idMap.has(e.from) && idMap.has(e.to))
        .map((e) => ({
          ...e,
          id: uid('e'),
          from: idMap.get(e.from)!,
          to: idMap.get(e.to)!,
          waypoints: e.waypoints?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        }))
      apply((prev) => ({ ...prev, nodes: [...prev.nodes, ...nodes], edges: [...prev.edges, ...edges] }))
      setSelection({ nodes: nodes.map((n) => n.id), edges: [] })
    },
    [apply, readClipboard, setSelection],
  )

  const duplicateSelection = useCallback(() => {
    const payload = collectSelectionPayload()
    if (!payload) return
    const idMap = new Map<string, string>()
    const nodes = payload.nodes.map((n) => {
      const id = uid('n')
      idMap.set(n.id, id)
      return { ...n, id, x: n.x + 24, y: n.y + 24 }
    })
    const edges = payload.edges
      .filter((e) => idMap.has(e.from) && idMap.has(e.to))
      .map((e) => ({
        ...e,
        id: uid('e'),
        from: idMap.get(e.from)!,
        to: idMap.get(e.to)!,
        waypoints: e.waypoints?.map((p) => ({ x: p.x + 24, y: p.y + 24 })),
      }))
    apply((prev) => ({ ...prev, nodes: [...prev.nodes, ...nodes], edges: [...prev.edges, ...edges] }))
    setSelection({ nodes: nodes.map((n) => n.id), edges: [] })
  }, [apply, collectSelectionPayload, setSelection])

  // ── Arrange ────────────────────────────────────────────────────────────────

  const orderSelection = useCallback(
    (mode: 'front' | 'back' | 'forward' | 'backward') => {
      const ids = new Set(selectionRef.current.nodes)
      if (ids.size === 0) return
      apply((prev) => ({
        ...prev,
        nodes:
          mode === 'front'
            ? bringToFront(prev.nodes, ids)
            : mode === 'back'
              ? sendToBack(prev.nodes, ids)
              : mode === 'forward'
                ? bringForward(prev.nodes, ids)
                : sendBackward(prev.nodes, ids),
      }))
    },
    [apply],
  )

  const alignSelection = useCallback(
    (mode: AlignMode) => {
      const nodes = docRef.current.nodes.filter((n) => selectionRef.current.nodes.includes(n.id))
      const patch = alignNodes(nodes, mode)
      if (patch.size === 0) return
      apply((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (patch.has(n.id) ? { ...n, ...patch.get(n.id) } : n)),
      }))
    },
    [apply],
  )

  const distributeSelection = useCallback(
    (axis: 'h' | 'v') => {
      const nodes = docRef.current.nodes.filter((n) => selectionRef.current.nodes.includes(n.id))
      const patch = distributeNodes(nodes, axis)
      if (patch.size === 0) return
      apply((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (patch.has(n.id) ? { ...n, ...patch.get(n.id) } : n)),
      }))
    },
    [apply],
  )

  const setPrefs = useCallback((patch: Partial<StudioPrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch }))
  }, [])

  return {
    doc,
    docRef,
    readOnly: !!readOnly,
    selection,
    selectionRef,
    selectedNodes,
    selectedEdges,
    prefs,
    setPrefs,
    historyTick,
    canUndo,
    canRedo,
    apply,
    beginGesture,
    undo,
    redo,
    setSelection,
    selectNodes,
    selectEdges,
    clearSelection,
    selectAll,
    addNodes,
    addEdge,
    updateNodes,
    updateNodeStyle,
    updateEdges,
    updateEdgeStyle,
    deleteSelection,
    deleteNodes,
    deleteEdges,
    copySelection,
    cutSelection,
    pasteClipboard,
    duplicateSelection,
    orderSelection,
    alignSelection,
    distributeSelection,
  }
}
