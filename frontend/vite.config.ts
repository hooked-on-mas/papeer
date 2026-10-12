import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * pdf.js's legacy build in place of its modern one, for react-pdf too (it imports `pdfjs-dist` and
 * `pdfjs-dist/web/pdf_viewer.mjs`). The modern build uses JavaScript that only the newest engines have
 * (Map.prototype.getOrInsertComputed, Promise.try, Math.sumPrecise, Uint8Array.fromBase64...), which
 * macOS's WKWebView (Safari's WebKit of the installed macOS) and Linux's WebKitGTK may lack: no PDF would
 * show at all. The legacy build brings polyfills for them. Windows (WebView2, always a recent Chromium)
 * uses it as well, so that every platform runs the same code. The worker is the legacy one too (PdfPane.tsx).
 */
export const pdfjsLegacy = [
  { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
  { find: /^pdfjs-dist\/web\/pdf_viewer\.mjs$/, replacement: "pdfjs-dist/legacy/web/pdf_viewer.mjs" },
];

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...pdfjsLegacy,
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // Match the packaged window's iframe boundary, including iframe navigations in dev/E2E.
    headers: { "Content-Security-Policy": "frame-src http://127.0.0.1:8000" },
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
