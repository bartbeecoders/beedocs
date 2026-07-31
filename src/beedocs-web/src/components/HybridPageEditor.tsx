import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { withApiBase } from '../basePath'
import { useImageIntake, type ImageIntakeContext } from '../hooks/useImageIntake'
import {
  isMediaFenceLang,
  isVisualFenceLang,
  joinMarkdownSegments,
  splitMarkdownSegments,
  type ContentSegment,
  type FenceSegment,
} from '../markdownFences'
import {
  insertMarkdownAt,
  isImageFile,
  markdownImageSnippet,
  splitTextWithImages,
  textOffsetFromPointer,
  type UploadedImage,
} from '../media/imageIntake'
import {
  extensionFromPath,
  modelFormatFromExtension,
} from '../media/mediaKinds'
import { segmentsForInsert, segmentsForLinkedDiagram, type InsertKind } from '../pageBlocks'
import { useWorkspace } from '../workspace/WorkspaceContext'
import { BeeDiagramEditor } from './BeeDiagramEditor'
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

type Props = {
  content: string
  onChange: (next: string) => void
  bookId?: string
  pageId?: string
  placeholder?: string
}

type InsertAt = 'end' | number // number = insert before segment index

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
      emit(segmentsRef.current.map((s, i) => (i === index ? patch : s)))
    },
    [emit],
  )

  const removeSegment = useCallback(
    (index: number) => {
      emit(segmentsRef.current.filter((_, i) => i !== index))
    },
    [emit],
  )

  const updateFenceBody = useCallback(
    (index: number, body: string) => {
      const list = segmentsRef.current
      const seg = list[index]
      if (!seg || seg.type !== 'fence') return
      emit(list.map((s, i) => (i === index ? { ...s, body } : s)))
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
        insertAt(at, segmentsForInsert(kind, { title }))
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
      emit(list.map((s, i) => (i === segmentIndex ? { type: 'text', text } : s)))
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

  const removeImageFromSegment = useCallback(
    (segmentIndex: number, raw: string) => {
      const list = segmentsRef.current
      const seg = list[segmentIndex]
      if (!seg || seg.type !== 'text') return
      const text = seg.text.replace(raw, '').replace(/\n{3,}/g, '\n\n')
      emit(list.map((s, i) => (i === segmentIndex ? { type: 'text', text } : s)))
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
      {dragging && dropHint && (
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
      <p className="hybrid-hint muted sm">
        Drop or paste images <strong>where you want them</strong> — they preview in edit mode. Use Add for
        sections, diagrams, <strong>PDF</strong>, and <strong>3D models</strong> (or drop <code>.pdf</code> /{' '}
        <code>.glb</code> / <code>.obj</code> files).
      </p>

      <InsertGap
        busy={busy}
        onInsert={(k) => void handleInsert(k, 0)}
        label="Insert at top"
        dropSlot="before:0"
        dropLabel="Insert image at top of page"
        dragging={dragging}
      />

      {segments.map((seg, index) => (
        <div key={`wrap-${index}`} className="hybrid-block-wrap">
          {seg.type === 'text' ? (
            <RichTextBlock
              segmentIndex={index}
              value={seg.text}
              placeholder={index === 0 ? placeholder : 'Continue Markdown…'}
              dragging={dragging}
              onChange={(text) => updateSegment(index, { type: 'text', text })}
              onRemoveImage={(raw) => removeImageFromSegment(index, raw)}
            />
          ) : isMediaFenceLang(seg.lang) ? (
            <MediaFenceBlock
              segment={seg}
              onChange={(next) => updateSegment(index, next)}
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
          />
        </div>
      ))}
    </div>
  )
}

function mergeAdjacentText(segments: ContentSegment[]): ContentSegment[] {
  const out: ContentSegment[] = []
  for (const s of segments) {
    const prev = out[out.length - 1]
    if (s.type === 'text' && prev?.type === 'text') {
      out[out.length - 1] = { type: 'text', text: prev.text + s.text }
    } else {
      out.push(s)
    }
  }
  return out
}

/**
 * Text segment with markdown images shown as previews between editable text pieces.
 * Underlying storage remains a single text string with ![alt](url) syntax.
 */
function RichTextBlock({
  segmentIndex,
  value,
  onChange,
  onRemoveImage,
  placeholder,
  dragging,
}: {
  segmentIndex: number
  value: string
  onChange: (v: string) => void
  onRemoveImage: (raw: string) => void
  placeholder?: string
  dragging: boolean
}) {
  const pieces = splitTextWithImages(value)

  // Latest text this block knows about — edits compose off this rather than off
  // `value`, which is still catching up while the user types.
  const textRef = useRef(value)
  useEffect(() => {
    textRef.current = value
  }, [value])

  // Rebuild full text when a piece changes
  const updatePieceText = (pieceIndex: number, nextText: string) => {
    const next = splitTextWithImages(textRef.current).map((p, i) => {
      if (i !== pieceIndex) return p
      return { kind: 'text' as const, text: nextText }
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
        <SyncedTextarea
          className="hybrid-text-block"
          data-segment-index={segmentIndex}
          value={value}
          rows={Math.min(28, Math.max(3, value.split('\n').length + 1))}
          onValueChange={onChange}
          spellCheck={false}
          placeholder={placeholder ?? 'Write Markdown…'}
        />
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
                  onClick={() => onRemoveImage(p.raw)}
                >
                  Remove
                </button>
              </figcaption>
            </figure>
          )
        }
        if (!p.text && i > 0 && i < pieces.length - 1) return null
        const rows = Math.min(20, Math.max(2, p.text.split('\n').length + 1))
        return (
          <SyncedTextarea
            key={`t-${i}`}
            className="hybrid-text-block hybrid-text-piece"
            data-segment-index={segmentIndex}
            value={p.text}
            rows={rows}
            onValueChange={(next) => updatePieceText(i, next)}
            spellCheck={false}
            placeholder={i === 0 ? placeholder : '…'}
          />
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
          title="Inline visual diagram stored in this page"
        >
          {busy ? '…' : 'BeeDiagram'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => onInsert('beediagram-linked')}
          title="Create a diagram entity and embed it (reusable, tree-visible)"
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
}: {
  busy: boolean
  onInsert: (kind: InsertKind | 'beediagram-linked') => void
  label?: string
  dropSlot?: string
  dropLabel?: string
  dragging?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`insert-gap${open ? ' is-open' : ''}${dragging ? ' drop-ready' : ''}`}
      data-drop-slot={dropSlot}
      data-drop-label={dropLabel}
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
      {open && (
        <div className="insert-gap-menu">
          {(
            [
              ['section', 'Section'],
              ['subsection', 'Subsection'],
              ['beediagram', 'BeeDiagram'],
              ['beediagram-linked', 'Linked diagram'],
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
  return (
    <div className="hybrid-fence-source">
      <div className="hybrid-fence-chrome">
        <span className="inline-diagram-badge">{segment.lang}</span>
        <span className="muted sm">source</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
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
        <span className="hybrid-fence-title">Visual editor · stored on this page</span>
        <button type="button" className="btn ghost sm danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="hybrid-visual-body">
        <BeeDiagramEditor source={segment.body} onChange={onBodyChange} />
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
      <div className="hybrid-visual-body">
        <BeeDiagramEditor source={source} onChange={onEditorChange} />
      </div>
    </div>
  )
}
