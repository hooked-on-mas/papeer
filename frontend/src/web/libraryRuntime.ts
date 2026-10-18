import type { ArtifactStore, ArtifactView, DocumentPagesView, LibraryItemView, ReadonlyLibraryQuery, RuntimeScope } from "../runtime/contracts.ts";
import { webLibraryCapabilities, type LibraryCapabilities } from "../runtime/capabilities.ts";
import { toLibraryItems } from "../runtime/libraryItems.ts";
import { fileLabel, itemFiles, type DriveFile, type DriveSession, type Manifest } from "./drive.ts";

type FileReader = Pick<DriveSession, "file">;
type ReadingRows = { bookmarks: Record<string, unknown>[]; messages: Record<string, unknown>[] };

export interface DriveLibraryRuntime {
  readonly scope: RuntimeScope;
  readonly query: ReadonlyLibraryQuery;
  readonly artifacts: ArtifactStore;
  readonly capabilities: LibraryCapabilities;
  /** Call on logout, account change, library switch, or snapshot replacement. */
  dispose(): void;
}

function abortError(): DOMException {
  return new DOMException("The library read was cancelled.", "AbortError");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readingRows(value: unknown): ReadingRows {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("保存された読書データの形式が不正です。");
  const source = value as Record<string, unknown>;
  const result: ReadingRows = { bookmarks: [], messages: [] };
  for (const key of ["bookmarks", "messages"] as const) {
    const rows = source[key] ?? [];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("保存された読書データの形式が不正です。");
    }
    result[key] = rows as Record<string, unknown>[];
  }
  return result;
}

