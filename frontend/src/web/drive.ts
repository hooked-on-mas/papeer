/** The static website talks only to Google, never to a desktop sidecar. */
import type { DriveEditStorage } from '../adapters/drive/editTransfer.ts';
import type { ResourceMetadata } from '../runtime/edits/contracts.ts';
import { createBrowserLegacyDriveRead } from '../adapters/browser/legacyDrive.ts';
export const CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID
  || "208743866503-mtrhc6kjigbp8kc6kqo6fllg23gc70sj.apps.googleusercontent.com";
const API = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const SESSION_KEY = "papeer-google-session:v1";
type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
declare global {
  interface Window {
    google?: { accounts: { oauth2: {
      initTokenClient(options: { client_id: string; scope: string; callback: (result: TokenResponse) => void;
        error_callback: (error: { type: string }) => void }): { requestAccessToken(options: { prompt: string }): void };
    } } };
  }
}

export type Item = { id: string; title?: string; original_name?: string; kind?: string; parent_id?: string | null;
  collection_name?: string; [key: string]: unknown };
export type DriveFile = { id: string; sha256: string; size: number; mime: string };
export type Manifest = { version: 1; updated_at: string; revision: string; items: Item[]; folder_id?: string;
  attachments: { id: string; owner_id: string; format: string; title: string }[]; files: Record<string, DriveFile> };
export type LibraryChoice = { id: string; name: string; modifiedTime: string };
export type Database = Record<string, Record<string, unknown>[]>;

