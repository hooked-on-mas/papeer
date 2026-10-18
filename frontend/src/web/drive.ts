/** The static website talks only to Google, never to a desktop sidecar. Tokens stay in memory. */
export const CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID
  || "208743866503-mtrhc6kjigbp8kc6kqo6fllg23gc70sj.apps.googleusercontent.com";
const API = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
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
export type Manifest = { version: 1; updated_at: string; revision: string; items: Item[];
  attachments: { id: string; owner_id: string; format: string; title: string }[]; files: Record<string, DriveFile> };
export type LibraryChoice = { id: string; name: string; modifiedTime: string };
export type Database = Record<string, Record<string, unknown>[]>;

export class DriveSession {
  private token = "";
  private expires = 0;
  private generation = 0;

  signIn(): Promise<void> {
    const oauth = window.google?.accounts.oauth2;
    if (!oauth) return Promise.reject(new Error("Googleのログイン画面を読み込み中です。通信を確認してもう一度お試しください。"));
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      const client = oauth.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE,
        callback: result => {
          if (generation !== this.generation) { reject(new Error("ログインを中止しました。")); return; }
          if (!result.access_token || result.error) { reject(new Error("Googleへのログインを完了できませんでした。")); return; }
          this.token = result.access_token;
          this.expires = Date.now() + (result.expires_in ?? 3600) * 1000;
          resolve();
        },
        error_callback: () => reject(new Error("ログイン画面が閉じられたか、ポップアップがブロックされています。")),
      });
      client.requestAccessToken({ prompt: "select_account" });
    });
  }

  signOut() { this.generation++; this.token = ""; this.expires = 0; }

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    if (!this.token || Date.now() >= this.expires) throw new Error("ログインの有効期限が切れました。再度Googleでログインしてください。");
    const generation = this.generation;
    const response = await fetch(API + path, { headers: { Authorization: `Bearer ${this.token}` }, signal, cache: "no-store" });
    if (generation !== this.generation) throw new Error("ログイン状態が変わりました。再読み込みしてください。");
    if (!response.ok) throw new Error(response.status === 401 ? "再度Googleでログインしてください。"
      : `Driveから読み込めませんでした (${response.status})。同じGoogleアカウント・OAuthプロジェクトか確認してください。`);
    return response;
  }

  async libraries(): Promise<LibraryChoice[]> {
    const items: LibraryChoice[] = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q: "trashed = false and properties has { key='papeer' and value='library-v1' }",
        fields: "nextPageToken,files(id,name,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await (await this.request("?" + params)).json();
      items.push(...page.files);
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return items;
  }

  async manifest(id: string): Promise<Manifest> {
    return parseManifest(await (await this.request(`/${encodeURIComponent(id)}?alt=media`)).json());
  }

  async file(file: DriveFile, signal?: AbortSignal): Promise<Blob> {
    const buffer = await (await this.request(`/${encodeURIComponent(file.id)}?alt=media`, signal)).arrayBuffer();
    if (buffer.byteLength !== file.size) throw new Error("ファイルが完全に届きませんでした。再読み込みしてください。");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), b => b.toString(16).padStart(2, "0")).join("");
    if (digest !== file.sha256) throw new Error("ファイルの内容が保存時と一致しません。Windows版から再アップロードしてください。");
    return new Blob([buffer], { type: file.mime });
  }
}

export function parseManifest(value: unknown): Manifest {
  const m = value as Manifest | null;
  if (!m || m.version !== 1 || !Array.isArray(m.items) || !Array.isArray(m.attachments)
    || !m.files || typeof m.files !== "object" || typeof m.updated_at !== "string" || typeof m.revision !== "string"
    || m.items.some(item => !item || typeof item.id !== "string" || !/^[a-f0-9]{32}$/.test(item.id))
    || m.attachments.some(a => !a || typeof a.id !== "string" || typeof a.owner_id !== "string" || typeof a.title !== "string")
    || Object.entries(m.files).some(([name, file]) => !name || name.startsWith("/") || name.includes("\\")
      || name.split("/").includes("..") || !file || typeof file.id !== "string" || !/^[\w-]+$/.test(file.id)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.mime !== "string")) {
    throw new Error("対応していない、または壊れたライブラリです。Windows版から再アップロードしてください。");
  }
  return m;
}

export function itemFiles(manifest: Manifest, itemId: string): string[] {
  const paths = Object.keys(manifest.files).filter(p => p.startsWith(`papers/${itemId}/`) || p.startsWith(`web/${itemId}/`));
  const rank = (p: string) => p.endsWith("original-annotated.pdf") ? 0 : p.endsWith("translated-annotated.pdf") ? 1
    : p.endsWith("original.pdf") ? 2 : p.endsWith("translated.pdf") ? 3 : p.endsWith(".md") ? 4 : p.endsWith(".html") ? 5 : 6;
  return paths.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function fileLabel(path: string, manifest: Manifest): string {
  const name = path.split("/").pop() ?? path;
  const attachment = manifest.attachments.find(a => name === `${a.id}.${a.format}`);
  return attachment?.title || ({ "original.pdf": "原文・ノート", "translated.pdf": "日本語訳",
    "original-annotated.pdf": "原文・ノート（手書き入り）", "translated-annotated.pdf": "日本語訳（手書き入り）",
    "article.md": "解説", "translation.md": "翻訳テキスト" } as Record<string, string>)[name] || name;
}
