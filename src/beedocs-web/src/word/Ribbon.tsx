import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { WordPageSetup } from '../types'
import {
  FONT_FAMILIES,
  FONT_SIZES,
  HIGHLIGHT_COLORS,
  MARGIN_PRESETS,
  PAPER_SIZES,
  STANDARD_COLORS,
  STYLE_GALLERY,
  SYMBOLS,
  THEME_COLORS,
  marginIdOf,
  paperIdOf,
} from './wordModel'

export type RibbonTab = 'file' | 'home' | 'insert' | 'layout' | 'view' | 'picture' | 'table'

export type SelState = {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  subscript: boolean
  superscript: boolean
  bullets: boolean
  numbering: boolean
  align: 'left' | 'center' | 'right' | 'justify'
  style: string
  font: string
  size: number
  link: boolean
  inTable: boolean
  image: boolean
}

export type EditorApi = {
  undo: () => void
  redo: () => void
  save: () => void
  download: () => void
  print: () => void
  paste: () => void
  cut: () => void
  copy: () => void
  toggle: (command: string) => void
  fontFamily: (family: string) => void
  fontSize: (pt: number) => void
  growFont: () => void
  shrinkFont: () => void
  textColor: (color: string | null) => void
  highlight: (color: string | null) => void
  clearFormatting: () => void
  list: (ordered: boolean) => void
  indent: (direction: 1 | -1) => void
  align: (a: 'left' | 'center' | 'right' | 'justify') => void
  lineSpacing: (v: number | null) => void
  paragraphSpacing: (which: 'before' | 'after', pt: number | null) => void
  style: (id: string) => void
  insertTable: (rows: number, cols: number) => void
  insertPicture: () => void
  link: () => void
  unlink: () => void
  pageBreak: () => void
  horizontalRule: () => void
  insertText: (text: string) => void
  margins: (presetId: string) => void
  orientation: (o: 'portrait' | 'landscape') => void
  paper: (id: string) => void
  layout: (l: 'print' | 'web') => void
  zoom: (z: number) => void
  zoomToWidth: () => void
  ruler: (on: boolean) => void
  picture: { size: (pct: number) => void; reset: () => void; remove: () => void }
  table: {
    rowAbove: () => void
    rowBelow: () => void
    colLeft: () => void
    colRight: () => void
    deleteRow: () => void
    deleteColumn: () => void
    deleteTable: () => void
    toggleBorders: () => void
    shade: (color: string | null) => void
  }
}

type Props = {
  tab: RibbonTab
  setTab: (t: RibbonTab) => void
  canEdit: boolean
  sel: SelState
  canUndo: boolean
  canRedo: boolean
  page: WordPageSetup
  layout: 'print' | 'web'
  zoom: number
  ruler: boolean
  findOpen: boolean
  onFindToggle: () => void
  api: EditorApi
}

/** Keeps the editor's selection: a ribbon click must not move focus. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

/**
 * The Word ribbon — tabs of grouped commands over the editor.
 *
 * Buttons act on the live selection, so every one of them prevents the
 * default mousedown: focusing a button would collapse the selection the
 * command is meant to format. Widgets that must take focus (the font pickers)
 * hand it back through the editor's `focusEditor` before applying.
 */
