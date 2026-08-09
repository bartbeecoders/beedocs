import type { BeePrim } from './shapes'

/**
 * Microsoft Azure service icons for the studio shape palette.
 *
 * Every icon is a flat, two-tone glyph drawn with the same primitive model as
 * the rest of the shape catalog, in a fixed **100 × 100 box**. `nodePrimitives`
 * scales that box into the node and centres it, so an icon stays crisp at any
 * size and exports identically to the PDF/SVG pipeline.
 *
 * These are BeeDocs' own drawings in Azure's palette — recognisable stand-ins
 * for the official stencils, not copies of them. Swapping in the artwork from
 * https://learn.microsoft.com/azure/architecture/icons/ is a data-only change:
 * replace an entry's `prims` (or point it at an `image` primitive).
 */

/** Azure brand palette. */
const C: Record<string, string> = {
  blue: '#0078D4',
  dark: '#005BA1',
  deep: '#003D6B',
  cyan: '#50E6FF',
  pale: '#C3F1FF',
  white: '#FFFFFF',
  teal: '#00A2AD',
  green: '#57A300',
  yellow: '#FFB900',
  orange: '#EF6C00',
  red: '#D13438',
  purple: '#8661C5',
  grey: '#9AA5B1',
}

// ── Primitive helpers (all coordinates in the 100 × 100 icon box) ─────────────

const rect = (x: number, y: number, w: number, h: number, fill: string, rx?: number): BeePrim => ({
  k: 'rect',
  x,
  y,
  w,
  h,
  rx,
  fill,
})

const path = (d: string, fill: string): BeePrim => ({ k: 'path', d, fill })

const line = (d: string, stroke: string, sw = 5): BeePrim => ({ k: 'path', d, fill: 'none', stroke, sw })

const dashed = (d: string, stroke: string, sw = 4, dash = '8 6'): BeePrim => ({
  k: 'path',
  d,
  fill: 'none',
  stroke,
  sw,
  dash,
})

const circle = (cx: number, cy: number, r: number, fill: string): BeePrim => ({
  k: 'ellipse',
  cx,
  cy,
  rx: r,
  ry: r,
  fill,
})

const oval = (cx: number, cy: number, rx: number, ry: number, fill: string): BeePrim => ({
  k: 'ellipse',
  cx,
  cy,
  rx,
  ry,
  fill,
})

const ring = (cx: number, cy: number, r: number, stroke: string, sw = 5): BeePrim => ({
  k: 'ellipse',
  cx,
  cy,
  rx: r,
  ry: r,
  fill: 'none',
  stroke,
  sw,
})

const tag = (text: string, x: number, y: number, size: number, color: string): BeePrim => ({
  k: 'text',
  x,
  y,
  text,
  size,
  color,
  weight: 700,
  anchor: 'middle',
})

// ── Composite motifs ──────────────────────────────────────────────────────────

/** Database drum. */
function cylinder(x: number, y: number, w: number, h: number, body = C.blue, top = C.cyan): BeePrim[] {
  const ry = Math.min(h * 0.18, w * 0.3)
  return [
    path(
      `M${x} ${y + ry} A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} V${y + h - ry} ` +
        `A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z`,
      body,
    ),
    oval(x + w / 2, y + ry, w / 2, ry, top),
  ]
}

/** Wire globe — the "public / internet facing" motif. */
function globe(cx: number, cy: number, r: number, fill = C.blue, ink = C.white): BeePrim[] {
  return [
    circle(cx, cy, r, fill),
    { k: 'ellipse', cx, cy, rx: r * 0.46, ry: r, fill: 'none', stroke: ink, sw: r * 0.12 },
    line(`M${cx - r * 0.99} ${cy} H${cx + r * 0.99}`, ink, r * 0.12),
    line(
      `M${cx - r * 0.85} ${cy - r * 0.5} H${cx + r * 0.85} M${cx - r * 0.85} ${cy + r * 0.5} H${cx + r * 0.85}`,
      ink,
      r * 0.1,
    ),
  ]
}

/** Monitor / screen with a stand. */
function screen(x: number, y: number, w: number, h: number, glass = C.pale): BeePrim[] {
  const cx = x + w / 2
  return [
    rect(x, y, w, h, C.blue, 5),
    rect(x + 6, y + 6, w - 12, h - 12, glass, 2),
    rect(cx - 6, y + h, 12, 8, C.dark),
    rect(cx - w * 0.28, y + h + 8, w * 0.56, 7, C.blue, 3),
  ]
}

function hexagon(cx: number, cy: number, r: number, fill: string): BeePrim {
  const pts: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90)
    pts.push(`${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`)
  }
  return path(`M${pts.join(' L')} Z`, fill)
}

