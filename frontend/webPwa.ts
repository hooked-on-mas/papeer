import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Web-only: the native build never emits or registers a service worker. */
export function webPwa(): Plugin {
  return {
    name: "papeer-web-pwa",
    apply: "build",
    // Run after Vite has emitted index.html and its hashed dependencies.
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = new Map<string, string | Uint8Array>();
      for (const [name, entry] of Object.entries(bundle)) {
        if (name === "index.html" || /^assets\/.*\.(?:m?js|css|woff2?)$/.test(name)
            || name === "licenses.md" || name === "geist-OFL.txt") {
          files.set(name, entry.type === "chunk" ? entry.code : entry.source);
        }
      }
      for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
        const source = readFileSync(path.resolve(import.meta.dirname, "web/icons", name));
        files.set(name, source);
        this.emitFile({ type: "asset", fileName: name, source });
      }
      files.set("papeer.png", readFileSync(path.resolve(import.meta.dirname, "public/papeer.png")));
      const manifest = JSON.stringify({
        id: "./", name: "Papeer", short_name: "Papeer", lang: "ja",
        description: "PCで翻訳したPDF・ノートをGoogle Driveから閲覧し、書き込めます。",
        start_url: "./", scope: "./", display: "standalone",
        background_color: "#fafaf9", theme_color: "#fafaf9",
        icons: [
          { src: "./icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "./icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "./icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }, null, 2);
      files.set("manifest.webmanifest", manifest);
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
      const hash = createHash("sha256");
      for (const [name, source] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update(source);
      const source = readFileSync(path.resolve(import.meta.dirname, "web/service-worker.js"), "utf8")
        .replace("__PAPEER_VERSION__", JSON.stringify(hash.digest("hex").slice(0, 20)))
        .replace("__PAPEER_ASSETS__", JSON.stringify([...files.keys()].sort()));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
