import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { uid } from '../diagram/beeModel'
import {
  parseIsoDoc,
  serializeIsoDoc,
  type IsoConnector,
  type IsoDoc,
  type IsoItem,
  type IsoText,
  type IsoZone,
} from './isoModel'

export type IsoSelection = {
  items: string[]
  connectors: string[]
  zones: string[]
  texts: string[]
}

const EMPTY_SELECTION: IsoSelection = { items: [], connectors: [], zones: [], texts: [] }

export type IsoPrefs = {
  grid: boolean
  paletteOpen: boolean
  formatOpen: boolean
}

const PREFS_KEY = 'beedocs-iso-prefs'
const CLIPBOARD_KEY = 'beedocs-iso-clipboard'
const HISTORY_LIMIT = 120

const DEFAULT_PREFS: IsoPrefs = { grid: true, paletteOpen: true, formatOpen: true }

function loadPrefs(): IsoPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<IsoPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

type ClipboardPayload = {
  items: IsoItem[]
  connectors: IsoConnector[]
  zones: IsoZone[]
  texts: IsoText[]
}

export function selectionSize(s: IsoSelection): number {
  return s.items.length + s.connectors.length + s.zones.length + s.texts.length
}

export type IsoController = ReturnType<typeof useIsoController>

type Options = {
  source: string
  onChange: (source: string) => void
  readOnly?: boolean
}

/**
 * Document state for the isometric editor: undo/redo, selection, clipboard
 * and every mutation — the same shape as the studio's controller so both
 * editors feel identical to work on. Viewport lives in the canvas.
 */