/** Kubernetes-style helm: ring, hub and spokes. */
function helm(cx: number, cy: number, r: number, color: string): BeePrim[] {
  const spokes: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i + 30)
    spokes.push(
      `M${round(cx + Math.cos(a) * r * 0.28)} ${round(cy + Math.sin(a) * r * 0.28)} ` +
        `L${round(cx + Math.cos(a) * r)} ${round(cy + Math.sin(a) * r)}`,
    )
  }
  return [ring(cx, cy, r, color, r * 0.17), line(spokes.join(' '), color, r * 0.17), circle(cx, cy, r * 0.3, color)]
}

/** Isometric box — containers, registries, cubes. */
function box3d(x: number, y: number, w: number, h: number, front = C.blue, top = C.cyan): BeePrim[] {
  const d = Math.min(w, h) * 0.24
  return [
    path(`M${x} ${y + d} L${x + d} ${y} H${x + w} L${x + w - d} ${y + d} Z`, top),
    rect(x, y + d, w - d, h - d, front),
    path(`M${x + w - d} ${y + d} L${x + w} ${y} V${y + h - d} L${x + w - d} ${y + h} Z`, C.dark),
  ]
}

function person(cx: number, headCy: number, s: number, fill: string): BeePrim[] {
  return [
    circle(cx, headCy, 11 * s, fill),
    path(`M${cx - 20 * s} ${headCy + 40 * s} a${20 * s} ${23 * s} 0 0 1 ${40 * s} 0 Z`, fill),
  ]
}

function bolt(cx: number, cy: number, s: number, fill: string): BeePrim {
  return path(
    `M${cx + 7 * s} ${cy - 24 * s} L${cx - 14 * s} ${cy + 4 * s} H${cx - 1 * s} ` +
      `L${cx - 6 * s} ${cy + 24 * s} L${cx + 15 * s} ${cy - 4 * s} H${cx + 2 * s} Z`,
    fill,
  )
}

function shield(cx: number, top: number, w: number, h: number, fill: string): BeePrim {
  const hw = w / 2
  return path(
    `M${cx - hw} ${top + h * 0.1} L${cx} ${top} L${cx + hw} ${top + h * 0.1} V${top + h * 0.5} ` +
      `C${cx + hw} ${top + h * 0.82} ${cx + hw * 0.45} ${top + h * 0.96} ${cx} ${top + h} ` +
      `C${cx - hw * 0.45} ${top + h * 0.96} ${cx - hw} ${top + h * 0.82} ${cx - hw} ${top + h * 0.5} Z`,
    fill,
  )
}

function arrowRight(x: number, y: number, len: number, thick: number, fill: string): BeePrim {
  const head = thick * 1.6
  return path(
    `M${x} ${y - thick / 2} H${x + len - head} V${y - head} L${x + len} ${y} ` +
      `L${x + len - head} ${y + head} V${y + thick / 2} H${x} Z`,
    fill,
  )
}

/** Page with a folded corner. */
function doc(x: number, y: number, w: number, h: number, fill = C.blue, fold = C.cyan): BeePrim[] {
  const f = w * 0.3
  return [
    path(`M${x} ${y} H${x + w - f} L${x + w} ${y + f} V${y + h} H${x} Z`, fill),
    path(`M${x + w - f} ${y} V${y + f} H${x + w} Z`, fold),
  ]
}

function magnifier(cx: number, cy: number, r: number, color: string, sw = 7): BeePrim[] {
  const k = r * 0.72
  return [ring(cx, cy, r, color, sw), line(`M${cx + k} ${cy + k} L${cx + k + r * 0.8} ${cy + k + r * 0.8}`, color, sw * 1.4)]
}

function padlock(x: number, y: number, w: number, h: number, body = C.blue, shackle = C.dark): BeePrim[] {
  const cx = x + w / 2
  const bodyY = y + h * 0.42
  return [
    line(
      `M${cx - w * 0.26} ${bodyY} V${y + h * 0.22} a${w * 0.26} ${w * 0.26} 0 0 1 ${w * 0.52} 0 V${bodyY}`,
      shackle,
      w * 0.14,
    ),
    rect(x, bodyY, w, h * 0.58, body, w * 0.12),
    circle(cx, bodyY + h * 0.29, w * 0.11, C.white),
  ]
}

/** Small connected-nodes motif (networks, meshes). */
function nodeLink(a: [number, number], b: [number, number], color: string, sw = 4): BeePrim {
  return line(`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`, color, sw)
}

function round(v: number): number {
  return Math.round(v * 10) / 10
}

// ── Icon registry ─────────────────────────────────────────────────────────────

export type AzureIconCategory =
  | 'general'
  | 'compute'
  | 'containers'
  | 'web'
  | 'storage'
  | 'databases'
  | 'networking'
  | 'integration'
  | 'identity'
  | 'analytics'
  | 'management'

export type AzureIcon = {
  /** Stable id — stored on the node as `icon`, so renames must not change it. */
  id: string
  label: string
  category: AzureIconCategory
  keywords?: string
  /** Geometry in the 100 × 100 icon box. */
  prims: BeePrim[]
}

const CLOUD =
  'M25 88 A19 20.8 0 0 1 15 51.6 A20 22.4 0 0 1 36 27.6 A22 24 0 0 1 72 26 ' +
  'A20 20.8 0 0 1 90 54 A17 19.2 0 0 1 78 88 Z'

