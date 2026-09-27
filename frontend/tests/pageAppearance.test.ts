import assert from "node:assert/strict";
import { test } from "node:test";
import { INVERT_AMOUNT, invertInkColor, mergeSavedSettings, PAGE_FILTERS, pageAppearance, pageFilterOf } from "../src/features/reader/pageAppearance.ts";

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hueOf = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** White paper through a filter made of brightness(), sepia(), invert() and hue-rotate(), as CSS computes it. */
function filteredWhite(filter: string): string {
  let rgb = [1, 1, 1];
  for (const [, name, arg] of filter.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    const a = parseFloat(arg);
    if (name === "brightness") rgb = rgb.map((c) => c * a);
    else if (name === "invert") rgb = rgb.map((c) => c * (1 - a) + (1 - c) * a);
    else if (name === "sepia") {
      const k = 1 - a, [r, g, b] = rgb;
      rgb = [
        (0.393 + 0.607 * k) * r + (0.769 - 0.769 * k) * g + (0.189 - 0.189 * k) * b,
        (0.349 - 0.349 * k) * r + (0.686 + 0.314 * k) * g + (0.168 - 0.168 * k) * b,
        (0.272 - 0.272 * k) * r + (0.534 - 0.534 * k) * g + (0.131 + 0.869 * k) * b,
      ];
    } else assert.equal(name, "hue-rotate", `unexpected filter ${name}`); // leaves greys as they are
    rgb = rgb.map((c) => Math.max(0, Math.min(1, c)));
  }
  return `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
}

test("an unknown saved setting falls back to 通常", () => {
  for (const { id } of PAGE_FILTERS) assert.equal(pageFilterOf(id), id);
  for (const value of [undefined, null, "", "dark", 1, {}]) assert.equal(pageFilterOf(value), "normal");
});

test("the light theme and 通常 show the page as it is", () => {
  for (const { id } of PAGE_FILTERS) assert.deepEqual(pageAppearance(id, false), { background: "#ffffff" });
  assert.deepEqual(pageAppearance("normal", true), { background: "#ffffff" });
});

test("under the dark theme the page is filtered and its background matches the filtered paper", () => {
  for (const id of ["invert", "sepia"] as const) {
    const { filter, background } = pageAppearance(id, true);
    assert.ok(filter);
    assert.equal(background, filteredWhite(filter));
  }
  // Dark grey paper rather than black.
  assert.equal(pageAppearance("invert", true).background, "#1f1f1f");
});

test("ink is lightened only over an inverted page", () => {
  assert.equal(pageAppearance("invert", true).inkColor, invertInkColor);
  assert.equal(pageAppearance("sepia", true).inkColor, undefined);
  assert.equal(pageAppearance("invert", false).inkColor, undefined);
});

test("an inverted ink colour flips its lightness as far as the page does and keeps its hue", () => {
  const paper = pageAppearance("invert", true).background;
  assert.equal(invertInkColor("#ffffff"), paper);
  assert.equal(invertInkColor("#000000"), filteredWhite(`invert(${1 - INVERT_AMOUNT})`));
  // The black pen reads like the page's text.
  assert.ok(contrast(invertInkColor("#18181b"), paper) > 7);
  // Fully saturated colours sit at the middle lightness and stay as they are.
  assert.equal(invertInkColor("#ff0000"), "#ff0000");
  for (const pen of ["#dc2626", "#2563eb", "#16a34a", "#facc15"]) {
    assert.ok(Math.abs(hueOf(invertInkColor(pen)) - hueOf(pen)) < 2, pen);
  }
  assert.equal(invertInkColor("#FFF"), paper);
});

test("colours that are not hex are shown as they are", () => {
  for (const value of ["red", "rgb(0, 0, 0)", "#12345", ""]) assert.equal(invertInkColor(value), value);
});

test("saved settings are laid over the defaults, with an unknown page filter falling back to 通常", () => {
  const defaults = { zoom: 1, pageFilter: "normal" as const, sidebarWidth: 280 };
  assert.deepEqual(mergeSavedSettings({ zoom: 2, pageFilter: "invert" }, defaults), { zoom: 2, pageFilter: "invert", sidebarWidth: 280 });
  assert.equal(mergeSavedSettings({ pageFilter: "negative" }, defaults).pageFilter, "normal");
  // Data saved before the setting existed keeps everything else as it was, even a zoom of 0
  // (the store's migrate, not this, brings old zoom values up to date).
  assert.deepEqual(mergeSavedSettings({ zoom: 0 }, defaults), { zoom: 0, pageFilter: "normal", sidebarWidth: 280 });
  // Nothing saved yet, or something that is not an object.
  for (const saved of [undefined, null, "x", 3]) assert.deepEqual(mergeSavedSettings(saved, defaults), defaults);
});

test("highlights are multiplied into the page, and screened over an inverted one so that they still show", () => {
  assert.equal(pageAppearance("invert", true).highlightBlend, "screen");
  assert.equal(pageAppearance("sepia", true).highlightBlend, undefined);
  assert.equal(pageAppearance("invert", false).highlightBlend, undefined);
});