export function useIsoController({ source, onChange, readOnly }: Options) {
  const [doc, setDocState] = useState<IsoDoc>(() => parseIsoDoc(source))
  const [selection, setSelectionState] = useState<IsoSelection>(EMPTY_SELECTION)
  const [prefs, setPrefsState] = useState<IsoPrefs>(loadPrefs)
  const [historyTick, setHistoryTick] = useState(0)

  const docRef = useRef(doc)
  docRef.current = doc
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const undoStack = useRef<IsoDoc[]>([])
  const redoStack = useRef<IsoDoc[]>([])
  const lastEmitted = useRef(source)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // External source changes (load / kind switch) re-hydrate the document.
  useEffect(() => {
    if (source === lastEmitted.current) return
    lastEmitted.current = source
    const next = parseIsoDoc(source)
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

  const emit = useCallback((next: IsoDoc) => {
    const serialized = serializeIsoDoc(next)
    lastEmitted.current = serialized
    onChangeRef.current(serialized)
  }, [])

  /** Apply a change. `history: false` folds into the previous entry (drags). */
  const apply = useCallback(
    (updater: (prev: IsoDoc) => IsoDoc, opts?: { history?: boolean }) => {
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

  const setSelection = useCallback((next: IsoSelection) => {
    selectionRef.current = next
    setSelectionState(next)
  }, [])

  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), [setSelection])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    redoStack.current.push(docRef.current)
    docRef.current = prev
    setDocState(prev)
    emit(prev)
    setHistoryTick((t) => t + 1)
    setSelectionState((s) => ({
      items: s.items.filter((id) => prev.items.some((x) => x.id === id)),
      connectors: s.connectors.filter((id) => prev.connectors.some((x) => x.id === id)),
      zones: s.zones.filter((id) => prev.zones.some((x) => x.id === id)),
      texts: s.texts.filter((id) => prev.texts.some((x) => x.id === id)),
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

  // ── Selection helpers ──────────────────────────────────────────────────────

  const select = useCallback(
    (kind: keyof IsoSelection, ids: string[], additive = false) => {
      const cur = selectionRef.current
      if (!additive) {
        setSelection({ ...EMPTY_SELECTION, [kind]: ids })
        return
      }
      const set = new Set(cur[kind])
      for (const id of ids) {
        if (set.has(id)) set.delete(id)
        else set.add(id)
      }
      setSelection({ ...cur, [kind]: [...set] })
    },
    [setSelection],
  )

  const selectAll = useCallback(() => {
    const d = docRef.current
    setSelection({
      items: d.items.map((x) => x.id),
      connectors: d.connectors.map((x) => x.id),
      zones: d.zones.map((x) => x.id),
      texts: d.texts.map((x) => x.id),
    })
  }, [setSelection])

  const selectedItems = useMemo(
    () => doc.items.filter((x) => selection.items.includes(x.id)),
    [doc.items, selection.items],
  )
  const selectedConnectors = useMemo(
    () => doc.connectors.filter((x) => selection.connectors.includes(x.id)),
    [doc.connectors, selection.connectors],
  )
  const selectedZones = useMemo(
    () => doc.zones.filter((x) => selection.zones.includes(x.id)),
    [doc.zones, selection.zones],
  )
  const selectedTexts = useMemo(
    () => doc.texts.filter((x) => selection.texts.includes(x.id)),
    [doc.texts, selection.texts],
  )

  // ── Mutations ──────────────────────────────────────────────────────────────

  const addItem = useCallback(
    (item: Omit<IsoItem, 'id'> & { id?: string }, opts?: { select?: boolean; history?: boolean }) => {
      const id = item.id ?? uid('i')
      apply((prev) => ({ ...prev, items: [...prev.items, { ...item, id }] }), opts)
      if (opts?.select !== false) setSelection({ ...EMPTY_SELECTION, items: [id] })
      return id
    },
    [apply, setSelection],
  )

  const addConnector = useCallback(
    (c: Omit<IsoConnector, 'id'> & { id?: string }, opts?: { select?: boolean }) => {
      const id = c.id ?? uid('c')
      apply((prev) => ({ ...prev, connectors: [...prev.connectors, { ...c, id }] }))
      if (opts?.select) setSelection({ ...EMPTY_SELECTION, connectors: [id] })
      return id
    },
    [apply, setSelection],
  )

  const addZone = useCallback(
    (z: Omit<IsoZone, 'id'> & { id?: string }, opts?: { select?: boolean }) => {
      const id = z.id ?? uid('z')
      apply((prev) => ({ ...prev, zones: [...prev.zones, { ...z, id }] }))
      if (opts?.select !== false) setSelection({ ...EMPTY_SELECTION, zones: [id] })
      return id
    },
    [apply, setSelection],
  )

  const addText = useCallback(
    (t: Omit<IsoText, 'id'> & { id?: string }, opts?: { select?: boolean }) => {
      const id = t.id ?? uid('t')
      apply((prev) => ({ ...prev, texts: [...prev.texts, { ...t, id }] }))
      if (opts?.select !== false) setSelection({ ...EMPTY_SELECTION, texts: [id] })
      return id
    },
    [apply, setSelection],
  )

  const updateItems = useCallback(
    (
      ids: string[],
      patch: Partial<IsoItem> | ((i: IsoItem) => Partial<IsoItem>),
      opts?: { history?: boolean },
    ) => {
      const set = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          items: prev.items.map((i) =>
            set.has(i.id) ? { ...i, ...(typeof patch === 'function' ? patch(i) : patch) } : i,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const updateConnectors = useCallback(
    (
      ids: string[],
      patch: Partial<IsoConnector> | ((c: IsoConnector) => Partial<IsoConnector>),
      opts?: { history?: boolean },
    ) => {
      const set = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          connectors: prev.connectors.map((c) =>
            set.has(c.id) ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const updateZones = useCallback(
    (
      ids: string[],
      patch: Partial<IsoZone> | ((z: IsoZone) => Partial<IsoZone>),
      opts?: { history?: boolean },
    ) => {
      const set = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          zones: prev.zones.map((z) =>
            set.has(z.id) ? { ...z, ...(typeof patch === 'function' ? patch(z) : patch) } : z,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const updateTexts = useCallback(
    (
      ids: string[],
      patch: Partial<IsoText> | ((t: IsoText) => Partial<IsoText>),
      opts?: { history?: boolean },
    ) => {
      const set = new Set(ids)
      apply(
        (prev) => ({
          ...prev,
          texts: prev.texts.map((t) =>
            set.has(t.id) ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t,
          ),
        }),
        opts,
      )
    },
    [apply],
  )

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current
    if (selectionSize(sel) === 0) return
    const items = new Set(sel.items)
    const connectors = new Set(sel.connectors)
    const zones = new Set(sel.zones)
    const texts = new Set(sel.texts)
    apply((prev) => ({
      ...prev,
      items: prev.items.filter((i) => !items.has(i.id)),
      // deleting an item takes its connectors with it
      connectors: prev.connectors.filter(
        (c) => !connectors.has(c.id) && !items.has(c.from) && !items.has(c.to),
      ),
      zones: prev.zones.filter((z) => !zones.has(z.id)),
      texts: prev.texts.filter((t) => !texts.has(t.id)),
    }))
    clearSelection()
  }, [apply, clearSelection])

  // ── Clipboard ──────────────────────────────────────────────────────────────

  const clipboardRef = useRef<ClipboardPayload | null>(null)

  const collectSelectionPayload = useCallback((): ClipboardPayload | null => {
    const sel = selectionRef.current
    const d = docRef.current
    const items = d.items.filter((i) => sel.items.includes(i.id))
    const itemIds = new Set(items.map((i) => i.id))
    const connectors = d.connectors.filter(
      (c) => sel.connectors.includes(c.id) || (itemIds.has(c.from) && itemIds.has(c.to)),
    )
    const zones = d.zones.filter((z) => sel.zones.includes(z.id))
    const texts = d.texts.filter((t) => sel.texts.includes(t.id))
    if (items.length + zones.length + texts.length === 0) return null
    return structuredClone({ items, connectors, zones, texts })
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
      if (!Array.isArray(parsed.items)) return null
      return parsed
    } catch {
      return null
    }
  }, [])

  const placePayload = useCallback(
    (payload: ClipboardPayload, dTile: { x: number; y: number }) => {
      const idMap = new Map<string, string>()
      const items = payload.items.map((i) => {
        const id = uid('i')
        idMap.set(i.id, id)
        return { ...i, id, x: i.x + dTile.x, y: i.y + dTile.y }
      })
      const connectors = payload.connectors
        .filter((c) => idMap.has(c.from) && idMap.has(c.to))
        .map((c) => ({ ...c, id: uid('c'), from: idMap.get(c.from)!, to: idMap.get(c.to)! }))
      const zones = payload.zones.map((z) => ({
        ...z,
        id: uid('z'),
        x1: z.x1 + dTile.x,
        y1: z.y1 + dTile.y,
        x2: z.x2 + dTile.x,
        y2: z.y2 + dTile.y,
      }))
      const texts = payload.texts.map((t) => ({
        ...t,
        id: uid('t'),
        x: t.x + dTile.x,
        y: t.y + dTile.y,
      }))
      apply((prev) => ({
        ...prev,
        items: [...prev.items, ...items],
        connectors: [...prev.connectors, ...connectors],
        zones: [...prev.zones, ...zones],
        texts: [...prev.texts, ...texts],
      }))
      setSelection({
        items: items.map((x) => x.id),
        connectors: connectors.map((x) => x.id),
        zones: zones.map((x) => x.id),
        texts: texts.map((x) => x.id),
      })
    },
    [apply, setSelection],
  )

  const pasteClipboard = useCallback(() => {
    const payload = readClipboard()
    if (!payload) return
    placePayload(payload, { x: 1, y: 1 })
  }, [placePayload, readClipboard])

  const duplicateSelection = useCallback(() => {
    const payload = collectSelectionPayload()
    if (!payload) return
    placePayload(payload, { x: 1, y: 1 })
  }, [collectSelectionPayload, placePayload])

  const setPrefs = useCallback((patch: Partial<IsoPrefs>) => {
    setPrefsState((p) => ({ ...p, ...patch }))
  }, [])

  return {
    doc,
    docRef,
    readOnly: !!readOnly,
    selection,
    selectionRef,
    selectedItems,
    selectedConnectors,
    selectedZones,
    selectedTexts,
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
    select,
    clearSelection,
    selectAll,
    addItem,
    addConnector,
    addZone,
    addText,
    updateItems,
    updateConnectors,
    updateZones,
    updateTexts,
    deleteSelection,
    copySelection,
    cutSelection,
    pasteClipboard,
    duplicateSelection,
  }
}