export const AZURE_ICONS: AzureIcon[] = [
  // ── General ────────────────────────────────────────────────────────────────
  {
    id: 'azure',
    label: 'Azure',
    category: 'general',
    keywords: 'cloud microsoft platform',
    prims: [path(CLOUD, C.blue), path('M50 26 L68 88 H32 Z', C.cyan), path('M50 26 L59 57 H41 Z', C.white)],
  },
  {
    id: 'region',
    label: 'Region',
    category: 'general',
    keywords: 'geography location datacenter availability zone',
    prims: globe(50, 50, 36),
  },
  {
    id: 'subscription',
    label: 'Subscription',
    category: 'general',
    keywords: 'billing account tenant',
    prims: [
      rect(8, 22, 84, 56, C.blue, 7),
      rect(8, 22, 84, 14, C.dark, 7),
      line('M20 50 H62 M20 62 H50', C.white, 5),
      circle(74, 60, 10, C.cyan),
    ],
  },
  {
    id: 'resource-group',
    label: 'Resource group',
    category: 'general',
    keywords: 'rg boundary grouping',
    prims: [
      dashed('M12 20 H88 V80 H12 Z', C.blue, 5),
      ...box3d(30, 34, 40, 34),
    ],
  },
  {
    id: 'azure-user',
    label: 'User',
    category: 'general',
    keywords: 'person actor human client',
    prims: person(50, 30, 1, C.blue),
  },

  // ── Compute ────────────────────────────────────────────────────────────────
  {
    id: 'vm',
    label: 'Virtual machine',
    category: 'compute',
    keywords: 'vm server compute instance iaas',
    prims: [...screen(8, 16, 84, 56), rect(20, 28, 34, 10, C.blue, 2), line('M20 46 H72 M20 56 H60', C.blue, 4)],
  },
  {
    id: 'vmss',
    label: 'VM scale set',
    category: 'compute',
    keywords: 'vmss autoscale scale set virtual machine',
    prims: [
      rect(30, 12, 62, 42, C.cyan, 5),
      rect(19, 22, 62, 42, C.pale, 5),
      ...screen(8, 32, 62, 40),
    ],
  },
  {
    id: 'app-service',
    label: 'App Service',
    category: 'compute',
    keywords: 'web app website paas api app service',
    prims: [
      rect(6, 14, 88, 68, C.blue, 7),
      rect(6, 14, 88, 15, C.dark, 7),
      circle(16, 21, 3.5, C.white),
      circle(27, 21, 3.5, C.white),
      circle(38, 21, 3.5, C.white),
      ...globe(50, 56, 20, C.cyan, C.dark),
    ],
  },
  {
    id: 'app-service-plan',
    label: 'App Service plan',
    category: 'compute',
    keywords: 'asp hosting plan compute sku farm',
    prims: [
      rect(12, 20, 76, 18, C.cyan, 4),
      rect(12, 42, 76, 18, C.blue, 4),
      rect(12, 64, 76, 18, C.dark, 4),
      circle(24, 29, 4, C.dark),
      circle(24, 51, 4, C.white),
      circle(24, 73, 4, C.cyan),
    ],
  },
  {
    id: 'function-app',
    label: 'Function App',
    category: 'compute',
    keywords: 'functions serverless lambda trigger',
    prims: [rect(14, 8, 72, 84, C.blue, 10), bolt(50, 50, 1.55, C.yellow)],
  },
  {
    id: 'batch',
    label: 'Batch',
    category: 'compute',
    keywords: 'job pool hpc parallel task',
    prims: [
      rect(10, 18, 20, 20, C.blue, 3),
      rect(34, 18, 20, 20, C.cyan, 3),
      rect(10, 42, 20, 20, C.cyan, 3),
      rect(34, 42, 20, 20, C.blue, 3),
      rect(10, 66, 20, 20, C.blue, 3),
      rect(34, 66, 20, 20, C.cyan, 3),
      arrowRight(62, 52, 30, 10, C.dark),
    ],
  },
  {
    id: 'service-fabric',
    label: 'Service Fabric',
    category: 'compute',
    keywords: 'microservices cluster mesh stateful',
    prims: [
      hexagon(50, 28, 22, C.cyan),
      hexagon(29, 66, 22, C.blue),
      hexagon(71, 66, 22, C.dark),
    ],
  },

  // ── Containers ─────────────────────────────────────────────────────────────
  {
    id: 'aks',
    label: 'Kubernetes Service (AKS)',
    category: 'containers',
    keywords: 'aks kubernetes k8s cluster orchestration pod',
    prims: [hexagon(50, 50, 44, C.blue), ...helm(50, 50, 25, C.white)],
  },
  {
    id: 'container-instances',
    label: 'Container Instances',
    category: 'containers',
    keywords: 'aci container docker instance',
    prims: [...box3d(10, 22, 80, 60), line('M28 42 V78 M44 42 V78 M60 42 V78', C.white, 4)],
  },
  {
    id: 'container-apps',
    label: 'Container Apps',
    category: 'containers',
    keywords: 'aca serverless container microservice dapr',
    prims: [
      rect(6, 12, 88, 76, C.pale, 8),
      ...box3d(16, 24, 32, 28),
      ...box3d(54, 24, 32, 28),
      ...box3d(35, 56, 32, 28),
    ],
  },
  {
    id: 'container-registry',
    label: 'Container Registry',
    category: 'containers',
    keywords: 'acr registry image repository docker',
    prims: [
      ...box3d(28, 8, 44, 30),
      ...box3d(8, 46, 44, 30),
      ...box3d(52, 46, 40, 30),
    ],
  },

  // ── Web ────────────────────────────────────────────────────────────────────
  {
    id: 'static-web-app',
    label: 'Static Web App',
    category: 'web',
    keywords: 'swa static site jamstack frontend spa',
    prims: [
      rect(6, 16, 88, 68, C.blue, 7),
      rect(6, 16, 88, 15, C.dark, 7),
      circle(16, 23, 3.5, C.white),
      circle(27, 23, 3.5, C.white),
      tag('</>', 50, 66, 30, C.cyan),
    ],
  },
  {
    id: 'signalr',
    label: 'SignalR Service',
    category: 'web',
    keywords: 'websocket realtime push broadcast hub',
    prims: [
      circle(30, 50, 12, C.blue),
      line('M48 34 A22 22 0 0 1 48 66', C.cyan, 6),
      line('M60 24 A34 34 0 0 1 60 76', C.blue, 6),
      line('M72 14 A46 46 0 0 1 72 86', C.dark, 6),
    ],
  },

  // ── Storage ────────────────────────────────────────────────────────────────
  {
    id: 'storage-account',
    label: 'Storage account',
    category: 'storage',
    keywords: 'storage account disk persistence',
    prims: [...cylinder(18, 12, 64, 76), line('M24 52 H76 M24 66 H76', C.white, 4)],
  },
  {
    id: 'blob-storage',
    label: 'Blob Storage',
    category: 'storage',
    keywords: 'blob object container unstructured bucket',
    prims: [
      ...cylinder(18, 12, 64, 76),
      circle(38, 48, 8, C.white),
      circle(60, 56, 6, C.white),
      circle(44, 68, 5, C.white),
    ],
  },
  {
    id: 'table-storage',
    label: 'Table Storage',
    category: 'storage',
    keywords: 'table nosql key value entity row column',
    prims: [
      rect(8, 16, 84, 68, C.blue, 5),
      rect(8, 16, 84, 18, C.dark, 5),
      line('M8 34 H92 M8 51 H92 M8 68 H92', C.white, 3.5),
      line('M36 16 V84 M64 16 V84', C.white, 3.5),
    ],
  },
  {
    id: 'queue-storage',
    label: 'Queue Storage',
    category: 'storage',
    keywords: 'queue message fifo buffer',
    prims: [
      rect(10, 20, 58, 16, C.cyan, 3),
      rect(10, 42, 58, 16, C.blue, 3),
      rect(10, 64, 58, 16, C.dark, 3),
      arrowRight(74, 50, 18, 9, C.blue),
    ],
  },
  {
    id: 'file-storage',
    label: 'File share',
    category: 'storage',
    keywords: 'files smb nfs share folder',
    prims: [
      path('M8 26 H40 L48 36 H92 V80 H8 Z', C.blue),
      path('M8 26 H40 L48 36 H8 Z', C.dark),
      line('M24 52 H76 M24 64 H62', C.pale, 5),
    ],
  },
  {
    id: 'data-lake',
    label: 'Data Lake Storage',
    category: 'storage',
    keywords: 'adls gen2 hierarchical big data lake',
    prims: [
      ...cylinder(18, 8, 64, 56),
      line('M14 74 c8 -7 14 -7 22 0 s14 7 22 0 s14 -7 22 0', C.cyan, 6),
      line('M14 88 c8 -7 14 -7 22 0 s14 7 22 0 s14 -7 22 0', C.blue, 6),
    ],
  },
  {
    id: 'managed-disk',
    label: 'Managed disk',
    category: 'storage',
    keywords: 'disk ssd vhd volume block',
    prims: [circle(50, 50, 40, C.blue), ring(50, 50, 26, C.cyan, 8), circle(50, 50, 9, C.white)],
  },

  // ── Databases ──────────────────────────────────────────────────────────────
  {
    id: 'sql-database',
    label: 'SQL Database',
    category: 'databases',
    keywords: 'sql azure sql relational tsql mssql database',
    prims: [...cylinder(14, 14, 72, 72), tag('SQL', 50, 62, 26, C.white)],
  },
  {
    id: 'sql-managed-instance',
    label: 'SQL Managed Instance',
    category: 'databases',
    keywords: 'sql mi managed instance lift shift',
    prims: [...cylinder(14, 14, 72, 72), tag('MI', 50, 62, 28, C.white)],
  },
  {
    id: 'sql-server',
    label: 'SQL Server',
    category: 'databases',
    keywords: 'sql logical server host mssql',
    prims: [
      rect(10, 18, 80, 20, C.blue, 4),
      rect(10, 42, 80, 20, C.blue, 4),
      rect(10, 66, 80, 20, C.dark, 4),
      circle(22, 28, 4, C.cyan),
      circle(22, 52, 4, C.cyan),
      circle(22, 76, 4, C.cyan),
      line('M36 28 H80 M36 52 H80 M36 76 H80', C.pale, 4),
    ],
  },
  {
    id: 'cosmos-db',
    label: 'Cosmos DB',
    category: 'databases',
    keywords: 'cosmos nosql document mongo cassandra gremlin global',
    prims: [
      ...globe(50, 50, 30, C.blue, C.pale),
      line('M10.1 68.6 A44 16 -25 0 1 89.9 31.4 A44 16 -25 0 1 10.1 68.6', C.cyan, 5),
    ],
  },
  {
    id: 'postgresql',
    label: 'Database for PostgreSQL',
    category: 'databases',
    keywords: 'postgres postgresql relational flexible server',
    prims: [...cylinder(14, 14, 72, 72, C.dark, C.cyan), tag('PG', 50, 62, 28, C.white)],
  },
  {
    id: 'mysql',
    label: 'Database for MySQL',
    category: 'databases',
    keywords: 'mysql mariadb relational flexible server',
    prims: [...cylinder(14, 14, 72, 72, C.teal, C.cyan), tag('My', 50, 62, 28, C.white)],
  },
  {
    id: 'redis-cache',
    label: 'Cache for Redis',
    category: 'databases',
    keywords: 'redis cache in memory key value session',
    prims: [...cylinder(14, 18, 72, 68, C.red, '#F1707B'), bolt(50, 54, 1.05, C.white)],
  },
  {
    id: 'synapse',
    label: 'Synapse Analytics',
    category: 'databases',
    keywords: 'synapse data warehouse sql pool dedicated analytics',
    prims: [
      ...cylinder(20, 46, 60, 44),
      rect(24, 26, 12, 16, C.cyan, 2),
      rect(44, 14, 12, 28, C.blue, 2),
      rect(64, 20, 12, 22, C.dark, 2),
    ],
  },

  // ── Networking ─────────────────────────────────────────────────────────────
  {
    id: 'vnet',
    label: 'Virtual network',
    category: 'networking',
    keywords: 'vnet network address space topology',
    prims: [
      rect(6, 16, 88, 68, C.pale, 8),
      nodeLink([28, 38], [72, 38], C.blue),
      nodeLink([28, 38], [50, 66], C.blue),
      nodeLink([72, 38], [50, 66], C.blue),
      circle(28, 38, 10, C.blue),
      circle(72, 38, 10, C.blue),
      circle(50, 66, 10, C.dark),
    ],
  },
  {
    id: 'subnet',
    label: 'Subnet',
    category: 'networking',
    keywords: 'subnet cidr range segment',
    prims: [
      dashed('M8 20 H92 V80 H8 Z', C.blue, 5),
      rect(24, 38, 22, 22, C.cyan, 3),
      rect(56, 38, 22, 22, C.blue, 3),
    ],
  },
  {
    id: 'load-balancer',
    label: 'Load balancer',
    category: 'networking',
    keywords: 'lb layer4 distribute backend pool traffic',
    prims: [
      nodeLink([28, 50], [72, 22], C.blue),
      nodeLink([28, 50], [72, 50], C.blue),
      nodeLink([28, 50], [72, 78], C.blue),
      circle(20, 50, 13, C.dark),
      circle(78, 22, 11, C.cyan),
      circle(78, 50, 11, C.cyan),
      circle(78, 78, 11, C.cyan),
    ],
  },
  {
    id: 'application-gateway',
    label: 'Application Gateway',
    category: 'networking',
    keywords: 'appgw waf layer7 ingress routing',
    prims: [
      path('M14 84 V44 A36 36 0 0 1 86 44 V84 H66 V44 A16 16 0 0 0 34 44 V84 Z', C.blue),
      arrowRight(30, 66, 40, 10, C.cyan),
    ],
  },
  {
    id: 'front-door',
    label: 'Front Door',
    category: 'networking',
    keywords: 'afd global edge cdn waf routing anycast',
    prims: [
      ...globe(38, 50, 28, C.blue, C.pale),
      rect(58, 26, 34, 58, C.dark, 4),
      rect(64, 32, 22, 46, C.cyan, 2),
      circle(69, 56, 3.5, C.dark),
    ],
  },
  {
    id: 'traffic-manager',
    label: 'Traffic Manager',
    category: 'networking',
    keywords: 'dns routing failover geographic priority weighted',
    prims: [
      ...globe(50, 50, 26, C.blue, C.pale),
      arrowRight(78, 26, 18, 7, C.cyan),
      arrowRight(78, 50, 18, 7, C.cyan),
      arrowRight(78, 74, 18, 7, C.cyan),
    ],
  },
  {
    id: 'dns-zone',
    label: 'DNS zone',
    category: 'networking',
    keywords: 'dns zone record name resolution',
    prims: [...globe(50, 40, 30, C.blue, C.pale), rect(18, 68, 64, 24, C.dark, 4), tag('DNS', 50, 86, 19, C.white)],
  },
  {
    id: 'public-ip',
    label: 'Public IP address',
    category: 'networking',
    keywords: 'ip address public endpoint frontend',
    prims: [
      ...globe(30, 38, 24, C.blue, C.pale),
      rect(34, 62, 58, 26, C.dark, 4),
      line('M42 72 H84 M42 80 H70', C.cyan, 4),
    ],
  },
  {
    id: 'nsg',
    label: 'Network security group',
    category: 'networking',
    keywords: 'nsg firewall rule inbound outbound acl security',
    prims: [
      shield(50, 8, 76, 84, C.blue),
      line('M28 42 H72 M28 58 H72 M40 26 V76 M60 26 V76', C.pale, 4),
    ],
  },
  {
    id: 'firewall',
    label: 'Firewall',
    category: 'networking',
    keywords: 'firewall filter threat intelligence egress',
    prims: [
      rect(8, 44, 84, 14, C.blue, 2),
      rect(8, 62, 84, 14, C.blue, 2),
      rect(8, 80, 84, 12, C.blue, 2),
      line('M36 44 V58 M64 44 V58 M22 62 V76 M50 62 V76 M78 62 V76', C.pale, 4),
      path('M50 4 C60 18 70 24 70 34 A20 20 0 1 1 30 34 C30 24 40 18 50 4 Z', C.orange),
    ],
  },
  {
    id: 'vpn-gateway',
    label: 'VPN Gateway',
    category: 'networking',
    keywords: 'vpn site to site point ipsec tunnel hybrid',
    prims: [
      rect(6, 34, 26, 32, C.blue, 4),
      rect(68, 34, 26, 32, C.blue, 4),
      line('M32 50 H68', C.dark, 6),
      ...padlock(38, 30, 24, 40, C.cyan, C.dark),
    ],
  },
  {
    id: 'expressroute',
    label: 'ExpressRoute',
    category: 'networking',
    keywords: 'expressroute private peering circuit hybrid on premises',
    prims: [
      circle(18, 50, 16, C.dark),
      circle(82, 50, 16, C.blue),
      line('M34 40 H66 M34 60 H66', C.cyan, 7),
    ],
  },
  {
    id: 'cdn',
    label: 'CDN profile',
    category: 'networking',
    keywords: 'cdn edge cache pop content delivery',
    prims: [
      ...globe(50, 50, 24, C.blue, C.pale),
      circle(14, 22, 8, C.cyan),
      circle(86, 22, 8, C.cyan),
      circle(14, 78, 8, C.cyan),
      circle(86, 78, 8, C.cyan),
      line('M28 34 L20 28 M72 34 L80 28 M28 66 L20 72 M72 66 L80 72', C.blue, 4),
    ],
  },
  {
    id: 'private-link',
    label: 'Private Link',
    category: 'networking',
    keywords: 'private endpoint link peering secure',
    prims: [
      line('M26 62 L44 44 a13 13 0 0 1 18 18 L56 68', C.blue, 9),
      line('M74 38 L56 56 a13 13 0 0 1 -18 -18 L44 32', C.cyan, 9),
      ...padlock(38, 8, 24, 26, C.dark, C.blue),
    ],
  },
  {
    id: 'nic',
    label: 'Network interface',
    category: 'networking',
    keywords: 'nic interface adapter card ethernet',
    prims: [
      rect(10, 28, 80, 44, C.blue, 4),
      rect(22, 40, 24, 20, C.cyan, 2),
      line('M56 40 H80 M56 50 H80 M56 60 H80', C.pale, 4),
      line('M26 72 V84 M50 72 V84 M74 72 V84', C.dark, 5),
    ],
  },

  // ── Integration ────────────────────────────────────────────────────────────
  {
    id: 'api-management',
    label: 'API Management',
    category: 'integration',
    keywords: 'apim gateway api product policy developer portal',
    prims: [hexagon(50, 50, 44, C.blue), tag('API', 50, 60, 26, C.white)],
  },
  {
    id: 'service-bus',
    label: 'Service Bus',
    category: 'integration',
    keywords: 'servicebus queue topic subscription message broker',
    prims: [
      rect(6, 44, 88, 14, C.blue, 6),
      nodeLink([26, 44], [26, 26], C.dark),
      nodeLink([50, 58], [50, 76], C.dark),
      nodeLink([74, 44], [74, 26], C.dark),
      circle(26, 20, 11, C.cyan),
      circle(74, 20, 11, C.cyan),
      circle(50, 82, 11, C.dark),
    ],
  },
  {
    id: 'event-grid',
    label: 'Event Grid',
    category: 'integration',
    keywords: 'eventgrid pubsub topic subscription reactive event',
    prims: [
      nodeLink([50, 50], [18, 22], C.blue),
      nodeLink([50, 50], [82, 22], C.blue),
      nodeLink([50, 50], [18, 78], C.blue),
      nodeLink([50, 50], [82, 78], C.blue),
      nodeLink([50, 50], [50, 12], C.blue),
      nodeLink([50, 50], [50, 88], C.blue),
      circle(18, 22, 9, C.cyan),
      circle(82, 22, 9, C.cyan),
      circle(18, 78, 9, C.cyan),
      circle(82, 78, 9, C.cyan),
      circle(50, 12, 9, C.cyan),
      circle(50, 88, 9, C.cyan),
      circle(50, 50, 14, C.dark),
    ],
  },
  {
    id: 'event-hubs',
    label: 'Event Hubs',
    category: 'integration',
    keywords: 'eventhub kafka stream ingest telemetry partition',
    prims: [
      path('M8 14 H92 L60 52 V86 L40 76 V52 Z', C.blue),
      circle(24, 26, 6, C.cyan),
      circle(50, 26, 6, C.cyan),
      circle(76, 26, 6, C.cyan),
    ],
  },
  {
    id: 'logic-apps',
    label: 'Logic Apps',
    category: 'integration',
    keywords: 'logic app workflow connector automation flow',
    prims: [
      line('M50 16 A34 34 0 1 1 22 32', C.blue, 8),
      path('M50 4 L64 16 L50 28 Z', C.blue),
      circle(50, 50, 13, C.cyan),
      circle(50, 50, 5, C.dark),
    ],
  },
  {
    id: 'data-factory',
    label: 'Data Factory',
    category: 'integration',
    keywords: 'adf pipeline etl ingest orchestration copy activity',
    prims: [
      rect(58, 12, 14, 24, C.dark, 2),
      path('M8 88 V50 L34 64 V50 L60 64 V50 L86 64 V88 Z', C.blue),
      rect(20, 72, 14, 16, C.cyan, 2),
      rect(46, 72, 14, 16, C.cyan, 2),
      rect(70, 72, 12, 16, C.cyan, 2),
    ],
  },

  // ── Identity & security ────────────────────────────────────────────────────
  {
    id: 'entra-id',
    label: 'Microsoft Entra ID',
    category: 'identity',
    keywords: 'entra azure ad aad identity directory tenant sso oauth',
    prims: [
      path('M50 8 L12 84 H34 L50 50 Z', C.dark),
      path('M50 8 L88 84 H66 L50 50 Z', C.blue),
      path('M34 84 H66 L50 58 Z', C.cyan),
    ],
  },
  {
    id: 'key-vault',
    label: 'Key Vault',
    category: 'identity',
    keywords: 'keyvault secret certificate key hsm credential',
    prims: [
      shield(50, 6, 76, 88, C.blue),
      ring(42, 44, 13, C.white, 7),
      line('M52 51 L70 69 M62 61 L70 53 M70 69 L78 61', C.white, 7),
    ],
  },
  {
    id: 'managed-identity',
    label: 'Managed identity',
    category: 'identity',
    keywords: 'msi managed identity service principal rbac workload',
    prims: [
      circle(50, 50, 42, C.pale),
      ...person(50, 36, 0.86, C.blue),
      circle(74, 74, 16, C.dark),
      line('M68 78 L78 68 M74 72 L79 77', C.cyan, 5),
    ],
  },

  // ── Analytics & AI ─────────────────────────────────────────────────────────
  {
    id: 'stream-analytics',
    label: 'Stream Analytics',
    category: 'analytics',
    keywords: 'asa streaming realtime query window telemetry',
    prims: [
      line('M6 34 c14 -14 26 14 40 0 s26 14 40 0', C.cyan, 7),
      line('M6 54 c14 -14 26 14 40 0 s26 14 40 0', C.blue, 7),
      line('M6 74 c14 -14 26 14 40 0 s26 14 40 0', C.dark, 7),
    ],
  },
  {
    id: 'ai-search',
    label: 'AI Search',
    category: 'analytics',
    keywords: 'cognitive search index vector semantic query',
    prims: [
      ...doc(10, 8, 54, 68),
      line('M20 42 H48 M20 54 H40', C.pale, 5),
      ...magnifier(62, 62, 22, C.dark, 8),
    ],
  },
  {
    id: 'ai-services',
    label: 'AI Services',
    category: 'analytics',
    keywords: 'openai cognitive services gpt llm vision language ai',
    prims: [
      rect(22, 22, 56, 56, C.blue, 8),
      rect(34, 34, 32, 32, C.cyan, 4),
      line(
        'M36 22 V10 M50 22 V10 M64 22 V10 M36 78 V90 M50 78 V90 M64 78 V90 ' +
          'M22 36 H10 M22 50 H10 M22 64 H10 M78 36 H90 M78 50 H90 M78 64 H90',
        C.dark,
        5,
      ),
    ],
  },
  {
    id: 'machine-learning',
    label: 'Machine Learning',
    category: 'analytics',
    keywords: 'aml ml model training endpoint neural network',
    prims: [
      nodeLink([18, 26], [50, 20], C.cyan, 3.5),
      nodeLink([18, 26], [50, 50], C.cyan, 3.5),
      nodeLink([18, 74], [50, 50], C.cyan, 3.5),
      nodeLink([18, 74], [50, 80], C.cyan, 3.5),
      nodeLink([50, 20], [82, 50], C.cyan, 3.5),
      nodeLink([50, 50], [82, 50], C.cyan, 3.5),
      nodeLink([50, 80], [82, 50], C.cyan, 3.5),
      circle(18, 26, 10, C.cyan),
      circle(18, 74, 10, C.cyan),
      circle(50, 20, 10, C.blue),
      circle(50, 50, 10, C.blue),
      circle(50, 80, 10, C.blue),
      circle(82, 50, 11, C.dark),
    ],
  },
  {
    id: 'databricks',
    label: 'Databricks',
    category: 'analytics',
    keywords: 'databricks spark notebook lakehouse cluster',
    prims: [
      path('M50 8 L92 30 L50 52 L8 30 Z', C.orange),
      path('M8 44 L50 66 L92 44 V56 L50 78 L8 56 Z', C.red),
      path('M8 70 L50 92 L92 70 V78 L50 100 L8 78 Z', C.dark),
    ],
  },

  // ── Management & monitoring ────────────────────────────────────────────────
  {
    id: 'monitor',
    label: 'Monitor',
    category: 'management',
    keywords: 'monitor metrics alert dashboard observability',
    prims: [
      rect(6, 16, 88, 68, C.blue, 7),
      line('M18 66 L36 46 L50 58 L82 28', C.cyan, 6),
      circle(36, 46, 5, C.white),
      circle(50, 58, 5, C.white),
    ],
  },
  {
    id: 'log-analytics',
    label: 'Log Analytics workspace',
    category: 'management',
    keywords: 'log analytics kusto kql workspace query logs',
    prims: [
      ...doc(12, 8, 56, 72),
      line('M22 36 H54 M22 48 H48 M22 60 H54', C.pale, 5),
      ...magnifier(64, 64, 20, C.dark, 8),
    ],
  },
  {
    id: 'app-insights',
    label: 'Application Insights',
    category: 'management',
    keywords: 'appinsights apm telemetry trace dependency performance',
    prims: [
      path('M50 6 A28 28 0 0 1 66 57 V66 H34 V57 A28 28 0 0 1 50 6 Z', C.cyan),
      rect(38, 70, 24, 8, C.dark, 3),
      rect(41, 82, 18, 7, C.dark, 3),
      line('M34 40 L44 40 L48 30 L54 50 L58 40 L66 40', C.dark, 5),
    ],
  },
  {
    id: 'backup-vault',
    label: 'Recovery Services vault',
    category: 'management',
    keywords: 'backup restore recovery vault snapshot disaster',
    prims: [
      rect(8, 18, 84, 66, C.blue, 6),
      ring(50, 51, 22, C.white, 7),
      line('M50 38 V51 L60 58', C.white, 6),
      path('M28 30 L38 40 L28 40 Z', C.cyan),
    ],
  },
]

