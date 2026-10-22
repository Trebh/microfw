import { defineConfig } from "vite"
import { pages } from "./scripts/pages.ts"

/**
 * `vite` serves every page. `vite build --mode <deployment>` builds one deployment from its page
 * into `dist/<deployment>`; the mode also selects `.env.<deployment>` for build-time settings.
 */
export default defineConfig(({ command, mode }) => {
  if (command === "serve") return {}
  const page = Object.hasOwn(pages, mode) ? pages[mode] : undefined
  if (page === undefined) {
    throw new Error(`unknown deployment "${mode}"; build with --mode ${Object.keys(pages).join("|")}`)
  }
  return {
    build: {
      outDir: `dist/${mode}`,
      rollupOptions: { input: { [mode]: page } }
    }
  }
})
