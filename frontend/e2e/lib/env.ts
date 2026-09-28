/**
 * The isolated environment every process of the end-to-end tests runs in (README「E2E テスト」).
 *
 * Everything that could reach the user's real data points into the test's own temporary folder:
 * the library (PAPEER_DATA_DIR), LOCALAPPDATA (PapeerSync), APPDATA, the home folder (USERPROFILE,
 * HOME, CODEX_HOME), TEMP/TMP and the WebView2 profile (WEBVIEW2_USER_DATA_FOLDER). Tauri itself finds
 * its folders through the Windows known-folder API, which ignores these variables: app.ts also passes
 * PAPEER_E2E_DIR, with which a debug build puts the WebView2 profile in the test's folder and leaves out
 * the window-state plugin (src-tauri/src/lib.rs), and checks the profile on WebView2's command line.
 * papeer.exe alone keeps the real USERPROFILE/HOME (lib/app.ts): WebView2 does not open its debugging
 * port with another home folder, and neither Tauri nor the app reads anything there.
 *
 * The AI CLIs (claude, codex, agy) are taken off PATH and API keys are removed, so nothing can reach a
 * real AI: translation goes to the stand-in server (tools/e2e_stub_ai.py).
 */
import fs from "node:fs";
import path from "node:path";

/** The executables whose folders are taken off PATH. */
const AI_CLIS = ["claude", "codex", "agy"];
const EXECUTABLE_SUFFIXES = ["", ".exe", ".cmd", ".bat", ".ps1"];

/** Variables that must not reach the processes: another token or data folder, and real API keys. */
function isDroppedVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("PAPEER_") || upper.startsWith("PAPERDESK_") || upper.startsWith("VITE_PAPEER")
    || upper.startsWith("VITE_PAPERDESK") || upper.endsWith("_API_KEY") || upper === "VIRTUAL_ENV"
    || upper.startsWith("WEBVIEW2_") || upper === "CODEX_HOME" || upper === "CLAUDE_CONFIG_DIR";
}

/** PATH without the folders that hold an AI CLI. */
export function pathWithoutAiClis(value: string): string {
  return value.split(path.delimiter).filter((dir) => {
    if (!dir) return false;
    return !AI_CLIS.some((name) => EXECUTABLE_SUFFIXES.some((suffix) => {
      try {
        return fs.statSync(path.join(dir, name + suffix)).isFile();
      } catch {
        return false;
      }
    }));
  }).join(path.delimiter);
}

/** The folders of one launch, all under `root`. */
export interface IsolatedDirs {
  root: string;
  data: string;
  localAppData: string;
  appData: string;
  home: string;
  temp: string;
  webview: string;
}

export function isolatedDirs(root: string): IsolatedDirs {
  const dirs = {
    root,
    data: path.join(root, "data"),
    localAppData: path.join(root, "LocalAppData"),
    appData: path.join(root, "Roaming"),
    home: path.join(root, "home"),
    temp: path.join(root, "temp"),
    webview: path.join(root, "webview2"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/** The caller's environment minus the dropped variables, with every user folder in `dirs`. */
export function isolatedEnv(base: NodeJS.ProcessEnv, dirs: IsolatedDirs, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isDroppedVariable(name)) env[name] = value;
  }
  // Windows variable names are case-insensitive: one spelling of PATH only.
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const pathValue = env[pathKey] ?? "";
  for (const name of Object.keys(env)) if (name.toUpperCase() === "PATH") delete env[name];
  Object.assign(env, {
    Path: pathWithoutAiClis(pathValue),
    PAPEER_DATA_DIR: dirs.data,
    LOCALAPPDATA: dirs.localAppData,
    APPDATA: dirs.appData,
    USERPROFILE: dirs.home,
    HOME: dirs.home,
    CODEX_HOME: path.join(dirs.home, ".codex"),
    TEMP: dirs.temp,
    TMP: dirs.temp,
    WEBVIEW2_USER_DATA_FOLDER: dirs.webview,
    // The stand-in AI is on 127.0.0.1: never through a proxy.
    NO_PROXY: "127.0.0.1,localhost",
    ...extra,
  });
  return env;
}

/** Whether `child` is `parent` or inside it (Windows paths, any case). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The value of --user-data-dir on a Chromium command line, or null. */
export function userDataDir(commandLine: string): string | null {
  const match = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(commandLine);
  return match ? (match[1] ?? match[2]) : null;
}
