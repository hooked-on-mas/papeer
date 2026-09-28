/**
 * Rules the sidecar keeps too, tested against the same cases as its tests (tests/test_shared_cases.py):
 * the sidecar has the last word, so a case both disagree on is settled its way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  folderAncestors, folderName, folderParts, isInsideFolder, normalizeCollection, parentFolder, subfolderPath,
} from "../src/lib/collectionPath.ts";
import { parsePageSelection } from "../src/lib/pageSelection.ts";
import { PY_SPACE, pyStrip } from "../src/lib/pyWhitespace.ts";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8")) as T;

type PageCase = { value: string; page_count: number; pages?: number[]; error?: string };

test("page ranges read as the sidecar reads them, with its messages", () => {
  for (const c of fixture<{ cases: PageCase[] }>("page_ranges.json").cases) {
    const label = `${JSON.stringify(c.value)} of ${c.page_count}`;
    if (c.pages) assert.deepEqual(parsePageSelection(c.value, c.page_count), c.pages, label);
    else assert.throws(() => parsePageSelection(c.value, c.page_count), { message: c.error }, label);
  }
});

type FolderCases = {
  normalize: { value: string; path: string }[];
  ancestors: { value: string; ancestors: string[] }[];
  inside: { value: string; path: string; inside: boolean }[];
};

test("folder paths normalize, nest and contain as the sidecar's do", () => {
  const cases = fixture<FolderCases>("collection_paths.json");
  for (const c of cases.normalize) assert.equal(normalizeCollection(c.value), c.path, JSON.stringify(c.value));
  for (const c of cases.ancestors) assert.deepEqual(folderAncestors(c.value), c.ancestors, JSON.stringify(c.value));
  for (const c of cases.inside) {
    assert.equal(isInsideFolder(c.value, c.path), c.inside, `${JSON.stringify(c.value)} in ${JSON.stringify(c.path)}`);
  }
});

test("a folder's parts, name, parent and subfolders", () => {
  assert.deepEqual(folderParts("a/ b /c"), ["a", "b", "c"]);
  assert.deepEqual(folderParts(""), []);
  assert.equal(folderName("a / b / c"), "c");
  assert.equal(folderName(""), "");
  assert.equal(parentFolder("a / b / c"), "a / b");
  assert.equal(parentFolder("a"), "");
  assert.equal(subfolderPath("a / b", "c"), "a / b / c");
  assert.equal(subfolderPath("", "c"), "c");
});

test("PY_SPACE is exactly Python's whitespace", () => {
  const space = new RegExp(`^${PY_SPACE}$`);
  const taken: string[] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (space.test(String.fromCodePoint(code))) taken.push(code.toString(16).toUpperCase().padStart(4, "0"));
  }
  assert.deepEqual(taken, fixture<{ code_points: string[] }>("python_whitespace.json").code_points);
});

test("pyStrip takes the whitespace Python's str.strip() takes, not U+FEFF", () => {
  assert.equal(pyStrip("\u3000\t a b \u001c\u0085\n"), "a b");
  assert.equal(pyStrip("\ufeffa\ufeff"), "\ufeffa\ufeff");
  assert.equal(pyStrip(" \u200b "), "\u200b");
});
