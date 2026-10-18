import assert from "node:assert/strict";
import { test } from "node:test";
import { createDriveLibraryRuntime } from "../src/web/libraryRuntime.ts";
import type { DriveFile, Manifest } from "../src/web/drive.ts";

const id = "a".repeat(32), otherId = "c".repeat(32), hash = "b".repeat(64);
const scope = { sessionKey: "epoch-1", libraryId: "library-1", revision: "revision-1" };
const pdfPath = `papers/${id}/original.pdf`;
const translatedPath = `papers/${id}/translated.pdf`;
const memoPath = `papers/${id}/attachments/memo.md`;
const imagePath = `papers/${id}/media/image.png`;
const partialPath = `papers/${id}/translation-pages/page-2.pdf`;

function fixture(): Manifest {
  const files: Manifest["files"] = {};
  for (const path of [pdfPath, translatedPath, memoPath, imagePath, partialPath, `web/${id}/original-annotated.pdf`,
    `papers/${otherId}/original.pdf`, "library-data.json", "web-annotations.json", "web-reading.json", "settings.json"]) {
    files[path] = { id: `drive-file-${Object.keys(files).length}`, sha256: hash, size: 3,
      mime: path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".png") ? "image/png" : "text/plain" };
  }
  return { version: 1, revision: scope.revision, updated_at: "2026-10-18T00:00:00Z",
    items: [{ id, title: "論文", first_author: "Smith", publication_year: "2024" }, { id: otherId, title: "別の論文" }],
    attachments: [{ id: "memo", owner_id: id, format: "md", title: "読書メモ" }], files };
}

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("snapshot query keeps document ordering and annotation anchors while hiding transport and internal files", async () => {
  const manifest = fixture();
  const calls: DriveFile[] = [];
  const runtime = createDriveLibraryRuntime({ file: async file => { calls.push(file); return new Blob(["pdf"]); } }, scope, manifest);
  assert.equal(runtime.query.listItems()[0].title, "Smith (2024) 論文");
  const files = runtime.query.listArtifacts(id);
  assert.equal(files[0].filename, "original.pdf"); // Existing base ink suppresses duplicate flattened PDFs.
  assert.equal(files.some(file => file.filename === "original-annotated.pdf"), false);
  assert.equal(files.find(file => file.filename === "memo.md")?.label, "読書メモ");
  const original = files[0];
  assert.deepEqual(original.annotationTarget, { paperId: id, side: "original", sourceSha256: hash });
  assert.equal(files.find(file => file.filename === "page-2.pdf")?.annotationTarget, undefined);
  assert.equal(files.find(file => file.filename === "page-2.pdf")?.role, "translated");
  assert.equal(runtime.query.listArtifacts(null).some(file => ["settings.json", "web-reading.json", "library-data.json", "web-annotations.json"].includes(file.filename)), false);
  assert.equal(JSON.stringify(files).includes("drive-file-"), false);
  assert.equal(JSON.stringify(files).includes(`papers/${id}/`), false);
  assert.equal(await (await runtime.artifacts.read(original.id)).text(), "pdf");
  assert.deepEqual(calls, [manifest.files[pdfPath]]);
  assert.deepEqual(runtime.query.listArtifacts("unknown"), []);
  await assert.rejects(runtime.artifacts.read(pdfPath), /資料が見つかりません/);
  runtime.dispose();
});

test("legacy snapshots retain their flattened handwritten PDF ordering", () => {
  const manifest = fixture();
  delete manifest.files["web-annotations.json"];
  const runtime = createDriveLibraryRuntime({ file: async () => new Blob() }, scope, manifest);
  assert.equal(runtime.query.listArtifacts(id)[0].filename, "original-annotated.pdf");
  assert.equal(runtime.query.listArtifacts(id)[0].annotationTarget, undefined);
  runtime.dispose();
});

