import type { BeeAnchor, BeeArrowHead, BeeEdgeRoute, BeeNodeStyle, BeeNodeType, BeeShape } from '../types'
import { AZURE_CATEGORY_ORDER, AZURE_CATEGORY_TITLES, AZURE_ICONS } from './azureIcons'
import { BEE_ANCHORS_ALL, BEE_EDGE_ROUTES } from './beeModel'
import {
  BEE_ARROW_HEADS,
  BEE_NODE_TYPES,
  BEE_SHAPES,
  defaultShapeSize,
  shapeFillParts,
} from './shapes'
import { libraryItemSize, SHAPE_LIBRARY } from './shapeLibrary'

/**
 * A machine-readable description of everything a BeeDiagram can be built from:
 * shapes, Azure stencils, palette groups, anchors, routes and arrow heads.
 *
 * The studio is the source of truth. `scripts/gen-diagram-catalog.mjs` renders
 * this object to `src/BeeDocs.Mcp/diagram-catalog.json`, which the MCP server
 * embeds and serves — so an agent building a diagram sees exactly the shapes a
 * human sees in the palette, and adding a shape in one place updates both.
 */

/** Bump when the catalog's *shape* changes, not when shapes are added to it. */
export const DIAGRAM_CATALOG_VERSION = 1

export type CatalogShape = {
  id: BeeShape
  /** Default size when the caller gives no w/h. */
  w: number
  h: number
  /**
   * Named fill slots. More than one means the shape is multi-part and honours
   * `style.fill2` (container header/body, cube front/top, cylinder body/top…).
   */
  fills: { key: 'fill' | 'fill2'; label: string }[]
  /** shape=azure additionally needs `icon` to pick a stencil. */
  needsIcon?: true
  /** shape=image additionally honours `imageUrl`. */
  needsImageUrl?: true
}

export type CatalogPaletteItem = {
  id: string
  label: string
  shape?: BeeShape
  legacyType?: BeeNodeType
  icon?: string
  /** Label the palette puts on a freshly dropped shape. */
  preset?: string
  style?: BeeNodeStyle
  w: number
  h: number
  keywords?: string
}

export type CatalogPaletteGroup = {
  id: string
  title: string
  items: CatalogPaletteItem[]
}

export type DiagramCatalog = {
  version: number
  nodeTypes: BeeNodeType[]
  shapes: CatalogShape[]
  azure: {
    categories: { id: string; title: string }[]
    icons: { id: string; label: string; category: string; keywords?: string }[]
  }
  palette: CatalogPaletteGroup[]
  anchors: BeeAnchor[]
  edgeRoutes: { id: BeeEdgeRoute; label: string; hint: string }[]
  arrowHeads: BeeArrowHead[]
}

export function buildDiagramCatalog(): DiagramCatalog {
  return {
    version: DIAGRAM_CATALOG_VERSION,
    nodeTypes: BEE_NODE_TYPES,
    shapes: BEE_SHAPES.map((id): CatalogShape => {
      const size = defaultShapeSize(id)
      return {
        id,
        w: size.w,
        h: size.h,
        fills: shapeFillParts(id),
        ...(id === 'azure' ? { needsIcon: true as const } : {}),
        ...(id === 'image' ? { needsImageUrl: true as const } : {}),
      }
    }),
    azure: {
      categories: AZURE_CATEGORY_ORDER.map((id) => ({ id, title: AZURE_CATEGORY_TITLES[id] })),
      icons: AZURE_ICONS.map(({ id, label, category, keywords }) => ({ id, label, category, keywords })),
    },
    palette: SHAPE_LIBRARY.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item): CatalogPaletteItem => {
        const size = libraryItemSize(item)
        return {
          id: item.id,
          label: item.label,
          shape: item.shape,
          legacyType: item.legacyType,
          icon: item.icon,
          preset: item.preset,
          style: item.style,
          w: size.w,
          h: size.h,
          keywords: item.keywords,
        }
      }),
    })),
    anchors: BEE_ANCHORS_ALL,
    edgeRoutes: BEE_EDGE_ROUTES,
    arrowHeads: BEE_ARROW_HEADS,
  }
}
