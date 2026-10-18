import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const script = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");

test("the startup theme follows saved preferences, including old storage and unavailable storage", () => {
  for (const [current, legacy, expected] of [
    ["dark", null, "dark"], ["light", "dark", "light"], ["system", "dark", "system"],
    [null, "dark", "dark"], [null, "light", "light"], [null, null, "system"],
    ["invalid", null, "system"],
  ]) {
    const document = { documentElement: { dataset: {} } };
    runInNewContext(script, { document, localStorage: { getItem: (key) => key === "papeer-ui-theme" ? current : legacy } });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
  const document = { documentElement: { dataset: {} } };
  runInNewContext(script, { document, localStorage: { getItem() { throw new Error("disabled"); } } });
  assert.equal(document.documentElement.dataset.theme, "system");
});
