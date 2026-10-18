import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { pdfjsLegacy } from "./vite.config.ts";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  publicDir: path.resolve(import.meta.dirname, "public"),
  base: "./",
  plugins: [react(), {
    name: "geist-font-license",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "geist-OFL.txt",
        source: readFileSync(path.resolve(import.meta.dirname, "node_modules/@fontsource-variable/geist/LICENSE"), "utf8") });
    },
  }],
  resolve: { alias: pdfjsLegacy },
  build: { outDir: "../web-dist", emptyOutDir: true, license: { fileName: "licenses.md" } },
});
