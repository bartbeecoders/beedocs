import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { useBlockReorder } from '../hooks/useBlockReorder'
import { useImageIntake, type ImageIntakeContext } from '../hooks/useImageIntake'
import {
  isExcelGridFenceLang,
  isFreedrawFenceLang,
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
import { outlineId } from '../pageOutline'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { AiAssistBar, AiAssistField } from './AiAssist'
import { BeeDiagramWorkbench } from './BeeDiagramWorkbench'
import { ExcelGridCanvas } from './ExcelGridCanvas'
import { FreeDrawCanvas } from './FreeDrawCanvas'
import { MarkdownTableEditor } from './MarkdownTableEditor'
import { MediaEmbed, parseMediaFenceBody } from './media/MediaEmbed'
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

type InsertAt = 'end' | number // number = insert before segment index

type ReorderGapProps = {
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

/**
 * Page editor that keeps prose as Markdown textareas but renders BeeDiagram
 * fences as the full visual canvas editor — so you edit diagrams on the page.
 * Markdown images show as previews in edit mode; drops insert at the pointer.
 */
export function HybridPageEditor({ content, onChange, bookId, pageId, placeholder }: Props) {
  const lastEmitted = useRef(content)
  const rootRef = useRef<HTMLDivElement>(null)
  const [segments, setSegments] = useState<ContentSegment[]>(() => splitMarkdownSegments(content))
  const [busy, setBusy] = useState(false)
  const [insertError, setInsertError] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)
  /** A page/book is being dragged over the editor from the library tree. */
  const [linkDragging, setLinkDragging] = useState(false)
  const { renameInTree } = useWorkspace()

  useEffect(() => {
    if (content === lastEmitted.current) return
    setSegments(splitMarkdownSegments(content))
    lastEmitted.current = content
  }, [content])

  const emit = useCallback(
    (next: ContentSegment[]) => {
      setSegments(next)
      const md = joinMarkdownSegments(next)
      lastEmitted.current = md
      onChange(md)
    },
    [onChange],
  )

  const segmentsRef = useRef(segments)
  segmentsRef.current = segments

  const updateSegment = useCallback(
    (index: number, patch: ContentSegment) => {
      // Read through the ref: a handler created in an earlier render must not
      // rebuild the document from that render's (now stale) segment list.
      emit(segmentsRef.current.map((s, i) => (i === index ? keepBlockId(s, patch) : s)))
    },
    [emit],
  )

  const removeSegment = useCallback(
    (index: number) => {
      emit(mergeAdjacentText(segmentsRef.current.filter((_, i) => i !== index)))
    },
    [emit],
  )

  /**
   * Move a block to sit before position `to` in the current list.
   *
   * `to` is a gap index, so dropping into the gap directly after the dragged
   * block is a no-op rather than an off-by-one shuffle.
   */
  const moveSegment = useCallback(
    (from: number, to: number) => {
      const list = segmentsRef.current
      if (from < 0 || from >= list.length) return
      if (to === from || to === from + 1) return

      const next = [...list]
      const [moved] = next.splice(from, 1)
      if (!moved) return
      next.splice(to > from ? to - 1 : to, 0, moved)
      emit(mergeAdjacentText(next))
    },
    [emit],
  )

  /**
   * Re-cut the blocks once a text block is done being edited.
   *
   * Splitting while someone types would tear the textarea out from under the
   * cursor, so a heading typed into an existing block only becomes its own
   * block — and so only becomes draggable — when focus leaves.
   */
  const normalizeBlocks = useCallback(() => {
    const list = segmentsRef.current
    const next = mergeAdjacentText(list)
    const unchanged =
      next.length === list.length &&
      next.every((s, i) => {
        const prev = list[i]
        return s.type === 'text' && prev.type === 'text'
          ? s.text === prev.text
          : s.type === 'fence' && prev.type === 'fence' && s.lang === prev.lang && s.body === prev.body
      })
    if (unchanged) return
    emit(next)
  }, [emit])

  const reorder = useBlockReorder({ onMove: moveSegment, containerRef: rootRef })

  const updateFenceBody = useCallback(
    (index: number, body: string) => {
      const list = segmentsRef.current
      const seg = list[index]
      if (!seg || seg.type !== 'fence') return
      emit(list.map((s, i) => (i === index ? keepBlockId(s, { ...seg, body }) : s)))
    },
    [emit],
  )

  const insertAt = useCallback(
    (at: InsertAt, extra: ContentSegment[]) => {
      const list = segmentsRef.current
      let next: ContentSegment[]
      if (at === 'end') {
        next = [...list, ...extra]
      } else {
        next = [...list.slice(0, at), ...extra, ...list.slice(at)]
      }
      next = mergeAdjacentText(next)
      emit(next)
    },
    [emit],
  )

  const handleInsert = useCallback(
    async (kind: InsertKind | 'beediagram-linked', at: InsertAt = 'end') => {
      setInsertError(null)
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
          insertAt(at, segmentsForLinkedDiagram(diagram.id, title))
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
        // Always prepend — new sections belong at the top of the page.
        insertAt(0, segmentsForInsert(kind, { title }))
        return
      }

      insertAt(at, segmentsForInsert(kind))
    },
    [bookId, insertAt, pageId, renameInTree],
  )

  /** Insert image markdown into a specific text segment at a character offset. */
  const insertImagesIntoTextSegment = useCallback(
    (segmentIndex: number, offset: number, images: UploadedImage[]) => {
      const list = segmentsRef.current
      const seg = list[segmentIndex]
      if (!seg || seg.type !== 'text') {
        const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
        insertAt(segmentIndex, [{ type: 'text', text: `\n\n${parts}\n\n` }])
        return
      }
      let text = seg.text
      let off = offset
      for (const img of images) {
        const snip = markdownImageSnippet(img.url, img.fileName)
        text = insertMarkdownAt(text, off, snip)
        off += snip.length + 4 // rough advance past padding
      }
      emit(list.map((s, i) => (i === segmentIndex ? keepBlockId(s, { type: 'text', text }) : s)))
    },
    [emit, insertAt],
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
        const slot = el.getAttribute('data-drop-slot') || ''
        // before:N → insert new text block before segment N
        if (slot.startsWith('before:')) {
          const idx = Number(slot.slice('before:'.length))
          const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
          insertAt(Number.isFinite(idx) ? idx : 'end', [{ type: 'text', text: `\n\n${parts}\n\n` }])
          setDropHint(null)
          return
        }
        // segment:N → insert into that text segment
        if (slot.startsWith('segment:')) {
          const idx = Number(slot.slice('segment:'.length))
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
          if (Number.isFinite(idx)) {
            insertImagesIntoTextSegment(idx, offset, images)
            setDropHint(null)
            return
          }
        }
      }

      // Focused textarea fallback (paste)
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement && active.dataset.segmentIndex != null) {
        const idx = Number(active.dataset.segmentIndex)
        const offset = active.selectionStart ?? active.value.length
        if (Number.isFinite(idx)) {
          insertImagesIntoTextSegment(idx, offset, images)
          setDropHint(null)
          return
        }
      }

      // Default: end of document
      const parts = images.map((img) => markdownImageSnippet(img.url, img.fileName)).join('\n\n')
      insertAt('end', [{ type: 'text', text: `\n\n${parts}\n\n` }])
      setDropHint(null)
    },
    [insertAt, insertImagesIntoTextSegment],
  )

  const { dragging, uploading, pickFiles } = useImageIntake({
    enabled: true,
    targetRef: rootRef,
    paste: true,
    onUploaded: insertImagesFromContext,
    onError: (msg) => setInsertError(msg),
  })

  const pickMedia = useCallback(
    (kind: 'pdf' | 'model', at: InsertAt = 'end') => {
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
            insertAt(at, mediaFenceFromUpload(result.url, result.fileName || file.name, lang))
          } catch (e) {
            setInsertError(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy(false)
          }
        })()
      }
      input.click()
    },
    [insertAt],
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
            insertAt('end', mediaFenceFromUpload(result.url, result.fileName || file.name, lang))
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
  }, [insertAt])

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
      const slot = (e.target as Element | null)?.closest?.('[data-drop-slot]')
      const raw = slot?.getAttribute('data-drop-slot') ?? ''
      const at: InsertAt = raw.startsWith('before:') ? Number(raw.slice(7)) : 'end'
      const target: InsertAt = typeof at === 'number' && Number.isFinite(at) ? at : 'end'

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
  }, [insertAt])

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

      const slot = (e.target as Element | null)?.closest?.('[data-drop-slot]')
      const raw = slot?.getAttribute('data-drop-slot') ?? ''
      const at: InsertAt = raw.startsWith('before:') ? Number(raw.slice(7)) : 'end'
      const target: InsertAt = typeof at === 'number' && Number.isFinite(at) ? at : 'end'

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
  }, [insertAt])

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
      if (slotEl) {
        const slot = slotEl.getAttribute('data-drop-slot') || ''
        if (slot.startsWith('before:')) {
          const idx = Number(slot.slice('before:'.length))
          insertAt(Number.isFinite(idx) ? idx : 'end', [{ type: 'text', text: `\n\n${snippet}\n\n` }])
          return
        }
        if (slot.startsWith('segment:')) {
          const idx = Number(slot.slice('segment:'.length))
          const seg = segmentsRef.current[idx]
          if (Number.isFinite(idx) && seg?.type === 'text') {
            const ta =
              slotEl instanceof HTMLTextAreaElement
                ? slotEl
                : (slotEl.querySelector('textarea') as HTMLTextAreaElement | null)
            const offset = ta ? textOffsetFromPointer(ta, e.clientY) : seg.text.length
            const text = insertInlineMarkdownAt(seg.text, offset, snippet)
            emit(
              segmentsRef.current.map((s, i) =>
                i === idx ? keepBlockId(s, { type: 'text', text }) : s,
              ),
            )
            return
          }
        }
      }
      insertAt('end', [{ type: 'text', text: `\n\n${snippet}\n\n` }])
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
  }, [emit, insertAt])

  /** Remove one embedded piece (image or table) from a text segment by its raw Markdown. */
  const removePieceFromSegment = useCallback(
    (segmentIndex: number, raw: string) => {
      const list = segmentsRef.current
      const seg = list[segmentIndex]
      if (!seg || seg.type !== 'text') return
      const text = seg.text.replace(raw, '').replace(/\n{3,}/g, '\n\n')
      emit(list.map((s, i) => (i === segmentIndex ? keepBlockId(s, { type: 'text', text }) : s)))
    },
    [emit],
  )

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
        onInsert={(k) => void handleInsert(k, 'end')}
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
      </p>

      <InsertGap
        busy={busy}
        onInsert={(k) => void handleInsert(k, 0)}
        label="Insert at top"
        dropSlot="before:0"
        dropLabel="Insert image at top of page"
        dragging={dragging}
        gapIndex={0}
        reorderProps={reorder.gapProps(0)}
        reorderActive={reorder.overGap === 0}
      />

      {segments.map((seg, index) => (
        <div
          key={blockId(seg)}
          id={outlineId(index)}
          className={`hybrid-block-wrap${reorder.dragIndex === index ? ' is-dragging' : ''}`}
          data-block-index={index}
          data-outline-id={outlineId(index)}
        >
          <BlockHandle
            index={index}
            total={segments.length}
            label={blockLabel(seg)}
            onDragStart={(e) => reorder.start(index, e)}
            onDragEnd={reorder.end}
            onMove={(to) => moveSegment(index, to)}
            onRemove={() => removeSegment(index)}
          />
          {seg.type === 'text' ? (
            <RichTextBlock
              segmentIndex={index}
              value={seg.text}
              pageContext={content}
              placeholder={index === 0 ? placeholder : 'Continue Markdown…'}
              dragging={dragging || linkDragging}
              onChange={(text) => updateSegment(index, { type: 'text', text })}
              onBlur={normalizeBlocks}
              onRemovePiece={(raw) => removePieceFromSegment(index, raw)}
            />
          ) : isMediaFenceLang(seg.lang) ? (
            <MediaFenceBlock
              segment={seg}
              onChange={(next) => updateSegment(index, next)}
              onRemove={() => removeSegment(index)}
            />
          ) : isFreedrawFenceLang(seg.lang) ? (
            <FreeDrawFenceBlock
              segment={seg}
              onBodyChange={(body) => updateFenceBody(index, body)}
              onRemove={() => removeSegment(index)}
            />
          ) : isExcelGridFenceLang(seg.lang) ? (
            <ExcelGridFenceBlock
              segment={seg}
              onBodyChange={(body) => updateFenceBody(index, body)}
              onRemove={() => removeSegment(index)}
            />
          ) : isVisualFenceLang(seg.lang) ? (
            <VisualFenceBlock
              segment={seg}
              bookId={bookId}
              onBodyChange={(body) => updateFenceBody(index, body)}
              onRemove={() => removeSegment(index)}
            />
          ) : (
            <SourceFenceBlock
              segment={seg}
              onChange={(next) => updateSegment(index, next)}
              onRemove={() => removeSegment(index)}
            />
          )}
          <InsertGap
            busy={busy}
            onInsert={(k) => void handleInsert(k, index + 1)}
            dropSlot={`before:${index + 1}`}
            dropLabel="Insert image here"
            dragging={dragging}
            gapIndex={index + 1}
            reorderProps={reorder.gapProps(index + 1)}
            reorderActive={reorder.overGap === index + 1}
          />
        </div>
      ))}
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
 *
 * Reordering hangs off a handle rather than the block itself so that dragging
 * inside a textarea still selects text, which is what anyone editing prose
 * expects a drag to do.
 */
