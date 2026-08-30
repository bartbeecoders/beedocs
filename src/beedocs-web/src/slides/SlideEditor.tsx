import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { api } from '../api'
import { useI18n, type MessageKey } from '../i18n'
import {
  cloneSlide,
  newImageElement,
  newShapeElement,
  newSlide,
  newTextElement,
  parseDeck,
  serializeDeck,
  SLIDE_LAYOUTS,
  SLIDE_THEMES,
  type Slide,
  type SlideDeckDoc,
  type SlideElement,
  type SlideLayoutId,
  type SlideShapeKind,
} from './slideModel'
import { SlideElementVisual, SlideScaled, SlideSurface } from './SlideView'

type Props = {
  /** The stored document at mount. The editor owns the deck afterwards. */
  initialSource: string
  onChange: (source: string) => void
  onPresent: (index: number) => void
}

const SHAPES: { kind: SlideShapeKind; glyph: string }[] = [
  { kind: 'rect', glyph: '▭' },
  { kind: 'rounded', glyph: '▢' },
  { kind: 'ellipse', glyph: '◯' },
  { kind: 'triangle', glyph: '△' },
  { kind: 'diamond', glyph: '◇' },
  { kind: 'star', glyph: '☆' },
  { kind: 'arrow', glyph: '→' },
  { kind: 'line', glyph: '—' },
]

/**
 * Message keys for the placeholder texts newSlide() stamps into each layout,
 * in element order — translated at insertion time so the stored document gets
 * the deck author's language (slideModel.ts stays language-neutral).
 */
const LAYOUT_STARTER_KEYS: Record<SlideLayoutId, MessageKey[]> = {
  title: ['slidesEditor.starter.title', 'slidesEditor.starter.subtitle'],
  'title-content': ['slidesEditor.starter.slideTitle', 'slidesEditor.starter.bullets'],
  'two-content': [
    'slidesEditor.starter.slideTitle',
    'slidesEditor.starter.left',
    'slidesEditor.starter.right',
  ],
  section: ['slidesEditor.starter.section'],
  blank: [],
}

/** Snap drags to a coarse grid so hand-placed boxes still line up. */
const GRID = 5
const MIN_SIZE = 20

const snap = (v: number) => Math.round(v / GRID) * GRID

type DragState =
  | { mode: 'move'; elementId: string; startX: number; startY: number; origX: number; origY: number }
  | {
      mode: 'resize'
      elementId: string
      handle: string
      startX: number
      startY: number
      orig: { x: number; y: number; w: number; h: number }
    }

/**
 * The PowerPoint-style designer: filmstrip on the left, the slide being edited
 * in the middle, a format panel on the right. Every mutation reports the
 * serialized document through `onChange`; saving is the caller's business
 * (SlideCanvas wires it into the shared auto-save).
 */
