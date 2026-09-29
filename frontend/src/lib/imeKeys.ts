/**
 * Whether a keydown belongs to the input method (IME) rather than to the page, so that an Enter that
 * commits a Japanese conversion never sends, saves or moves.
 *
 * WebView2 (Chromium) marks every key of a conversion with isComposing. Safari's engine, WKWebView on
 * macOS, ends the composition before the Enter that commits it arrives: that keydown has isComposing
 * false, and keyCode 229 ("processed by the IME") tells it apart.
 * This file imports nothing, so that node:test can load it (tests/imeKeys.test.ts).
 */
export function isImeKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
