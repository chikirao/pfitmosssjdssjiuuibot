import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    // npm run dev:web + отдельно `wrangler dev` на 8787 — API проксируется туда
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
