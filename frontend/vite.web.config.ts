import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { pdfjsLegacy } from "./vite.config.ts";
import { webPwa } from "./webPwa.ts";
import { distributionLicenses } from "./buildLicenses.ts";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  cacheDir: path.resolve(import.meta.dirname, "node_modules/.vite-web"),
  base: "./",
  optimizeDeps: {
    include: ["pdfjs-dist/legacy/build/pdf.mjs", "react-pdf", "pdf-lib", "react-markdown", "remark-gfm", "remark-math", "rehype-katex"],
  },
  plugins: [react(), tailwindcss(), webPwa(), {
    name: "web-runtime-boundary",
    generateBundle() {
      for (const moduleId of this.getModuleIds()) {
        const id = moduleId.replaceAll("\\", "/");
        if (/\/node_modules\/@tauri-apps\//.test(id)
            || /\/src\/api\/client\.ts(?:\?|$)/.test(id)
            || /\/src\/features\/settings\//.test(id)
            || /\/src\/app\/(?:actions|appClosing|jobHandlers)\./.test(id)) {
          this.error("WebビルドへPC専用の接続・設定・操作が混入しています。");
        }
      }
    },
  }, distributionLicenses()],
  resolve: { alias: [...pdfjsLegacy, { find: "@", replacement: path.resolve(import.meta.dirname, "./src") }] },
  build: { outDir: "../web-dist", emptyOutDir: true, license: { fileName: "licenses.md" } },
});
