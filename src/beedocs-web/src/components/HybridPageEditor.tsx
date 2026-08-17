import { Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { sameGap, useBlockReorder, type BlockAddr, type GapAddr } from '../hooks/useBlockReorder'
import { useImageIntake, type ImageIntakeContext } from '../hooks/useImageIntake'
import {
  isExcelGridFenceLang,
  isFreedrawFenceLang,
  isIsometricFenceLang,
  isMediaFenceLang,
  isVisualFenceLang,
  joinMarkdownSegments,
  splitMarkdownSegments,
  splitTextAtHeadings,
  startsWithHeading,
  type ContentSegment,
  type FenceSegment,
} from '../markdownFences'
import {
  insertMarkdownAt,
  isImageFile,
  markdownImageSnippet,
  textOffsetFromPointer,
  type UploadedImage,
} from '../media/imageIntake'
import {
  insertInlineMarkdownAt,
  isTreeDrag,
  markdownLinkForTreePayload,
  parseTreeDrag,
} from '../markdownLinks'
import { splitTextWithImagesAndTables } from '../markdownTable'
import {
  collectDataFilesFromDataTransfer,
  dataFenceLangForFile,
  formatJson,
  formatXml,
  isCsvFile,
  readDataFile,
  type DataFenceLang,
} from '../media/dataFiles'
import { parseCsv } from '../excelgrid/csv'
import { fromWorking, serializeExcelGridDoc, starterExcelGridDoc, toWorking } from '../excelgrid/model'
import { MAX_COLS, MAX_ROWS } from '../excelgrid/types'
import {
  extensionFromPath,
  modelFormatFromExtension,
} from '../media/mediaKinds'
import { segmentsForInsert, segmentsForLinkedDiagram, type InsertKind } from '../pageBlocks'
import {
  LAYOUT_PRESETS,
  cellCount,
  formatLayoutSpec,
  parseLayoutSpec,
  parsePageLayout,
  reflowCells,
  serializePageLayout,
  type PageLayout,
} from '../pageLayout'
import { outlineId } from '../pageOutline'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { AiAssistBar, AiAssistField } from './AiAssist'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { ExcelGridCanvas } from './ExcelGridCanvas'
import { FreeDrawCanvas } from './FreeDrawCanvas'
import { MarkdownTableEditor } from './MarkdownTableEditor'
import { MediaEmbed, parseMediaFenceBody } from './media/MediaEmbed'

// Lazy so pages without an isometric section don't load the iso editor module.
const IsometricEditor = lazy(() => import('../isometric/IsometricEditor'))

const isometricLoading = <p className="muted sm">Loading isometric editor…</p>
import { SyncedTextarea } from './SyncedText'

/** Build markdown segments for an uploaded PDF / 3D model fence. */
function mediaFenceFromUpload(url: string, fileName: string, lang: string): ContentSegment[] {
  return [
    { type: 'text', text: '\n\n' },
    { type: 'fence', lang, body: `title: ${fileName}\n${url}` },
    { type: 'text', text: '\n\n' },
  ]
}

/** Fence segments for a dropped JSON/XML file: a labelled block, kept verbatim. */
function dataFenceFromFile(lang: DataFenceLang, body: string): ContentSegment[] {
  return [
    { type: 'text', text: '\n\n' },
    { type: 'fence', lang, body: body.replace(/\r\n/g, '\n').replace(/\s+$/, '') },
    { type: 'text', text: '\n\n' },
  ]
}

/** Dropped CSV/TSV becomes an excelgrid fence, not a raw text block. */
function excelGridFenceFromCsv(text: string): ContentSegment[] {
  const parsed = parseCsv(text)
  const working = toWorking(starterExcelGridDoc())
  working.cells = parsed.cells
  working.rowCount = Math.min(MAX_ROWS, Math.max(parsed.rowCount + 2, 8))
  working.colCount = Math.min(MAX_COLS, Math.max(parsed.colCount + 1, 4))
  return [
    { type: 'text', text: '\n\n' },
    { type: 'fence', lang: 'excelgrid', body: serializeExcelGridDoc(fromWorking(working)) },
    { type: 'text', text: '\n\n' },
  ]
}

/** Resolve fence language from a media file name/type. */
function fenceLangFromMediaFile(file: File): string | null {
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf'
  if (name.endsWith('.glb') || type === 'model/gltf-binary') return 'glb'
  if (name.endsWith('.gltf') || type === 'model/gltf+json') return 'gltf'
  if (name.endsWith('.obj') || type === 'model/obj') return 'obj'
  return null
}

function isMediaFile(file: File): boolean {
  return fenceLangFromMediaFile(file) != null
}

function collectMediaFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt?.files?.length) return []
  return Array.from(dt.files).filter(isMediaFile)
}

/**
 * A stable React key per block, so a wrapper is never reused for a different one.
 *
 * Blocks used to be keyed by position. Reordering therefore handed a block's
 * whole DOM subtree — including the height dragged onto it with the resize grip,
 * and every piece of per-field state the AI helpers keep — to whatever block
 * moved into that slot. Identity travels with the segment object instead:
 * editing a block carries its id onto the replacement object, while re-cutting,
 * merging or loading a different document produces genuinely new blocks and
 * genuinely new keys.
 */
const blockIds = new WeakMap<object, string>()
let blockIdSeq = 0

function blockId(seg: ContentSegment): string {
  let id = blockIds.get(seg)
  if (id == null) {
    blockIdSeq += 1
    id = `b${blockIdSeq}`
    blockIds.set(seg, id)
  }
  return id
}

/** Same block, new object: an edit, not a different block. */
function keepBlockId(from: ContentSegment, to: ContentSegment): ContentSegment {
  blockIds.set(to, blockId(from))
  return to
}

type Props = {
  content: string
  onChange: (next: string) => void
  bookId?: string
  pageId?: string
  placeholder?: string
}

/**
 * The editor's working shape of a page: its grid layout (null = the classic
 * single flow) and one segment list per cell. Serializing goes back through
 * `serializePageLayout`, so the markers round-trip with the content.
 */
type EditorDoc = {
  layout: PageLayout | null
  cells: ContentSegment[][]
}

/** Every cell keeps at least one (possibly empty) text block to type into. */
function ensureCell(segments: ContentSegment[]): ContentSegment[] {
  return segments.length > 0 ? segments : [{ type: 'text', text: '' }]
}

function parseEditorDoc(content: string): EditorDoc {
  const parsed = parsePageLayout(content)
  if (!parsed) return { layout: null, cells: [splitMarkdownSegments(content)] }
  return { layout: parsed.layout, cells: parsed.cells.map((c) => ensureCell(splitMarkdownSegments(c))) }
}

function serializeEditorDoc(doc: EditorDoc): string {
  const cellMds = doc.cells.map(joinMarkdownSegments)
  if (!doc.layout) return cellMds[0] ?? ''
  return serializePageLayout(doc.layout, cellMds)
}

/** Where an insert should land: a gap index inside a cell, or that cell's end. */
type InsertTarget = { cell: number; at: number | 'end' }

/** Parse a `data-drop-slot` value (`before:CELL:GAP` / `segment:CELL:INDEX`). */
function parseDropSlot(raw: string): { kind: 'before' | 'segment'; cell: number; index: number } | null {
  const m = /^(before|segment):(\d+):(\d+)$/.exec(raw)
  if (!m) return null
  return { kind: m[1] as 'before' | 'segment', cell: Number(m[2]), index: Number(m[3]) }
}