export class DriveHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Driveとの通信に失敗しました (${status})。接続・空き容量・Googleアカウントを確認して再試行してください。`);this.status = status; }
}
/** Actual configured credential receiver; this object contains no bearer value and accepts no ownership booleans. */
export interface ProviderDriveTransport {
  readonly generation: number; readonly storage: DriveEditStorage;
  scopedStorage(signal: AbortSignal): DriveEditStorage;
  assertCurrent(): void; subscribeInvalidation(listener: () => void): () => void;
  about(signal: AbortSignal): Promise<unknown>;
  allocateFileIds(count: number, signal: AbortSignal): Promise<string[]>;
  metadata(id: string, fields: string, signal: AbortSignal): Promise<unknown>;
  bytes(id: string, limit: number, signal: AbortSignal): Promise<Uint8Array>;
  list(q: string, fields: string, signal: AbortSignal): Promise<unknown[]>;
  createMetadata(metadata: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  createJson(metadata: Record<string, unknown>, bytes: Uint8Array, signal: AbortSignal): Promise<unknown>;
}

export class DriveSession {
  private providerStrictRedirect = false;
  private providerScopeSignal?: AbortSignal;
  private token = "";
  private expires = 0;
  private generation = 0;
  private leaseParent?: DriveSession;
  private cancelLogin?: () => void;
  private requests = new Set<AbortController>();
  private flights = new Set<Promise<void>>();
  private invalidationListeners = new Set<() => void>();
  private expiryTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    try {
      const saved = window.sessionStorage?.getItem(SESSION_KEY);
      if (!saved) return;
      const value = JSON.parse(saved);
      if (value?.clientId === CLIENT_ID && value.scope === SCOPE && typeof value.token === "string" && value.token
        && typeof value.expires === "number" && Number.isFinite(value.expires) && value.expires > Date.now()) {
        this.token = value.token; this.expires = value.expires; this.scheduleExpiry();
      } else this.clearToken();
    } catch { this.clearToken(); }
  }

  hasValidToken(): boolean {
    if (this.token && Date.now() < this.expires) return true;
    this.clearToken(); return false;
  }

  private invalidateGeneration() {
    this.generation++;
    for (const request of this.requests) request.abort();
    for (const listener of [...this.invalidationListeners]) { try { listener(); } catch { /* One observer must not prevent another operation aborting. */ } }
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    if (!this.token) return;
    this.expiryTimer = setTimeout(() => { if (Date.now() >= this.expires) this.clearToken(); else this.scheduleExpiry(); }, Math.max(0, Math.min(this.expires - Date.now(), 2_147_483_647)));
    (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
  }
  private clearToken() {
    if (this.leaseParent) { this.leaseParent.clearToken();return; }
    clearTimeout(this.expiryTimer);this.token = '';this.expires = 0;
    try { window.sessionStorage?.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ }
    this.invalidateGeneration();
  }
  subscribeInvalidation(listener: () => void): () => void {
    if (this.leaseParent) return this.leaseParent.subscribeInvalidation(listener);
    this.invalidationListeners.add(listener);return () => { this.invalidationListeners.delete(listener); };
  }

  signIn({ selectAccount = false }: { selectAccount?: boolean } = {}): Promise<void> {
    if (this.leaseParent) return this.leaseParent.signIn({ selectAccount });
    this.cancelSignIn();this.clearToken();
    const oauth = window.google?.accounts.oauth2;
    if (!oauth) return Promise.reject(new Error("Googleのログイン画面を読み込み中です。通信を確認してもう一度お試しください。"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (this.cancelLogin === cancel) this.cancelLogin = undefined;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error("Googleへの接続をキャンセルしました。"));
      const timer = setTimeout(() => finish(new Error("Googleへの接続が時間切れになりました。もう一度ログインしてください。")), 180_000);
      this.cancelLogin = cancel;
      try {
      const client = oauth.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE,
        callback: result => {
          if (settled) return;
          const lifetime = result.expires_in ?? 3600;
          if (!result.access_token || result.error || !Number.isFinite(lifetime) || lifetime <= 0) {
            finish(new Error("Googleへのログインを完了できませんでした。")); return;
          }
          this.clearToken();
          this.token = result.access_token;
          this.expires = Date.now() + lifetime * 1000; this.scheduleExpiry();
          // A tab can reload without another popup, but Google's expiry is never extended.
          // Do not put bearer tokens in localStorage, IndexedDB, or service-worker caches.
          try {
            const storage = window.sessionStorage;
            // A failed write after switching accounts must not leave the previous grant restorable.
            storage?.removeItem(SESSION_KEY);
            storage?.setItem(SESSION_KEY, JSON.stringify({ clientId: CLIENT_ID, scope: SCOPE,
              token: this.token, expires: this.expires }));
          } catch { /* Continue in memory when storage is unavailable. */ }
          finish();
        },
        error_callback: () => finish(new Error("ログイン画面が閉じられたか、ポップアップがブロックされています。")),
      });
      client.requestAccessToken({ prompt: selectAccount ? "select_account" : "" });
      } catch { finish(new Error("Googleへの接続を開始できませんでした。もう一度ログインしてください。")); }
    });
  }

  cancelSignIn() { this.cancelLogin?.(); }
  signOut() {
    this.cancelSignIn(); this.clearToken();
    for (const request of this.requests) request.abort();
  }

  async signOutAndWait(): Promise<void> { this.signOut();await Promise.allSettled([...this.flights]); }

  private checkStatus(response: Response): never {
    if (response.status === 401) { this.clearToken(); throw new Error("再度Googleでログインしてください。"); }
    throw new DriveHttpError(response.status);
  }

  private async fetchChecked<T>(url: string, init: RequestInit, handle: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const signals = [...new Set([signal, this.providerScopeSignal].filter((value): value is AbortSignal => value !== undefined))];
    if (this.leaseParent && this.leaseParent.generation !== this.generation) throw new Error("drive-auth-changed: ログイン状態が変わりました。");
    if (!this.hasValidToken()) throw new Error("ログインの有効期限が切れました。再度Googleでログインしてください。");
    if (signals.some(value => value.aborted)) throw new DOMException('Cancelled', 'AbortError');
    const generation = this.generation;
    const controller = new AbortController(); this.requests.add(controller);
    let settle!: () => void; const flight = new Promise<void>(resolve => { settle = resolve; }); this.flights.add(flight);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
    const cancel = () => controller.abort();
    for (const current of signals) current.addEventListener("abort", cancel, { once: true });
    if (signals.some(current => current.aborted)) controller.abort();
    try {
      const response = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${this.token}` }, signal: controller.signal, cache: "no-store", redirect: this.providerStrictRedirect ? "error" : (init.redirect ?? "follow") });
      if (generation !== this.generation || (this.leaseParent && generation !== this.leaseParent.generation)) throw new Error("ログイン状態が変わりました。再読み込みしてください。");
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const value = await handle(response);
      if (generation !== this.generation || (this.leaseParent && generation !== this.leaseParent.generation)) throw new Error("ログイン状態が変わりました。再読み込みしてください。");
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      return value;
    } catch (error) {
      if (generation !== this.generation || (this.leaseParent && generation !== this.leaseParent.generation)) throw new Error("ログイン状態が変わりました。再読み込みしてください。");
      if (timedOut) throw new Error("Driveとの通信が時間切れになりました。通信を確認して再試行してください。");
      throw error;
    } finally {
      clearTimeout(timer); for (const current of signals) current.removeEventListener("abort", cancel); this.requests.delete(controller); this.flights.delete(flight); settle();
    }
  }

  private request<T>(path: string, read: (response: Response) => Promise<T>, signal?: AbortSignal, init: RequestInit = {}, upload = false, resource: 'files' | 'about' = 'files'): Promise<T> {
    const base = upload ? "https://www.googleapis.com/upload/drive/v3/files" : resource === 'about' ? 'https://www.googleapis.com/drive/v3/about' : API;
    return this.fetchChecked(base + path, init, async response => {
      if (!response.ok) this.checkStatus(response);
      return read(response);
    }, signal);
  }

  private async uploadResumableChunks(location: string, bytes: Uint8Array): Promise<string> {
    const chunkSize = 8 * 1024 * 1024;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      const body = Uint8Array.from(bytes.subarray(offset, end));
      const outcome = await this.fetchChecked<{ done: false } | { done: true; id: string }>(location, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end - 1}/${bytes.byteLength}`,
        },
        body,
      }, async response => {
        if (response.status === 308) {
          if (end >= bytes.byteLength) throw new Error('drive-upload-range');
          const range = response.headers.get('range');
          if (range !== null && range !== `bytes=0-${end - 1}`) throw new Error('drive-upload-range');
          return { done: false };
        }
        if (!response.ok) this.checkStatus(response);
        if (end !== bytes.byteLength) throw new Error('drive-upload-incomplete');
        const saved = await response.json() as { id?: unknown };
        if (typeof saved.id !== 'string' || !/^[\w-]+$/.test(saved.id)) throw new Error('invalid-resource-upload-response');
        return { done: true, id: saved.id };
      });
      if (outcome.done) return outcome.id;
      offset = end;
    }
    throw new Error('drive-upload-incomplete');
  }

  /** Host adapter captures one token lifetime. Canonical scope IDs never select or rebind this receiver. */
  captureProviderTransport(): ProviderDriveTransport {
    this.assertCurrent(); const root = this.leaseParent ?? this;
    const bound: DriveSession = Object.create(root);bound.token = root.token;bound.expires = root.expires;bound.generation = root.generation;bound.leaseParent = root;bound.providerStrictRedirect = true;
    const validId = (id: string) => { if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('invalid-drive-id');return encodeURIComponent(id); };
    return Object.freeze({ generation: root.generation, storage: bound,
      scopedStorage: (signal: AbortSignal): DriveEditStorage => {
        bound.assertCurrent();
        const scoped: DriveSession = Object.create(bound);
        scoped.providerScopeSignal = signal;
        scoped.assertCurrent(); return scoped;
      },
      assertCurrent: () => bound.assertCurrent(), subscribeInvalidation: (listener: () => void) => root.subscribeInvalidation(listener),
      allocateFileIds: async (count: number, signal: AbortSignal) => {
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('drive-id-count');
        const value = await bound.request<{ids?: unknown}>('/generateIds?' + new URLSearchParams({ count: String(count), space: 'drive', type: 'files' }), response => response.json(), signal);
        if (!Array.isArray(value.ids) || value.ids.length !== count || new Set(value.ids).size !== count || value.ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id))) throw new Error('drive-generated-ids');return value.ids as string[];
      },
      about: (signal: AbortSignal) => bound.request('?fields=user(permissionId)', response => response.json(), signal, {}, false, 'about'),
      metadata: (id: string, fields: string, signal: AbortSignal) => bound.request('/' + validId(id) + '?' + new URLSearchParams({ fields, supportsAllDrives: 'true' }), response => response.json(), signal),
      bytes: (id: string, limit: number, signal: AbortSignal) => bound.request('/' + validId(id) + '?alt=media&supportsAllDrives=true', async response => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error('drive-body-limit');
        const declared = response.headers.get('content-length');if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('drive-body-too-large');
        if (!response.body) throw new Error('drive-body-missing');const reader = response.body.getReader(), chunks: Uint8Array[] = [];let length = 0;
        try { while (true) { const next = await reader.read();if (next.done) break;length += next.value.length;if (length > limit) throw new Error('drive-body-too-large');chunks.push(next.value); } }
        catch (error) { await reader.cancel().catch(() => {});throw error; } finally { reader.releaseLock(); }
        const result = new Uint8Array(length);let offset = 0;for (const chunk of chunks) { result.set(chunk, offset);offset += chunk.length; }return result;
      }, signal),
      list: async (q: string, fields: string, signal: AbortSignal) => {
        const result: unknown[] = [], tokens = new Set<string>();let token: string | undefined;
        do { const params = new URLSearchParams({ q, fields: 'nextPageToken,incompleteSearch,files(' + fields + ')', pageSize: '100', corpora: 'user', spaces: 'drive' });if (token) params.set('pageToken', token);
          const page = await bound.request<{ files?: unknown[]; incompleteSearch?: boolean; nextPageToken?: string }>('?' + params, response => response.json(), signal);
          if (!Array.isArray(page.files) || page.incompleteSearch || result.length + page.files.length > 1000) throw new Error('drive-list-incomplete');result.push(...page.files);token = page.nextPageToken;
          if (token !== undefined && (typeof token !== 'string' || !token || tokens.has(token))) throw new Error('drive-list-pagination');if (token) tokens.add(token);
        } while (token !== undefined);return result;
      },
      createMetadata: (metadata: Record<string, unknown>, signal: AbortSignal) => bound.request('?fields=id', response => response.json(), signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }),
      createJson: (metadata: Record<string, unknown>, bytes: Uint8Array, signal: AbortSignal) => {
        const boundary = 'papeer_' + crypto.randomUUID();const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, Uint8Array.from(bytes), `\r\n--${boundary}--`]);
        return bound.request('?uploadType=multipart&fields=id', response => response.json(), signal, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }, true);
      },
    });
  }

  async bindAccount(accountId: string): Promise<DriveEditStorage> {
    // A separate receiver pins the token and generation across every awaited
    // step (including multi-request resource uploads), while sharing aborts.
    const root = this.leaseParent ?? this;root.assertCurrent();
    const bound: DriveSession = Object.create(root);
    bound.token = root.token; bound.expires = root.expires;
    bound.generation = root.generation; bound.leaseParent = root;
    bound.providerStrictRedirect = this.providerStrictRedirect;
    bound.providerScopeSignal = this.providerScopeSignal;
    const account = await bound.request('?fields=user(permissionId)', response => response.json(), undefined, {}, false, 'about');
    if (account.user?.permissionId !== accountId) throw new Error('drive-account-mismatch');
    return bound;
  }

  assertCurrent(): void {
    if ((this.leaseParent && this.leaseParent.generation !== this.generation) || !this.hasValidToken()) {
      throw new Error('drive-auth-changed: ログイン状態が変わりました。');
    }
    if (this.providerScopeSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  }

  async libraries(): Promise<LibraryChoice[]> {
    const items: LibraryChoice[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: "trashed = false and properties has { key='papeer' and value='library-v1' }",
        fields: "nextPageToken,files(id,name,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.request("?" + params, response => response.json());
      items.push(...page.files);
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return items;
  }

  legacyDriveRead() {
    return createBrowserLegacyDriveRead((resource, path, format) => this.request<unknown>(path,
      response => format === 'json' ? response.json() : response.arrayBuffer().then(value => new Uint8Array(value)), undefined, {}, false, resource));
  }

  async manifest(id: string): Promise<Manifest> {
    return parseManifest(await this.request(`/${encodeURIComponent(id)}?alt=media`, response => response.json()));
  }

  async annotationFiles(libraryId: string, signal?: AbortSignal): Promise<{ id: string; name: string; size: string }[]> {
    if (!/^[\w-]+$/.test(libraryId)) throw new Error("ライブラリIDが不正です。");
    const files: { id: string; name: string; size: string }[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: "trashed = false and properties has { key='papeer' and value='ink-v1' }"
        + ` and properties has { key='library' and value='${libraryId}' }`,
        fields: "nextPageToken,files(id,name,size)", pageSize: "1000" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.request("?" + params, response => response.json(), signal);
      files.push(...page.files); pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return files;
  }

  async annotation(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/${encodeURIComponent(id)}?alt=media`, response => response.json(), signal);
  }

  async sharedEditFiles(namespace: string): Promise<{ id: string; version?: string; kind?: string }[]> {
    if (!/^[0-9a-f]{64}$/.test(namespace)) throw new Error('変更データの保存領域が不正です。');
    const files: { id: string; version?: string; kind?: string }[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: `trashed = false and properties has { key='papeer' and value='edits-v1' } and properties has { key='scope' and value='${namespace}' }`,
        fields: 'nextPageToken,files(id,version,properties)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request('?' + params, response => response.json());
      files.push(...page.files.map((file: { id: string; version?: string; properties?: { editKind?: string } }) => ({ id: file.id, version: file.version, kind: file.properties?.editKind }))); pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return files;
  }

  async saveSharedEdit(namespace: string, folderId: string, id: string, value: unknown): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(namespace) || !/^[\w-]+$/.test(folderId) || !/^[0-9a-f-]{36,73}$/.test(id)) throw new Error('変更データの保存先が不正です。');
    const boundary = 'papeer_' + crypto.randomUUID();
    const metadata = { name: `edit-${id}.json`, parents: [folderId], mimeType: 'application/json', properties: { papeer: 'edits-v1', scope: namespace, editKind: (value as { kind?: string }).kind ?? '' } };
    const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(value), `--${boundary}--`].join('\r\n');
    await this.request('?uploadType=multipart&fields=id', async () => undefined, undefined,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, true);
  }

  async sharedResource(namespace: string, metadata: ResourceMetadata, blobId: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(namespace) || !/^[\w-]+$/.test(blobId)) throw new Error('invalid-resource-location');
    const file = await this.request(`/${encodeURIComponent(blobId)}?fields=size,properties`, response => response.json());
    if (file.properties?.papeer !== 'edits-resource-v1' || file.properties?.scope !== namespace
      || file.properties?.sha256 !== metadata.sha256 || Number(file.size) !== metadata.byteLength) throw new Error('resource-scope-or-version');
    const blob = await this.file({ id: blobId, sha256: metadata.sha256, size: metadata.byteLength, mime: metadata.mediaType });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async saveSharedResource(namespace: string, folderId: string, resource: { metadata: ResourceMetadata; bytes: Uint8Array }): Promise<void> {
    const { metadata, bytes } = resource;
    if (!/^[0-9a-f]{64}$/.test(namespace) || !/^[\w-]+$/.test(folderId) || !/^[0-9a-f]{64}$/.test(metadata.sha256)) throw new Error('invalid-resource-location');
    if (bytes.byteLength < 1 || bytes.byteLength > 128 * 1024 * 1024) throw new Error('drive-provider-resource-limit');
    const params = new URLSearchParams({ q: `trashed = false and properties has { key='papeer' and value='edits-resource-v1' } and properties has { key='scope' and value='${namespace}' } and properties has { key='sha256' and value='${metadata.sha256}' }`,
      fields: 'files(id,size)', pageSize: '1000' });
    const existing = await this.request('?' + params, response => response.json());
    let blobId: string | undefined;
    for (const file of existing.files) {
      if (Number(file.size) !== metadata.byteLength) continue;
      // A manually damaged Drive object must not become a successful durable reference.
      try { await this.sharedResource(namespace, metadata, file.id); blobId = file.id; break; } catch { /* Upload a fresh immutable object; do not delete another writer's data. */ }
    }
    if (!blobId) {
      const descriptor = { name: `resource-${metadata.sha256}`, parents: [folderId], mimeType: 'application/octet-stream',
        properties: { papeer: 'edits-resource-v1', scope: namespace, sha256: metadata.sha256 } };
      if (bytes.byteLength <= 4 * 1024 * 1024) {
        const boundary = 'papeer_' + crypto.randomUUID();
        const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(descriptor)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
          Uint8Array.from(bytes), `\r\n--${boundary}--`]);
        const saved = await this.request('?uploadType=multipart&fields=id', response => response.json(), undefined,
          { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, true);
        if (typeof saved.id !== 'string' || !/^[\w-]+$/.test(saved.id)) throw new Error('invalid-resource-upload-response');
        blobId = saved.id;
      } else {
        const location = await this.request('?uploadType=resumable&fields=id', response => Promise.resolve(response.headers.get('location')), undefined,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Type': 'application/octet-stream',
              'X-Upload-Content-Length': String(bytes.byteLength),
            },
            body: JSON.stringify(descriptor),
          }, true);
        let parsed: URL | undefined;
        try { if (typeof location === 'string') parsed = new URL(location); } catch { /* handled below */ }
        if (!location || !parsed || parsed.origin !== 'https://www.googleapis.com' || parsed.username || parsed.password
          || !parsed.pathname.startsWith('/upload/drive/v3/files')) {
          throw new Error('drive-upload-session');
        }
        blobId = await this.uploadResumableChunks(location, bytes);
      }
    }
    await this.saveSharedEdit(namespace, folderId, metadata.id, { kind: 'resource', metadata, blobId });
  }

  async saveAnnotation(libraryId: string, folderId: string | undefined, id: string, operation: unknown): Promise<void> {
    // Small immutable JSON files: neither the snapshot nor another device's edits are overwritten.
    const folder = folderId || (await this.request(`/${encodeURIComponent(libraryId)}?fields=parents`, response => response.json())).parents?.[0];
    if (!folder || !/^[\w-]+$/.test(folder)) throw new Error("保存フォルダーが見つかりません。PCから再アップロードしてください。");
    const boundary = "papeer_" + crypto.randomUUID();
    const metadata = { name: `ink-${id}.json`, parents: [folder], mimeType: "application/json",
      properties: { papeer: "ink-v1", library: libraryId } };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(operation)}\r\n--${boundary}--`;
    await this.request("?uploadType=multipart&fields=id", async () => undefined, undefined,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, true);
  }

  async noteFiles(libraryId: string): Promise<{ id: string }[]> {
    if (!/^[\w-]{1,100}$/.test(libraryId)) throw new Error("ライブラリIDが不正です。");
    const files: { id: string }[] = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: "trashed = false and properties has { key='papeer' and value='notes-v1' } and properties has { key='library' and value='" + libraryId + "' }", fields: 'nextPageToken,files(id)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.request('?' + params, response => response.json());
      files.push(...page.files); pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return files;
  }

  async saveNote(libraryId: string, folderId: string | undefined, operation: import('../runtime/noteDocuments').NoteOperation) {
    const folder = folderId || (await this.request('/' + encodeURIComponent(libraryId) + '?fields=parents', response => response.json())).parents?.[0];
    if (!folder) throw new Error('保存先が見つかりません。');
    const upload = async (name: string, text: string, kind: string) => {
      const boundary = 'papeer_' + crypto.randomUUID();
      const metadata = { name, parents: [folder], mimeType: 'application/json', properties: { papeer: kind, library: libraryId } };
      const body = ['--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata), '--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', text, '--' + boundary + '--'].join('\r\n');
      return this.request('?uploadType=multipart&fields=id', response => response.json(), undefined, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }, true);
    };
    const { note, ...op } = operation;
    let blob: { id: string; sha256: string; size: number } | undefined;
    if (note) {
      const content = JSON.stringify(note), bytes = new TextEncoder().encode(content);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('ノートが大きすぎます。ページを分けて保存してください。');
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      const result = await upload('note-blob-' + sha256 + '.json', content, 'note-blob-v1');
      blob = { id: result.id, sha256, size: bytes.length };
    }
    await upload('note-' + op.id + '.json', JSON.stringify({ ...op, ...(blob ? { blob } : {}) }), 'notes-v1');
  }

  async file(file: DriveFile, signal?: AbortSignal): Promise<Blob> {
    const buffer = await this.request(`/${encodeURIComponent(file.id)}?alt=media`, response => response.arrayBuffer(), signal);
    if (buffer.byteLength !== file.size) throw new Error("ファイルが完全に届きませんでした。再読み込みしてください。");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), b => b.toString(16).padStart(2, "0")).join("");
    if (digest !== file.sha256) throw new Error("ファイルの内容が保存時と一致しません。Windows版から再アップロードしてください。");
    return new Blob([buffer], { type: file.mime });
  }
}

export function parseManifest(value: unknown): Manifest {
  const m = value as Manifest | null;
  if (!m || m.version !== 1 || !Array.isArray(m.items) || !Array.isArray(m.attachments)
    || !m.files || typeof m.files !== "object" || Array.isArray(m.files) || typeof m.updated_at !== "string" || typeof m.revision !== "string"
    || (m.folder_id !== undefined && (typeof m.folder_id !== "string" || !/^[\w-]+$/.test(m.folder_id)))
    || m.items.some(item => !item || typeof item.id !== "string" || !/^[a-f0-9]{32}$/.test(item.id))
    || new Set(m.items.map(item => item.id)).size !== m.items.length
    || m.attachments.some(a => !a || typeof a.id !== "string" || typeof a.owner_id !== "string" || typeof a.title !== "string")
    || Object.entries(m.files).some(([name, file]) => !name || name.startsWith("/") || name.includes("\\")
      || name.split("/").includes("..") || !file || typeof file.id !== "string" || !/^[\w-]+$/.test(file.id)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.mime !== "string")) {
    throw new Error("対応していない、または壊れたライブラリです。Windows版から再アップロードしてください。");
  }
  return m;
}

export function itemFiles(manifest: Manifest, itemId: string): string[] {
  const paths = Object.keys(manifest.files).filter(p => p.startsWith(`papers/${itemId}/`) || p.startsWith(`web/${itemId}/`))
    // Review rollback copies are retained in the snapshot, but are not current reading materials.
    .filter(p => !p.startsWith(`papers/${itemId}/review-backups/`))
    .filter(p => !p.endsWith("-annotated.pdf") || !manifest.files["web-annotations.json"]
      || !manifest.files[p.replace(/^web\//, "papers/").replace("-annotated.pdf", ".pdf")]);
  const rank = (p: string) => p === `web/${itemId}/original-annotated.pdf` ? 0 : p === `papers/${itemId}/original.pdf` ? 1
    : p === `web/${itemId}/translated-annotated.pdf` ? 2 : p === `papers/${itemId}/translated.pdf` ? 3
    : p.endsWith(".md") ? 4 : p.endsWith(".html") ? 5 : 6;
  return paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function fileLabel(path: string, manifest: Manifest): string {
  const name = path.split("/").pop() ?? path;
  const relative = path.replace(/^(?:papers|web)\/[a-f0-9]{32}\//, "");
  const attachment = manifest.attachments.find(a => path === `papers/${a.owner_id}/attachments/${a.id}.${a.format}`);
  // Only current, top-level outputs get the friendly document names. Keep history distinguishable
  // in the explicit all-files view, even when it has the same basename as a current PDF.
  if (relative.includes("/")) return attachment?.title || relative;
  return attachment?.title || ({ "original.pdf": "原文・ノート", "translated.pdf": "日本語訳",
    "original-annotated.pdf": "原文・ノート（手書き入り）", "translated-annotated.pdf": "日本語訳（手書き入り）",
    "article.md": "サマリー", "translation.md": "翻訳テキスト" } as Record<string, string>)[name] || name;
}
