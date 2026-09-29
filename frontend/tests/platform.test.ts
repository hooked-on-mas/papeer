import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPlatform, shortcutKeys, shortcutLabel, withShortcutLabels } from "../src/lib/platform.ts";
import { SHORTCUT_GROUPS } from "../src/app/hotkeys.ts";

test("the platform comes from navigator.platform, then the user agent", () => {
  assert.equal(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140" }), "windows");
  assert.equal(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), "macos");
  // WebKitGTK may present itself as a Mac in its user agent; navigator.platform tells the truth.
  assert.equal(detectPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), "linux");
  assert.equal(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }), "macos");
  assert.equal(detectPlatform({ platform: "", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(detectPlatform(undefined), "linux");
});

test("shortcuts stay as written on Windows and Linux, and take the Mac's keys on macOS", () => {
  for (const platform of ["windows", "linux"] as const) {
    assert.equal(shortcutLabel("Ctrl+B", platform), "Ctrl+B");
    assert.equal(withShortcutLabels("ライブラリを表示（Ctrl+B）", platform), "ライブラリを表示（Ctrl+B）");
    assert.deepEqual(shortcutKeys(["F11"], platform), ["F11"]);
  }
  assert.equal(shortcutLabel("Ctrl+B", "macos"), "⌘B");
  assert.equal(shortcutLabel("Ctrl++", "macos"), "⌘+");
  assert.equal(shortcutLabel("Ctrl+-", "macos"), "⌘-");
  assert.equal(shortcutLabel("Ctrl+Shift+F", "macos"), "⇧⌘F");
  assert.equal(shortcutLabel("Alt+←", "macos"), "⌘[");
  assert.equal(shortcutLabel("F11", "macos"), "⌃⌘F");
});

test("shortcuts in text are rewritten for the Mac, prose included", () => {
  const mac = (text: string) => withShortcutLabels(text, "macos");
  assert.equal(mac("ライブラリを表示（Ctrl+B）"), "ライブラリを表示（⌘B）");
  assert.equal(mac("拡大（Ctrl++）"), "拡大（⌘+）");
  assert.equal(mac("原文・日本語訳を拡大（Ctrl＋マウスホイール上 / Ctrl+=）"), "原文・日本語訳を拡大（⌘＋マウスホイール上 / ⌘=）");
  assert.equal(mac("（Ctrl + / Ctrl − / Ctrl+ホイール）"), "（⌘ + / ⌘ − / ⌘+ホイール）");
  assert.equal(mac("移動する前の場所に戻る（Alt+←）"), "移動する前の場所に戻る（⌘[）");
  assert.equal(mac("PDF の目次から移動（Alt+← で戻る）"), "PDF の目次から移動（⌘[ で戻る）");
  assert.equal(mac("大きく表示（F11で切り替え）"), "大きく表示（⌃⌘Fで切り替え）");
  assert.equal(mac("Ctrl・Shift+クリックで複数選択（F2：名前変更、Delete：削除）"), "⌘・Shift+クリックで複数選択（F2：名前変更、⌫：削除）");
  assert.equal(mac("タブを切り替え（Ctrl+1〜4）"), "タブを切り替え（⌘1〜4）");
  assert.equal(mac("基準の行から（Ctrl+Shift+クリックで追加）"), "基準の行から（⌘+Shift+クリックで追加）");
});

test("every key of the shortcut list has a Mac form without Ctrl, Alt, F11 or Delete", () => {
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      const keys = shortcutKeys(item.keys, "macos").join(" ") + " " + withShortcutLabels(item.label, "macos");
      assert.doesNotMatch(keys, /\b(?:Ctrl|Alt|F11|Delete)\b/, `${group.title}: ${item.label}`);
    }
  }
  assert.deepEqual(shortcutKeys(["F11"], "macos"), ["⌃", "⌘", "F"]);
  assert.deepEqual(shortcutKeys(["Alt", "← / →"], "macos"), ["⌘", "[ / ]"]);
  assert.deepEqual(shortcutKeys(["Ctrl", "Shift", "F"], "macos"), ["⌘", "⇧", "F"]);
  assert.deepEqual(shortcutKeys(["Delete"], "macos"), ["⌫"]);
});
