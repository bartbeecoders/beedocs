import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useI18n } from '../i18n'
import { useAutoSave } from '../hooks/useAutoSave'
import type { Attachment, WordDocument, WordPageSetup } from '../types'
import { dragHasFiles, collectDroppedFiles } from '../media/attachments'
import {
  geometryOf,
  MARGIN_PRESETS,
  PAPER_SIZES,
  PAGE_GAP_PX,
  usesInches,
  type PageGeometry,
} from './wordModel'
import { paginate, pageOfOffset, stackHeight } from './paginate'
import { UndoHistory, restoreSelection, saveSelection } from './undo'
import { prepareForEdit, sanitizePastedHtml, plainTextToHtml, serializeBody } from './serialize'
import * as cmd from './commands'
import { Ribbon, type RibbonTab, type SelState } from './Ribbon'
import '../styles/word.css'

type Props = {
  attachmentId: string
  canEdit: boolean
  /** The attachment after each successful save — size and timestamp change. */
  onSaved?: (saved: Attachment) => void
  /** Provided by the canvas so its toolbar can offer the same actions. */
  onDownload?: () => void
}

const ZOOM_KEY = 'beedocs-word-zoom'
const LAYOUT_KEY = 'beedocs-word-layout'
const RULER_KEY = 'beedocs-word-ruler'

const EMPTY_SEL: SelState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  subscript: false,
  superscript: false,
  bullets: false,
  numbering: false,
  align: 'left',
  style: 'Normal',
  font: '',
  size: 11,
  link: false,
  inTable: false,
  image: false,
}

function readStored<T>(key: string, fallback: T, parse: (v: string) => T | null): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return parse(raw) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * A Word-like editor over a .docx attachment.
 *
 * The body is one contentEditable flow of the HTML the server derived from the
 * document; the ribbon issues formatting commands against the live selection;
 * print layout is drawn by pushing blocks past page boundaries rather than by
 * splitting the DOM (see paginate.ts). Saves go back as HTML and the server
 * rewrites the document part inside the original package. There is no
 * document model in between — which is what keeps typing native-fast even in
 * long documents.
 */
