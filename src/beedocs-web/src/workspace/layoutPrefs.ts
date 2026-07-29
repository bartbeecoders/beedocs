export type PaneLayout = {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

const KEY = 'beedocs-pane-layout'

const DEFAULTS: PaneLayout = {
  leftWidth: 280,
  rightWidth: 300,
  leftCollapsed: false,
  rightCollapsed: false,
}

export function loadPaneLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<PaneLayout>
    return {
      leftWidth: clamp(Number(parsed.leftWidth) || DEFAULTS.leftWidth, 180, 520),
      rightWidth: clamp(Number(parsed.rightWidth) || DEFAULTS.rightWidth, 200, 480),
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePaneLayout(layout: PaneLayout) {
  localStorage.setItem(KEY, JSON.stringify(layout))
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}