export function Ribbon(props: Props) {
  const { tab, setTab, canEdit, sel, api } = props
  const { t } = useI18n()

  const tabs: { id: RibbonTab; label: string }[] = canEdit
    ? [
        { id: 'file', label: t('word.tabFile') },
        { id: 'home', label: t('word.tabHome') },
        { id: 'insert', label: t('word.tabInsert') },
        { id: 'layout', label: t('word.tabLayout') },
        { id: 'view', label: t('word.tabView') },
      ]
    : [
        { id: 'file', label: t('word.tabFile') },
        { id: 'view', label: t('word.tabView') },
      ]
  if (canEdit && sel.image) tabs.push({ id: 'picture', label: t('word.tabPicture') })
  if (canEdit && sel.inTable) tabs.push({ id: 'table', label: t('word.tabTable') })
  const activeTab = tabs.some((x) => x.id === tab) ? tab : tabs[canEdit ? 1 : 1].id

  return (
    <div className="word-ribbon">
      <div className="word-ribbon-tabs" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={activeTab === x.id}
            className={`word-ribbon-tab${activeTab === x.id ? ' active' : ''}${x.id === 'picture' || x.id === 'table' ? ' contextual' : ''}`}
            onMouseDown={keepFocus}
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </button>
        ))}
        <span className="word-ribbon-spacer" />
        {canEdit && (
          <div className="word-quick">
            <RibbonButton icon="↶" label={t('word.undo')} shortcut="Ctrl+Z" onClick={api.undo} disabled={!props.canUndo} />
            <RibbonButton icon="↷" label={t('word.redo')} shortcut="Ctrl+Y" onClick={api.redo} disabled={!props.canRedo} />
            <RibbonButton icon="💾" label={t('word.save')} shortcut="Ctrl+S" onClick={api.save} />
          </div>
        )}
      </div>
      <div className="word-ribbon-body" role="tabpanel">
        {activeTab === 'file' && <FileTab {...props} />}
        {activeTab === 'home' && <HomeTab {...props} />}
        {activeTab === 'insert' && <InsertTab {...props} />}
        {activeTab === 'layout' && <LayoutTab {...props} />}
        {activeTab === 'view' && <ViewTab {...props} />}
        {activeTab === 'picture' && <PictureTab {...props} />}
        {activeTab === 'table' && <TableTab {...props} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="word-group">
      <div className="word-group-items">{children}</div>
      <div className="word-group-label">{label}</div>
    </div>
  )
}

