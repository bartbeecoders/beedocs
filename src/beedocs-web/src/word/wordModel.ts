import type { WordPageSetup } from '../types'

/** Twips → CSS px at 96 dpi (1440 twips = 1 in = 96 px). */
export const TWIPS_PER_PX = 15

export function twipsToPx(twips: number): number {
  return twips / TWIPS_PER_PX
}

export function pxToTwips(px: number): number {
  return Math.round(px * TWIPS_PER_PX)
}

/** Space between pages in print layout, in CSS px. */
export const PAGE_GAP_PX = 28

export type PageGeometry = {
  pageW: number
  pageH: number
  mTop: number
  mRight: number
  mBottom: number
  mLeft: number
  /** pageH − margins: what one page can hold. */
  contentH: number
  contentW: number
}

export function geometryOf(page: WordPageSetup): PageGeometry {
  const pageW = twipsToPx(page.width)
  const pageH = twipsToPx(page.height)
  const mTop = twipsToPx(page.top)
  const mRight = twipsToPx(page.right)
  const mBottom = twipsToPx(page.bottom)
  const mLeft = twipsToPx(page.left)
  return {
    pageW,
    pageH,
    mTop,
    mRight,
    mBottom,
    mLeft,
    contentH: Math.max(pageH - mTop - mBottom, 100),
    contentW: Math.max(pageW - mLeft - mRight, 100),
  }
}

/** Word's paper sizes, portrait, in twips. */
export const PAPER_SIZES: { id: string; label: string; width: number; height: number }[] = [
  { id: 'a4', label: 'A4 (21 × 29.7 cm)', width: 11906, height: 16838 },
  { id: 'letter', label: 'Letter (8.5 × 11 in)', width: 12240, height: 15840 },
  { id: 'legal', label: 'Legal (8.5 × 14 in)', width: 12240, height: 20160 },
  { id: 'a3', label: 'A3 (29.7 × 42 cm)', width: 16838, height: 23811 },
  { id: 'a5', label: 'A5 (14.8 × 21 cm)', width: 8391, height: 11906 },
]

/** Word's margin presets (top, right, bottom, left) in twips. */
export const MARGIN_PRESETS: { id: string; label: string; top: number; right: number; bottom: number; left: number }[] = [
  { id: 'normal', label: 'Normal (2.54 cm)', top: 1440, right: 1440, bottom: 1440, left: 1440 },
  { id: 'narrow', label: 'Narrow (1.27 cm)', top: 720, right: 720, bottom: 720, left: 720 },
  { id: 'moderate', label: 'Moderate (2.54 / 1.91 cm)', top: 1440, right: 1080, bottom: 1440, left: 1080 },
  { id: 'wide', label: 'Wide (2.54 / 5.08 cm)', top: 1440, right: 2880, bottom: 1440, left: 2880 },
]

export function paperIdOf(page: WordPageSetup): string | null {
  const w = Math.min(page.width, page.height)
  const h = Math.max(page.width, page.height)
  const hit = PAPER_SIZES.find((p) => Math.abs(p.width - w) < 40 && Math.abs(p.height - h) < 40)
  return hit?.id ?? null
}

export function marginIdOf(page: WordPageSetup): string | null {
  const hit = MARGIN_PRESETS.find(
    (m) => m.top === page.top && m.right === page.right && m.bottom === page.bottom && m.left === page.left,
  )
  return hit?.id ?? null
}

/** Whether a page's ruler reads better in inches (US paper) or centimetres. */
export function usesInches(page: WordPageSetup): boolean {
  const id = paperIdOf(page)
  return id === 'letter' || id === 'legal'
}

export const FONT_FAMILIES = [
  'Calibri',
  'Calibri Light',
  'Aptos',
  'Arial',
  'Cambria',
  'Georgia',
  'Times New Roman',
  'Verdana',
  'Tahoma',
  'Segoe UI',
  'Trebuchet MS',
  'Garamond',
  'Book Antiqua',
  'Consolas',
  'Courier New',
  'Comic Sans MS',
]

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]

/** Word's ribbon styles, in gallery order, with the preview typography the chips use. */
export const STYLE_GALLERY: { id: string; label: string; preview: string }[] = [
  { id: 'Normal', label: 'Normal', preview: 'font-size:11pt' },
  { id: 'NoSpacing', label: 'No Spacing', preview: 'font-size:11pt' },
  { id: 'Heading1', label: 'Heading 1', preview: 'font-size:14pt;color:#2F5496' },
  { id: 'Heading2', label: 'Heading 2', preview: 'font-size:12pt;color:#2F5496' },
  { id: 'Heading3', label: 'Heading 3', preview: 'font-size:11pt;color:#1F3763' },
  { id: 'Title', label: 'Title', preview: 'font-size:15pt;letter-spacing:-0.3pt' },
  { id: 'Subtitle', label: 'Subtitle', preview: 'font-size:10pt;color:#5A5A5A;letter-spacing:0.5pt' },
  { id: 'Quote', label: 'Quote', preview: 'font-size:10pt;font-style:italic;color:#404040' },
]

/** Word's "Theme Colors" and "Standard Colors" palette rows. */
export const THEME_COLORS: string[][] = [
  ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
  ['#F2F2F2', '#808080', '#D0CECE', '#D6DCE5', '#DAE3F3', '#FBE5D6', '#EDEDED', '#FFF2CC', '#DEEBF7', '#E2F0D9'],
  ['#D9D9D9', '#595959', '#AEABAB', '#ADB9CA', '#B4C7E7', '#F8CBAD', '#DBDBDB', '#FFE699', '#BDD7EE', '#C5E0B4'],
  ['#BFBFBF', '#404040', '#767171', '#8497B0', '#8FAADC', '#F4B183', '#C9C9C9', '#FFD966', '#9DC3E6', '#A9D18E'],
  ['#A6A6A6', '#262626', '#3B3838', '#333F50', '#2F5597', '#C55A11', '#7B7B7B', '#BF9000', '#2E75B6', '#548235'],
  ['#7F7F7F', '#0D0D0D', '#171616', '#222A35', '#1F3864', '#843C0C', '#525252', '#7F6000', '#1F4E79', '#385723'],
]

export const STANDARD_COLORS = [
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0',
]

/** Word's fifteen highlighter colours. */
export const HIGHLIGHT_COLORS: { name: string; hex: string }[] = [
  { name: 'Yellow', hex: '#FFFF00' },
  { name: 'Bright green', hex: '#00FF00' },
  { name: 'Turquoise', hex: '#00FFFF' },
  { name: 'Pink', hex: '#FF00FF' },
  { name: 'Blue', hex: '#0000FF' },
  { name: 'Red', hex: '#FF0000' },
  { name: 'Dark blue', hex: '#000080' },
  { name: 'Teal', hex: '#008080' },
  { name: 'Green', hex: '#008000' },
  { name: 'Violet', hex: '#800080' },
  { name: 'Dark red', hex: '#800000' },
  { name: 'Dark yellow', hex: '#808000' },
  { name: 'Gray 50%', hex: '#808080' },
  { name: 'Gray 25%', hex: '#C0C0C0' },
  { name: 'Black', hex: '#000000' },
]

export const SYMBOLS = ['©', '®', '™', '€', '£', '¥', '§', '¶', '•', '–', '—', '…', '«', '»', '←', '→', '↑', '↓', '✓', '✗', '★', '½', '¼', '¾', '°', '±', '×', '÷', '≠', '≤', '≥', '∞']
