import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveSession, fileLabel, itemFiles, parseManifest, type Manifest } from "../src/web/drive.ts";

const id = "a".repeat(32);
const hash = "b".repeat(64);
function manifest(): Manifest {
  return { version: 1, updated_at: "2026-10-18T00:00:00Z", revision: "revision", items: [{ id, title: "論文" }],
    attachments: [{ id: "memo", owner_id: id, title: "読書メモ", format: "md" }], files: {
      [`papers/${id}/attachments/memo.md`]: { id: "file-1", sha256: hash, size: 3, mime: "text/markdown" },
      [`papers/${id}/original.pdf`]: { id: "file-2", sha256: hash, size: 3, mime: "application/pdf" },
      [`web/${id}/original-annotated.pdf`]: { id: "file-3", sha256: hash, size: 3, mime: "application/pdf" },
    } };
}

test("manifest validation rejects incompatible and unsafe data", () => {
  assert.deepEqual(parseManifest(manifest()), manifest());
  for (const bad of [null, {}, { ...manifest(), version: 9 }, { ...manifest(), items: [{ id: "../../" }] },
    { ...manifest(), files: { "../secret": { id: "test", sha256: hash, size: 1, mime: "text/plain" } } },
    { ...manifest(), files: { "bad": { id: "test", sha256: "bad", size: -1, mime: "text/plain" } } }]) {
    assert.throws(() => parseManifest(bad));
  }
});

test("handwritten PDFs appear first and attachments keep their human title", () => {
  const m = manifest();
  assert.equal(itemFiles(m, id)[0], `web/${id}/original-annotated.pdf`);
  assert.equal(fileLabel(`papers/${id}/attachments/memo.md`, m), "読書メモ");
  assert.deepEqual(itemFiles(m, "unrelated"), []);
});

test("Drive session uses bearer headers, pagination, integrity checks and memory-only logout", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const calls: { url: string; auth: string | null }[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void }) => ({
      requestAccessToken: () => options.callback({ access_token: "private-token", expires_in: 100 }),
    }),
  } } } } });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    if (url.includes("alt=media")) return new Response("abc");
    return Response.json(url.includes("pageToken=next") ? { files: [{ id: "second" }] }
      : { files: [{ id: "first" }], nextPageToken: "next" });
  };
  try {
    const session = new DriveSession();
    await session.signIn();
    assert.deepEqual((await session.libraries()).map(f => f.id), ["first", "second"]);
    const file = { id: "file", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", mime: "text/plain" };
    assert.equal(await (await session.file(file)).text(), "abc");
    await assert.rejects(session.file({ ...file, sha256: hash }), /一致/);
    await assert.rejects(session.file({ ...file, size: 4 }), /完全/);
    assert.ok(calls.every(call => call.auth === "Bearer private-token" && !call.url.includes("private-token")));
    session.signOut();
    await assert.rejects(session.libraries(), /ログイン/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