test("review backups cannot replace current PDFs, and nested PDFs keep distinct labels and roles", async () => {
  const manifest = fixture();
  const backup = `papers/${id}/review-backups/20260919T120527Z-b38b0572/translated.pdf`;
  const nested = `papers/${id}/attachments/translated.pdf`;
  manifest.files[backup] = { ...manifest.files[translatedPath], id: "historical-pdf" };
  manifest.files[nested] = { ...manifest.files[translatedPath], id: "attached-pdf" };
  // This historical path sorts before translated.pdf under the old basename-only ranking.
  assert.ok(backup.localeCompare(translatedPath) < 0);
  const data = { version: 1, items: { [id]: { pageCount: 1,
    translatedPages: { "1": { artifactPath: translatedPath, page: 1 } } } } };
  const runtime = createDriveLibraryRuntime({ file: async () => new Blob([JSON.stringify(data)]) }, scope, manifest);
  const files = runtime.query.listArtifacts(id);
  assert.deepEqual(files.slice(0, 2).map(file => file.label), ["原文・ノート", "日本語訳"]);
  const translations = files.filter(file => file.label === "日本語訳");
  assert.equal(translations.length, 1);
  assert.equal(translations[0].annotationTarget?.side, "translated");
  assert.equal(files.some(file => file.label.includes("review-backups/")), false);
  const history = runtime.query.listArtifacts(null).find(file => file.label.startsWith("review-backups/"))!;
  assert.equal(history.role, "other");
  assert.equal(history.annotationTarget, undefined);
  const attachment = files.find(file => file.label === "attachments/translated.pdf")!;
  assert.equal(attachment.role, "attachment");
  assert.equal(attachment.annotationTarget, undefined);
  assert.deepEqual((await runtime.query.readDocumentPages(id))?.translatedPages["1"], { artifactId: translations[0].id, page: 1 });
  runtime.dispose();
});

test("relative images resolve only to published resources within the same item", () => {
  const runtime = createDriveLibraryRuntime({ file: async () => new Blob() }, scope, fixture());
  const memo = runtime.query.listArtifacts(id).find(file => file.filename === "memo.md")!;
  assert.equal(runtime.artifacts.resolveRelative(memo.id, "../media/image.png")?.filename, "image.png");
  for (const unsafe of ["https://evil.invalid/a.png", "//evil.invalid/a.png", "data:image/png;base64,a", "javascript:alert(1)",
    "\\evil\\image.png", "%2f%2fevil.invalid/a.png", "https%3A%2F%2Fevil.invalid/a.png", "../media/%00image.png",
    "../../../../settings.json", `../../${otherId}/original.pdf`, `../../%2e%2e/settings.json`, "../../../../library-data.json", "%"]) {
    assert.equal(runtime.artifacts.resolveRelative(memo.id, unsafe), undefined, unsafe);
  }
  assert.equal(runtime.artifacts.resolveRelative("not-an-artifact", "../media/image.png"), undefined);
  runtime.dispose();
});

test("caller abort cancels transport promptly and never returns a late Blob", async () => {
  const pending = deferred<Blob>();
  let transportSignal: AbortSignal | undefined;
  const runtime = createDriveLibraryRuntime({ file: async (_, signal) => { transportSignal = signal; return pending.promise; } }, scope, fixture());
  const controller = new AbortController();
  const result = runtime.artifacts.read(runtime.query.listArtifacts(id)[0].id, controller.signal);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(transportSignal?.aborted, true);
  pending.resolve(new Blob(["stale"]));
  runtime.dispose();
});

test("dispose cancels reads, isolates a replacement login, and rejects old artifact handles", async () => {
  const pending = deferred<Blob>();
  let signal: AbortSignal | undefined;
  const old = createDriveLibraryRuntime({ file: async (_, received) => { signal = received; return pending.promise; } }, scope, fixture());
  const oldId = old.query.listArtifacts(id)[0].id;
  const result = old.artifacts.read(oldId);
  old.dispose();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(signal?.aborted, true);
  assert.throws(() => old.query.listItems(), { name: "AbortError" });
  await assert.rejects(old.artifacts.read(oldId), { name: "AbortError" });
  const current = createDriveLibraryRuntime({ file: async () => new Blob(["current"]) }, { ...scope, sessionKey: "epoch-2" }, fixture());
  await assert.rejects(current.artifacts.read(oldId), /資料が見つかりません/);
  pending.resolve(new Blob(["old account"]));
  assert.equal(await (await current.artifacts.read(current.query.listArtifacts(id)[0].id)).text(), "current");
  current.dispose();
});

