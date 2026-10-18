import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnotationStore, mergeInk, parseOperation, type Anchor, type Operation } from "../src/web/annotations.ts";
import type { DriveSession, Manifest } from "../src/web/drive.ts";

const anchor: Anchor = { paper_id: "a".repeat(32), side: "translated", source_sha256: "b".repeat(64), page: 1 };
const manifest: Manifest = { version: 1, revision: "r", updated_at: "now", folder_id: "folder", items: [], attachments: [],
  files: { [`papers/${anchor.paper_id}/translated.pdf`]: { id: "pdf", sha256: anchor.source_sha256, size: 0, mime: "application/pdf" } } };
const stroke = { color: "#ff0000", width: .003, kind: "pen" as const, points: [[.1, .1], [.5, .5]] as [number, number][] };
const add = (): Operation => { const id = crypto.randomUUID(); return { ...anchor, version: 1, library_id: "library", id, action: "add", stroke: { ...stroke, id: "web-" + id } }; };
const remove = (target: string): Operation => ({ ...anchor, version: 1, library_id: "library", id: crypto.randomUUID(), action: "remove", target });
const storage = () => {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() } as Storage;
};

test("page/version anchors, tombstones, duplicate events and imported PC edits merge predictably", () => {
  const added = add(); assert.equal(added.action, "add"); if (added.action !== "add") return;
  const removed = remove(added.stroke.id), pc = { ...stroke, id: "pc" };
  assert.equal(mergeInk([pc], [added, added], anchor, []).length, 2);
  assert.deepEqual(mergeInk([pc], [removed, added], anchor, []), [pc]);
  assert.deepEqual(mergeInk([pc], [added], { ...anchor, page: 2 }, []), [pc]);
  assert.deepEqual(mergeInk([pc], [added], { ...anchor, source_sha256: "c".repeat(64) }, []), [pc]);
  assert.deepEqual(mergeInk([pc], [added], anchor, [added.id]), [pc]); // Erased on the PC after import.
  assert.equal(mergeInk([pc, added.stroke], [added], anchor, [added.id]).length, 2); // No double rendering.
  assert.equal(mergeInk([added.stroke], [added, removed], anchor, [added.id, removed.id]).length, 1); // Later PC undo.
  assert.throws(() => parseOperation({ ...added, library_id: "another" }, "library"));
  assert.throws(() => parseOperation({ ...removed, target: "pc" }, "library"));
  assert.throws(() => parseOperation({ ...added, stroke: { ...added.stroke, points: [[Infinity, 1]] } }, "library"));
});

test("failed/ambiguous network saves keep durable drafts; reopening and retry deduplicate by operation ID", async () => {
  const local = storage(), remote = new Map<string, Operation>();
  let offline = true;
  const transport = {
    annotationFiles: async () => [...remote.keys()].map(id => ({ id, name: `ink-${id}.json`, size: "100" })),
    annotation: async (id: string) => remote.get(id),
    saveAnnotation: async (_library: string, _folder: string, id: string, op: Operation) => {
      remote.set(id, op); if (offline) throw new Error("lost response after accepted upload");
    },
  } as unknown as DriveSession;
  const first = new AnnotationStore(transport, "library", manifest, local); await first.start();
  first.add(anchor, stroke); await first.flush();
  assert.equal(first.getSnapshot().pending, 1); assert.equal(local.length, 1); first.dispose();
  const second = new AnnotationStore(transport, "library", manifest, local); await second.start();
  assert.equal(second.page(anchor).strokes.length, 1); assert.equal(second.getSnapshot().pending, 1);
  offline = false; await second.retry();
  assert.equal(second.getSnapshot().pending, 0); assert.equal(local.length, 0); assert.equal(remote.size, 1);
  second.dispose();
});

test("storage failures do not report a successful stroke; unrelated library drafts stay isolated", async () => {
  const local = storage();
  const other = { ...add(), library_id: "another" };
  local.setItem(`papeer-ink:another:${other.id}`, JSON.stringify(other));
  const transport = { annotationFiles: async () => [] } as unknown as DriveSession;
  const store = new AnnotationStore(transport, "library", manifest, local); await store.start();
  assert.equal(store.page(anchor).strokes.length, 0);
  local.setItem = () => { throw new Error("quota exceeded"); };
  assert.throws(() => store.add(anchor, stroke), /quota/);
  assert.equal(store.page(anchor).strokes.length, 0); assert.equal(store.getSnapshot().pending, 0);
  assert.match(store.getSnapshot().error, /この端末/); store.dispose();
});
