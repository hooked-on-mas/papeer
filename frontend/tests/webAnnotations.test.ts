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

test('one erase gesture is one durable operation; quota failure leaves every target unchanged and retry/reload stays atomic', async () => {
  const local = storage(), write = local.setItem.bind(local), remote = new Map<string, Operation>(); let quota = false, offline = true, groupedWrites = 0;
  local.setItem = (key, value) => { if (JSON.parse(value).version === 2) { if (quota) throw new Error('quota'); if (key.startsWith('papeer-ink:')) groupedWrites++; } write(key, value); };
  const transport = { annotationFiles: async () => [...remote].map(([id]) => ({ id, name: `ink-${id}.json`, size: '100' })),
    annotation: async (id: string) => remote.get(id), saveAnnotation: async (_library: string, _folder: string, id: string, op: Operation) => { remote.set(id, op); if (offline) throw new Error('offline'); } } as unknown as DriveSession;
  const first = new AnnotationStore(transport, 'library', manifest, local); await first.start();
  const a = first.add(anchor, stroke), b = first.add(anchor, stroke); await first.flush();
  const before = first.getSnapshot().pending; quota = true;
  assert.throws(() => first.edit(anchor, { remove: [a.id, b.id] }), /quota/);
  assert.equal(first.getSnapshot().pending, before); assert.deepEqual(first.page(anchor).strokes.map(value => value.id), [a.id, b.id]);
  quota = false; first.edit(anchor, { remove: [a.id, b.id] }); await first.flush();
  assert.equal(groupedWrites, 1); assert.equal(first.page(anchor).strokes.length, 0); first.dispose();
  const reopened = new AnnotationStore(transport, 'library', manifest, local); await reopened.start(); assert.equal(reopened.page(anchor).strokes.length, 0);
  offline = false; await reopened.retry(); assert.equal(local.length, 0);
  const restored = reopened.edit(anchor, { add: [a, b] }); assert.equal(restored.length, 2); assert.equal(reopened.page(anchor).strokes.length, 2);
  reopened.edit(anchor, { remove: restored.map(value => value.id) }); assert.equal(reopened.page(anchor).strokes.length, 0); await reopened.flush();
  assert.ok([...remote.values()].filter(op => op.version === 2).every(op => op.action === 'edit' && op.changes.length === 2));
});

test('erase admission rejects an oversized inverse, permits smaller groups, and cleans interrupted probes', async () => {
  const local = storage(), write = local.setItem.bind(local), uploads: Operation[] = [];
  local.setItem = (key, value) => { if (value.length > 1800) throw new Error('quota'); write(key, value); };
  write('papeer-ink-admission:library:interrupted', 'not an operation');
  const transport = { annotationFiles: async () => [], saveAnnotation: async (_library: string, _folder: string, _id: string, op: Operation) => { uploads.push(op); } } as unknown as DriveSession;
  const store = new AnnotationStore(transport, 'library', manifest, local); await store.start();
  assert.equal(store.getSnapshot().ready, true); assert.equal(local.length, 0);
  const large = { ...stroke, points: Array.from({ length: 20 }, () => [.12345678901234567, .7654321098765432] as [number, number]) };
  const a = store.add(anchor, large); await store.flush(); const b = store.add(anchor, large); await store.flush();
  assert.throws(() => store.edit(anchor, { remove: [a.id, b.id] }), /一度に消去する量を減らして/);
  assert.equal(uploads.length, 2); assert.equal(local.length, 0);
  assert.deepEqual(store.page(anchor).strokes, [a, b]);
  store.edit(anchor, { remove: [a.id] }); await store.flush();
  assert.deepEqual(store.page(anchor).strokes, [b]);
  store.edit(anchor, { add: [a] }); await store.flush();
  assert.equal(store.page(anchor).strokes.length, 2); assert.equal(local.length, 0); store.dispose();
});

test('grouped ink validates the whole change collection before taking an operation ID', () => {
  const a = add(); if (a.action !== 'add') assert.fail();
  const op: Operation = { ...anchor, library_id: 'library', id: crypto.randomUUID(), version: 2, action: 'edit', changes: [{ action: 'remove', target: a.stroke.id }] };
  assert.deepEqual(parseOperation(op, 'library'), op);
  for (const bad of [ { ...op, changes: [] }, { ...op, changes: 1 }, { ...op, changes: [op.changes[0], op.changes[0]] },
    { ...op, changes: [{ action: 'remove', target: a.stroke.id, stroke: a.stroke }] }, { ...op, version: true }, { ...op, target: a.stroke.id },
    { ...op, changes: [{ action: 'remove', target: a.stroke.id + '\n' }] } ]) assert.throws(() => parseOperation(bad, 'library'));
});

