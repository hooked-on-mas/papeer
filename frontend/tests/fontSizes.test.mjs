import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The UI size (設定「表示」の文字の大きさ, src/lib/uiScale.ts) scales the root font size, so only sizes in
// rem (or em) follow it. Text is also never smaller than 12px at 100% (0.75rem). An em size is taken
// as it stands (a parent of at least 1rem assumed): it cannot be checked against its parent here.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const MIN = 0.75;
const REM_FOR_PX = { 10: "0.75rem", 11: "0.75rem", 12: "0.75rem", 13: "0.8125rem", 14: "0.875rem", 15: "0.9375rem", 16: "1rem" };

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

function findings(pattern, check) {
  const found = [];
  for (const file of sources(SRC)) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const problem = check(match);
        if (problem) found.push(`${relative(SRC, file).replaceAll("\\", "/")}:${index + 1}: ${problem}`);
      }
    });
  }
  return found;
}

const NUMBER = String.raw`(\d*\.?\d+)`;
// Tailwind classes, CSS declarations and inline styles (fontSize: "0.8rem" / 12 / `${x}em` is skipped).
const TAILWIND = new RegExp(String.raw`\btext-\[${NUMBER}(px|rem|em)\]`, "g");
const CSS = new RegExp(String.raw`font-size:\s*${NUMBER}(px|rem|em)\b`, "g");
const INLINE = new RegExp(String.raw`\bfontSize:\s*(?:["'\`]${NUMBER}(px|rem|em)["'\`]|${NUMBER}\b(?!\s*[*/+-]))`, "g");

test("font sizes are in rem or em so that they follow the UI size", () => {
  const found = [
    ...findings(TAILWIND, ([text, value, unit]) => unit === "px" && `${text} → text-[${REM_FOR_PX[Math.round(value)] ?? `${value / 16}rem`}]`),
    ...findings(CSS, ([text, value, unit]) => unit === "px" && `${text} → font-size: ${value / 16}rem`),
    ...findings(INLINE, ([text, , unit, bare]) => (unit === "px" || bare !== undefined) && `${text} (use rem or em)`),
  ];
  assert.deepEqual(found, [], "px font sizes found:\n" + found.join("\n"));
});

test("no text is smaller than 12px at 100%", () => {
  const small = ([text, value, unit]) => unit !== "px" && Number(value) < MIN && `${text} (at least ${MIN}${unit})`;
  const found = [
    ...findings(TAILWIND, small),
    ...findings(CSS, small),
    ...findings(INLINE, ([text, value, unit]) => unit && unit !== "px" && Number(value) < MIN && `${text} (at least ${MIN}${unit})`),
  ];
  assert.deepEqual(found, [], "too small:\n" + found.join("\n"));
});
