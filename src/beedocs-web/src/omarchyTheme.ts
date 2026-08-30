import type { OmarchyTheme } from './types'

/**
 * Turns the raw Omarchy desktop palette (what /api/branding reports) into the
 * same CSS token set the built-in themes declare in index.css. The server only
 * forwards colors it actually found, so every derived token has a computed
 * fallback — a minimal theme (background + foreground + terminal colors) still
 * produces a complete, coherent workspace.
 */

function parseHex(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** `t` is the weight of `b`: mix(x, y, 0.1) is x with 10% of y blended in. */
function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  return toHex([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t])
}

/** WCAG relative luminance, for picking readable text on the accent. */
function luminance(hex: string): number {
  const p = parseHex(hex)
  if (!p) return 0
  const [r, g, b] = p.map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function saturation(hex: string): number {
  const p = parseHex(hex)
  if (!p) return 0
  const max = Math.max(...p)
  const min = Math.min(...p)
  return max === 0 ? 0 : (max - min) / max
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const valid = (c: string | null | undefined): string | null => (parseHex(c) ? (c as string) : null)

/**
 * The theme's own accent when it declares one; otherwise the most saturated of
 * its terminal colors (blue first on ties — the conventional UI accent), and as
 * a last resort the foreground.
 */
export function pickOmarchyAccent(p: OmarchyTheme): string {
  const declared = valid(p.accent)
  if (declared) return declared

  let best: string | null = null
  let bestScore = 0.2 // below this everything is gray — not an accent
  for (const c of [p.blue, p.magenta, p.cyan, p.green, p.yellow, p.red]) {
    const hex = valid(c)
    if (!hex) continue
    const score = saturation(hex)
    if (score > bestScore) {
      best = hex
      bestScore = score
    }
  }
  return best ?? p.foreground
}

/** Every token deriveOmarchyVars sets — what leaving the omarchy theme must remove. */
export const OMARCHY_VAR_KEYS = [
  '--bg',
  '--bg-elevated',
  '--bg-soft',
  '--bg-pane',
  '--text',
  '--muted',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-strong',
  '--accent-fg',
  '--danger',
  '--focus',
  '--header-bg',
  '--tree-active',
  '--shadow',
] as const

/** Complete CSS custom-property map for `html[data-theme='omarchy']`. */
export function deriveOmarchyVars(p: OmarchyTheme): Record<string, string> {
  const dark = p.scheme !== 'light'
  const bg = valid(p.background) ?? (dark ? '#12110f' : '#f3f0e8')
  const fg = valid(p.foreground) ?? (dark ? '#f2eee5' : '#1a1814')
  const accent = pickOmarchyAccent(p)

  const elevated = valid(p.bgLighter) ?? (dark ? mix(bg, fg, 0.06) : mix(bg, '#ffffff', 0.6))
  const soft = dark ? mix(bg, fg, 0.11) : mix(bg, fg, 0.07)
  const pane = dark ? mix(bg, fg, 0.03) : mix(bg, '#ffffff', 0.35)
  const muted = valid(p.muted) ?? mix(fg, bg, 0.38)
  const border = mix(bg, fg, dark ? 0.16 : 0.22)
  const borderStrong = mix(bg, fg, dark ? 0.28 : 0.36)
  const accentStrong = dark ? mix(accent, '#ffffff', 0.18) : mix(accent, '#000000', 0.18)
  const accentFg = contrast(accent, '#ffffff') >= contrast(accent, '#141414') ? '#ffffff' : '#141414'

  return {
    '--bg': bg,
    '--bg-elevated': elevated,
    '--bg-soft': soft,
    '--bg-pane': pane,
    '--text': fg,
    '--muted': muted,
    '--border': border,
    '--border-strong': borderStrong,
    '--accent': accent,
    '--accent-strong': accentStrong,
    '--accent-fg': accentFg,
    '--danger': valid(p.red) ?? (dark ? '#f97066' : '#b42318'),
    '--focus': 'color-mix(in srgb, var(--accent) 45%, transparent)',
    '--header-bg': `color-mix(in srgb, ${elevated} ${dark ? 94 : 92}%, transparent)`,
    '--tree-active': valid(p.selection) ?? `color-mix(in srgb, ${accent} 14%, ${elevated})`,
    '--shadow': dark
      ? '0 1px 0 rgba(0, 0, 0, 0.3), 0 16px 40px rgba(0, 0, 0, 0.35)'
      : '0 1px 0 rgba(26, 24, 20, 0.04), 0 12px 32px rgba(26, 24, 20, 0.06)',
  }
}
