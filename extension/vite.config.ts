import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

// crxjs v2 derives most input/output from the manifest itself (background
// service worker here). The popup HTML lives at index.html and we use it
// as a full-page tab opened via chrome.action.onClicked in background.ts;
// therefore it's NOT a `default_popup` but it must still ship in dist/
// so chrome.runtime.getURL("index.html") resolves.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        app: "index.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});