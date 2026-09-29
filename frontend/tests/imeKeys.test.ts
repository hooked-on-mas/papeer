import assert from "node:assert/strict";
import { test } from "node:test";
import { isImeKey } from "../src/lib/imeKeys.ts";

test("keys of a conversion belong to the IME, also the Enter that commits it in WKWebView (macOS)", () => {
  // WebView2: every key while composing.
  assert.equal(isImeKey({ isComposing: true, keyCode: 229 }), true);
  assert.equal(isImeKey({ isComposing: true, keyCode: 13 }), true);
  // Safari's engine: the committing Enter comes after compositionend, marked by keyCode 229 only.
  assert.equal(isImeKey({ isComposing: false, keyCode: 229 }), true);
  // A plain Enter sends, saves or moves.
  assert.equal(isImeKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isImeKey({}), false);
});
