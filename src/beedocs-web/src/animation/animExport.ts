/**
 * Getting an animation out of BeeDocs: a video file rendered in the browser,
 * or an fframes project (Rust) that renders the same frames on the GPU.
 *
 * Both reuse `renderFrameSvg` — the fframes model of "frame = f(t)" means a
 * frame can be rendered alone, so export just walks t = i / fps.
 */
import { parseAnimation, renderFrameSvg, serializeAnimation, totalDuration, type AnimDoc } from './animModel'
import { buildZip, downloadBlob } from './zip'
import animRs from './fframes/beedocs_anim.rs?raw'
import libTmpl from './fframes/lib.rs.tmpl?raw'
import mainTmpl from './fframes/main.rs.tmpl?raw'
import cargoTmpl from './fframes/Cargo.toml.tmpl?raw'

/** The fframes release the exported crate pins (crates.io). */
export const FFRAMES_VERSION = '1.2.1-rc.14'

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'animation'
}

// ---------------------------------------------------------------------------
// Images: SVG drawn through <img> (and resvg in fframes) cannot fetch, so every
// image is inlined as a data: URL first.
// ---------------------------------------------------------------------------

async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src
  const res = await fetch(src, { credentials: 'include' })
  if (!res.ok) throw new Error(`${res.status} ${src}`)
  const blob = await res.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

export async function inlineImages(doc: AnimDoc): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const srcs = new Set<string>()
  for (const scene of doc.scenes)
    for (const el of scene.elements) if (el.type === 'image' && el.src) srcs.add(el.src)
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        map.set(src, await toDataUrl(src))
      } catch {
        // A missing image renders as nothing rather than failing the export.
      }
    }),
  )
  return map
}

// ---------------------------------------------------------------------------
// Video (MediaRecorder over a canvas, paced in real time)
// ---------------------------------------------------------------------------

export type VideoFormat = { mimeType: string; ext: 'mp4' | 'webm' }

export function pickVideoFormat(): VideoFormat | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates: VideoFormat[] = [
    { mimeType: 'video/mp4;codecs=avc1.640028', ext: 'mp4' },
    { mimeType: 'video/mp4', ext: 'mp4' },
    { mimeType: 'video/webm;codecs=vp9', ext: 'webm' },
    { mimeType: 'video/webm;codecs=vp8', ext: 'webm' },
    { mimeType: 'video/webm', ext: 'webm' },
  ]
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? null
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Frame failed to render'))
    }
    img.src = url
  })
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))

export type VideoExportOptions = {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * Records the animation to a video Blob. MediaRecorder timestamps frames by
 * wall clock, so frames are pushed at the document's real frame rate — an
 * export takes as long as the animation plays.
 */
export async function recordVideo(
  source: string,
  opts: VideoExportOptions = {},
): Promise<{ blob: Blob; ext: string }> {
  const format = pickVideoFormat()
  if (!format) throw new Error('This browser cannot record video (MediaRecorder unavailable).')
  const doc = parseAnimation(source)
  const images = await inlineImages(doc)
  const resolveSrc = (src: string) => images.get(src) ?? src

  const canvas = document.createElement('canvas')
  canvas.width = doc.width
  canvas.height = doc.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable.')
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const recorder = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: Math.round(doc.width * doc.height * doc.fps * 0.15),
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  const total = totalDuration(doc)
  const frames = Math.max(1, Math.ceil(total * doc.fps))
  const frameMs = 1000 / doc.fps

  // Paint frame 0 before starting so the first chunk is not black.
  const first = await loadSvgImage(renderFrameSvg(doc, 0, { idPrefix: 'rec', resolveSrc }))
  ctx.drawImage(first, 0, 0, doc.width, doc.height)
  recorder.start(1000)
  const startedAt = performance.now()
  try {
    for (let i = 0; i <= frames; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const t = Math.min(total, i / doc.fps)
      const img = i === 0 ? first : await loadSvgImage(renderFrameSvg(doc, t, { idPrefix: 'rec', resolveSrc }))
      ctx.drawImage(img, 0, 0, doc.width, doc.height)
      track.requestFrame?.()
      opts.onProgress?.(i / frames)
      await sleep(startedAt + (i + 1) * frameMs - performance.now())
    }
  } finally {
    if (recorder.state !== 'inactive') recorder.stop()
    await stopped
    track.stop()
  }
  if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  return { blob: new Blob(chunks, { type: format.mimeType.split(';')[0] }), ext: format.ext }
}

export async function downloadVideo(source: string, title: string, opts: VideoExportOptions = {}) {
  const { blob, ext } = await recordVideo(source, opts)
  downloadBlob(blob, `${slugify(title)}.${ext}`)
}

/** One frame as a PNG — the poster image people paste into chat or slides. */
export async function downloadFramePng(source: string, time: number, title: string) {
  const doc = parseAnimation(source)
  const images = await inlineImages(doc)
  const img = await loadSvgImage(
    renderFrameSvg(doc, time, { idPrefix: 'png', resolveSrc: (s) => images.get(s) ?? s }),
  )
  const canvas = document.createElement('canvas')
  canvas.width = doc.width
  canvas.height = doc.height
  canvas.getContext('2d')?.drawImage(img, 0, 0)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
  if (blob) downloadBlob(blob, `${slugify(title)}-${time.toFixed(1)}s.png`)
}

// ---------------------------------------------------------------------------
// fframes project
// ---------------------------------------------------------------------------

function pascal(slug: string): string {
  const p = slug
    .split('-')
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('')
  return /^[A-Za-z]/.test(p) ? p : `Anim${p}`
}

function fill(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '')
}

