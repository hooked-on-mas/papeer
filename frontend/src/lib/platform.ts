/**
 * The OS the app runs on, as the webview tells it (WebView2 on Windows, WKWebView on macOS, WebKitGTK on
 * Linux), and the keys shown for shortcuts on it.
 *
 * On macOS the app's shortcuts take ⌘ where Windows and Linux take Ctrl (both are registered everywhere:
 * app/AppShell.tsx), and a few follow the Mac's own custom: ⌃⌘F for 集中表示 (F11 shows the desktop there),
 * ⌘[ / ⌘] for going back and forward, and the delete key (⌫, Backspace) for deleting.
 * This file imports nothing, so that node:test can load it (tests/platform.test.ts).
 */

export type Platform = "windows" | "macos" | "linux";

/** navigator.platform first ("Win32", "MacIntel", "Linux x86_64"): WebKitGTK may say "Macintosh" in its user agent. */
export function detectPlatform(nav: { platform?: string; userAgent?: string } | undefined): Platform {
  const platform = nav?.platform ?? "";
  if (/^Mac/i.test(platform)) return "macos";
  if (/^Win/i.test(platform)) return "windows";
  if (/Linux|X11|BSD/i.test(platform)) return "linux";
  const agent = nav?.userAgent ?? "";
  if (/Windows/.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/.test(agent)) return "macos";
  return "linux";
}

export const PLATFORM: Platform = detectPlatform(typeof navigator === "undefined" ? undefined : navigator);
export const IS_MAC = PLATFORM === "macos";

// Apple's order for modifiers: ⌃ ⌥ ⇧ ⌘.
const MAC_MODIFIERS: Record<string, string> = { Ctrl: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];
/** Whole shortcuts that are another key on the Mac, not the same key with ⌘ for Ctrl. */
const MAC_SHORTCUTS: Record<string, string> = {
  "F11": "⌃⌘F",
  "Alt+←": "⌘[",
  "Alt+→": "⌘]",
  "Delete": "⌫",
};

/**
 * A shortcut written as on Windows ("Ctrl+B", "Ctrl++", "Ctrl+Shift+F", "Alt+←", "F11"), as the keyboard
 * of `platform` has it: unchanged on Windows and Linux; "⌘B", "⌘+", "⇧⌘F", "⌘[", "⌃⌘F" on macOS.
 */
export function shortcutLabel(shortcut: string, platform: Platform = PLATFORM): string {
  if (platform !== "macos") return shortcut;
  if (MAC_SHORTCUTS[shortcut]) return MAC_SHORTCUTS[shortcut];
  // "Ctrl++" is Ctrl and "+": an empty part after a "+" stands for the "+" key itself.
  const parts = shortcut.split("+").reduce<string[]>((keys, part, i, all) => {
    if (part === "" && i > 0 && all[i - 1] !== "") keys.push("+");
    else if (part !== "") keys.push(part);
    return keys;
  }, []);
  const modifiers = parts.filter(part => MAC_MODIFIERS[part]).map(part => MAC_MODIFIERS[part])
    .sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  const keys = parts.filter(part => !MAC_MODIFIERS[part]).map(part => MAC_SHORTCUTS[part] ?? part);
  return modifiers.join("") + keys.join("+");
}

/**
 * Every shortcut in `text` ("…（Ctrl+B）", "Ctrl＋マウスホイール", "F2：名前変更、Delete：削除") as the keyboard of
 * `platform` has it. Only the key names this app writes are recognized.
 */
export function withShortcutLabels(text: string, platform: Platform = PLATFORM): string {
  if (platform !== "macos") return text;
  return text
    .replace(/(?:(?:Ctrl|Alt|Shift)\+)+(?:[A-Z0-9←→]|\+|-|=)(?![A-Za-z])/g, shortcut => shortcutLabel(shortcut, platform))
    // What is left is prose: "Ctrl＋マウスホイール", "Ctrl・Shift+クリック", "Ctrl + / Ctrl −".
    .replace(/\bCtrl\b/g, MAC_MODIFIERS.Ctrl)
    .replace(/\bAlt\b/g, MAC_MODIFIERS.Alt)
    .replace(/\bF11\b/g, MAC_SHORTCUTS.F11)
    .replace(/\bDelete\b/g, MAC_SHORTCUTS.Delete);
}

/** The keys of a shortcut listed in 設定「ショートカット」 (app/hotkeys.ts), as the keyboard of `platform` has them. */
export function shortcutKeys(keys: string[], platform: Platform = PLATFORM): string[] {
  if (platform !== "macos") return keys;
  const joined = keys.join("+");
  if (joined === "F11") return ["⌃", "⌘", "F"];
  if (joined === "Alt+← / →") return ["⌘", "[ / ]"];
  if (joined === "Ctrl+Z / Y") return ["⌘", "Z / ⇧Z"];
  return keys.map(key => MAC_MODIFIERS[key] ?? (key === "Delete" ? "⌫" : withShortcutLabels(key, platform)));
}

/**
 * What carries the sync folder between PCs, as the sync's texts name it (papeer/core/sync_client.py): Google
 * Drive for desktop on Windows and macOS; on Linux, which has no official client, the user's own sync software.
 */
export function syncClientNames(platform: Platform = PLATFORM): {
  /** The program: 「{app}が行います」. */ app: string;
  /** Where to look at the transfer: 「{service}側の同期完了」. */ service: string;
  /** What the library is synced with: 「{remote}との変更が競合」. */ remote: string;
  /** A sync folder's path on this OS, as an example. */ folderExample: string;
} {
  if (platform === "linux") {
    return { app: "同期ソフト", service: "同期ソフト", remote: "同期フォルダー", folderExample: "~/Sync/Papeer-sync" };
  }
  return {
    app: "PC版Google Drive", service: "Google Drive", remote: "Google Drive",
    folderExample: platform === "macos" ? "~/Library/CloudStorage/GoogleDrive-…/My Drive/Papeer-sync" : String.raw`G:\マイドライブ\Papeer-sync`,
  };
}
