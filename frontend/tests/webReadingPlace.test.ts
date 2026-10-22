import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ArtifactView } from "../src/runtime/contracts.ts";
import { clearReadingPlaces, getPdfPlace, pdfPlaceKey, persistPdfPlaces, rememberPdfPlace } from "../src/web/readingPlace.ts";

function storage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const local: Record<string, unknown> = {};
  Object.defineProperties(local, {
    getItem: { value: (key: string) => local[key] ?? null },
    setItem: { value: (key: string, value: string) => { local[key] = value; }, writable: true },
    removeItem: { value: (key: string) => { delete local[key]; } },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  clearReadingPlaces();
  t.after(() => { clearReadingPlaces(); if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return local as unknown as Storage;
}
const artifact: ArtifactView = { id: "temporary-object", itemId: "paper", filename: "translated.pdf", label: "日本語訳", role: "translated", mediaType: "application/pdf",
  annotationTarget: { paperId: "paper", side: "translated", sourceSha256: "first-version" } };

test("reading positions survive a fresh session and stay scoped to library, PDF version, side and page", t => {
  const local = storage(t), key = pdfPlaceKey("library", artifact, "revision"), point = { x: .65, y: .3 };
  rememberPdfPlace(key, 8, point); persistPdfPlaces(key);
  const saved = local.getItem("papeer-reading:pdf:" + key)!;
  clearReadingPlaces(); local.setItem("papeer-reading:pdf:" + key, saved);
  assert.deepEqual(getPdfPlace(key, 8), point);
  assert.equal(getPdfPlace(key, 9), undefined);
  for (const other of [pdfPlaceKey("other-library", artifact, "revision"),
    pdfPlaceKey("library", { ...artifact, filename: "original.pdf", role: "original" }, "revision"),
    pdfPlaceKey("library", { ...artifact, annotationTarget: { ...artifact.annotationTarget!, sourceSha256: "new-version" } }, "revision")]) {
    assert.equal(getPdfPlace(other, 8), undefined);
  }
  assert.equal(pdfPlaceKey("library", { ...artifact, id: "new-runtime-object" }, "new-revision"), key, "temporary runtime IDs and metadata revisions do not reset an unchanged PDF");
});

test("recent page positions are bounded, invalid points are ignored, and blocked storage still permits reading", t => {
  const local = storage(t), key = "bounded-pdf";
  for (let page = 1; page <= 22; page++) rememberPdfPlace(key, page, { x: .5, y: .2 });
  assert.equal(getPdfPlace(key, 1), undefined); assert.deepEqual(getPdfPlace(key, 22), { x: .5, y: .2 });
  for (const bad of [{ x: Infinity, y: .2 }, { x: .5, y: -1 }, { x: 2, y: .2 }]) rememberPdfPlace(key, 22, bad);
  local.setItem = () => { throw new Error("blocked"); };
  assert.doesNotThrow(() => persistPdfPlaces(key));
  assert.deepEqual(getPdfPlace(key, 22), { x: .5, y: .2 });
});

test("logout clears positions and a late persistence callback cannot restore them", t => {
  const local = storage(t), key = "logout-pdf";
  rememberPdfPlace(key, 1, { x: .5, y: .2 }); persistPdfPlaces(key);
  clearReadingPlaces(); persistPdfPlaces(key);
  assert.equal(local.getItem("papeer-reading:pdf:" + key), null);
  assert.equal(getPdfPlace(key, 1), undefined);
  local.setItem("papeer-reading:pdf:damaged", JSON.stringify([[1, { x: .5, y: 8 }], [2, null], [3, { x: .5, y: .2 }]]));
  assert.equal(getPdfPlace("damaged", 1), undefined); assert.deepEqual(getPdfPlace("damaged", 3), { x: .5, y: .2 });
});
