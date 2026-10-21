import { defineConfig } from "vite"

/** One page per deployment, plus the demo page that switches placement at runtime. */
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        demo: "index.html",
        "browser-only": "browser-only.html",
        "server-owned": "server-owned.html",
        "server-model": "server-model.html",
        "server-actions": "server-actions.html"
      }
    }
  }
})