/** One immutable snapshot and one login epoch. DriveSession remains the authenticated transport. */
export function createDriveLibraryRuntime(session: FileReader, scope: RuntimeScope, manifest: Manifest): DriveLibraryRuntime {
  if (scope.revision !== manifest.revision) throw new Error("ライブラリの世代が一致しません。");
  const runtimeScope = Object.freeze({ ...scope });
  const instance = crypto.randomUUID();
  const items: readonly LibraryItemView[] = Object.freeze(toLibraryItems(manifest.items));
  const itemIds = new Set(items.map(item => item.id));
  const byId = new Map<string, { view: ArtifactView; path: string; file: DriveFile }>();
  const byPath = new Map<string, ArtifactView>();
  // Only the existing document namespaces are browsable. Never expose settings/library-data.json.
  const paths = Object.keys(manifest.files).filter(path => /^(papers|web)\//.test(path)).sort();
  for (const [index, path] of paths.entries()) {
    const file = { ...manifest.files[path] };
    const filename = path.split("/").pop()!;
    const owner = /^(?:papers|web)\/([a-f0-9]{32})\//.exec(path)?.[1] ?? null;
    const source = /^papers\/([a-f0-9]{32})\/(original|translated)\.pdf$/.exec(path);
    const role = source?.[2] ?? /^web\/[a-f0-9]{32}\/(original|translated)-annotated\.pdf$/.exec(path)?.[1]
      ?? (/^papers\/[a-f0-9]{32}\/(?:translation\.md|translation-pages\/.*\.pdf)$/.test(path) ? "translated" : undefined);
    const view: ArtifactView = Object.freeze({
      id: `artifact-${instance}-${index}`, itemId: owner,
      label: fileLabel(path, manifest), filename, mediaType: file.mime,
      role: role === "original" || role === "translated" ? role : path.includes("/attachments/") ? "attachment" : "other",
      ...(source ? { annotationTarget: Object.freeze({ paperId: source[1], side: source[2] as "original" | "translated", sourceSha256: file.sha256 }) } : {}),
    });
    byId.set(view.id, { view, path, file });
    byPath.set(path, view);
  }
  const allArtifacts = Object.freeze(paths.map(path => byPath.get(path)!));
  const artifactsByItem = new Map(items.map(item => [item.id, Object.freeze(itemFiles(manifest, item.id).map(path => byPath.get(path)!))]));
  const readingFile = manifest.files["library-data.json"] ? { ...manifest.files["library-data.json"] } : undefined;
  const pagesFile = manifest.files["web-reading.json"] ? { ...manifest.files["web-reading.json"] } : undefined;
  let savedReading: ReadingRows | undefined;
  let documentPages: Map<string, DocumentPagesView> | undefined;
  let disposed = false;
  const pending = new Set<AbortController>();
  const assertActive = () => { if (disposed) throw abortError(); };

  async function read<T>(action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertActive();
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    pending.add(controller);
    let rejectCancelled: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = () => reject(abortError()); });
    controller.signal.addEventListener("abort", rejectCancelled, { once: true });
    try {
      // Settle promptly even if transport/body parsing ignores abort, and discard its late result.
      const result = await Promise.race([action(controller.signal), cancelled]);
      if (controller.signal.aborted || disposed) throw abortError();
      return result;
    } finally {
      pending.delete(controller);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", rejectCancelled);
    }
  }

  const query: ReadonlyLibraryQuery = {
    listItems() { assertActive(); return items; },
    listArtifacts(itemId) { assertActive(); return itemId === null ? allArtifacts : artifactsByItem.get(itemId) ?? []; },
    readSavedReading(itemId, signal) {
      return read(async activeSignal => {
        if (!itemIds.has(itemId)) throw new Error("ライブラリの項目が見つかりません。");
        if (!readingFile) return { notes: [], messages: [] };
        if (!savedReading) {
          const content = await (await session.file(readingFile, activeSignal)).text();
          if (activeSignal.aborted) throw abortError();
          savedReading = readingRows(JSON.parse(content));
        }
        return {
          notes: savedReading.bookmarks.filter(row => row.paper_id === itemId).map((row, index) => ({
            id: String(row.id ?? `note-${index}`), page: typeof row.page === "number" && Number.isSafeInteger(row.page) && row.page > 0 ? row.page : null,
            side: row.side === "translated" ? "translated" as const : "original" as const,
            label: text(row.label), quote: text(row.quote), note: text(row.note),
          })),
          messages: savedReading.messages.filter(row => row.paper_id === itemId).map((row, index) => ({
            id: String(row.id ?? `message-${index}`),
            role: row.role === "user" ? "user" as const : row.role === "assistant" ? "assistant" as const : "other" as const,
            content: text(row.content),
          })),
        };
      }, signal);
    },
    readDocumentPages(itemId, signal) {
      return read(async activeSignal => {
        if (!itemIds.has(itemId)) throw new Error("ライブラリの項目が見つかりません。");
        if (!pagesFile) return null;
        if (!documentPages) {
          const content = await (await session.file(pagesFile, activeSignal)).text();
          if (activeSignal.aborted) throw abortError();
          const value: unknown = JSON.parse(content);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("保存されたページ対応の形式が不正です。");
          const data = value as { version?: unknown; items?: unknown };
          if (data.version !== 1 || !data.items || typeof data.items !== "object" || Array.isArray(data.items)) {
            throw new Error("保存されたページ対応の形式が不正です。");
          }
          const parsed = new Map<string, DocumentPagesView>();
          for (const [id, entry] of Object.entries(data.items)) {
            if (!itemIds.has(id)) continue;
            const row = entry as { pageCount?: unknown; translatedPages?: unknown } | null;
            if (!row || typeof row.pageCount !== "number" || !Number.isSafeInteger(row.pageCount) || row.pageCount < 0 || row.pageCount > 100000
              || !row.translatedPages || typeof row.translatedPages !== "object" || Array.isArray(row.translatedPages)) {
              throw new Error("保存されたページ対応の形式が不正です。");
            }
            const translatedPages: Record<string, { artifactId: string; page: number } | null> = {};
            for (const [page, target] of Object.entries(row.translatedPages)) {
              if (!/^[1-9]\d*$/.test(page) || Number(page) > row.pageCount) throw new Error("保存されたページ対応の形式が不正です。");
              if (target === null) { translatedPages[page] = null; continue; }
              const ref = target as { artifactPath?: unknown; page?: unknown } | null;
              if (!ref || typeof ref.artifactPath !== "string" || typeof ref.page !== "number" || !Number.isSafeInteger(ref.page)
                || ref.page < 1 || ref.page > 100000) throw new Error("保存されたページ対応の形式が不正です。");
              const artifact = byPath.get(ref.artifactPath);
              translatedPages[page] = artifact?.itemId === id && artifact.filename.endsWith(".pdf")
                ? Object.freeze({ artifactId: artifact.id, page: ref.page }) : null;
            }
            parsed.set(id, Object.freeze({ pageCount: row.pageCount, translatedPages: Object.freeze(translatedPages) }));
          }
          documentPages = parsed;
        }
        return documentPages.get(itemId) ?? null;
      }, signal);
    },
  };
  const artifacts: ArtifactStore = {
    read(id, signal) {
      return read(activeSignal => {
        const artifact = byId.get(id);
        if (!artifact) throw new Error("資料が見つかりません。ライブラリを開き直してください。");
        return session.file(artifact.file, activeSignal);
      }, signal);
    },
    resolveRelative(baseId, relative) {
      assertActive();
      const base = byId.get(baseId);
      if (!base?.view.itemId || !relative) return undefined;
      try {
        const decoded = decodeURIComponent(relative);
        if (/^[a-z][a-z\d+.-]*:/i.test(decoded.trim()) || /^[\/\\]/.test(decoded.trim()) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return undefined;
        const resolved = new URL(decoded, `https://library.invalid/${base.path}`);
        if (resolved.origin !== "https://library.invalid") return undefined;
        const path = decodeURIComponent(resolved.pathname.slice(1));
        const target = byPath.get(path);
        // Relative references may walk up within this item, never into another item or private metadata.
        return target?.itemId === base.view.itemId ? target : undefined;
      } catch { return undefined; }
    },
  };
  return {
    scope: runtimeScope, query, artifacts,
    capabilities: webLibraryCapabilities(allArtifacts, !!readingFile),
    dispose() {
      disposed = true;
      for (const controller of pending) controller.abort();
      savedReading = undefined;
      documentPages = undefined;
    },
  };
}