test("already-aborted requests make no transport call", async () => {
  let calls = 0;
  const runtime = createDriveLibraryRuntime({ file: async () => { calls++; return new Blob(); } }, scope, fixture());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.artifacts.read(runtime.query.listArtifacts(id)[0].id, controller.signal), { name: "AbortError" });
  await assert.rejects(runtime.query.readSavedReading(id, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  runtime.dispose();
});

test("saved reading is filtered by item, cached per snapshot, and independent of generation permissions", async () => {
  let calls = 0;
  const data = {
    bookmarks: [{ id: 10, paper_id: id, page: 4, side: "translated", label: "確認", quote: "引用", note: "メモ" },
      { paper_id: otherId, note: "other" }],
    messages: [{ id: 11, paper_id: id, role: "assistant", content: "保存済みの回答" }, { paper_id: otherId, content: "other" }],
  };
  const runtime = createDriveLibraryRuntime({ file: async () => { calls++; return new Blob([JSON.stringify(data)]); } }, scope, fixture());
  const saved = await runtime.query.readSavedReading(id);
  assert.deepEqual(saved.notes, [{ id: "10", page: 4, side: "translated", label: "確認", quote: "引用", note: "メモ" }]);
  assert.deepEqual(saved.messages, [{ id: "11", role: "assistant", content: "保存済みの回答" }]);
  await runtime.query.readSavedReading(otherId);
  assert.equal(calls, 1);
  assert.equal(runtime.capabilities["chat.generate"], false);
  runtime.dispose();
});

test("dispose during body parsing discards the old snapshot instead of caching or returning it", async () => {
  const content = deferred<string>();
  const parsing = deferred<void>();
  const blob = new Blob();
  blob.text = () => { parsing.resolve(); return content.promise; };
  const runtime = createDriveLibraryRuntime({ file: async () => blob }, scope, fixture());
  const result = runtime.query.readSavedReading(id);
  await parsing.promise;
  runtime.dispose();
  await assert.rejects(result, { name: "AbortError" });
  content.resolve(JSON.stringify({ messages: [{ paper_id: id, content: "old account" }] }));
  await assert.rejects(runtime.query.readSavedReading(id), { name: "AbortError" });
});

test("page mapping preserves exact partial-PDF page numbers and never guesses missing translations", async () => {
  const data = { version: 1, items: { [id]: { pageCount: 6, translatedPages: {
    "1": { artifactPath: translatedPath, page: 2 }, "2": { artifactPath: partialPath, page: 1 },
    "3": null, "4": { artifactPath: `papers/${id}/missing.pdf`, page: 1 },
    "5": { artifactPath: `papers/${otherId}/original.pdf`, page: 1 },
    "6": { artifactPath: `papers/${id}/original.pdf`, page: 1 },
  } } } };
  const calls: string[] = [];
  const manifest = fixture();
  const runtime = createDriveLibraryRuntime({ file: async file => { calls.push(file.id); return new Blob([JSON.stringify(data)]); } }, scope, manifest);
  const pages = await runtime.query.readDocumentPages(id);
  const artifacts = runtime.query.listArtifacts(id);
  assert.deepEqual(pages, { pageCount: 6, translatedPages: {
    "1": { artifactId: artifacts.find(file => file.filename === "translated.pdf")!.id, page: 2 },
    "2": { artifactId: artifacts.find(file => file.filename === "page-2.pdf")!.id, page: 1 }, "3": null, "4": null, "5": null, "6": null,
  } });
  assert.equal(await runtime.query.readDocumentPages(otherId), null);
  assert.deepEqual(calls, [manifest.files["web-reading.json"].id]);
  runtime.dispose();
});

test("old snapshots do not invent paired reading, while malformed mapping is rejected", async () => {
  const manifest = fixture(); delete manifest.files["web-reading.json"];
  const old = createDriveLibraryRuntime({ file: async () => { throw new Error("unexpected read"); } }, scope, manifest);
  assert.equal(await old.query.readDocumentPages(id), null);
  old.dispose();
  for (const invalid of [null, { version: 2, items: {} }, { version: 1, items: { [id]: { pageCount: 2, translatedPages: {
    "1": { artifactPath: translatedPath, page: 0 },
  } } } }, { version: 1, items: { [id]: { pageCount: 2, translatedPages: { "3": null } } } }]) {
    const runtime = createDriveLibraryRuntime({ file: async () => new Blob([JSON.stringify(invalid)]) }, scope, fixture());
    await assert.rejects(runtime.query.readDocumentPages(id), /ページ対応/);
    runtime.dispose();
  }
});
