import { parseManifest, type DriveFile, type DriveSession, type Manifest } from "./drive.ts";

export type LibraryTransport = Pick<DriveSession, "file" | "annotationFiles" | "annotation" | "saveAnnotation">;
export type OfflineLibrary = { id: string; manifest: Manifest; savedAt: number };

/** Private document storage is separate from the public service-worker shell cache.
 * No tokens or authenticated HTTP responses are stored. Keys include the library and exact file version. */
export class OfflineLibraryStore {
  private name: string;
  constructor(name = `papeer-documents:${new URL(".", location.href).pathname}`) { this.name = name; }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const name of ["libraries", "files", "annotations"]) request.result.createObjectStore(name);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("端末の保存領域を開けません。他のPapeerの画面を閉じて再試行してください。"));
      request.onsuccess = () => resolve(request.result);
    });
  }

  private async access<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = action(transaction.objectStore(store));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error ?? request.error);
        transaction.onerror = () => reject(transaction.error ?? request.error);
      });
    } finally { db.close(); }
  }

  async libraries(): Promise<OfflineLibrary[]> {
    const rows = await this.access<OfflineLibrary[]>("libraries", "readonly", store => store.getAll());
    return rows.map(row => ({ ...row, manifest: parseManifest(row.manifest) })).sort((a, b) => b.savedAt - a.savedAt);
  }
  async saveLibrary(id: string, manifest: Manifest): Promise<void> {
    await this.access("libraries", "readwrite", store => store.put({ id, manifest, savedAt: Date.now() }, id));
  }
  private fileKey(libraryId: string, file: DriveFile) {
    return JSON.stringify([libraryId, file.id, file.sha256, file.size, file.mime]);
  }
  async file(libraryId: string, file: DriveFile): Promise<Blob> {
    const blob = await this.access<Blob | undefined>("files", "readonly", store => store.get(this.fileKey(libraryId, file)));
    if (!(blob instanceof Blob) || blob.size !== file.size) {
      throw new Error("この資料は端末に保存されていません。オンラインで一度開いてから、オフラインでお読みください。");
    }
    return blob;
  }
  async saveFile(libraryId: string, file: DriveFile, blob: Blob): Promise<void> {
    await this.access("files", "readwrite", store => store.put(blob, this.fileKey(libraryId, file)));
  }
  async annotation<T>(libraryId: string, id: string): Promise<T | undefined> {
    return this.access("annotations", "readonly", store => store.get(JSON.stringify([libraryId, id])));
  }
  async saveAnnotation(libraryId: string, id: string, value: unknown): Promise<void> {
    await this.access("annotations", "readwrite", store => store.put(value, JSON.stringify([libraryId, id])));
  }
  async localAnnotations(libraryId: string): Promise<{ id: string; name: string; size: string }[]> {
    const keys = await this.access("annotations", "readonly", store => store.getAllKeys());
    return keys.flatMap(key => {
      const [library, id] = JSON.parse(String(key)) as [string, string];
      return library === libraryId && id.startsWith("local:")
        ? [{ id, name: `ink-${id.slice(6)}.json`, size: "0" }] : [];
    });
  }
  async clear(): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(["libraries", "files", "annotations"], "readwrite");
        for (const name of ["libraries", "files", "annotations"]) transaction.objectStore(name).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }
}

/** Online reads still prove Drive access and verify the hash in DriveSession.file.
 * Offline reads never fall back to a different revision or another library. */
export function offlineLibraryTransport(session: LibraryTransport, store: OfflineLibraryStore, libraryId: string,
  localOnly: boolean, storageFailed: () => void): LibraryTransport {
  const offline = () => localOnly || !navigator.onLine;
  const assertActive = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
  return {
    async file(file, signal) {
      assertActive(signal);
      if (offline()) {
        const blob = await store.file(libraryId, file); assertActive(signal); return blob;
      }
      const blob = await session.file(file, signal);
      assertActive(signal);
      try { await store.saveFile(libraryId, file, blob); } catch { storageFailed(); }
      assertActive(signal); return blob;
    },
    async annotationFiles(id, signal) {
      assertActive(signal);
      if (offline()) return [...await store.annotation<Awaited<ReturnType<DriveSession["annotationFiles"]>>>(id, "list") ?? [],
        ...await store.localAnnotations(id)];
      const files = await session.annotationFiles(id, signal);
      assertActive(signal);
      try { await store.saveAnnotation(id, "list", files); } catch { storageFailed(); }
      return files;
    },
    async annotation(id, signal) {
      assertActive(signal);
      if (offline()) {
        const value = await store.annotation(libraryId, id);
        if (!value) throw new Error("この書き込みは端末に保存されていません。オンラインでライブラリを開き直してください。");
        return value;
      }
      const value = await session.annotation(id, signal);
      assertActive(signal);
      try { await store.saveAnnotation(libraryId, id, value); } catch { storageFailed(); }
      return value;
    },
    async saveAnnotation(id, folder, operationId, operation) {
      if (offline()) throw new Error("オンラインでGoogleにログインすると送信できます。");
      // Keep our own immutable edits for later offline viewing even after Drive
      // acknowledges the upload and the durable pending queue is removed.
      try { await store.saveAnnotation(id, `local:${operationId}`, operation); } catch { storageFailed(); }
      return session.saveAnnotation(id, folder, operationId, operation);
    },
  };
}
