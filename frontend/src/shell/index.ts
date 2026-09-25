import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type FileDropEvent =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

export interface ShellAdapter {
  openFiles(filters: { name: string, extensions: string[] }[]): Promise<string[]>;
  saveFile(defaultName: string, filters: { name: string, extensions: string[] }[]): Promise<string | null>;
  openPath(path: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  isFocused(): Promise<boolean>;
  setProgress(state: 'none' | 'normal' | 'indeterminate' | 'error', done?: number, total?: number): Promise<void>;
  /** OS file drags over the window; x/y are CSS pixels in the viewport. */
  onFileDrop(callback: (event: FileDropEvent) => void): () => void;
}

let notificationAllowed: boolean | null = null;

export const tauriShell: ShellAdapter = {
  async openFiles(filters) {
    const result = await openDialog({
      multiple: true,
      filters
    });
    if (result === null) return [];
    return Array.isArray(result) ? result : [result];
  },

  async saveFile(defaultName, filters) {
    return await saveDialog({
      defaultPath: defaultName,
      filters
    });
  },

  async openPath(path) {
    await openPath(path);
  },

  async notify(title, body) {
    if (notificationAllowed === null) {
      notificationAllowed = await isPermissionGranted();
      if (!notificationAllowed) notificationAllowed = (await requestPermission()) === "granted";
    }
    if (notificationAllowed) sendNotification({ title, body });
  },

  async isFocused() {
    return await getCurrentWindow().isFocused();
  },

  async setProgress(state, done = 0, total = 0) {
    const w = getCurrentWindow();
    const progress = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    switch (state) {
      case 'none':
        await w.setProgressBar({ status: ProgressBarStatus.None });
        break;
      case 'normal':
        await w.setProgressBar({ status: ProgressBarStatus.Normal, progress });
        break;
      case 'indeterminate':
        await w.setProgressBar({ status: ProgressBarStatus.Indeterminate });
        break;
      case 'error':
        await w.setProgressBar({ status: ProgressBarStatus.Error, progress: progress || 100 });
        break;
    }
  },

  onFileDrop(callback) {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      const ratio = window.devicePixelRatio || 1;
      if (payload.type === "leave") {
        callback({ type: "leave" });
      } else if (payload.type === "drop") {
        callback({ type: "drop", paths: payload.paths, x: payload.position.x / ratio, y: payload.position.y / ratio });
      } else {
        callback({ type: "over", x: payload.position.x / ratio, y: payload.position.y / ratio });
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }
};

// Use a mock if not running in Tauri (e.g. browser)
// @ts-ignore window.__TAURI__ is injected by Tauri
export const shell = (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined) ? tauriShell : {
  openFiles: async () => [],
  saveFile: async () => null,
  openPath: async () => {},
  notify: async (t, b) => { console.log("Notify", t, b); },
  isFocused: async () => document.hasFocus(),
  setProgress: async () => {},
  onFileDrop: () => () => {},
} as ShellAdapter;

/** Toast the result of a long job only when the user has looked away, as the old tray balloon did. */
export async function notifyIfAway(title: string, body: string): Promise<void> {
  try {
    if (!(await shell.isFocused())) await shell.notify(title, body);
  } catch {
    // Notifications are a convenience; never let them break job handling.
  }
}

export function joinPath(folder: string, name: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith(sep) ? folder + name : folder + sep + name;
}