export function WordEditor({ attachmentId, canEdit, onSaved, onDownload }: Props) {
  const { t } = useI18n()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const history = useRef(new UndoHistory())
  const savedRange = useRef<Range | null>(null)
  const version = useRef(0)
  const paginateTimer = useRef<number | null>(null)

  const [doc, setDoc] = useState<WordDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState<WordPageSetup>({ width: 11906, height: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440 })
  const [zoom, setZoomState] = useState(() => readStored(ZOOM_KEY, 1, (v) => (Number(v) >= 0.3 && Number(v) <= 3 ? Number(v) : null)))
  const [layout, setLayoutState] = useState<'print' | 'web'>(() => readStored(LAYOUT_KEY, 'print', (v) => (v === 'web' ? 'web' : 'print')))
  const [ruler, setRulerState] = useState(() => readStored(RULER_KEY, true, (v) => v !== '0'))
  const [pages, setPages] = useState(1)
  const [caretPage, setCaretPage] = useState(1)
  const [words, setWords] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [tab, setTab] = useState<RibbonTab>(canEdit ? 'home' : 'view')
  const [sel, setSel] = useState<SelState>(EMPTY_SEL)
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false })
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const selectedImage = useRef<HTMLImageElement | null>(null)

  const geom = useMemo(() => geometryOf(page), [page])
  const printLayout = layout === 'print'

  // ---------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    setDoc(null)
    setError(null)
    setDirty(false)
    setSavedAt(null)
    setSaveError(null)
    api
      .getWordDocument(attachmentId)
      .then((d) => {
        if (cancelled) return
        setDoc(d)
        setPage(d.page)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [attachmentId])

  const schedulePaginate = useCallback(() => {
    if (paginateTimer.current != null) return
    paginateTimer.current = window.requestAnimationFrame(() => {
      paginateTimer.current = null
      const body = bodyRef.current
      if (!body) return
      const count = paginate(body, geom, zoom, printLayout)
      setPages(count)
      setWords(cmd.countWords(body))
    })
  }, [geom, zoom, printLayout])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !doc) return
    body.innerHTML = prepareForEdit(doc.html)
    history.current.reset(body.innerHTML, null)
    setHistoryState({ canUndo: false, canRedo: false })
    version.current = 0
    schedulePaginate()
    // Pictures arriving later change block heights.
    const onLoad = (e: Event) => {
      if ((e.target as HTMLElement)?.tagName === 'IMG') schedulePaginate()
    }
    body.addEventListener('load', onLoad, true)
    // The document's fonts may still be loading on first paint; metrics change
    // when they land, and page boundaries with them.
    let cancelled = false
    document.fonts?.ready.then(() => {
      if (!cancelled) schedulePaginate()
    })
    return () => {
      cancelled = true
      body.removeEventListener('load', onLoad, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded document
  }, [doc])

  useEffect(() => {
    schedulePaginate()
  }, [schedulePaginate])

  // ---------------------------------------------------------------------
  // Change tracking, history, save
  // ---------------------------------------------------------------------

  const recordHistory = useCallback((kind: 'typing' | 'command') => {
    const body = bodyRef.current
    if (!body) return
    history.current.record(body.innerHTML, saveSelection(body), kind)
    setHistoryState({ canUndo: history.current.canUndo, canRedo: history.current.canRedo })
  }, [])

  const markChanged = useCallback(
    (kind: 'typing' | 'command') => {
      version.current += 1
      setDirty(true)
      recordHistory(kind)
      schedulePaginate()
    },
    [recordHistory, schedulePaginate],
  )

  const restoreEntry = useCallback(
    (entry: { html: string; sel: ReturnType<typeof saveSelection> } | null) => {
      const body = bodyRef.current
      if (!entry || !body) return
      body.innerHTML = entry.html
      restoreSelection(body, entry.sel)
      version.current += 1
      setDirty(true)
      setHistoryState({ canUndo: history.current.canUndo, canRedo: history.current.canRedo })
      schedulePaginate()
    },
    [schedulePaginate],
  )

  const undo = useCallback(() => restoreEntry(history.current.undo()), [restoreEntry])
  const redo = useCallback(() => restoreEntry(history.current.redo()), [restoreEntry])

  const save = useCallback(async () => {
    const body = bodyRef.current
    if (!body || !doc || !canEdit) return
    const at = version.current
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await api.saveWordDocument(attachmentId, { html: serializeBody(body), page })
      if (version.current === at) setDirty(false)
      setSavedAt(new Date().toLocaleTimeString())
      onSaved?.(saved)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [attachmentId, doc, canEdit, page, onSaved])

  useAutoSave({ enabled: canEdit && !!doc, dirty, save })

  // ---------------------------------------------------------------------
  // Selection state for the ribbon
  // ---------------------------------------------------------------------

  const refreshSelection = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const range = cmd.currentRange(body)
    if (!range) return
    savedRange.current = range.cloneRange()
    const block = cmd.selectedBlocks(body)[0]
    if (block && printLayout) {
      const y = (block.getBoundingClientRect().top - body.getBoundingClientRect().top) / zoom - geom.mTop
      setCaretPage(pageOfOffset(Math.max(0, y), geom))
    }
    const img = selectedImage.current
    if (img && !(range.collapsed === false && range.intersectsNode(img))) {
      const still = range.startContainer === img.parentNode && range.startOffset <= Array.prototype.indexOf.call(img.parentNode!.childNodes, img) + 1 && range.endOffset >= Array.prototype.indexOf.call(img.parentNode!.childNodes, img)
      if (!still) {
        img.removeAttribute('data-bee-selected')
        selectedImage.current = null
      }
    }
    setSel({
      bold: cmd.queryState('bold'),
      italic: cmd.queryState('italic'),
      underline: cmd.queryState('underline'),
      strike: cmd.queryState('strikeThrough'),
      subscript: cmd.queryState('subscript'),
      superscript: cmd.queryState('superscript'),
      bullets: cmd.queryState('insertUnorderedList'),
      numbering: cmd.queryState('insertOrderedList'),
      align: cmd.currentAlignment(body),
      style: cmd.currentParagraphStyle(body),
      font: cmd.currentFontFamily(body),
      size: cmd.currentFontSize(body),
      link: !!cmd.currentLink(body),
      inTable: !!cmd.currentTableCell(body),
      image: !!selectedImage.current,
    })
  }, [geom, zoom, printLayout])

  useEffect(() => {
    let raf: number | null = null
    const handler = () => {
      if (raf != null) return
      raf = window.requestAnimationFrame(() => {
        raf = null
        refreshSelection()
      })
    }
    document.addEventListener('selectionchange', handler)
    return () => {
      document.removeEventListener('selectionchange', handler)
      if (raf != null) cancelAnimationFrame(raf)
    }
  }, [refreshSelection])

  /** Ribbon widgets that take focus (selects, inputs) hand it back through here. */
  const focusEditor = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    if (document.activeElement !== body) body.focus({ preventScroll: true })
    if (!cmd.currentRange(body) && savedRange.current) cmd.setRange(savedRange.current)
  }, [])

  const run = useCallback(
    (fn: () => void) => {
      if (!canEdit) return
      focusEditor()
      fn()
      markChanged('command')
      refreshSelection()
    },
    [canEdit, focusEditor, markChanged, refreshSelection],
  )

  // ---------------------------------------------------------------------
  // Editor events
  // ---------------------------------------------------------------------

  const onInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const native = e.nativeEvent as InputEvent
      const type = native.inputType ?? ''
      // Keystrokes coalesce into one undo step; a space, an Enter, a paste or a
      // formatting change starts a new one, so Ctrl+Z steps back a word at a
      // time the way Word does rather than a whole burst of typing.
      const isKeystroke =
        type === 'insertText' || type === 'insertCompositionText' || type === 'deleteContentBackward' || type === 'deleteContentForward'
      const boundary = type === 'insertText' && typeof native.data === 'string' && /^\s$/.test(native.data)
      markChanged(isKeystroke && !boundary ? 'typing' : 'command')
    },
    [markChanged],
  )

  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      const native = e.nativeEvent as InputEvent
      if (native.inputType === 'historyUndo') {
        e.preventDefault()
        undo()
      } else if (native.inputType === 'historyRedo') {
        e.preventDefault()
        redo()
      }
    },
    [undo, redo],
  )

  const insertPictureFile = useCallback(
    (file: File) => {
      const body = bodyRef.current
      if (!body || !file.type.startsWith('image/')) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const probe = new Image()
        probe.onload = () => {
          run(() => {
            const img = cmd.insertImage(body, src, probe.naturalWidth || 400, probe.naturalHeight || 300, file.name, geom.contentW)
            img.setAttribute('data-resized', '1')
          })
        }
        probe.src = src
      }
      reader.readAsDataURL(file)
    },
    [run, geom.contentW],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!canEdit) return
      const dt = e.clipboardData
      const image = Array.from(dt.files).find((f) => f.type.startsWith('image/'))
      if (image && !dt.getData('text/html')) {
        e.preventDefault()
        insertPictureFile(image)
        return
      }
      const html = dt.getData('text/html')
      const text = dt.getData('text/plain')
      if (!html && !text) return
      e.preventDefault()
      const fragment = html ? sanitizePastedHtml(html) : plainTextToHtml(text)
      cmd.exec('insertHTML', fragment)
      markChanged('command')
    },
    [canEdit, insertPictureFile, markChanged],
  )

  const promptLink = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    focusEditor()
    const existing = cmd.currentLink(body)
    const url = window.prompt(t('word.linkPrompt'), existing?.getAttribute('href') ?? 'https://')
    if (url == null) return
    run(() => {
      if (!url.trim()) cmd.exec('unlink')
      else if (existing) existing.setAttribute('href', url.trim())
      else cmd.insertLink(body, url.trim())
    })
  }, [focusEditor, run, t])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const body = bodyRef.current
      if (!body) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
        return
      }
      if (mod && !e.altKey && e.key.toLowerCase() === 'f' && !e.shiftKey) {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (!canEdit) return
      if (mod && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        e.preventDefault()
        if (e.key.toLowerCase() === 'y' || e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        run(() => cmd.insertPageBreak(body))
        return
      }
      if (e.key === 'Tab') {
        const cell = cmd.currentTableCell(body)
        if (cell) {
          e.preventDefault()
          cmd.tableMoveCell(cell, e.shiftKey)
          markChanged('command')
          return
        }
        const block = cmd.selectedBlocks(body)[0]
        e.preventDefault()
        if (block?.tagName === 'LI') run(() => cmd.indent(body, e.shiftKey ? -1 : 1))
        else if (e.shiftKey) run(() => cmd.indent(body, -1))
        else {
          cmd.exec('insertText', '\t')
          markChanged('typing')
        }
        return
      }
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        promptLink()
        return
      }
      if (mod && !e.altKey && !e.shiftKey && (e.key === 'e' || e.key === 'j' || e.key === 'r')) {
        e.preventDefault()
        run(() => cmd.setAlignment(body, e.key === 'e' ? 'center' : e.key === 'j' ? 'justify' : 'right'))
        return
      }
      if (mod && !e.altKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        run(() => cmd.setFontSize(body, Math.max(1, cmd.currentFontSize(body) + (e.key === ']' ? 1 : -1))))
        return
      }
      if (mod && e.altKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault()
        run(() => cmd.applyParagraphStyle(body, `Heading${e.key}`))
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        run(() => cmd.applyParagraphStyle(body, 'Normal'))
        return
      }
      if (e.key === 'Escape') {
        setFindOpen(false)
        const img = selectedImage.current
        if (img) {
          img.removeAttribute('data-bee-selected')
          selectedImage.current = null
          refreshSelection()
        }
      }
    },
    [canEdit, save, undo, redo, run, markChanged, refreshSelection, promptLink],
  )

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      const prev = selectedImage.current
      if (prev && prev !== target) {
        prev.removeAttribute('data-bee-selected')
        selectedImage.current = null
      }
      if (target.tagName === 'IMG' && canEdit) {
        target.setAttribute('data-bee-selected', '1')
        selectedImage.current = target as HTMLImageElement
        const range = document.createRange()
        range.selectNode(target)
        cmd.setRange(range)
        setTab('picture')
      } else if (prev && tab === 'picture') {
        setTab('home')
      }
      const link = target.closest('a')
      if (link && (e.ctrlKey || e.metaKey)) {
        const href = link.getAttribute('href')
        if (href && /^https?:/i.test(href)) window.open(href, '_blank', 'noopener')
      }
      refreshSelection()
    },
    [canEdit, tab, refreshSelection],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!canEdit || !dragHasFiles(e.dataTransfer)) return
      const files = collectDroppedFiles(e.dataTransfer).filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      // Pictures dropped on the page are embedded; anything else bubbles up to
      // the canvas, where a drop means "replace this file".
      e.preventDefault()
      e.stopPropagation()
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
      if (range) cmd.setRange(range)
      for (const f of files) insertPictureFile(f)
      // The canvas around the editor lit up as a "replace file" target when the
      // drag entered it; the stopped drop never reaches it, so tell it the drag ended.
      window.dispatchEvent(new Event('dragend'))
    },
    [canEdit, insertPictureFile],
  )

  // ---------------------------------------------------------------------
  // Actions the ribbon calls
  // ---------------------------------------------------------------------


  const setZoom = useCallback((z: number) => {
    const clamped = Math.min(3, Math.max(0.3, Math.round(z * 100) / 100))
    setZoomState(clamped)
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped))
    } catch {
      /* private mode */
    }
  }, [])

  const setLayout = useCallback((l: 'print' | 'web') => {
    setLayoutState(l)
    try {
      localStorage.setItem(LAYOUT_KEY, l)
    } catch {
      /* private mode */
    }
  }, [])

  const setRuler = useCallback((on: boolean) => {
    setRulerState(on)
    try {
      localStorage.setItem(RULER_KEY, on ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [])

  const zoomToWidth = useCallback(() => {
    const ws = workspaceRef.current
    if (!ws) return
    setZoom((ws.clientWidth - 64) / geom.pageW)
  }, [geom.pageW, setZoom])

  const updatePage = useCallback(
    (next: WordPageSetup) => {
      setPage(next)
      version.current += 1
      setDirty(true)
    },
    [],
  )

  const print = useCallback(() => {
    const body = bodyRef.current
    if (!body || !doc) return
    const win = window.open('', '_blank')
    if (!win) return
    const mm = (twips: number) => `${(twips / 1440) * 25.4}mm`
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>` +
        `@page{size:${mm(page.width)} ${mm(page.height)};margin:${mm(page.top)} ${mm(page.right)} ${mm(page.bottom)} ${mm(page.left)}}` +
        `body{margin:0}` +
        `.docx-body{white-space:pre-wrap;word-wrap:break-word}.docx-body p,.docx-body h1,.docx-body h2,.docx-body h3,.docx-body h4,.docx-body h5,.docx-body h6{margin:0}` +
        `.docx-body table{border-collapse:collapse}.docx-body table[data-borders="1"] td,.docx-body table[data-borders="1"] th{border:1px solid #000;padding:0 5.4pt}` +
        `.docx-body hr[data-break="page"]{border:0;height:0;page-break-after:always}.docx-body hr:not([data-break]){border:0;border-bottom:1px solid #a0a0a0}` +
        `.docx-body img{max-width:100%}.docx-raw{display:inline}` +
        doc.css +
        `</style></head><body><div class="docx-body">${serializeBody(body)}</div></body></html>`,
    )
    win.document.close()
    win.focus()
    setTimeout(() => {
      win.print()
    }, 250)
  }, [doc, page])

  const download = useCallback(() => {
    if (onDownload) onDownload()
    else {
      const a = document.createElement('a')
      a.href = api.attachmentUrl(attachmentId)
      a.download = ''
      a.click()
    }
  }, [attachmentId, onDownload])

  const pasteFromClipboard = useCallback(async () => {
    focusEditor()
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text()
          cmd.exec('insertHTML', sanitizePastedHtml(html))
          markChanged('command')
          return
        }
        const image = item.types.find((ty) => ty.startsWith('image/'))
        if (image) {
          const blob = await item.getType(image)
          insertPictureFile(new File([blob], 'pasted.png', { type: image }))
          return
        }
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text()
          cmd.exec('insertHTML', plainTextToHtml(text))
          markChanged('command')
          return
        }
      }
    } catch {
      window.alert(t('word.pasteHint'))
    }
  }, [focusEditor, insertPictureFile, markChanged, t])

  const findNext = useCallback(
    (backwards: boolean) => {
      const body = bodyRef.current
      if (!body || !findQuery) return
      const w = window as Window & { find?: (q: string, cs: boolean, back: boolean, wrap: boolean) => boolean }
      body.focus({ preventScroll: true })
      const found = w.find?.(findQuery, false, backwards, true)
      if (!found) {
        // Wrap by restarting from the top.
        const range = document.createRange()
        range.selectNodeContents(body)
        range.collapse(!backwards)
        cmd.setRange(range)
        w.find?.(findQuery, false, backwards, true)
      }
      refreshSelection()
    },
    [findQuery, refreshSelection],
  )

  const pictureApi = useMemo(
    () => ({
      size: (pct: number) => {
        const img = selectedImage.current
        if (!img) return
        run(() => {
          const ratio = (img.naturalHeight || img.height) / Math.max(img.naturalWidth || img.width, 1)
          const w = Math.round((geom.contentW * pct) / 100)
          img.width = w
          img.height = Math.round(w * ratio)
          img.setAttribute('data-resized', '1')
        })
      },
      reset: () => {
        const img = selectedImage.current
        if (!img) return
        run(() => {
          img.width = img.naturalWidth || img.width
          img.height = img.naturalHeight || img.height
          if (img.width > geom.contentW) {
            img.height = Math.round((img.height * geom.contentW) / img.width)
            img.width = Math.round(geom.contentW)
          }
          img.setAttribute('data-resized', '1')
        })
      },
      remove: () => {
        const img = selectedImage.current
        if (!img) return
        run(() => {
          img.remove()
          selectedImage.current = null
        })
        setTab('home')
      },
    }),
    [run, geom.contentW],
  )

  const tableApi = useMemo(
    () => ({
      rowAbove: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableInsertRow(c, 'above') }),
      rowBelow: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableInsertRow(c, 'below') }),
      colLeft: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableInsertColumn(c, 'left') }),
      colRight: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableInsertColumn(c, 'right') }),
      deleteRow: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableDeleteRow(c) }),
      deleteColumn: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableDeleteColumn(c) }),
      deleteTable: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableDelete(c) }),
      toggleBorders: () => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableToggleBorders(c) }),
      shade: (color: string | null) => run(() => { const c = cmd.currentTableCell(bodyRef.current!); if (c) cmd.tableSetCellShading(c, color) }),
    }),
    [run],
  )

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (error) {
    return <div className="canvas-message error">{error}</div>
  }
  if (!doc) {
    return <div className="canvas-message muted">{t('word.loading')}</div>
  }

  const body = bodyRef
  const stackH = printLayout ? stackHeight(pages, geom) : undefined
  const status = saving
    ? t('word.saving')
    : saveError
      ? saveError
      : dirty
        ? t('word.unsaved')
        : savedAt
          ? t('word.savedAt', { time: savedAt })
          : t('word.saved')

  return (
    <div className={`word-editor${canEdit ? '' : ' word-readonly'}`}>
      <style>{doc.css}</style>
      <Ribbon
        tab={tab}
        setTab={setTab}
        canEdit={canEdit}
        sel={sel}
        canUndo={historyState.canUndo}
        canRedo={historyState.canRedo}
        page={page}
        layout={layout}
        zoom={zoom}
        ruler={ruler}
        findOpen={findOpen}
        onFindToggle={() => setFindOpen((v) => !v)}
        api={{
          undo,
          redo,
          save: () => void save(),
          download,
          print,
          paste: () => void pasteFromClipboard(),
          cut: () => run(() => cmd.exec('cut')),
          copy: () => {
            focusEditor()
            cmd.exec('copy')
          },
          toggle: (c) => run(() => cmd.exec(c)),
          fontFamily: (f) => run(() => cmd.setFontFamily(body.current!, f)),
          fontSize: (pt) => run(() => cmd.setFontSize(body.current!, pt)),
          growFont: () => run(() => cmd.setFontSize(body.current!, nextSize(cmd.currentFontSize(body.current!), 1))),
          shrinkFont: () => run(() => cmd.setFontSize(body.current!, nextSize(cmd.currentFontSize(body.current!), -1))),
          textColor: (c) => run(() => cmd.setTextColor(body.current!, c)),
          highlight: (c) => run(() => cmd.setHighlight(body.current!, c)),
          clearFormatting: () => run(() => cmd.clearFormatting(body.current!)),
          list: (ordered) => run(() => cmd.exec(ordered ? 'insertOrderedList' : 'insertUnorderedList')),
          indent: (d) => run(() => cmd.indent(body.current!, d)),
          align: (a) => run(() => cmd.setAlignment(body.current!, a)),
          lineSpacing: (v) => run(() => cmd.setLineSpacing(body.current!, v)),
          paragraphSpacing: (which, pt) => run(() => cmd.setParagraphSpacing(body.current!, which, pt)),
          style: (id) => run(() => cmd.applyParagraphStyle(body.current!, id)),
          insertTable: (r, c) => run(() => cmd.insertTable(body.current!, r, c)),
          insertPicture: () => fileInputRef.current?.click(),
          link: promptLink,
          unlink: () => run(() => cmd.exec('unlink')),
          pageBreak: () => run(() => cmd.insertPageBreak(body.current!)),
          horizontalRule: () => run(() => cmd.insertHorizontalRule(body.current!)),
          insertText: (text) => run(() => cmd.exec('insertText', text)),
          margins: (id) => {
            const preset = MARGIN_PRESETS.find((m) => m.id === id)
            if (preset) updatePage({ ...page, top: preset.top, right: preset.right, bottom: preset.bottom, left: preset.left })
          },
          orientation: (o) => {
            const w = Math.min(page.width, page.height)
            const h = Math.max(page.width, page.height)
            updatePage({ ...page, width: o === 'portrait' ? w : h, height: o === 'portrait' ? h : w })
          },
          paper: (id) => {
            const paper = PAPER_SIZES.find((p) => p.id === id)
            if (!paper) return
            const landscape = page.width > page.height
            updatePage({ ...page, width: landscape ? paper.height : paper.width, height: landscape ? paper.width : paper.height })
          },
          layout: setLayout,
          zoom: setZoom,
          zoomToWidth,
          ruler: setRuler,
          picture: pictureApi,
          table: tableApi,
        }}
      />
      {findOpen && (
        <div className="word-findbar">
          <input
            autoFocus
            value={findQuery}
            placeholder={t('word.findPlaceholder')}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                findNext(e.shiftKey)
              } else if (e.key === 'Escape') setFindOpen(false)
            }}
          />
          <button type="button" className="btn sm ghost" onClick={() => findNext(true)} title={t('word.findPrev')}>
            ↑
          </button>
          <button type="button" className="btn sm ghost" onClick={() => findNext(false)} title={t('word.findNext')}>
            ↓
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setFindOpen(false)} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      )}
      {ruler && printLayout && <Ruler geom={geom} zoom={zoom} inches={usesInches(page)} />}
      <div ref={workspaceRef} className={`word-workspace ${printLayout ? 'is-print' : 'is-web'}`}>
        <div
          className="docx-pages"
          style={{
            width: printLayout ? geom.pageW : undefined,
            minHeight: stackH,
            zoom,
          }}
        >
          {printLayout &&
            Array.from({ length: pages }, (_, i) => (
              <div
                key={i}
                className="docx-page-bg"
                style={{ top: i * (geom.pageH + PAGE_GAP_PX), height: geom.pageH }}
                aria-hidden
              />
            ))}
          <div
            ref={bodyRef}
            className="docx-body"
            contentEditable={canEdit}
            suppressContentEditableWarning
            spellCheck
            style={
              printLayout
                ? { padding: `${geom.mTop}px ${geom.mRight}px ${geom.mBottom}px ${geom.mLeft}px`, minHeight: geom.pageH }
                : undefined
            }
            onInput={onInput}
            onBeforeInput={onBeforeInput}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onClick={onClick}
            onDrop={onDrop}
            onDragOver={(e) => {
              if (canEdit && dragHasFiles(e.dataTransfer)) {
                const items = Array.from(e.dataTransfer.items ?? [])
                if (items.length && items.every((i) => i.type.startsWith('image/'))) {
                  e.preventDefault()
                  e.stopPropagation()
                }
              }
            }}
          />
        </div>
      </div>
      <div className="word-statusbar">
        <span>{printLayout ? t('word.pageOf', { page: String(caretPage), pages: String(pages) }) : t('word.webLayout')}</span>
        <span>{t('word.words', { count: String(words) })}</span>
        {doc.hasHeaderFooter && <span className="muted" title={t('word.headerFooterNote')}>⚠ {t('word.headerFooterShort')}</span>}
        <span className={`word-status-save${saveError ? ' error' : ''}`}>{canEdit ? status : t('word.readOnly')}</span>
        <span className="word-status-spacer" />
        <button type="button" className="word-status-btn" onClick={() => setLayout('print')} aria-pressed={printLayout} title={t('word.printLayout')}>
          ▤
        </button>
        <button type="button" className="word-status-btn" onClick={() => setLayout('web')} aria-pressed={!printLayout} title={t('word.webLayout')}>
          ▭
        </button>
        <button type="button" className="word-status-btn" onClick={() => setZoom(zoom - 0.1)} aria-label="−">
          −
        </button>
        <input
          type="range"
          min={30}
          max={300}
          value={Math.round(zoom * 100)}
          onChange={(e) => setZoom(Number(e.target.value) / 100)}
          aria-label={t('word.zoom')}
        />
        <button type="button" className="word-status-btn" onClick={() => setZoom(zoom + 0.1)} aria-label="+">
          +
        </button>
        <button type="button" className="word-status-btn word-status-zoom" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) insertPictureFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