function readme(title: string, crate: string, doc: AnimDoc): string {
  return `# ${title}

An animation exported from BeeDocs as an [fframes](https://github.com/dmtrKovalenko/fframes)
video project: ${doc.scenes.length} scene(s), ${totalDuration(doc).toFixed(1)} s,
${doc.width}x${doc.height} at ${doc.fps} fps.

- \`animation.json\` — the animation, exactly as BeeDocs stores it (paste it back into a
  BeeDocs \`animation\` block or the editor's JSON tab to round-trip).
- \`src/beedocs_anim.rs\` — the BeeDocs frame renderer ported to Rust. Every frame is
  \`render_frame_svg(doc, seconds)\`: an SVG string that fframes rasterises and encodes.
- \`src/lib.rs\` — the fframes \`Video\`; replace \`render_frame\` with your own
  \`svgr!\` scenes to take the video further than BeeDocs can.

## Render

Install Rust (<https://rustup.rs>) and the ffmpeg build dependencies listed in the fframes
README (Debian/Ubuntu: \`sudo apt-get install -y yasm nasm ffmpeg libx264-dev libclang-dev
clang ninja-build\`), then:

\`\`\`bash
cargo run --release -- timeline        # scenes and timing
cargo run --release -- strip all -n 12 # contact sheet (strip.png)
cargo run --release -- frame 2s        # one full-size PNG in frames/
cargo run --release -- render -o ${crate}.mp4
\`\`\`

This project uses fframes' built-in CPU renderer, so it needs no GPU or Skia build. For
~10x faster renders and the real-time \`preview\` window, add the Skia backend as
\`cargo fframes new --backend skia-vulkan\` (or \`skia-metal\` on macOS) generates it.

Text uses the fonts installed on the machine that renders (\`load_system_fonts\`). Colour
emoji depend on the renderer's emoji font support.
`
}

export async function downloadFframesProject(source: string, title: string): Promise<void> {
  const doc = parseAnimation(source)
  const images = await inlineImages(doc)
  // Inline images so the crate renders offline and identically.
  const portable: AnimDoc = {
    ...doc,
    scenes: doc.scenes.map((s) => ({
      ...s,
      elements: s.elements.map((e) =>
        e.type === 'image' && e.src && images.has(e.src) ? { ...e, src: images.get(e.src) } : e,
      ),
    })),
  }
  const slug = slugify(title)
  const crate = /^[a-z]/.test(slug) ? slug : `anim-${slug}`
  const vars = {
    crate_name: crate,
    lib_name: crate.replace(/-/g, '_'),
    Struct: pascal(crate),
    title: title.replace(/\n/g, ' '),
    width: String(doc.width),
    height: String(doc.height),
    fps: String(doc.fps),
    fframes_version: FFRAMES_VERSION,
  }
  const json = JSON.stringify(JSON.parse(serializeAnimation(portable)), null, 2)
  const zip = buildZip([
    { path: `${crate}/Cargo.toml`, data: fill(cargoTmpl, vars) },
    { path: `${crate}/README.md`, data: readme(title, crate, doc) },
    { path: `${crate}/.gitignore`, data: '/target\n/frames\n/test_render\n*.mp4\n*.png\n' },
    { path: `${crate}/animation.json`, data: json },
    { path: `${crate}/src/lib.rs`, data: fill(libTmpl, vars) },
    { path: `${crate}/src/main.rs`, data: fill(mainTmpl, vars) },
    { path: `${crate}/src/beedocs_anim.rs`, data: animRs },
  ])
  downloadBlob(zip, `${crate}-fframes.zip`)
}
