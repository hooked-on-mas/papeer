import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pdfjsLegacy } from "./vite.config.ts";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  base: "./",
  plugins: [react(), tailwindcss(), {
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
  }, {
    name: "geist-font-license",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "geist-OFL.txt",
        source: readFileSync(path.resolve(import.meta.dirname, "node_modules/@fontsource-variable/geist/LICENSE"), "utf8") });
    },
  }],
  resolve: { alias: [...pdfjsLegacy, { find: "@", replacement: path.resolve(import.meta.dirname, "./src") }] },
  build: { outDir: "../web-dist", emptyOutDir: true, license: { fileName: "licenses.md" } },
});