test('erase admission accounts for forward and inverse journals coexisting during offline Undo', async () => {
  const local = storage(), write = local.setItem.bind(local);
  let capacity = Infinity, offline = false;
  const usage = () => Array.from({ length: local.length }, (_, i) => local.key(i)!)
    .reduce((size, key) => size + key.length + local.getItem(key)!.length, 0);
  local.setItem = (key, value) => {
    const previous = local.getItem(key);
    if (usage() - (previous === null ? 0 : key.length + previous.length) + key.length + value.length > capacity) {
      throw new Error('QuotaExceededError');
    }
    write(key, value);
  };
  const transport = { annotationFiles: async () => [], saveAnnotation: async () => { if (offline) throw new Error('offline'); } } as unknown as DriveSession;
  const store = new AnnotationStore(transport, 'library', manifest, local); await store.start();
  const a = store.add(anchor, { ...stroke, points: Array.from({ length: 500 }, () => [.12345678901234567, .7654321098765432] as [number, number]) });
  await store.flush(); assert.equal(local.length, 0); offline = true;
  const forward: Operation = { ...anchor, id: crypto.randomUUID(), library_id: 'library', version: 2, action: 'edit', changes: [{ action: 'remove', target: a.id }] };
  const inverse: Operation = { ...anchor, id: crypto.randomUUID(), library_id: 'library', version: 2, action: 'edit', changes: [{ action: 'add', stroke: { ...a, id: 'web-' + crypto.randomUUID() } }] };
  // The old inverse-only probe fits, but the actual offline Undo would not.
  capacity = ('papeer-ink-admission:library:' + crypto.randomUUID()).length + JSON.stringify(inverse).length;
  assert.throws(() => store.edit(anchor, { remove: [a.id] }), /一度に消去する量を減らして/);
  assert.deepEqual(store.page(anchor).strokes, [a]); assert.equal(local.length, 0); assert.equal(store.getSnapshot().pending, 0);
  // Exactly enough for both keys/bodies plus the conservative JSON-array margin.
  capacity = ('papeer-ink:library:' + forward.id).length + ('papeer-ink:library:' + inverse.id).length
    + JSON.stringify(forward).length + JSON.stringify(inverse).length + 3;
  store.edit(anchor, { remove: [a.id] }); await store.flush();
  assert.equal(store.page(anchor).strokes.length, 0); assert.equal(store.getSnapshot().pending, 1);
  const restored = store.edit(anchor, { add: [a] }); await store.flush();
  assert.deepEqual(store.page(anchor).strokes, restored); assert.equal(store.getSnapshot().pending, 2);
  assert.equal(local.length, 2); assert.ok(usage() <= capacity); store.dispose();
});

test('one grouped Undo can restore multiple legal large strokes and survive remote reload', async () => {
  const remote = new Map<string, Operation>();
  const transport = { annotationFiles: async () => [...remote].map(([id, op]) => ({ id, name: `ink-${id}.json`, size: String(new TextEncoder().encode(JSON.stringify(op)).length) })),
    annotation: async (id: string) => remote.get(id), saveAnnotation: async (_library: string, _folder: string, id: string, op: Operation) => { remote.set(id, op); } } as unknown as DriveSession;
  const store = new AnnotationStore(transport, 'library', manifest, storage()); await store.start();
  const large = { ...stroke, points: Array.from({ length: 20000 }, () => [.12345678901234567, .7654321098765432] as [number, number]) };
  const a = store.add(anchor, large), b = store.add(anchor, large); await store.flush();
  store.edit(anchor, { remove: [a.id, b.id] }); await store.flush();
  const restored = store.edit(anchor, { add: [a, b] }); await store.flush();
  assert.equal(store.page(anchor).strokes.length, 2);
  assert.ok([...remote.values()].some(op => op.version === 2 && JSON.stringify(op).length > 1024 * 1024));
  store.dispose();
  const reopened = new AnnotationStore(transport, 'library', manifest, storage()); await reopened.start();
  assert.deepEqual(reopened.page(anchor).strokes.map(s => s.id), restored.map(s => s.id));
  reopened.edit(anchor, { remove: restored.map(s => s.id) }); await reopened.flush();
  assert.equal(reopened.page(anchor).strokes.length, 0); reopened.dispose();
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

test("concurrent initialization/reconnects share one read and recover an initial failure", async () => {
  let fail = true, calls = 0;
  let release = () => {};
  let waiting = new Promise<void>(resolve => { release = resolve; });
  const transport = { annotationFiles: async () => { calls++; await waiting; if (fail) throw new Error("offline"); return []; } } as unknown as DriveSession;
  const store = new AnnotationStore(transport, "library", manifest, storage());
  const first = store.start(); assert.equal(store.start(), first);
  release(); await first;
  assert.equal(calls, 1); assert.equal(store.getSnapshot().ready, false);
  fail = false; waiting = new Promise<void>(resolve => { release = resolve; });
  const retries = [store.retry(), store.retry(), store.retry()];
  release(); await Promise.all(retries);
  assert.equal(calls, 2); assert.equal(store.getSnapshot().ready, true); assert.equal(store.getSnapshot().error, "");
  store.dispose();
});

test("a recovered refresh failure clears its error even when there was no pending upload", async () => {
  let fail = false;
  const transport = { annotationFiles: async () => { if (fail) throw new Error("offline"); return []; } } as unknown as DriveSession;
  const store = new AnnotationStore(transport, "library", manifest, storage()); await store.start();
  fail = true; await store.retry(); assert.match(store.getSnapshot().error, /offline/);
  fail = false; await Promise.all([store.retry(), store.retry()]);
  assert.equal(store.getSnapshot().error, ""); store.dispose();
});

test("blocked browser storage does not crash library viewing or pretend that ink is durably saved", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
  const transport = { annotationFiles: async () => [] } as unknown as DriveSession;
  const store = new AnnotationStore(transport, "library", manifest); await store.start();
  assert.equal(store.getSnapshot().ready, false); assert.match(store.getSnapshot().error, /保存領域/);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage() });
  await store.retry(); assert.equal(store.getSnapshot().ready, true); assert.equal(store.getSnapshot().error, ""); store.dispose();
});