const BY_ID = new Map(AZURE_ICONS.map((i) => [i.id, i]))

export function azureIcon(id: string | undefined): AzureIcon | undefined {
  return id ? BY_ID.get(id) : undefined
}

export const AZURE_CATEGORY_TITLES: Record<AzureIconCategory, string> = {
  general: 'Azure · General',
  compute: 'Azure · Compute',
  containers: 'Azure · Containers',
  web: 'Azure · Web',
  storage: 'Azure · Storage',
  databases: 'Azure · Databases',
  networking: 'Azure · Networking',
  integration: 'Azure · Integration',
  identity: 'Azure · Identity & security',
  analytics: 'Azure · Analytics & AI',
  management: 'Azure · Management',
}

/** Palette order — matches the grouping used by the Azure architecture docs. */
export const AZURE_CATEGORY_ORDER: AzureIconCategory[] = [
  'general',
  'compute',
  'containers',
  'web',
  'storage',
  'databases',
  'networking',
  'integration',
  'identity',
  'analytics',
  'management',
]

/**
 * Geometry for an icon, scaled from the 100 × 100 icon box into `w × h` and
 * centred (aspect ratio preserved). Unknown ids fall back to the Azure mark.
 */
export function azureIconPrimitives(id: string | undefined, w: number, h: number): BeePrim[] {
  const icon = azureIcon(id) ?? BY_ID.get('azure')!
  const s = Math.min(w, h) / 100
  const ox = (w - 100 * s) / 2
  const oy = (h - 100 * s) / 2
  const transform = `translate(${round(ox)},${round(oy)}) scale(${s.toFixed(4)})`
  return icon.prims.map((p) => ({ ...p, transform }))
}