function RibbonButton({
  icon,
  label,
  shortcut,
  onClick,
  active,
  disabled,
  large,
  text,
  className,
}: {
  icon: ReactNode
  label: string
  shortcut?: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  large?: boolean
  /** Show the label next to the icon (large buttons show it under). */
  text?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={`word-btn${large ? ' large' : ''}${active ? ' active' : ''}${text ? ' with-text' : ''}${className ? ` ${className}` : ''}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      <span className="word-btn-icon" aria-hidden>
        {icon}
      </span>
      {(large || text) && <span className="word-btn-text">{label}</span>}
    </button>
  )
}

/** A button that opens a panel below it; closes on outside click or Escape. */
function Dropdown({
  icon,
  label,
  children,
  large,
  text,
  swatch,
}: {
  icon: ReactNode
  label: string
  children: (close: () => void) => ReactNode
  large?: boolean
  text?: boolean
  swatch?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const host = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    // The ribbon scrolls horizontally, so the panel is positioned against the
    // viewport rather than clipped inside it.
    const rect = host.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 2, left: Math.min(rect.left, window.innerWidth - 260) })
    const onDown = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="word-dropdown" ref={host}>
      <button
        type="button"
        className={`word-btn${large ? ' large' : ''}${text ? ' with-text' : ''}${open ? ' active' : ''}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onMouseDown={keepFocus}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="word-btn-icon" aria-hidden>
          {icon}
          {swatch !== undefined && <span className="word-swatch-bar" style={{ background: swatch ?? 'transparent' }} />}
        </span>
        {(large || text) && <span className="word-btn-text">{label}</span>}
        <span className="word-btn-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="word-dropdown-panel" style={pos} onMouseDown={keepFocus}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function ColorPanel({
  onPick,
  close,
  automaticLabel,
  highlight,
}: {
  onPick: (color: string | null) => void
  close: () => void
  automaticLabel: string
  highlight?: boolean
}) {
  const { t } = useI18n()
  const pick = (c: string | null) => {
    onPick(c)
    close()
  }
  if (highlight) {
    return (
      <div className="word-colors">
        <div className="word-color-grid five">
          {HIGHLIGHT_COLORS.map((c) => (
            <button key={c.hex} type="button" className="word-color" style={{ background: c.hex }} title={c.name} onClick={() => pick(c.hex)} />
          ))}
        </div>
        <button type="button" className="word-color-auto" onClick={() => pick(null)}>
          {automaticLabel}
        </button>
      </div>
    )
  }
  return (
    <div className="word-colors">
      <button type="button" className="word-color-auto" onClick={() => pick(null)}>
        <span className="word-color small" style={{ background: 'currentColor' }} /> {automaticLabel}
      </button>
      <div className="word-color-heading">{t('word.themeColors')}</div>
      <div className="word-color-grid ten">
        {THEME_COLORS.flat().map((c, i) => (
          <button key={i} type="button" className="word-color" style={{ background: c }} title={c} onClick={() => pick(c)} />
        ))}
      </div>
      <div className="word-color-heading">{t('word.standardColors')}</div>
      <div className="word-color-grid ten">
        {STANDARD_COLORS.map((c) => (
          <button key={c} type="button" className="word-color" style={{ background: c }} title={c} onClick={() => pick(c)} />
        ))}
      </div>
    </div>
  )
}

function TableSizePicker({ onPick, close }: { onPick: (rows: number, cols: number) => void; close: () => void }) {
  const { t } = useI18n()
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const rows = 8
  const cols = 10
  return (
    <div className="word-table-picker">
      <div className="word-table-grid" style={{ gridTemplateColumns: `repeat(${cols}, 16px)` }} onMouseLeave={() => setHover({ r: 0, c: 0 })}>
        {Array.from({ length: rows * cols }, (_, i) => {
          const r = Math.floor(i / cols) + 1
          const c = (i % cols) + 1
          const on = r <= hover.r && c <= hover.c
          return (
            <button
              key={i}
              type="button"
              className={`word-table-cell${on ? ' on' : ''}`}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => {
                onPick(r, c)
                close()
              }}
              aria-label={`${r} × ${c}`}
            />
          )
        })}
      </div>
      <div className="word-table-size">{hover.r > 0 ? `${hover.c} × ${hover.r}` : t('word.tableSize')}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function FileTab({ api, canEdit }: Props) {
  const { t } = useI18n()
  return (
    <>
      <Group label={t('word.tabFile')}>
        {canEdit && <RibbonButton large icon="💾" label={t('word.save')} shortcut="Ctrl+S" onClick={api.save} />}
        <RibbonButton large icon="⬇" label={t('word.download')} onClick={api.download} />
        <RibbonButton large icon="🖨" label={t('word.print')} onClick={api.print} />
      </Group>
      {canEdit && <div className="word-file-hint muted sm">{t('word.saveHint')}</div>}
    </>
  )
}

function HomeTab({ api, sel, onFindToggle, findOpen }: Props) {
  const { t } = useI18n()
  const fontValue = FONT_FAMILIES.includes(sel.font) ? sel.font : sel.font || 'Calibri'
  return (
    <>
      <Group label={t('word.clipboard')}>
        <RibbonButton large icon="📋" label={t('word.paste')} shortcut="Ctrl+V" onClick={api.paste} />
        <div className="word-stack">
          <RibbonButton icon="✂" text label={t('word.cut')} shortcut="Ctrl+X" onClick={api.cut} />
          <RibbonButton icon="⧉" text label={t('word.copy')} shortcut="Ctrl+C" onClick={api.copy} />
        </div>
      </Group>
      <Group label={t('word.font')}>
        <div className="word-stack">
          <div className="word-row">
            <select
              className="word-select font"
              value={fontValue}
              title={t('word.fontFamily')}
              aria-label={t('word.fontFamily')}
              onChange={(e) => api.fontFamily(e.target.value)}
            >
              {!FONT_FAMILIES.includes(fontValue) && <option value={fontValue}>{fontValue}</option>}
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
            <select
              className="word-select size"
              value={String(sel.size)}
              title={t('word.fontSize')}
              aria-label={t('word.fontSize')}
              onChange={(e) => api.fontSize(Number(e.target.value))}
            >
              {!FONT_SIZES.includes(sel.size) && <option value={String(sel.size)}>{sel.size}</option>}
              {FONT_SIZES.map((s) => (
                <option key={s} value={String(s)}>
                  {s}
                </option>
              ))}
            </select>
            <RibbonButton icon="A↑" label={t('word.growFont')} shortcut="Ctrl+]" onClick={api.growFont} />
            <RibbonButton icon="A↓" label={t('word.shrinkFont')} shortcut="Ctrl+[" onClick={api.shrinkFont} />
            <RibbonButton icon="Ⓐ" label={t('word.clearFormatting')} onClick={api.clearFormatting} />
          </div>
          <div className="word-row">
            <RibbonButton icon={<b>B</b>} label={t('word.bold')} shortcut="Ctrl+B" active={sel.bold} onClick={() => api.toggle('bold')} />
            <RibbonButton icon={<i>I</i>} label={t('word.italic')} shortcut="Ctrl+I" active={sel.italic} onClick={() => api.toggle('italic')} />
            <RibbonButton icon={<u>U</u>} label={t('word.underline')} shortcut="Ctrl+U" active={sel.underline} onClick={() => api.toggle('underline')} />
            <RibbonButton icon={<s>ab</s>} label={t('word.strike')} active={sel.strike} onClick={() => api.toggle('strikeThrough')} />
            <RibbonButton icon={<span>x<sub>2</sub></span>} label={t('word.subscript')} active={sel.subscript} onClick={() => api.toggle('subscript')} />
            <RibbonButton icon={<span>x<sup>2</sup></span>} label={t('word.superscript')} active={sel.superscript} onClick={() => api.toggle('superscript')} />
            <Dropdown icon="🖍" label={t('word.highlight')} swatch="#FFFF00">
              {(close) => <ColorPanel highlight onPick={api.highlight} close={close} automaticLabel={t('word.noColor')} />}
            </Dropdown>
            <Dropdown icon={<span className="word-icon-A">A</span>} label={t('word.fontColor')} swatch="#C00000">
              {(close) => <ColorPanel onPick={api.textColor} close={close} automaticLabel={t('word.automatic')} />}
            </Dropdown>
          </div>
        </div>
      </Group>
      <Group label={t('word.paragraph')}>
        <div className="word-stack">
          <div className="word-row">
            <RibbonButton icon="•≡" label={t('word.bullets')} active={sel.bullets} onClick={() => api.list(false)} />
            <RibbonButton icon="1≡" label={t('word.numbering')} active={sel.numbering} onClick={() => api.list(true)} />
            <RibbonButton icon="⇤" label={t('word.decreaseIndent')} onClick={() => api.indent(-1)} />
            <RibbonButton icon="⇥" label={t('word.increaseIndent')} onClick={() => api.indent(1)} />
            <Dropdown icon="↕≡" label={t('word.lineSpacing')}>
              {(close) => (
                <div className="word-menu">
                  {[1, 1.15, 1.5, 2, 2.5, 3].map((v) => (
                    <button key={v} type="button" className="word-menu-item" onClick={() => { api.lineSpacing(v); close() }}>
                      {v.toFixed(2).replace(/\.?0+$/, '')}
                    </button>
                  ))}
                  <div className="word-menu-sep" />
                  <button type="button" className="word-menu-item" onClick={() => { api.paragraphSpacing('before', 12); close() }}>
                    {t('word.addSpaceBefore')}
                  </button>
                  <button type="button" className="word-menu-item" onClick={() => { api.paragraphSpacing('after', 8); close() }}>
                    {t('word.addSpaceAfter')}
                  </button>
                  <button type="button" className="word-menu-item" onClick={() => { api.paragraphSpacing('before', 0); api.paragraphSpacing('after', 0); close() }}>
                    {t('word.removeSpace')}
                  </button>
                </div>
              )}
            </Dropdown>
          </div>
          <div className="word-row">
            <RibbonButton icon="≡" className="al" label={t('word.alignLeft')} active={sel.align === 'left'} onClick={() => api.align('left')} />
            <RibbonButton icon="≡" className="ac" label={t('word.alignCenter')} shortcut="Ctrl+E" active={sel.align === 'center'} onClick={() => api.align('center')} />
            <RibbonButton icon="≡" className="ar" label={t('word.alignRight')} shortcut="Ctrl+R" active={sel.align === 'right'} onClick={() => api.align('right')} />
            <RibbonButton icon="≡" className="aj" label={t('word.justify')} shortcut="Ctrl+J" active={sel.align === 'justify'} onClick={() => api.align('justify')} />
          </div>
        </div>
      </Group>
      <Group label={t('word.styles')}>
        <div className="word-styles">
          {STYLE_GALLERY.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`word-style-chip${sel.style === s.id ? ' active' : ''}`}
              onMouseDown={keepFocus}
              onClick={() => api.style(s.id)}
              title={styleLabel(s.id, t)}
            >
              <span className="word-style-preview" style={cssToObject(s.preview)}>
                AaBbCc
              </span>
              <span className="word-style-name">{styleLabel(s.id, t)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group label={t('word.editing')}>
        <RibbonButton large icon="🔍" label={t('word.find')} shortcut="Ctrl+F" active={findOpen} onClick={onFindToggle} />
      </Group>
    </>
  )
}

function InsertTab({ api, sel }: Props) {
  const { t } = useI18n()
  return (
    <>
      <Group label={t('word.tables')}>
        <Dropdown large icon="▦" label={t('word.table')}>
          {(close) => <TableSizePicker onPick={api.insertTable} close={close} />}
        </Dropdown>
      </Group>
      <Group label={t('word.illustrations')}>
        <RibbonButton large icon="🖼" label={t('word.picture')} onClick={api.insertPicture} />
      </Group>
      <Group label={t('word.links')}>
        <RibbonButton large icon="🔗" label={t('word.link')} shortcut="Ctrl+K" onClick={api.link} active={sel.link} />
        {sel.link && <RibbonButton large icon="⛓" label={t('word.removeLink')} onClick={api.unlink} />}
      </Group>
      <Group label={t('word.pages')}>
        <RibbonButton large icon="⤓" label={t('word.pageBreak')} shortcut="Ctrl+Enter" onClick={api.pageBreak} />
        <RibbonButton large icon="―" label={t('word.horizontalLine')} onClick={api.horizontalRule} />
      </Group>
      <Group label={t('word.text')}>
        <RibbonButton large icon="📅" label={t('word.dateTime')} onClick={() => api.insertText(new Date().toLocaleDateString())} />
        <Dropdown large icon="Ω" label={t('word.symbol')}>
          {(close) => (
            <div className="word-symbols">
              {SYMBOLS.map((s) => (
                <button key={s} type="button" className="word-symbol" onClick={() => { api.insertText(s); close() }}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      </Group>
    </>
  )
}

function LayoutTab({ api, page }: Props) {
  const { t } = useI18n()
  const landscape = page.width > page.height
  const marginId = marginIdOf(page)
  const paperId = paperIdOf(page)
  return (
    <Group label={t('word.pageSetup')}>
      <Dropdown large icon="⊞" label={t('word.margins')}>
        {(close) => (
          <div className="word-menu">
            {MARGIN_PRESETS.map((m) => (
              <button key={m.id} type="button" className={`word-menu-item${marginId === m.id ? ' active' : ''}`} onClick={() => { api.margins(m.id); close() }}>
                {m.label}
              </button>
            ))}
          </div>
        )}
      </Dropdown>
      <Dropdown large icon={landscape ? '▭' : '▯'} label={t('word.orientation')}>
        {(close) => (
          <div className="word-menu">
            <button type="button" className={`word-menu-item${!landscape ? ' active' : ''}`} onClick={() => { api.orientation('portrait'); close() }}>
              ▯ {t('word.portrait')}
            </button>
            <button type="button" className={`word-menu-item${landscape ? ' active' : ''}`} onClick={() => { api.orientation('landscape'); close() }}>
              ▭ {t('word.landscape')}
            </button>
          </div>
        )}
      </Dropdown>
      <Dropdown large icon="📄" label={t('word.paperSize')}>
        {(close) => (
          <div className="word-menu">
            {PAPER_SIZES.map((p) => (
              <button key={p.id} type="button" className={`word-menu-item${paperId === p.id ? ' active' : ''}`} onClick={() => { api.paper(p.id); close() }}>
                {p.label}
              </button>
            ))}
          </div>
        )}
      </Dropdown>
    </Group>
  )
}

function ViewTab({ api, layout, ruler, zoom }: Props) {
  const { t } = useI18n()
  return (
    <>
      <Group label={t('word.views')}>
        <RibbonButton large icon="▤" label={t('word.printLayout')} active={layout === 'print'} onClick={() => api.layout('print')} />
        <RibbonButton large icon="▭" label={t('word.webLayout')} active={layout === 'web'} onClick={() => api.layout('web')} />
      </Group>
      <Group label={t('word.show')}>
        <RibbonButton large icon="📏" label={t('word.ruler')} active={ruler} onClick={() => api.ruler(!ruler)} />
      </Group>
      <Group label={t('word.zoom')}>
        <RibbonButton large icon="100%" label={t('word.zoom100')} active={Math.abs(zoom - 1) < 0.01} onClick={() => api.zoom(1)} />
        <RibbonButton large icon="↔" label={t('word.zoomPageWidth')} onClick={api.zoomToWidth} />
      </Group>
    </>
  )
}

function PictureTab({ api }: Props) {
  const { t } = useI18n()
  return (
    <Group label={t('word.pictureSize')}>
      {[25, 50, 75, 100].map((pct) => (
        <RibbonButton key={pct} large icon={`${pct}%`} label={`${pct}%`} onClick={() => api.picture.size(pct)} />
      ))}
      <RibbonButton large icon="↺" label={t('word.pictureReset')} onClick={api.picture.reset} />
      <RibbonButton large icon="🗑" label={t('word.pictureRemove')} onClick={api.picture.remove} />
    </Group>
  )
}

function TableTab({ api }: Props) {
  const { t } = useI18n()
  return (
    <>
      <Group label={t('word.rowsColumns')}>
        <RibbonButton large icon="⬆▦" label={t('word.rowAbove')} onClick={api.table.rowAbove} />
        <RibbonButton large icon="⬇▦" label={t('word.rowBelow')} onClick={api.table.rowBelow} />
        <RibbonButton large icon="⬅▦" label={t('word.colLeft')} onClick={api.table.colLeft} />
        <RibbonButton large icon="➡▦" label={t('word.colRight')} onClick={api.table.colRight} />
      </Group>
      <Group label={t('word.delete')}>
        <RibbonButton large icon="⊟" label={t('word.deleteRow')} onClick={api.table.deleteRow} />
        <RibbonButton large icon="⊟" label={t('word.deleteColumn')} onClick={api.table.deleteColumn} />
        <RibbonButton large icon="✕" label={t('word.deleteTable')} onClick={api.table.deleteTable} />
      </Group>
      <Group label={t('word.tableStyle')}>
        <RibbonButton large icon="▦" label={t('word.tableBorders')} onClick={api.table.toggleBorders} />
        <Dropdown large icon="◧" label={t('word.cellShading')}>
          {(close) => <ColorPanel onPick={api.table.shade} close={close} automaticLabel={t('word.noColor')} />}
        </Dropdown>
      </Group>
    </>
  )
}

function styleLabel(id: string, t: (k: never) => string): string {
  const key = `word.style${id}` as never
  const label = t(key)
  return label === `word.style${id}` ? id : label
}

function cssToObject(css: string): React.CSSProperties {
  const out: Record<string, string> = {}
  for (const decl of css.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) continue
    const name = decl.slice(0, colon).trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out[name] = decl.slice(colon + 1).trim()
  }
  return out as React.CSSProperties
}