type ReorderGapProps = {
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

/**
 * Page editor that keeps prose as Markdown textareas but renders BeeDiagram
 * fences as the full visual canvas editor — so you edit diagrams on the page.
 * Markdown images show as previews in edit mode; drops insert at the pointer.
 *
 * Pages can arrange their blocks in a grid (`pageLayout.ts`): each cell hosts
 * its own block list, and blocks drag between cells with the same handle that
 * reorders them.
 */
export function HybridPageEditor({ content, onChange, bookId, pageId, placeholder }: Props) {
  const lastEmitted = useRef(content)
  const rootRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<EditorDoc>(() => parseEditorDoc(content))
  const [busy, setBusy] = useState(false)
  const [insertError, setInsertError] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)
  /** A page/book is being dragged over the editor from the library tree. */
  const [linkDragging, setLinkDragging] = useState(false)
  /** Cell the toolbar inserts into — follows focus/clicks. Always 0 without a grid. */
  const [activeCell, setActiveCell] = useState(0)
  const { renameInTree } = useWorkspace()

  useEffect(() => {
    if (content === lastEmitted.current) return
    setDoc(parseEditorDoc(content))
    lastEmitted.current = content
  }, [content])

  const emit = useCallback(
    (next: EditorDoc) => {
      setDoc(next)
      const md = serializeEditorDoc(next)
      lastEmitted.current = md
      onChange(md)
    },
    [onChange],
  )

  const docRef = useRef(doc)
  docRef.current = doc
  const activeCellRef = useRef(activeCell)
  activeCellRef.current = Math.min(activeCell, doc.cells.length - 1)

  /** Replace one cell's segment list (already normalized by the caller). */
  const emitCell = useCallback(
    (cell: number, segments: ContentSegment[]) => {
      const d = docRef.current
      emit({ ...d, cells: d.cells.map((c, i) => (i === cell ? ensureCell(segments) : c)) })
    },
    [emit],
  )

  const updateSegment = useCallback(
    (cell: number, index: number, patch: ContentSegment) => {
      // Read through the ref: a handler created in an earlier render must not
      // rebuild the document from that render's (now stale) segment list.
      const list = docRef.current.cells[cell]
      if (!list) return
      emitCell(cell, list.map((s, i) => (i === index ? keepBlockId(s, patch) : s)))
    },
    [emitCell],
  )

  const removeSegment = useCallback(
    (cell: number, index: number) => {
      const list = docRef.current.cells[cell]
      if (!list) return
      emitCell(cell, mergeAdjacentText(list.filter((_, i) => i !== index)))
    },
    [emitCell],
  )

  /**
   * Move a block to sit before gap `to.gap` in cell `to.cell` — which may be a
   * different cell than the one it came from.
   *
   * Within one cell, `to.gap` is a gap index, so dropping into the gap directly
   * after the dragged block is a no-op rather than an off-by-one shuffle.
   */
  const moveSegment = useCallback(
    (from: BlockAddr, to: GapAddr) => {
      const d = docRef.current
      const source = d.cells[from.cell]
      if (!source || from.index < 0 || from.index >= source.length) return
      if (!d.cells[to.cell]) return

      if (from.cell === to.cell) {
        if (to.gap === from.index || to.gap === from.index + 1) return
        const next = [...source]
        const [moved] = next.splice(from.index, 1)
        if (!moved) return
        next.splice(to.gap > from.index ? to.gap - 1 : to.gap, 0, moved)
        emitCell(from.cell, mergeAdjacentText(next))
        return
      }

      const nextSource = [...source]
      const [moved] = nextSource.splice(from.index, 1)
      if (!moved) return
      const nextTarget = [...d.cells[to.cell]]
      nextTarget.splice(Math.min(Math.max(0, to.gap), nextTarget.length), 0, moved)
      emit({
        ...d,
        cells: d.cells.map((c, i) =>
          i === from.cell
            ? ensureCell(mergeAdjacentText(nextSource))
            : i === to.cell
              ? mergeAdjacentText(nextTarget)
              : c,
        ),
      })
    },
    [emit, emitCell],
  )

  /**
   * Re-cut the blocks once a text block is done being edited.
   *
   * Splitting while someone types would tear the textarea out from under the
   * cursor, so a heading typed into an existing block only becomes its own
   * block — and so only becomes draggable — when focus leaves.
   */
  const normalizeBlocks = useCallback(() => {
    const d = docRef.current
    let changed = false
    const cells = d.cells.map((list) => {
      const next = mergeAdjacentText(list)
      const unchanged =
        next.length === list.length &&
        next.every((s, i) => {
          const prev = list[i]
          return s.type === 'text' && prev.type === 'text'
            ? s.text === prev.text
            : s.type === 'fence' && prev.type === 'fence' && s.lang === prev.lang && s.body === prev.body
        })
      if (unchanged) return list
      changed = true
      return ensureCell(next)
    })
    if (!changed) return
    emit({ ...d, cells })
  }, [emit])

  const reorder = useBlockReorder({ onMove: moveSegment, containerRef: rootRef })

  const updateFenceBody = useCallback(
    (cell: number, index: number, body: string) => {
      const list = docRef.current.cells[cell]
      const seg = list?.[index]
      if (!seg || seg.type !== 'fence') return
      emitCell(cell, list.map((s, i) => (i === index ? keepBlockId(s, { ...seg, body }) : s)))
    },
    [emitCell],
  )

  const insertAt = useCallback(
    (target: InsertTarget, extra: ContentSegment[]) => {
      const d = docRef.current
      const cell = Math.min(Math.max(0, target.cell), d.cells.length - 1)
      const list = d.cells[cell]
      let next: ContentSegment[]
      if (target.at === 'end') {
        next = [...list, ...extra]
      } else {
        const at = Math.min(Math.max(0, target.at), list.length)
        next = [...list.slice(0, at), ...extra, ...list.slice(at)]
      }
      emitCell(cell, mergeAdjacentText(next))
    },
    [emitCell],
  )

  /** Default landing spot for content that arrives without a drop slot. */
  const defaultTarget = useCallback(
    (): InsertTarget => ({ cell: activeCellRef.current, at: 'end' }),
    [],
  )

  /** Switch the page's grid layout, re-flowing existing cells into the new one. */
  const changeLayout = useCallback(
    (spec: string) => {
      const layout = parseLayoutSpec(spec)
      if (!layout) return
      const d = docRef.current
      if (d.layout && formatLayoutSpec(d.layout) === formatLayoutSpec(layout)) return
      if (!d.layout && cellCount(layout) <= 1) return
      const cellMds = d.cells.map(joinMarkdownSegments)
      const single = cellCount(layout) <= 1
      const reflowed = reflowCells(cellMds, single ? 1 : cellCount(layout))
      setActiveCell(0)
      emit({
        layout: single ? null : layout,
        cells: reflowed.map((md) => ensureCell(splitMarkdownSegments(md))),
      })
    },
    [emit],
  )

  const handleInsert = useCallback(
    async (kind: InsertKind | 'beediagram-linked', at?: InsertTarget) => {
      setInsertError(null)
      const target = at ?? { cell: activeCellRef.current, at: 'end' as const }
      if (kind === 'beediagram-linked') {
        if (!bookId) {
          setInsertError('Open a page inside a book to add a linked diagram.')
          return
        }
        const title = window.prompt('Diagram title', 'Architecture')?.trim()
        if (!title) return
        setBusy(true)
        try {
          const starter = segmentsForInsert('beediagram').find((s): s is FenceSegment => s.type === 'fence')
          const diagram = await api.createDiagram(bookId, {
            title,
            kind: 'beediagram',
            pageId: pageId || undefined,
            source: starter?.body,
          })
          insertAt(target, segmentsForLinkedDiagram(diagram.id))
          await renameInTree()
        } catch (e) {
          setInsertError(e instanceof Error ? e.message : String(e))
        } finally {
          setBusy(false)
        }
        return
      }

      if (kind === 'section' || kind === 'subsection') {
        const label = kind === 'section' ? 'Section title' : 'Subsection title'
        const title = window.prompt(label, kind === 'section' ? 'Overview' : 'Details')?.trim()
        if (!title) return
        // Toolbar inserts prepend — new sections belong at the top of their cell.
        insertAt(at ?? { cell: activeCellRef.current, at: 0 }, segmentsForInsert(kind, { title }))
        return
      }

      insertAt(target, segmentsForInsert(kind))
    },
    [bookId, insertAt, pageId, renameInTree],
  )

  /** Insert image markdown into a specific text segment at a character offset. */
  const insertImagesIntoTextSegment = useCallback(
    (cell: number, segmentIndex: number, offset: number, images: UploadedImage[]) => {
      const list = docRef.current.cells[cell]
      const seg = list?.[segmentIndex]
      if (!seg || seg.type !== 'text') {
        const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
        insertAt({ cell, at: segmentIndex }, [{ type: 'text', text: `\n\n${parts}\n\n` }])
        return
      }
      let text = seg.text
      let off = offset
      for (const img of images) {
        const snip = markdownImageSnippet(img.url, img.fileName)
        text = insertMarkdownAt(text, off, snip)
        off += snip.length + 4 // rough advance past padding
      }
      emitCell(cell, list.map((s, i) => (i === segmentIndex ? keepBlockId(s, { type: 'text', text }) : s)))
    },
    [emitCell, insertAt],
  )

  const insertImagesFromContext = useCallback(
    (images: UploadedImage[], ctx: ImageIntakeContext) => {
      setInsertError(null)
      const el =
        (ctx.target instanceof Element ? ctx.target : null)?.closest?.('[data-drop-slot]') ??
        (typeof document !== 'undefined'
          ? document.elementFromPoint(ctx.clientX, ctx.clientY)?.closest('[data-drop-slot]')
          : null)

      if (el) {
        const slot = parseDropSlot(el.getAttribute('data-drop-slot') || '')
        // before → insert a new text block at that gap
        if (slot?.kind === 'before') {
          const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
          insertAt({ cell: slot.cell, at: slot.index }, [{ type: 'text', text: `\n\n${parts}\n\n` }])
          setDropHint(null)
          return
        }
        // segment → insert into that text segment
        if (slot?.kind === 'segment') {
          const ta =
            el instanceof HTMLTextAreaElement
              ? el
              : (el.querySelector('textarea') as HTMLTextAreaElement | null)
          let offset = ta?.value.length ?? 0
          if (ta && ctx.source === 'paste' && document.activeElement === ta) {
            offset = ta.selectionStart ?? ta.value.length
          } else if (ta && ctx.clientY) {
            offset = textOffsetFromPointer(ta, ctx.clientY)
          }
          insertImagesIntoTextSegment(slot.cell, slot.index, offset, images)
          setDropHint(null)
          return
        }
      }

      // Focused textarea fallback (paste)
      const active = document.activeElement
      if (
        active instanceof HTMLTextAreaElement &&
        active.dataset.segmentIndex != null &&
        active.dataset.cellIndex != null
      ) {
        const cell = Number(active.dataset.cellIndex)
        const idx = Number(active.dataset.segmentIndex)
        const offset = active.selectionStart ?? active.value.length
        if (Number.isFinite(cell) && Number.isFinite(idx)) {
          insertImagesIntoTextSegment(cell, idx, offset, images)
          setDropHint(null)
          return
        }
      }

      // Default: end of the active cell
      const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
      insertAt(defaultTarget(), [{ type: 'text', text: `\n\n${parts}\n\n` }])
      setDropHint(null)
    },
    [defaultTarget, insertAt, insertImagesIntoTextSegment],
  )

  const { dragging, uploading, pickFiles } = useImageIntake({
    enabled: true,
    targetRef: rootRef,
    paste: true,
    onUploaded: insertImagesFromContext,
    onError: (msg) => setInsertError(msg),
  })

  const pickMedia = useCallback(
    (kind: 'pdf' | 'model', at?: InsertTarget) => {
      const input = document.createElement('input')
      input.type = 'file'
      if (kind === 'pdf') {
        input.accept = '.pdf,application/pdf'
      } else {
        input.accept = '.glb,.gltf,.obj,model/*'
      }
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        void (async () => {
          setBusy(true)
          setInsertError(null)
          try {
            const result = await api.uploadFile(file)
            const lang = fenceLangFromMediaFile(file) || (kind === 'pdf' ? 'pdf' : 'model')
            insertAt(at ?? defaultTarget(), mediaFenceFromUpload(result.url, result.fileName || file.name, lang))
          } catch (e) {
            setInsertError(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy(false)
          }
        })()
      }
      input.click()
    },
    [defaultTarget, insertAt],
  )

  /** Drop PDF / 3D models (image drops stay with useImageIntake). */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const onDrop = (e: DragEvent) => {
      const mediaFiles = collectMediaFilesFromDataTransfer(e.dataTransfer)
      if (!mediaFiles.length) return
      // Prefer image intake when the drop also contains images
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
      if (files.some((f) => isImageFile(f))) return

      e.preventDefault()
      e.stopPropagation()
      void (async () => {
        setBusy(true)
        setInsertError(null)
        setDropHint(null)
        try {
          for (const file of mediaFiles) {
            const result = await api.uploadFile(file)
            const lang = fenceLangFromMediaFile(file)
            if (!lang) continue
            insertAt(defaultTarget(), mediaFenceFromUpload(result.url, result.fileName || file.name, lang))
          }
        } catch (err) {
          setInsertError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
    }

    el.addEventListener('drop', onDrop)
    return () => el.removeEventListener('drop', onDrop)
  }, [defaultTarget, insertAt])

  /** Drop JSON / XML — inlined as a fenced block rather than uploaded. */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const onDrop = (e: DragEvent) => {
      const dataFilesDropped = collectDataFilesFromDataTransfer(e.dataTransfer)
      if (!dataFilesDropped.length) return
      // Anything the other handlers own takes precedence.
      const all = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
      if (all.some((f) => isImageFile(f) || isMediaFile(f))) return

      e.preventDefault()
      e.stopPropagation()

      // Land where it was dropped when the pointer is over a slot, as images do.
      const slotEl = (e.target as Element | null)?.closest?.('[data-drop-slot]')
      const slot = parseDropSlot(slotEl?.getAttribute('data-drop-slot') ?? '')
      const target: InsertTarget =
        slot?.kind === 'before' ? { cell: slot.cell, at: slot.index } : defaultTarget()

      void (async () => {
        setBusy(true)
        setInsertError(null)
        setDropHint(null)
        try {
          const problems: string[] = []
          for (const file of dataFilesDropped) {
            const lang = dataFenceLangForFile(file)
            if (!lang) continue
            const read = await readDataFile(file)
            if ('error' in read) {
              problems.push(read.error)
              continue
            }
            insertAt(target, dataFenceFromFile(lang, read.text))
          }
          if (problems.length) setInsertError(problems.join(' '))
        } finally {
          setBusy(false)
        }
      })()
    }

    el.addEventListener('drop', onDrop)
    return () => el.removeEventListener('drop', onDrop)
  }, [defaultTarget, insertAt])

  /** Drop CSV / TSV — opened as an Excel-style grid section. */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
      const csvFiles = files.filter(isCsvFile)
      if (!csvFiles.length) return
      if (files.some((f) => isImageFile(f) || isMediaFile(f))) return

      e.preventDefault()
      e.stopPropagation()

      const slotEl = (e.target as Element | null)?.closest?.('[data-drop-slot]')
      const slot = parseDropSlot(slotEl?.getAttribute('data-drop-slot') ?? '')
      const target: InsertTarget =
        slot?.kind === 'before' ? { cell: slot.cell, at: slot.index } : defaultTarget()

      void (async () => {
        setBusy(true)
        setInsertError(null)
        setDropHint(null)
        try {
          const problems: string[] = []
          for (const file of csvFiles) {
            const read = await readDataFile(file)
            if ('error' in read) {
              problems.push(read.error)
              continue
            }
            insertAt(target, excelGridFenceFromCsv(read.text))
          }
          if (problems.length) setInsertError(problems.join(' '))
        } finally {
          setBusy(false)
        }
      })()
    }

    el.addEventListener('drop', onDrop)
    return () => el.removeEventListener('drop', onDrop)
  }, [defaultTarget, insertAt])

  /**
   * Drop a page or book dragged from the library tree — inserts a Markdown
   * link to it. A link is inline content, so a drop into a text section lands
   * at the pointer's line inside the prose rather than as a block of its own;
   * gaps and the document end still get their own paragraph.
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    const onDragOver = (e: DragEvent) => {
      if (!isTreeDrag(e.dataTransfer)) return
      // Without preventDefault the browser refuses the drop outright.
      e.preventDefault()
      // Must stay within the tree drag's effectAllowed ('move') or the drop is cancelled.
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setLinkDragging(true)
      setDropHint('Drop to insert a link to that document')
    }

    const onDrop = (e: DragEvent) => {
      if (!isTreeDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      setLinkDragging(false)
      setDropHint(null)

      const payload = parseTreeDrag(e.dataTransfer)
      const snippet = payload ? markdownLinkForTreePayload(payload) : null
      if (!snippet) return // e.g. a folder — nothing to link to

      const slotEl =
        (e.target instanceof Element ? e.target : null)?.closest?.('[data-drop-slot]') ??
        document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drop-slot]')
      const slot = parseDropSlot(slotEl?.getAttribute('data-drop-slot') ?? '')
      if (slot?.kind === 'before') {
        insertAt({ cell: slot.cell, at: slot.index }, [{ type: 'text', text: `\n\n${snippet}\n\n` }])
        return
      }
      if (slot?.kind === 'segment') {
        const seg = docRef.current.cells[slot.cell]?.[slot.index]
        if (seg?.type === 'text' && slotEl) {
          const ta =
            slotEl instanceof HTMLTextAreaElement
              ? slotEl
              : (slotEl.querySelector('textarea') as HTMLTextAreaElement | null)
          const offset = ta ? textOffsetFromPointer(ta, e.clientY) : seg.text.length
          const text = insertInlineMarkdownAt(seg.text, offset, snippet)
          updateSegment(slot.cell, slot.index, { type: 'text', text })
          return
        }
      }
      insertAt(defaultTarget(), [{ type: 'text', text: `\n\n${snippet}\n\n` }])
    }

    // dragend fires on the tree row that started the drag, wherever it ended.
    const onDragEnd = () => {
      setLinkDragging(false)
      setDropHint(null)
    }

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    document.addEventListener('dragend', onDragEnd, true)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
      document.removeEventListener('dragend', onDragEnd, true)
    }
  }, [defaultTarget, insertAt, updateSegment])

  /** Remove one embedded piece (image or table) from a text segment by its raw Markdown. */
  const removePieceFromSegment = useCallback(
    (cell: number, segmentIndex: number, raw: string) => {
      const seg = docRef.current.cells[cell]?.[segmentIndex]
      if (!seg || seg.type !== 'text') return
      const text = seg.text.replace(raw, '').replace(/\n{3,}/g, '\n\n')
      updateSegment(cell, segmentIndex, { type: 'text', text })
    },
    [updateSegment],
  )

  const layout = doc.layout
  const gridMode = layout != null
  const totalBlocks = doc.cells.reduce((sum, c) => sum + c.length, 0)
  /** Global block index offsets per cell — outline ids span cells in order. */
  const cellOffsets: number[] = []
  {
    let acc = 0
    for (const c of doc.cells) {
      cellOffsets.push(acc)
      acc += c.length
    }
  }

  const renderBlock = (seg: ContentSegment, cellIdx: number, index: number) => {
    const globalIndex = cellOffsets[cellIdx] + index
    const cellSegs = doc.cells[cellIdx]
    return (
      <div
        key={blockId(seg)}
        id={outlineId(globalIndex)}
        className={`hybrid-block-wrap${
          reorder.dragAddr?.cell === cellIdx && reorder.dragAddr?.index === index ? ' is-dragging' : ''
        }`}
        data-block-index={index}
        data-outline-id={outlineId(globalIndex)}
      >
        <BlockHandle
          label={blockLabel(seg)}
          canMoveUp={index > 0}
          canMoveDown={index < cellSegs.length - 1}
          canMoveLeft={gridMode && cellIdx > 0}
          canMoveRight={gridMode && cellIdx < doc.cells.length - 1}
          canRemove={gridMode || totalBlocks > 1}
          onDragStart={(e) => reorder.start({ cell: cellIdx, index }, e)}
          onDragEnd={reorder.end}
          onMoveUp={() => moveSegment({ cell: cellIdx, index }, { cell: cellIdx, gap: index - 1 })}
          onMoveDown={() => moveSegment({ cell: cellIdx, index }, { cell: cellIdx, gap: index + 2 })}
          onMoveLeft={() =>
            moveSegment(
              { cell: cellIdx, index },
              { cell: cellIdx - 1, gap: doc.cells[cellIdx - 1]?.length ?? 0 },
            )
          }
          onMoveRight={() => moveSegment({ cell: cellIdx, index }, { cell: cellIdx + 1, gap: 0 })}
          onRemove={() => removeSegment(cellIdx, index)}
        />
        {seg.type === 'text' ? (
          <RichTextBlock
            cellIndex={cellIdx}
            segmentIndex={index}
            value={seg.text}
            pageContext={content}
            placeholder={globalIndex === 0 ? placeholder : 'Continue Markdown…'}
            dragging={dragging || linkDragging}
            onChange={(text) => updateSegment(cellIdx, index, { type: 'text', text })}
            onBlur={normalizeBlocks}
            onRemovePiece={(raw) => removePieceFromSegment(cellIdx, index, raw)}
          />
        ) : isMediaFenceLang(seg.lang) ? (
          <MediaFenceBlock
            segment={seg}
            onChange={(next) => updateSegment(cellIdx, index, next)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        ) : isFreedrawFenceLang(seg.lang) ? (
          <FreeDrawFenceBlock
            segment={seg}
            onBodyChange={(body) => updateFenceBody(cellIdx, index, body)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        ) : isExcelGridFenceLang(seg.lang) ? (
          <ExcelGridFenceBlock
            segment={seg}
            onBodyChange={(body) => updateFenceBody(cellIdx, index, body)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        ) : isIsometricFenceLang(seg.lang) ? (
          <IsometricFenceBlock
            segment={seg}
            bookId={bookId}
            onBodyChange={(body) => updateFenceBody(cellIdx, index, body)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        ) : isVisualFenceLang(seg.lang) ? (
          <VisualFenceBlock
            segment={seg}
            bookId={bookId}
            onBodyChange={(body) => updateFenceBody(cellIdx, index, body)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        ) : (
          <SourceFenceBlock
            segment={seg}
            onChange={(next) => updateSegment(cellIdx, index, next)}
            onRemove={() => removeSegment(cellIdx, index)}
          />
        )}
        <InsertGap
          busy={busy}
          onInsert={(k) => void handleInsert(k, { cell: cellIdx, at: index + 1 })}
          dropSlot={`before:${cellIdx}:${index + 1}`}
          dropLabel="Insert image here"
          dragging={dragging}
          reorderProps={reorder.gapProps({ cell: cellIdx, gap: index + 1 })}
          reorderActive={sameGap(reorder.overGap, { cell: cellIdx, gap: index + 1 })}
        />
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`hybrid-page-editor${dragging ? ' is-drop-target' : ''}${uploading || busy ? ' is-busy' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return
        const slot = (e.target as Element).closest?.('[data-drop-slot]')
        if (slot) {
          const label = slot.getAttribute('data-drop-label')
          setDropHint(label || 'Drop image or media here')
        }
      }}
      onDragLeave={() => setDropHint(null)}
    >
      {uploading && (
        <div className="image-upload-banner" aria-live="polite">
          Uploading image…
        </div>
      )}
      {(dragging || linkDragging) && dropHint && (
        <div className="image-drop-hint" aria-live="polite">
          {dropHint}
        </div>
      )}
      <InsertToolbar
        busy={busy || uploading}
        layoutSpec={layout ? formatLayoutSpec(layout) : '1x1'}
        onLayoutChange={changeLayout}
        onInsert={(k) => void handleInsert(k)}
        onPickImage={() => pickFiles()}
        onPickPdf={() => pickMedia('pdf')}
        onPickModel={() => pickMedia('model')}
      />
      {insertError && <div className="banner error compact">{insertError}</div>}
      <AiAssistBar />
      <p className="hybrid-hint muted sm">
        Drop or paste images <strong>where you want them</strong> — they preview in edit mode. Use Add for
        sections, <strong>tables</strong> (edited as a grid — add/remove rows and columns in place),
        diagrams, <strong>PDF</strong>, and <strong>3D models</strong> (or drop <code>.pdf</code> /{' '}
        <code>.glb</code> / <code>.obj</code> files). Dropping <code>.json</code> / <code>.xml</code> inlines
        the file as a code block you can reformat; <code>.csv</code> / <code>.tsv</code> becomes a
        spreadsheet section. Drag a <strong>page or book from the library</strong>{' '}
        into a section to insert a link to it.
        {gridMode && (
          <>
            {' '}This page uses a <strong>{layout!.cols}×{layout!.rows} grid</strong> — drag blocks between
            cells with their handle, or use ←/→ on a focused handle.
          </>
        )}
      </p>

      <div
        className={`hybrid-cells${gridMode ? ' hybrid-cells--grid' : ''}`}
        style={gridMode ? ({ '--page-grid-cols': layout!.cols } as CSSProperties) : undefined}
      >
        {doc.cells.map((segs, cellIdx) => (
          <section
            key={cellIdx}
            data-cell-root={cellIdx}
            className={`hybrid-cell${gridMode ? ' hybrid-cell--grid' : ''}${
              gridMode && activeCellRef.current === cellIdx ? ' is-active' : ''
            }`}
            aria-label={gridMode ? `Layout cell ${cellIdx + 1}` : undefined}
            onFocusCapture={() => setActiveCell(cellIdx)}
            onMouseDownCapture={() => setActiveCell(cellIdx)}
          >
            {gridMode && <div className="hybrid-cell-tag">Cell {cellIdx + 1}</div>}
            <InsertGap
              busy={busy}
              onInsert={(k) => void handleInsert(k, { cell: cellIdx, at: 0 })}
              label={gridMode ? `Insert at top of cell ${cellIdx + 1}` : 'Insert at top'}
              dropSlot={`before:${cellIdx}:0`}
              dropLabel={gridMode ? `Insert image at top of cell ${cellIdx + 1}` : 'Insert image at top of page'}
              dragging={dragging}
              reorderProps={reorder.gapProps({ cell: cellIdx, gap: 0 })}
              reorderActive={sameGap(reorder.overGap, { cell: cellIdx, gap: 0 })}
            />
            {segs.map((seg, index) => renderBlock(seg, cellIdx, index))}
          </section>
        ))}
      </div>
    </div>
  )
}

/** Short description of a block, for the drag handle's accessible name. */
function blockLabel(seg: ContentSegment): string {
  if (seg.type === 'fence') return `${seg.lang} block`
  const heading = seg.text.split('\n').find((l) => /^#{1,6}\s+\S/.test(l))
  if (heading) return heading.replace(/^#+\s+/, '')
  const firstWords = seg.text.trim().split(/\s+/).slice(0, 6).join(' ')
  return firstWords || 'Empty block'
}

/**
 * Grip for reordering a block: drag it, or move the block with the keyboard.
 * On a grid page, ←/→ send the block to the neighbouring cell.
 *
 * Reordering hangs off a handle rather than the block itself so that dragging
 * inside a textarea still selects text, which is what anyone editing prose
 * expects a drag to do.
 */
function BlockHandle({
  label,
  canMoveUp,
  canMoveDown,
  canMoveLeft,
  canMoveRight,
  canRemove,
  onDragStart,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  onMoveLeft,
  onMoveRight,
  onRemove,
}: {
  label: string
  canMoveUp: boolean
  canMoveDown: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  canRemove: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onRemove: () => void
}) {
  const cellHint = canMoveLeft || canMoveRight ? ' · ← / → to another cell' : ''
  return (
    <div className="block-controls">
      <button
        type="button"
        className="block-handle"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        // Keyboard equivalent — a drag gesture is not reachable without a pointer.
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' && canMoveUp) {
            e.preventDefault()
            onMoveUp()
          } else if (e.key === 'ArrowDown' && canMoveDown) {
            e.preventDefault()
            onMoveDown()
          } else if (e.key === 'ArrowLeft' && canMoveLeft) {
            e.preventDefault()
            onMoveLeft()
          } else if (e.key === 'ArrowRight' && canMoveRight) {
            e.preventDefault()
            onMoveRight()
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && canRemove) {
            e.preventDefault()
            onRemove()
          }
        }}
        aria-label={`Move block: ${label}. Drag, or use arrow keys.`}
        title={`Drag to reorder · ↑ / ↓ to move${cellHint}`}
      >
        <span aria-hidden="true">{'⠿'}</span>
      </button>
      {canRemove && (
        <button
          type="button"
          className="block-remove"
          onClick={onRemove}
          aria-label={`Remove block: ${label}`}
          title="Remove block"
        >
          ×
        </button>
      )}
    </div>
  )
}

/**
 * Concatenate two text runs, capping the blank lines where they meet.
 *
 * Both runs keep the blank lines that separated them from the block that used to
 * sit between them, so pulling that block out would otherwise leave a growing
 * pile of empty lines behind every move. Only the seam is touched.
 */
function joinTextRuns(a: string, b: string): string {
  const trailing = /\n*$/.exec(a)?.[0].length ?? 0
  const leading = /^\n*/.exec(b)?.[0].length ?? 0

  // A block opening with a heading has to keep its own line. Without this, a
  // block whose trailing newline was edited away swallows the next section's
  // `##` mid-line — which destroys the heading and cannot be recovered by
  // re-splitting, because the marker is no longer at the start of a line.
  if (trailing + leading === 0 && a !== '' && startsWithHeading(b)) return a + '\n\n' + b

  if (trailing + leading <= 2) return a + b
  return a.slice(0, a.length - trailing) + '\n\n' + b.slice(leading)
}

/**
 * Normalize the block list after a structural change: glue adjacent text runs
 * back together, then cut them at headings again.
 *
 * The round trip matters because inserting or moving a block can leave two text
 * runs side by side — merging and re-splitting turns those back into exactly one
 * block per section, so the same page always shows the same blocks however it
 * was assembled.
 */
function mergeAdjacentText(segments: ContentSegment[]): ContentSegment[] {
  const merged: ContentSegment[] = []
  for (const s of segments) {
    const prev = merged[merged.length - 1]
    if (s.type === 'text' && prev?.type === 'text') {
      // The merged run keeps the first run's identity: React keys off it, and a
      // new object here would remount every text block on the page.
      merged[merged.length - 1] = keepBlockId(prev, {
        type: 'text',
        text: joinTextRuns(prev.text, s.text),
      })
    } else {
      merged.push(s)
    }
  }

  const out: ContentSegment[] = []
  for (const s of merged) {
    if (s.type !== 'text') {
      out.push(s)
      continue
    }
    const pieces = splitTextAtHeadings(s.text)
    // Untouched runs must come through as the *same* object. Reordering rebuilds
    // this list on every move, and a fresh object per run would discard each
    // block's manual height and drop focus from the drag handle mid-keypress.
    if (pieces.length === 1 && pieces[0] === s.text) {
      out.push(s)
      continue
    }
    // A run that genuinely splits hands its identity to the first piece, so the
    // block the caret is in survives the recut.
    pieces.forEach((piece, i) => {
      const next: ContentSegment = { type: 'text', text: piece }
      out.push(i === 0 ? keepBlockId(s, next) : next)
    })
  }

  // Reordering glues two runs together and immediately cuts them apart again, so
  // the pieces above are new objects even though the text is untouched. Re-adopt
  // an input run's identity wherever the text came out the same, matching each
  // one only once so duplicate paragraphs cannot both claim it.
  const spare = segments.filter((s): s is Extract<ContentSegment, { type: 'text' }> => s.type === 'text')
  const adopted = out.map((s) => {
    if (s.type !== 'text' || blockIds.has(s)) return s
    const i = spare.findIndex((c) => c.text === s.text)
    if (i === -1) return s
    const [claimed] = spare.splice(i, 1)
    return claimed ? keepBlockId(claimed, s) : s
  })

  // Drop whitespace-only text blocks left behind after clearing a heading (or
  // similar). Keep a lone empty text block so a blank page still has a caret.
  if (adopted.length <= 1) return adopted
  const pruned = adopted.filter((s) => s.type !== 'text' || s.text.trim() !== '')
  return pruned.length > 0 ? pruned : adopted
}

/**
 * Text segment with markdown images shown as previews — and markdown tables as
 * an editable grid designer — between editable text pieces. Underlying storage
 * remains a single text string with ![alt](url) / pipe-table syntax.
 */
function RichTextBlock({
  cellIndex,
  segmentIndex,
  value,
  pageContext,
  onChange,
  onBlur,
  onRemovePiece,
  placeholder,
  dragging,
}: {
  cellIndex: number
  segmentIndex: number
  value: string
  /** Whole page, handed to the AI helpers as grounding for this block. */
  pageContext: string
  onChange: (v: string) => void
  /** Editing finished — the editor re-cuts blocks at any newly typed heading. */
  onBlur?: () => void
  /** Remove an embedded image or table by its raw Markdown. */
  onRemovePiece: (raw: string) => void
  placeholder?: string
  dragging: boolean
}) {
  const pieces = splitTextWithImagesAndTables(value)

  // Latest text this block knows about — edits compose off this rather than off
  // `value`, which is still catching up while the user types.
  const textRef = useRef(value)
  useEffect(() => {
    textRef.current = value
  }, [value])

  // Rebuild full text when a piece changes
  const updatePieceText = (pieceIndex: number, nextText: string) => {
    const next = splitTextWithImagesAndTables(textRef.current).map((p, i) => {
      if (i !== pieceIndex) return p
      return { kind: 'text' as const, text: nextText }
    })
    const joined = next.map((p) => (p.kind === 'text' ? p.text : p.raw)).join('')
    textRef.current = joined
    onChange(joined)
  }

  // Swap a table piece's raw markdown for the designer's re-serialized version.
  const updatePieceRaw = (pieceIndex: number, nextRaw: string) => {
    const next = splitTextWithImagesAndTables(textRef.current).map((p, i) => {
      if (i !== pieceIndex || p.kind !== 'table') return p
      return { kind: 'table' as const, raw: nextRaw }
    })
    const joined = next.map((p) => (p.kind === 'text' ? p.text : p.raw)).join('')
    textRef.current = joined
    onChange(joined)
  }

  // If no images, single full textarea (simpler)
  if (pieces.length === 1 && pieces[0].kind === 'text') {
    return (
      <div
        className={`rich-text-block${dragging ? ' drop-active' : ''}`}
        data-drop-slot={`segment:${cellIndex}:${segmentIndex}`}
        data-drop-label="Insert image in this section"
      >
        <AiAssistField context={pageContext}>
          <SyncedTextarea
            className="hybrid-text-block"
            data-segment-index={segmentIndex}
            data-cell-index={cellIndex}
            value={value}
            rows={Math.min(28, Math.max(3, value.split('\n').length + 1))}
            onValueChange={onChange}
            onBlur={onBlur}
            spellCheck={false}
            placeholder={placeholder ?? 'Write Markdown…'}
          />
        </AiAssistField>
      </div>
    )
  }

  return (
    <div
      className={`rich-text-block has-images${dragging ? ' drop-active' : ''}`}
      data-drop-slot={`segment:${cellIndex}:${segmentIndex}`}
      data-drop-label="Insert image in this section"
    >
      {pieces.map((p, i) => {
        if (p.kind === 'image') {
          return (
            <figure key={`img-${i}-${p.url}`} className="edit-image-preview">
              <img src={withApiBase(p.url)} alt={p.alt || 'image'} loading="lazy" />
              <figcaption>
                <span className="muted sm" title={p.url}>
                  {p.alt || p.url}
                </span>
                <button
                  type="button"
                  className="btn ghost sm danger"
                  onClick={() => onRemovePiece(p.raw)}
                >
                  Remove
                </button>
              </figcaption>
            </figure>
          )
        }
        if (p.kind === 'table') {
          return (
            <MarkdownTableEditor
              key={`tbl-${i}`}
              raw={p.raw}
              onChange={(nextRaw) => updatePieceRaw(i, nextRaw)}
              onRemove={() => onRemovePiece(p.raw)}
            />
          )
        }
        if (!p.text && i > 0 && i < pieces.length - 1) return null
        const rows = Math.min(20, Math.max(2, p.text.split('\n').length + 1))
        return (
          <AiAssistField key={`t-${i}`} context={pageContext}>
            <SyncedTextarea
              className="hybrid-text-block hybrid-text-piece"
              data-segment-index={segmentIndex}
              data-cell-index={cellIndex}
              value={p.text}
              rows={rows}
              onValueChange={(next) => updatePieceText(i, next)}
              onBlur={onBlur}
              spellCheck={false}
              placeholder={i === 0 ? placeholder : '…'}
            />
          </AiAssistField>
        )
      })}
    </div>
  )
}

function InsertToolbar({
  busy,
  layoutSpec,
  onLayoutChange,
  onInsert,
  onPickImage,
  onPickPdf,
  onPickModel,
}: {
  busy: boolean
  /** Current layout as "COLSxROWS" ("1x1" = single flow). */
  layoutSpec: string
  onLayoutChange: (spec: string) => void
  onInsert: (kind: InsertKind | 'beediagram-linked') => void
  onPickImage?: () => void
  onPickPdf?: () => void
  onPickModel?: () => void
}) {
  const presets = LAYOUT_PRESETS.some((p) => p.spec === layoutSpec)
    ? LAYOUT_PRESETS
    : [...LAYOUT_PRESETS, { spec: layoutSpec, label: layoutSpec.replace('x', ' × ') }]
  return (
    <div className="insert-toolbar" role="toolbar" aria-label="Insert content">
      <span className="insert-toolbar-label">Add</span>
      <div className="insert-toolbar-group">
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('section')}>
          Section
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('subsection')}>
          Subsection
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('paragraph')}>
          Paragraph
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('bullet-list')}>
          List
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('table')}>
          Table
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onInsert('excelgrid')}
          title="Insert an Excel-style spreadsheet stored on this page"
        >
          Spreadsheet
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('callout')}>
          Callout
        </button>
      </div>
      <div className="insert-toolbar-divider" aria-hidden />
      <div className="insert-toolbar-group insert-toolbar-group--media" aria-label="Media">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onPickImage?.()}
          title="Upload image file(s) — or drag/drop / paste where you want them"
        >
          Image
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onPickPdf?.()}
          title="Upload a PDF document embed"
        >
          PDF
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onPickModel?.()}
          title="Upload a 3D model (.glb / .gltf / .obj)"
        >
          3D model
        </button>
      </div>
      <div className="insert-toolbar-divider" aria-hidden />
      <div className="insert-toolbar-group">
        <button
          type="button"
          className="btn sm primary"
          disabled={busy}
          onClick={() => onInsert('beediagram')}
          title="Insert an inline BeeDiagram (Studio by default) stored on this page"
        >
          {busy ? '…' : 'BeeDiagram'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onInsert('beediagram-linked')}
          title="Create a reusable diagram entity and embed it (Studio by default, tree-visible)"
        >
          Linked diagram
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onInsert('isometric')}
          title="Insert an inline isometric (tile-grid) diagram stored on this page"
        >
          Isometric
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('mermaid-flow')}>
          Flowchart
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('mermaid-sequence')}>
          Sequence
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => onInsert('mermaid-er')}>
          ER diagram
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onInsert('freedraw')}
          title="Insert a free-draw sketch pad stored on this page"
        >
          Free draw
        </button>
      </div>
      <div className="insert-toolbar-divider" aria-hidden />
      <div className="insert-toolbar-group insert-toolbar-group--layout">
        <label className="insert-toolbar-label" htmlFor="page-layout-picker">
          Layout
        </label>
        <select
          id="page-layout-picker"
          className="page-layout-picker"
          value={layoutSpec}
          disabled={busy}
          onChange={(e) => onLayoutChange(e.target.value)}
          title="Arrange this page's sections in a grid — drag blocks into any cell"
        >
          {presets.map((p) => (
            <option key={p.spec} value={p.spec}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function InsertGap({
  busy,
  onInsert,
  label,
  dropSlot,
  dropLabel,
  dragging,
  reorderProps,
  reorderActive,
}: {
  busy: boolean
  onInsert: (kind: InsertKind | 'beediagram-linked') => void
  label?: string
  dropSlot?: string
  dropLabel?: string
  /** An image file is being dragged over the editor. */
  dragging?: boolean
  /** Drop handlers when a block can land here; null when this gap is not a valid target. */
  reorderProps?: ReorderGapProps | null
  /** The dragged block is currently hovering this gap. */
  reorderActive?: boolean
}) {
  const [open, setOpen] = useState(false)
  const canAcceptBlock = Boolean(reorderProps)
  return (
    <div
      className={
        `insert-gap${open ? ' is-open' : ''}${dragging ? ' drop-ready' : ''}` +
        `${canAcceptBlock ? ' block-target' : ''}${reorderActive ? ' block-target-active' : ''}`
      }
      data-drop-slot={dropSlot}
      data-drop-label={dropLabel}
      {...reorderProps}
    >
      <button
        type="button"
        className="insert-gap-btn"
        aria-expanded={open}
        aria-label={label ?? 'Insert block here'}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {dragging && <span className="insert-gap-drop-label muted sm">Drop image</span>}
      {reorderActive && <span className="insert-gap-drop-label muted sm">Move here</span>}
      {open && (
        <div className="insert-gap-menu">
          {(
            [
              ['section', 'Section'],
              ['subsection', 'Subsection'],
              ['beediagram', 'BeeDiagram'],
              ['beediagram-linked', 'Linked diagram'],
              ['isometric', 'Isometric'],
              ['freedraw', 'Free draw'],
              ['excelgrid', 'Spreadsheet'],
              ['mermaid-flow', 'Flowchart'],
              ['mermaid-sequence', 'Sequence'],
              ['table', 'Table'],
              ['callout', 'Callout'],
            ] as const
          ).map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              className="btn sm"
              onClick={() => {
                setOpen(false)
                onInsert(kind)
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SourceFenceBlock({
  segment,
  onChange,
  onRemove,
}: {
  segment: FenceSegment
  onChange: (s: FenceSegment) => void
  onRemove: () => void
}) {
  const rows = Math.min(20, Math.max(4, segment.body.split('\n').length + 1))
  const [formatError, setFormatError] = useState<string | null>(null)

  const lang = segment.lang.toLowerCase()
  const formatter = lang === 'json' ? formatJson : lang === 'xml' ? formatXml : null

  // Reformatting is an explicit action: a drop keeps the file's own text, since
  // re-serializing can reorder keys, round numbers, or move significant whitespace.
  const reformat = () => {
    if (!formatter) return
    const result = formatter(segment.body)
    if (!result.ok) {
      setFormatError(result.reason)
      return
    }
    setFormatError(null)
    if (result.changed) onChange({ ...segment, body: result.text })
  }

  return (
    <div className="hybrid-fence-source">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">{segment.lang}</span>
        <span className="muted sm">source</span>
        {formatter && (
          <button
            type="button"
            className="btn sm"
            onClick={reformat}
            title={`Re-indent this ${lang.toUpperCase()} block`}
          >
            Format
          </button>
        )}
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      {formatError && <div className="banner error compact">{formatError}</div>}
      <SyncedTextarea
        className="hybrid-text-block hybrid-fence-body"
        value={segment.body}
        rows={rows}
        spellCheck={false}
        onValueChange={(body) => onChange({ ...segment, body })}
      />
    </div>
  )
}

function mediaBadge(lang: string): string {
  if (lang === 'pdf') return 'PDF'
  if (lang === 'glb' || lang === 'gltf' || lang === 'obj' || lang === 'model') return '3D'
  return lang
}

function MediaFenceBlock({
  segment,
  onChange,
  onRemove,
}: {
  segment: FenceSegment
  onChange: (s: FenceSegment) => void
  onRemove: () => void
}) {
  const [replacing, setReplacing] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = parseMediaFenceBody(segment.body)
  const rows = Math.min(12, Math.max(3, segment.body.split('\n').length + 1))

  const replaceFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    if (segment.lang === 'pdf') {
      input.accept = '.pdf,application/pdf'
    } else {
      input.accept = '.glb,.gltf,.obj,model/*'
    }
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void (async () => {
        setReplacing(true)
        setError(null)
        try {
          const result = await api.uploadFile(file)
          const lang = fenceLangFromMediaFile(file) || segment.lang
          const title = parsed.title || result.fileName || file.name
          const format = modelFormatFromExtension(extensionFromPath(result.url || file.name))
          const lines = [`title: ${title}`]
          if (lang === 'model' && format) lines.push(`format: ${format}`)
          lines.push(result.url)
          onChange({ type: 'fence', lang, body: lines.join('\n') })
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setReplacing(false)
        }
      })()
    }
    input.click()
  }

  return (
    <div className="hybrid-media-block">
      <div className="hybrid-fence-chrome">
        <div className="hybrid-fence-labels">
          <span className="inline-diagram-badge">{mediaBadge(segment.lang)}</span>
          <span className="hybrid-fence-title">{parsed.title || segment.lang}</span>
          <span className="muted sm">{segment.lang}</span>
        </div>
        <div className="hybrid-fence-actions">
          <button
            type="button"
            className="btn sm"
            onClick={() => setShowSource((v) => !v)}
            title={showSource ? 'Show embedded preview' : 'Edit fence source'}
          >
            {showSource ? 'Preview' : 'Source'}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={replacing}
            onClick={replaceFile}
            title="Upload a different file for this embed"
          >
            {replacing ? 'Uploading…' : 'Replace file'}
          </button>
          <button type="button" className="btn ghost sm danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      {showSource ? (
        <SyncedTextarea
          className="hybrid-text-block hybrid-fence-body"
          value={segment.body}
          rows={rows}
          spellCheck={false}
          onValueChange={(body) => onChange({ ...segment, body })}
          aria-label={`${segment.lang} fence source`}
        />
      ) : (
        <div className="hybrid-media-body">
          <MediaEmbed lang={segment.lang} body={segment.body} />
        </div>
      )}
    </div>
  )
}

function FreeDrawFenceBlock({
  segment,
  onBodyChange,
  onRemove,
}: {
  segment: FenceSegment
  onBodyChange: (body: string) => void
  onRemove: () => void
}) {
  return (
    <div className="hybrid-visual-diagram hybrid-freedraw-block">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">Free draw</span>
        <span className="hybrid-fence-title">Sketch pad · stored on this page</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="hybrid-visual-body hybrid-visual-body--freedraw">
        <FreeDrawCanvas source={segment.body} onChange={onBodyChange} compact />
      </div>
    </div>
  )
}

function ExcelGridFenceBlock({
  segment,
  onBodyChange,
  onRemove,
}: {
  segment: FenceSegment
  onBodyChange: (body: string) => void
  onRemove: () => void
}) {
  return (
    <div className="hybrid-visual-diagram hybrid-excelgrid-block">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">Spreadsheet</span>
        <span className="hybrid-fence-title">Excel grid · stored on this page</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="hybrid-visual-body hybrid-visual-body--excelgrid">
        <ExcelGridCanvas source={segment.body} onChange={onBodyChange} compact />
      </div>
    </div>
  )
}

/**
 * Isometric blocks in the hybrid editor: an inline ```isometric fence hosts
 * the tile-grid editor right in the page (the document lives in the fence),
 * while ```isometric-ref delegates to the kind-aware linked-diagram block.
 */
function IsometricFenceBlock({
  segment,
  bookId,
  onBodyChange,
  onRemove,
}: {
  segment: FenceSegment
  bookId?: string
  onBodyChange: (body: string) => void
  onRemove: () => void
}) {
  if (segment.lang === 'isometric-ref') {
    return <RefDiagramBlock diagramId={segment.body} bookId={bookId} onRemove={onRemove} />
  }

  return (
    <div className="hybrid-visual-diagram">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">Isometric</span>
        <span className="hybrid-fence-title">Isometric · stored on this page</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="hybrid-visual-body hybrid-visual-body--studio">
        <Suspense fallback={isometricLoading}>
          <IsometricEditor source={segment.body} onChange={onBodyChange} />
        </Suspense>
      </div>
    </div>
  )
}

function VisualFenceBlock({
  segment,
  bookId,
  onBodyChange,
  onRemove,
}: {
  segment: FenceSegment
  bookId?: string
  onBodyChange: (body: string) => void
  onRemove: () => void
}) {
  if (segment.lang === 'beediagram-ref') {
    return <RefDiagramBlock diagramId={segment.body} bookId={bookId} onRemove={onRemove} />
  }

  return (
    <div className="hybrid-visual-diagram">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">BeeDiagram</span>
        <span className="hybrid-fence-title">Studio · stored on this page</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="hybrid-visual-body hybrid-visual-body--studio">
        <BeeDiagramWorkbench source={segment.body} onChange={onBodyChange} bookId={bookId} />
      </div>
    </div>
  )
}

function RefDiagramBlock({
  diagramId,
  bookId,
  onRemove,
}: {
  diagramId: string
  bookId?: string
  onRemove: () => void
}) {
  const id = diagramId.trim().split(/\s+/)[0] ?? ''
  const [title, setTitle] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  // Which editor to host follows the entity's stored kind, not the fence
  // language — so a ref keeps working even if the diagram's kind changed.
  const [kind, setKind] = useState('beediagram')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const titleRef = useRef<string | null>(null)
  const latestRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setSource(null)
    setError(null)
    void (async () => {
      try {
        const d = await api.getDiagram(id)
        if (cancelled) return
        setTitle(d.title)
        titleRef.current = d.title
        setKind(d.kind)
        setSource(d.source)
        latestRef.current = d.source
        setDirty(false)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [id])

  const persist = useCallback(
    async (next: string) => {
      const t = titleRef.current
      if (!t) return
      setSaving(true)
      setError(null)
      try {
        const updated = await api.updateDiagram(id, { title: t, source: next })
        setSource(updated.source)
        latestRef.current = updated.source
        setSavedAt(new Date().toLocaleTimeString())
        if (latestRef.current === next) setDirty(false)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(false)
      }
    },
    [id],
  )

  const onEditorChange = (next: string) => {
    latestRef.current = next
    setSource(next)
    setDirty(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void persist(next), 1200)
  }

  if (error && !source) {
    return (
      <div className="hybrid-visual-diagram">
        <div className="banner error compact">
          Diagram ref <code>{id}</code>: {error}{' '}
          <button type="button" className="btn ghost sm" onClick={onRemove}>
            Remove block
          </button>
        </div>
      </div>
    )
  }
  if (!source) {
    return (
      <div className="hybrid-visual-diagram">
        <p className="muted sm">Loading diagram {id}…</p>
      </div>
    )
  }

  const openHref = bookId ? `/books/${bookId}/diagrams/${id}` : undefined

  return (
    <div className="hybrid-visual-diagram">
      <div className="hybrid-fence-chrome">
        <div className="hybrid-fence-labels">
          <span className="inline-diagram-badge">
            {kind === 'isometric' ? 'Isometric' : 'BeeDiagram'}
          </span>
          <span className="hybrid-fence-title">{title ?? id}</span>
          <span className="muted sm">linked · reusable</span>
        </div>
        <div className="hybrid-fence-actions">
          {saving && <span className="muted sm">Saving…</span>}
          {!saving && dirty && <span className="dirty-dot sm">Unsaved</span>}
          {!saving && !dirty && savedAt && <span className="muted sm">Saved · {savedAt}</span>}
          <button
            type="button"
            className="btn primary sm"
            disabled={saving || !dirty}
            onClick={() => {
              if (timerRef.current) clearTimeout(timerRef.current)
              void persist(latestRef.current)
            }}
          >
            {saving ? 'Saving…' : dirty ? 'Save diagram' : 'Saved'}
          </button>
          {openHref && (
            <Link className="btn ghost sm" to={openHref}>
              Full page
            </Link>
          )}
          <button type="button" className="btn ghost sm danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
      {error && <div className="banner error compact">{error}</div>}
      <div className="hybrid-visual-body hybrid-visual-body--studio">
        {kind === 'isometric' ? (
          <Suspense fallback={isometricLoading}>
            <IsometricEditor key={id} source={source} onChange={onEditorChange} />
          </Suspense>
        ) : (
          <BeeDiagramWorkbench source={source} onChange={onEditorChange} bookId={bookId} />
        )}
      </div>
    </div>
  )
}
