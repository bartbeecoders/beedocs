// Renders the studio shape catalog to the JSON the MCP server embeds.
//
//   node scripts/gen-diagram-catalog.mjs            # write
//   node scripts/gen-diagram-catalog.mjs --check    # fail if stale (CI / prebuild)
//
// The studio TypeScript is the single source of truth; this only serialises it,
// so adding a shape or an Azure stencil reaches AI agents without a second edit.
// Runs through Vite's SSR loader so the TS modules resolve exactly as they do in
// the app (no extra toolchain, no duplicated tsconfig paths).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const OUT = resolve(webRoot, '../BeeDocs.Mcp/diagram-catalog.json')

const check = process.argv.includes('--check')

const server = await createServer({
  root: webRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  // Nothing here loads a browser bundle — skipping discovery keeps the
  // dep-scan from racing server.close() and spewing a spurious error.
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const { buildDiagramCatalog } = await server.ssrLoadModule('/src/diagram/catalog.ts')
  const catalog = buildDiagramCatalog()
  const json = `${JSON.stringify(catalog, null, 2)}\n`

  if (check) {
    let current = null
    try {
      current = readFileSync(OUT, 'utf8')
    } catch {
      /* missing counts as stale */
    }
    if (current !== json) {
      console.error(
        `diagram-catalog.json is out of date.\n` +
          `Run: pnpm --dir src/beedocs-web gen:catalog`,
      )
      process.exitCode = 1
    }
  } else {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, json)
    const icons = catalog.azure.icons.length
    console.log(`diagram-catalog.json — ${catalog.shapes.length} shapes, ${icons} Azure stencils`)
  }
} finally {
  await server.close()
}