export function SlideEditor({ initialSource, onChange, onPresent }: Props) {
  const { t } = useI18n()
  const [deck, setDeck] = useState<SlideDeckDoc>(() => parseDeck(initialSource))
  const [current, setCurrent] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const [scale, setScale] = useState(0.5)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const stageRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const deckRef = useRef(deck)
  deckRef.current = deck

  const slide = deck.slides[Math.min(current, deck.slides.length - 1)]
  const selected = slide?.elements.find((el) => el.id === selectedId) ?? null

  // Fit the slide to the stage. ResizeObserver keeps it right through pane
  // resizes without a window listener that misses them.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fit = () => {
      const pad = 48
      const w = el.clientWidth - pad
      const h = el.clientHeight - pad
      if (w <= 0 || h <= 0) return
      setScale(Math.max(0.05, Math.min(w / deck.size.w, h / deck.size.h)))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [deck.size.w, deck.size.h])

  const apply = useCallback(
    (mutate: (deck: SlideDeckDoc) => SlideDeckDoc) => {
      setDeck((prev) => {
        const next = mutate(prev)
        onChange(serializeDeck(next))
        return next
      })
    },
    [onChange],
  )

  const updateSlide = useCallback(
    (index: number, mutate: (slide: Slide) => Slide) => {
      apply((d) => ({
        ...d,
        slides: d.slides.map((s, i) => (i === index ? mutate(s) : s)),
      }))
    },
    [apply],
  )

  const updateElement = useCallback(
    (id: string, patch: Partial<SlideElement>) => {
      updateSlide(current, (s) => ({
        ...s,
        elements: s.elements.map((el) => (el.id === id ? { ...el, ...patch } : el)),
      }))
    },
    [updateSlide, current],
  )

  const addElement = useCallback(
    (element: SlideElement) => {
      updateSlide(current, (s) => ({ ...s, elements: [...s.elements, element] }))
      setSelectedId(element.id)
      setEditingId(null)
    },
    [updateSlide, current],
  )

  const removeElement = useCallback(
    (id: string) => {
      updateSlide(current, (s) => ({ ...s, elements: s.elements.filter((el) => el.id !== id) }))
      setSelectedId((sel) => (sel === id ? null : sel))
      setEditingId((ed) => (ed === id ? null : ed))
    },
    [updateSlide, current],
  )

  /** Element order is z-order, so restacking is an array move. */
  const reorderElement = useCallback(
    (id: string, direction: 'front' | 'back' | 'forward' | 'backward') => {
      updateSlide(current, (s) => {
        const idx = s.elements.findIndex((el) => el.id === id)
        if (idx < 0) return s
        const elements = [...s.elements]
        const [el] = elements.splice(idx, 1)
        const target =
          direction === 'front'
            ? elements.length
            : direction === 'back'
              ? 0
              : direction === 'forward'
                ? Math.min(elements.length, idx + 1)
                : Math.max(0, idx - 1)
        elements.splice(target, 0, el)
        return { ...s, elements }
      })
    },
    [updateSlide, current],
  )

  const addSlide = useCallback(
    (layout: SlideLayoutId) => {
      const s = newSlide(layout)
      const starterKeys = LAYOUT_STARTER_KEYS[layout]
      s.elements = s.elements.map((el, i) =>
        starterKeys[i] ? { ...el, text: t(starterKeys[i]) } : el,
      )
      apply((d) => {
        const slides = [...d.slides]
        slides.splice(current + 1, 0, s)
        return { ...d, slides }
      })
      setCurrent((i) => i + 1)
      setSelectedId(null)
      setEditingId(null)
    },
    [apply, current, t],
  )

  const duplicateSlide = useCallback(() => {
    apply((d) => {
      const slides = [...d.slides]
      slides.splice(current + 1, 0, cloneSlide(slides[current]))
      return { ...d, slides }
    })
    setCurrent((i) => i + 1)
  }, [apply, current])

  const deleteSlide = useCallback(() => {
    if (deck.slides.length <= 1) {
      // A deck with no slides has nothing to select, edit or present — replace
      // the last one with a blank instead of allowing zero.
      apply((d) => ({ ...d, slides: [newSlide('blank')] }))
      setSelectedId(null)
      return
    }
    apply((d) => ({ ...d, slides: d.slides.filter((_, i) => i !== current) }))
    setCurrent((i) => Math.max(0, i - (current === deck.slides.length - 1 ? 1 : 0)))
    setSelectedId(null)
    setEditingId(null)
  }, [apply, current, deck.slides.length])

  const moveSlide = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      apply((d) => {
        const slides = [...d.slides]
        const [s] = slides.splice(from, 1)
        slides.splice(to, 0, s)
        return { ...d, slides }
      })
      setCurrent(to)
    },
    [apply],
  )

  // -- pointer interactions on the stage ------------------------------------

  const beginDrag = useCallback((e: React.MouseEvent, element: SlideElement) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(element.id)
    if (editingId && editingId !== element.id) setEditingId(null)
    dragRef.current = {
      mode: 'move',
      elementId: element.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: element.x,
      origY: element.y,
    }
  }, [editingId])

  const beginResize = useCallback(
    (e: React.MouseEvent, element: SlideElement, handle: string) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = {
        mode: 'resize',
        elementId: element.id,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        orig: { x: element.x, y: element.y, w: element.w, h: element.h },
      }
    },
    [],
  )

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = (e.clientX - drag.startX) / scale
      const dy = (e.clientY - drag.startY) / scale

      if (drag.mode === 'move') {
        updateElement(drag.elementId, {
          x: snap(drag.origX + dx),
          y: snap(drag.origY + dy),
        })
        return
      }

      const { orig, handle } = drag
      let { x, y, w, h } = orig
      if (handle.includes('e')) w = Math.max(MIN_SIZE, snap(orig.w + dx))
      if (handle.includes('s')) h = Math.max(MIN_SIZE, snap(orig.h + dy))
      if (handle.includes('w')) {
        w = Math.max(MIN_SIZE, snap(orig.w - dx))
        x = orig.x + orig.w - w
      }
      if (handle.includes('n')) {
        h = Math.max(MIN_SIZE, snap(orig.h - dy))
        y = orig.y + orig.h - h
      }
      updateElement(drag.elementId, { x, y, w, h })
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [scale, updateElement])

  // Keyboard: nudge, delete, duplicate — skipped while typing in any field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return
      }
      const el = deckRef.current.slides[current]?.elements.find((x) => x.id === selectedId)
      if (!el) return

      const nudge = e.shiftKey ? 10 : 1
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          removeElement(el.id)
          break
        case 'ArrowLeft':
          e.preventDefault()
          updateElement(el.id, { x: el.x - nudge })
          break
        case 'ArrowRight':
          e.preventDefault()
          updateElement(el.id, { x: el.x + nudge })
          break
        case 'ArrowUp':
          e.preventDefault()
          updateElement(el.id, { y: el.y - nudge })
          break
        case 'ArrowDown':
          e.preventDefault()
          updateElement(el.id, { y: el.y + nudge })
          break
        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            addElement({ ...el, id: `${el.id}-copy-${Date.now().toString(36)}`, x: el.x + 20, y: el.y + 20 })
          }
          break
        case 'Escape':
          setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, selectedId, removeElement, updateElement, addElement])

  const uploadImage = useCallback(
    async (file: File) => {
      try {
        const uploaded = await api.uploadImage(file)
        addElement(newImageElement(uploaded.url))
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      }
    },
    [addElement],
  )

  const renderElement = useCallback(
    (element: SlideElement, box: CSSProperties): ReactNode => {
      const isSelected = element.id === selectedId
      const isEditing = element.id === editingId
      return (
        <div
          key={element.id}
          className={`slide-el${isSelected ? ' selected' : ''}`}
          style={box}
          onMouseDown={(e) => {
            if (!isEditing) beginDrag(e, element)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (element.kind !== 'image') {
              setSelectedId(element.id)
              setEditingId(element.id)
            }
          }}
        >
          {isEditing ? (
            <>
              {element.kind === 'shape' && (
                <SlideElementVisual element={{ ...element, text: '' }} theme={deck.theme} />
              )}
              <textarea
                className="slide-el-editor"
                autoFocus
                value={element.text ?? ''}
                onChange={(e) => updateElement(element.id, { text: e.target.value })}
                onBlur={() => setEditingId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setEditingId(null)
                  }
                }}
                style={{
                  fontSize: element.fontSize ?? 28,
                  fontFamily: element.fontFamily ?? deck.theme.fontFamily,
                  fontWeight: element.bold ? 700 : 400,
                  fontStyle: element.italic ? 'italic' : 'normal',
                  color: element.color ?? deck.theme.color,
                  textAlign: element.align ?? 'left',
                }}
              />
            </>
          ) : (
            <SlideElementVisual element={element} theme={deck.theme} />
          )}

          {isSelected && !isEditing && (
            <>
              {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => (
                <span
                  key={handle}
                  className={`slide-handle slide-handle-${handle}`}
                  onMouseDown={(e) => beginResize(e, element, handle)}
                />
              ))}
            </>
          )}
        </div>
      )
    },
    [selectedId, editingId, deck.theme, beginDrag, beginResize, updateElement],
  )

  if (!slide) return null

  return (
    <div className="slide-editor">
      <div className="slide-toolbar">
        <div className="slide-toolbar-group">
          <button
            type="button"
            className="btn sm"
            onClick={() => addElement(newTextElement({ text: t('slidesEditor.starter.text') }))}
            title={t('slidesEditor.insertText')}
          >
            + {t('slidesEditor.text')}
          </button>
          <div className="slide-shape-menu">
            <button
              type="button"
              className="btn sm"
              onClick={() => setShapeMenuOpen((v) => !v)}
              aria-expanded={shapeMenuOpen}
            >
              + {t('slidesEditor.shapeBtn')} ▾
            </button>
            {shapeMenuOpen && (
              <div className="slide-shape-popover" onMouseLeave={() => setShapeMenuOpen(false)}>
                {SHAPES.map((s) => (
                  <button
                    key={s.kind}
                    type="button"
                    className="slide-shape-item"
                    onClick={() => {
                      addElement(newShapeElement(s.kind))
                      setShapeMenuOpen(false)
                    }}
                  >
                    {s.glyph} {t(`slidesEditor.shape.${s.kind}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => fileRef.current?.click()}
            title={t('slidesEditor.insertImage')}
          >
            + {t('slidesEditor.image')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadImage(file)
              e.target.value = ''
            }}
          />
        </div>

        <span className="slide-toolbar-sep" />

        <div className="slide-toolbar-group">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addSlide(e.target.value as SlideLayoutId)
            }}
            title={t('slidesEditor.addSlideTitle')}
          >
            <option value="">{t('slidesEditor.addSlideOption')}</option>
            {SLIDE_LAYOUTS.map((l) => (
              <option key={l.id} value={l.id}>
                {t(`slidesEditor.layout.${l.id}`)}
              </option>
            ))}
          </select>
          <button type="button" className="btn ghost sm" onClick={duplicateSlide}>
            {t('slidesEditor.duplicate')}
          </button>
          <button type="button" className="btn ghost danger sm" onClick={deleteSlide}>
            {t('slidesEditor.deleteSlide')}
          </button>
        </div>

        <span className="slide-toolbar-sep" />

        <div className="slide-toolbar-group">
          <label className="slide-inline-label">
            {t('slidesEditor.themeLabel')}
            <select
              value={SLIDE_THEMES.find((th) => th.theme.background === deck.theme.background && th.theme.color === deck.theme.color)?.id ?? ''}
              onChange={(e) => {
                const preset = SLIDE_THEMES.find((th) => th.id === e.target.value)
                if (preset) apply((d) => ({ ...d, theme: { ...preset.theme } }))
              }}
            >
              <option value="">{t('slidesEditor.themeCustom')}</option>
              {SLIDE_THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {t(`slidesEditor.theme.${th.id}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <span className="slide-toolbar-spacer" />

        <button
          type="button"
          className="btn primary sm"
          onClick={() => onPresent(current)}
          title={t('slidesEditor.presentTitle')}
        >
          ▶ {t('slidesEditor.present')}
        </button>
      </div>

      <div className="slide-editor-body">
        <div className="slide-filmstrip">
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              className={`slide-thumb${i === current ? ' active' : ''}${dragOverIndex === i ? ' drag-over' : ''}`}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/beedocs-slide', String(i))}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverIndex(i)
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverIndex(null)
                const from = Number(e.dataTransfer.getData('text/beedocs-slide'))
                if (!Number.isNaN(from)) moveSlide(from, i)
              }}
              onClick={() => {
                setCurrent(i)
                setSelectedId(null)
                setEditingId(null)
              }}
            >
              <span className="slide-thumb-index">{i + 1}</span>
              <SlideScaled deck={deck} slide={s} width={150} className="slide-thumb-preview" />
            </div>
          ))}
          <button
            type="button"
            className="slide-thumb-add"
            onClick={() => addSlide('title-content')}
            title={t('slidesEditor.addSlideThumbTitle')}
          >
            + {t('slidesEditor.newSlide')}
          </button>
        </div>

        <div
          ref={stageRef}
          className="slide-stage"
          onMouseDown={() => {
            setSelectedId(null)
            setEditingId(null)
          }}
        >
          <div
            className="slide-stage-frame"
            style={{ width: deck.size.w * scale, height: deck.size.h * scale }}
          >
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <SlideSurface deck={deck} slide={slide} renderElement={renderElement} />
            </div>
          </div>
        </div>

        <div className="slide-format-panel">
          {selected ? (
            <ElementFormat
              element={selected}
              onPatch={(patch) => updateElement(selected.id, patch)}
              onReorder={(dir) => reorderElement(selected.id, dir)}
              onDelete={() => removeElement(selected.id)}
            />
          ) : (
            <SlideFormat
              slide={slide}
              theme={deck.theme}
              onPatchSlide={(patch) => updateSlide(current, (s) => ({ ...s, ...patch }))}
              onPatchTheme={(patch) => apply((d) => ({ ...d, theme: { ...d.theme, ...patch } }))}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** Hex for <input type="color">, which rejects "none" and rgb() strings. */
function toColorInput(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function ElementFormat({
  element,
  onPatch,
  onReorder,
  onDelete,
}: {
  element: SlideElement
  onPatch: (patch: Partial<SlideElement>) => void
  onReorder: (dir: 'front' | 'back' | 'forward' | 'backward') => void
  onDelete: () => void
}) {
  const { t } = useI18n()

  return (
    <div className="slide-format">
      <h4>{t(`slidesEditor.elKind.${element.kind}`)}</h4>

      {element.kind !== 'image' && (
        <>
          <div className="slide-format-row">
            <button
              type="button"
              className={`btn sm slide-style-toggle${element.bold ? ' on' : ''}`}
              onClick={() => onPatch({ bold: !element.bold })}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className={`btn sm slide-style-toggle${element.italic ? ' on' : ''}`}
              onClick={() => onPatch({ italic: !element.italic })}
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className={`btn sm slide-style-toggle${element.underline ? ' on' : ''}`}
              onClick={() => onPatch({ underline: !element.underline })}
            >
              <span style={{ textDecoration: 'underline' }}>U</span>
            </button>
            <input
              type="number"
              className="slide-num"
              min={8}
              max={200}
              value={element.fontSize ?? 28}
              onChange={(e) => onPatch({ fontSize: Number(e.target.value) || 28 })}
              title={t('slidesEditor.fontSize')}
            />
          </div>

          <div className="slide-format-row">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={`btn sm slide-style-toggle${(element.align ?? 'left') === a ? ' on' : ''}`}
                onClick={() => onPatch({ align: a })}
                title={t(`slidesEditor.align.${a}`)}
              >
                {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
              </button>
            ))}
            {(['top', 'middle', 'bottom'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`btn sm slide-style-toggle${(element.valign ?? 'top') === v ? ' on' : ''}`}
                onClick={() => onPatch({ valign: v })}
                title={t(`slidesEditor.valign.${v}`)}
              >
                {v === 'top' ? '⤒' : v === 'middle' ? '⇕' : '⤓'}
              </button>
            ))}
          </div>

          <label className="slide-format-field">
            <span>{t('slidesEditor.textColor')}</span>
            <input
              type="color"
              value={toColorInput(element.color, '#1f2430')}
              onChange={(e) => onPatch({ color: e.target.value })}
            />
          </label>
        </>
      )}

      {element.kind === 'shape' && (
        <>
          <label className="slide-format-field">
            <span>{t('slidesEditor.fill')}</span>
            <span className="slide-format-inline">
              <input
                type="color"
                value={toColorInput(element.fill, '#f59e0b')}
                disabled={element.fill === 'none'}
                onChange={(e) => onPatch({ fill: e.target.value })}
              />
              <label className="slide-check">
                <input
                  type="checkbox"
                  checked={element.fill === 'none'}
                  onChange={(e) => onPatch({ fill: e.target.checked ? 'none' : '#f59e0b' })}
                />
                {t('common.none')}
              </label>
            </span>
          </label>
          <label className="slide-format-field">
            <span>{t('slidesEditor.outline')}</span>
            <span className="slide-format-inline">
              <input
                type="color"
                value={toColorInput(element.stroke, '#1f2430')}
                disabled={!element.stroke || element.stroke === 'none'}
                onChange={(e) => onPatch({ stroke: e.target.value })}
              />
              <input
                type="number"
                className="slide-num"
                min={0}
                max={30}
                value={element.stroke && element.stroke !== 'none' ? (element.strokeWidth ?? 2) : 0}
                onChange={(e) => {
                  const width = Number(e.target.value) || 0
                  onPatch(
                    width <= 0
                      ? { stroke: 'none', strokeWidth: 0 }
                      : { stroke: element.stroke && element.stroke !== 'none' ? element.stroke : '#1f2430', strokeWidth: width },
                  )
                }}
                title={t('slidesEditor.outlineWidth')}
              />
            </span>
          </label>
        </>
      )}

      <label className="slide-format-field">
        <span>{t('slidesEditor.opacity')}</span>
        <input
          type="range"
          min={10}
          max={100}
          value={element.opacity ?? 100}
          onChange={(e) => onPatch({ opacity: Number(e.target.value) })}
        />
      </label>

      <label className="slide-format-field">
        <span>{t('slidesEditor.rotation')}</span>
        <input
          type="number"
          className="slide-num"
          min={-180}
          max={180}
          value={element.rotation ?? 0}
          onChange={(e) => onPatch({ rotation: Number(e.target.value) || 0 })}
        />
      </label>

      <div className="slide-format-grid">
        {(['x', 'y', 'w', 'h'] as const).map((key) => (
          <label key={key} className="slide-format-field compact">
            <span>{key.toUpperCase()}</span>
            <input
              type="number"
              className="slide-num"
              value={Math.round(element[key])}
              onChange={(e) => onPatch({ [key]: Number(e.target.value) || 0 })}
            />
          </label>
        ))}
      </div>

      <div className="slide-format-row">
        <button type="button" className="btn ghost sm" onClick={() => onReorder('front')} title={t('slidesEditor.bringToFront')}>
          ⬆⬆
        </button>
        <button type="button" className="btn ghost sm" onClick={() => onReorder('forward')} title={t('slidesEditor.bringForward')}>
          ⬆
        </button>
        <button type="button" className="btn ghost sm" onClick={() => onReorder('backward')} title={t('slidesEditor.sendBackward')}>
          ⬇
        </button>
        <button type="button" className="btn ghost sm" onClick={() => onReorder('back')} title={t('slidesEditor.sendToBack')}>
          ⬇⬇
        </button>
      </div>

      <button type="button" className="btn ghost danger sm" onClick={onDelete}>
        {t('slidesEditor.deleteElement')}
      </button>

      <p className="muted sm">{t('slidesEditor.elementHint')}</p>
    </div>
  )
}

function SlideFormat({
  slide,
  theme,
  onPatchSlide,
  onPatchTheme,
}: {
  slide: Slide
  theme: { background: string; color: string; accent: string; fontFamily: string }
  onPatchSlide: (patch: Partial<Slide>) => void
  onPatchTheme: (patch: Partial<{ background: string; color: string }>) => void
}) {
  const { t } = useI18n()
  return (
    <div className="slide-format">
      <h4>{t('slidesEditor.slide')}</h4>
      <label className="slide-format-field">
        <span>{t('slidesEditor.background')}</span>
        <span className="slide-format-inline">
          <input
            type="color"
            value={toColorInput(slide.background, toColorInput(theme.background, '#ffffff'))}
            onChange={(e) => onPatchSlide({ background: e.target.value })}
          />
          {slide.background && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => onPatchSlide({ background: undefined })}
              title={t('slidesEditor.resetBackgroundTitle')}
            >
              {t('common.reset')}
            </button>
          )}
        </span>
      </label>

      <label className="slide-format-field">
        <span>{t('slidesEditor.themeBackground')}</span>
        <input
          type="color"
          value={toColorInput(theme.background, '#ffffff')}
          onChange={(e) => onPatchTheme({ background: e.target.value })}
        />
      </label>
      <label className="slide-format-field">
        <span>{t('slidesEditor.themeText')}</span>
        <input
          type="color"
          value={toColorInput(theme.color, '#1f2430')}
          onChange={(e) => onPatchTheme({ color: e.target.value })}
        />
      </label>

      <label className="slide-format-field column">
        <span>{t('slidesEditor.speakerNotes')}</span>
        <textarea
          className="slide-notes"
          rows={6}
          placeholder={t('slidesEditor.notesPlaceholder')}
          value={slide.notes ?? ''}
          onChange={(e) => onPatchSlide({ notes: e.target.value || undefined })}
        />
      </label>

      <p className="muted sm">{t('slidesEditor.slideHint')}</p>
    </div>
  )
}
