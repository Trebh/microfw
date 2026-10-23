import { defineConfig } from "vite"

export default defineConfig({
  // Act V starts its touring company with `{ type: "module" }`, so the worker is bundled as an ES module.
  worker: { format: "es" },
  server: { port: 5180 }
})
