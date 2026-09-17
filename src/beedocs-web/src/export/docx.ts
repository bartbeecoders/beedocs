import mermaid from 'mermaid'
import { api } from '../api'
import { freeDrawToSvg } from '../freedraw/model'
import { isoDiagramToSvg } from '../isometric/isoSvg'
import type { ExportDiagramFence } from '../types'
import { beeDiagramToSvg } from './beeDiagramSvg'
import type { ExportProgress } from './pdf'

/**
 * Word export with diagram pictures.
 *
 * The API writes the .docx, but it cannot draw a Mermaid, BeeDiagram or
 * isometric fence — that takes a DOM. So a Word export from the UI is two
 * trips: `GET …/export/diagrams` lists the fences the document would contain
 * (references already resolved to their source), this module draws each one
 * to a PNG with the same renderers the PDF export uses, and
 * `POST …/export?format=docx` hands the pictures back for the writer to embed.
 * A fence that fails to render is simply left out and comes through as the
 * captioned source block the plain API export always produced.
 */

export type DocxTarget =
  | { scope: 'book'; id: string }
  | { scope: 'page'; id: string }
  | { scope: 'folder'; bookId: string; chapterId: string }

/** Device pixels per CSS pixel — matches `DocxWriter.DiagramRenderScale` on the server. */
const RENDER_SCALE = 2
/** Longest side of a rendered PNG, in device pixels. */
const MAX_SIDE = 4096

function exportPath(target: DocxTarget): string {
  switch (target.scope) {
    case 'book':
      return `/api/books/${target.id}/export`
    case 'page':
      return `/api/pages/${target.id}/export`
    case 'folder':
      return `/api/books/${target.bookId}/chapters/${target.chapterId}/export`
  }
}

/** Render every diagram in the target, then download the Word file. Resolves to the file name. */
export async function exportToDocx(target: DocxTarget, onProgress?: ExportProgress): Promise<string> {
  const path = exportPath(target)

  onProgress?.('Listing diagrams…')
  const fences = await api.listExportDiagrams(path)

  const images: { key: string; data: string }[] = []
  if (fences.length > 0) {
    await withExportMermaid(async () => {
      for (let i = 0; i < fences.length; i++) {
        const fence = fences[i]
        onProgress?.(`Rendering diagram ${i + 1}/${fences.length}…`)
        try {
          // Sequential on purpose: mermaid.render is not safe to run concurrently.
          const data = await renderFenceToPng(fence, i)
          if (data) images.push({ key: fence.key, data })
        } catch {
          // Leave it out; the writer falls back to the source block.
        }
      }
    })
  }

  onProgress?.('Building document…')
  return api.downloadRenderedExport(path, images)
}

/**
 * Mermaid keeps one global config. The viewer initialises it for the current
 * theme; the export wants the neutral print theme and SVG-only labels (HTML
 * labels are `<foreignObject>`, which some browsers refuse to draw onto a
 * canvas). Swap it in for the duration and put the viewer's back afterwards.
 */
async function withExportMermaid(run: () => Promise<void>): Promise<void> {
  const previous = mermaid.mermaidAPI.getConfig()
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    securityLevel: 'loose',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  })
  try {
    await run()
  } finally {
    mermaid.initialize(previous)
  }
}

async function renderFenceToPng(fence: ExportDiagramFence, index: number): Promise<string | null> {
  let markup: string
  switch (fence.kind) {
    case 'mermaid': {
      const id = `docx-mmd-${index}-${Math.random().toString(36).slice(2, 8)}`
      markup = (await mermaid.render(id, fence.source)).svg
      break
    }
    case 'beediagram':
      markup = beeDiagramToSvg(fence.source)
      break
    case 'isometric':
      markup = isoDiagramToSvg(fence.source)
      break
    case 'freedraw':
      markup = freeDrawToSvg(fence.source)
      break
    default:
      return null
  }

  const svg = extractSvg(markup)
  if (!svg) return null
  await inlineExternalImages(svg)
  return rasterize(svg)
}

/**
 * The renderers return `<figure>` markup for the print page (and a `<div>`
 * for an empty diagram); pull the SVG element out and give it an explicit
 * pixel size, because an `<img>` loading an SVG that says `width="100%"` has
 * no box to resolve that against.
 */
function extractSvg(markup: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(markup, 'text/html')
  const svg = doc.querySelector('svg')
  if (!svg) return null

  const { width, height } = naturalSize(svg)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.removeAttribute('style')
  return svg as unknown as SVGSVGElement
}

/** Pixel size of an SVG root: its viewBox, else its width/height attributes. */
function naturalSize(svg: Element): { width: number; height: number } {
  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: Math.ceil(viewBox[2]), height: Math.ceil(viewBox[3]) }
  }
  const w = parseFloat(svg.getAttribute('width') ?? '')
  const h = parseFloat(svg.getAttribute('height') ?? '')
  return {
    width: Number.isFinite(w) && w > 0 ? Math.ceil(w) : 800,
    height: Number.isFinite(h) && h > 0 ? Math.ceil(h) : 600,
  }
}

/**
 * An SVG loaded through `<img>` fetches nothing external, so a BeeDiagram
 * image node pointing at `/uploads/…` would come out blank. Fetch each one
 * (same origin, session cookie included) and inline it as a data URL.
 */
async function inlineExternalImages(svg: SVGSVGElement): Promise<void> {
  const images = Array.from(svg.querySelectorAll('image'))
  await Promise.all(
    images.map(async (img) => {
      const href = img.getAttribute('href') ?? img.getAttribute('xlink:href')
      if (!href || href.startsWith('data:')) return
      try {
        const res = await fetch(href, { credentials: 'include' })
        if (!res.ok) return
        const dataUrl = await blobToDataUrl(await res.blob())
        img.setAttribute('href', dataUrl)
        img.removeAttribute('xlink:href')
      } catch {
        // Leave the reference; the picture just lacks that image.
      }
    }),
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

/** Draw the SVG onto a white canvas at RENDER_SCALE and return a PNG data URL. */
async function rasterize(svg: SVGSVGElement): Promise<string> {
  const width = Number(svg.getAttribute('width'))
  const height = Number(svg.getAttribute('height'))
  const scale = Math.min(RENDER_SCALE, MAX_SIDE / Math.max(width, height, 1))

  const source = new XMLSerializer().serializeToString(svg)
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('SVG failed to load'))
    img.src = url
  })
}