function BlockHandle({
  index,
  total,
  label,
  onDragStart,
  onDragEnd,
  onMove,
  onRemove,
}: {
  index: number
  total: number
  label: string
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  /** Target gap index. */
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const canMoveUp = index > 0
  const canMoveDown = index < total - 1
  // Keep at least one block so the page always has somewhere to type.
  const canRemove = total > 1

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
            onMove(index - 1)
          } else if (e.key === 'ArrowDown' && canMoveDown) {
            e.preventDefault()
            onMove(index + 2)
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && canRemove) {
            e.preventDefault()
            onRemove()
          }
        }}
        aria-label={`Move block: ${label}. Drag, or use arrow up and down.`}
        title="Drag to reorder · ↑ / ↓ to move"
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
  segmentIndex,
  value,
  pageContext,
  onChange,
  onBlur,
  onRemovePiece,
  placeholder,
  dragging,
}: {
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
        data-drop-slot={`segment:${segmentIndex}`}
        data-drop-label="Insert image in this section"
      >
        <AiAssistField context={pageContext}>
          <SyncedTextarea
            className="hybrid-text-block"
            data-segment-index={segmentIndex}
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
      data-drop-slot={`segment:${segmentIndex}`}
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
  onInsert,
  onPickImage,
  onPickPdf,
  onPickModel,
}: {
  busy: boolean
  onInsert: (kind: InsertKind | 'beediagram-linked') => void
  onPickImage?: () => void
  onPickPdf?: () => void
  onPickModel?: () => void
}) {
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
  gapIndex,
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
  /** Gap index (0 = before first block) — used for hit-testing attributes. */
  gapIndex?: number
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
      data-block-gap={gapIndex != null ? String(gapIndex) : undefined}
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
          <span className="inline-diagram-badge">BeeDiagram</span>
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
        <BeeDiagramWorkbench source={source} onChange={onEditorChange} bookId={bookId} />
      </div>
    </div>
  )
}