const SIZE_STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

function nextSize(current: number, direction: 1 | -1): number {
  if (direction > 0) return SIZE_STEPS.find((s) => s > current) ?? Math.min(current + 4, 400)
  const smaller = SIZE_STEPS.filter((s) => s < current)
  return smaller.length ? smaller[smaller.length - 1] : Math.max(1, current - 1)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Word's horizontal ruler: margins shaded, ticks every ¼ in or ½ cm, numbers each unit. */
function Ruler({ geom, zoom, inches }: { geom: PageGeometry; zoom: number; inches: boolean }) {
  const unit = inches ? 96 : 96 / 2.54
  const minor = inches ? unit / 4 : unit / 2
  const width = geom.pageW
  const ticks: { x: number; major: boolean; label?: number }[] = []
  const origin = geom.mLeft
  for (let x = origin; x <= width - geom.mRight + 0.5; x += minor) {
    const n = Math.round((x - origin) / unit)
    const major = Math.abs((x - origin) / unit - n) < 0.001
    ticks.push({ x, major, label: major && n > 0 ? n : undefined })
  }
  for (let x = origin - minor; x >= 0; x -= minor) {
    const n = Math.round((origin - x) / unit)
    const major = Math.abs((origin - x) / unit - n) < 0.001
    ticks.push({ x, major, label: major && n > 0 ? n : undefined })
  }
  return (
    <div className="word-ruler-host" style={{ zoom }}>
      <svg className="word-ruler" width={width} height={20} viewBox={`0 0 ${width} 20`} aria-hidden>
        <rect x={0} y={4} width={width} height={12} className="word-ruler-margin" />
        <rect x={geom.mLeft} y={4} width={geom.contentW} height={12} className="word-ruler-content" />
        {ticks.map((tick, i) =>
          tick.label != null ? (
            <text key={i} x={tick.x} y={13.5} textAnchor="middle" className="word-ruler-label">
              {tick.label}
            </text>
          ) : (
            <line key={i} x1={tick.x} x2={tick.x} y1={tick.major ? 7 : 9} y2={tick.major ? 13 : 11} className="word-ruler-tick" />
          ),
        )}
      </svg>
    </div>
  )
}
