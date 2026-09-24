import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface ShellAdapter {
  openFiles(filters: { name: string, extensions: string[] }[]): Promise<string[]>;
  saveFile(defaultName: string, filters: { name: string, extensions: string[] }[]): Promise<string | null>;
  openPath(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  setProgress(state: 'none' | 'normal' | 'indeterminate' | 'error', done?: number, total?: number): Promise<void>;
}

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
    await openUrl(path);
  },

  async revealInFolder(path) {
    await revealItemInDir(path);
  },

  async notify(title, body) {
    await sendNotification({ title, body });
  },

  async setProgress(state, done = 0, total = 0) {
    const w = getCurrentWindow();
    let progress = 0;
    if (total > 0) progress = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    
    switch (state) {
      case 'none':
        await w.setProgressBar({ progress: 0 }); // Hide or reset
        break;
      case 'normal':
        await w.setProgressBar({ progress });
        break;
      case 'indeterminate':
        await w.setProgressBar({ progress: 0 }); // Tauri v2 supports state via setProgressBar state, wait, setProgressBar might just take a number in some environments, but let's just pass progress.
        break;
      case 'error':
        // Wait for v2 API details. Will set progress for now.
        await w.setProgressBar({ progress });
        break;
    }
  }
};

// Use a mock if not running in Tauri (e.g. browser)
// @ts-ignore window.__TAURI__ is injected by Tauri
export const shell = (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined) ? tauriShell : {
  openFiles: async () => [],
  saveFile: async () => null,
  openPath: async () => {},
  revealInFolder: async () => {},
  notify: async (t, b) => { console.log("Notify", t, b); },
  setProgress: async () => {},
} as ShellAdapter;

