import type { Plugin } from "vite";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/** Keep EPL-only ELK out of distributed JavaScript, even when Mermaid adds lazy imports. */
export function distributionLicenses(): Plugin {
  let publicDirectory = "";
  return {
    name: "distribution-licenses",
    enforce: "pre",
    configResolved(config) { publicDirectory = config.publicDir; },
    buildStart() {
      // Vite copies publicDir verbatim, including ignored files. Refuse accidental local data.
      const inspect = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink() || entry.name === "__pycache__" || entry.name.startsWith(".env")
              || /(?:\.pyc|\.sqlite3?|\.db|\.pdf)$/i.test(entry.name)
              || /^(?:client_secret.*|google-desktop-oauth)\.json$/i.test(entry.name)) {
            this.error(`Local data must not be distributed from public/: ${path.relative(publicDirectory, file)}`);
          }
          if (entry.isDirectory()) inspect(file);
        }
      };
      if (publicDirectory && existsSync(publicDirectory)) inspect(publicDirectory);
    },
    resolveId(source, importer) {
      if (importer?.replaceAll("\\", "/").includes("/mermaid/")
          && /(?:^|\/)elk-[^/]+\.mjs$/.test(source)) {
        return path.resolve(import.meta.dirname, "src/lib/unavailableLayout.ts");
      }
    },
    generateBundle() {
      for (const id of this.getModuleIds()) {
        if (/(?:^|\/)elkjs\//.test(id.replaceAll("\\", "/"))) {
          this.error("ELK must not be included in distributed Papeer builds.");
        }
      }
      for (const [fileName, source] of [
        ["geist-OFL.txt", "node_modules/@fontsource-variable/geist/LICENSE"],
        ["noto-sans-jp-OFL.txt", "distribution-licenses/noto-sans-jp-OFL.txt"],
        ["noto-serif-jp-OFL.txt", "distribution-licenses/noto-serif-jp-OFL.txt"],
        ["third-party/pdf-lib-MIT.txt", "distribution-licenses/pdf-lib-MIT.txt"],
        ["third-party/pdf-lib-fontkit-MIT.txt", "distribution-licenses/pdf-lib-fontkit-MIT.txt"],
        ["third-party/pdf-lib-standard-fonts-MIT.txt", "distribution-licenses/pdf-lib-standard-fonts-MIT.txt"],
        ["third-party/pdf-lib-upng-MIT.txt", "distribution-licenses/pdf-lib-upng-MIT.txt"],
        ["third-party/pako-LICENSE.txt", "distribution-licenses/pako-LICENSE.txt"],
        ["third-party/tslib-1-LICENSE.txt", "distribution-licenses/tslib-1-LICENSE.txt"],
        ["third-party/tslib-1-CopyrightNotice.txt", "distribution-licenses/tslib-1-CopyrightNotice.txt"],
        ["source-han-sans-OFL.txt", "../papeer/core/assets/fonts/source-han-sans-LICENSE.txt"],
        ["source-han-serif-OFL.txt", "../papeer/core/assets/fonts/source-han-serif-LICENSE.txt"],
        ["LICENSE", "../LICENSE"],
        ["SOURCE.md", "../docs/distribution-source.md"],
      ]) {
        this.emitFile({ type: "asset", fileName,
          source: readFileSync(path.resolve(import.meta.dirname, source), "utf8") });
      }
    },
  };
}
