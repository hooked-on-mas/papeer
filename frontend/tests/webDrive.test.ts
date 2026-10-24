import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveSession, fileLabel, itemFiles, parseManifest, type Manifest } from "../src/web/drive.ts";

const id = "a".repeat(32);
const hash = "b".repeat(64);

test("tab grants survive reload without another prompt, keep Google's expiry, and clear on rejection or logout", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  const stored = new Map<string, string>(), prompts: string[] = [];
  let status = 200, requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    get localStorage() { throw new Error("Bearer tokens must not enter localStorage"); },
    google: { accounts: { oauth2: {
      initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: ({ prompt }: { prompt: string }) => {
        prompts.push(prompt); options.callback({ access_token: "fixture-token", expires_in: 100 });
      } }),
    } } },
  } });
  globalThis.fetch = async () => { requests++; return status === 200 ? Response.json({ files: [] }) : new Response("", { status }); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const session = new DriveSession(); await session.signIn();
  assert.equal(stored.size, 1);
  const [key, value] = [...stored][0];
  t.mock.timers.tick(50_000);
  const restored = new DriveSession();
  assert.equal(restored.hasValidToken(), true);
  assert.deepEqual(await restored.libraries(), []);
  assert.deepEqual(prompts, [""]);
  assert.equal(stored.get(key), value, "restoring a token never extends its deadline");
  t.mock.timers.tick(50_000);
  const expired = new DriveSession();
  await assert.rejects(expired.libraries(), /有効期限/);
  assert.equal(stored.size, 0); assert.equal(requests, 1);
  await expired.signIn({ selectAccount: true });
  assert.deepEqual(prompts, ["", "select_account"]);
  status = 401;
  await assert.rejects(expired.libraries(), /ログイン/);
  assert.equal(stored.size, 0); assert.equal(new DriveSession().hasValidToken(), false);
  await expired.signIn(); expired.signOut();
  assert.equal(stored.size, 0); assert.equal(new DriveSession().hasValidToken(), false);
});

test("unusable tab storage and invalid saved grants do not prevent manual login or cause Drive requests", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  const stored = new Map<string, string>();
  let blocked = false, writeBlocked = false, requests = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get sessionStorage() {
      if (blocked) throw new DOMException("disabled", "SecurityError");
      return { getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (writeBlocked) throw new DOMException("full", "QuotaExceededError");
          stored.set(key, value);
        }, removeItem: (key: string) => stored.delete(key) };
    },
    google: { accounts: { oauth2: {
      initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: () => options.callback({ access_token: "fixture", expires_in: 100 }) }),
    } } },
  } });
  globalThis.fetch = async () => { requests++; return Response.json({ files: [] }); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  await new DriveSession().signIn();
  const [key, value] = [...stored][0], saved = JSON.parse(value);
  for (const invalid of ["{broken", "null", JSON.stringify({ ...saved, clientId: "another-app" }),
    JSON.stringify({ ...saved, scope: "another-scope" }), JSON.stringify({ ...saved, expires: "forever" })]) {
    stored.set(key, invalid);
    await assert.rejects(new DriveSession().libraries(), /ログイン/);
    assert.equal(stored.size, 0);
  }
  assert.equal(requests, 0);
  await new DriveSession().signIn();
  writeBlocked = true;
  const switched = new DriveSession(); await switched.signIn({ selectAccount: true });
  assert.equal(switched.hasValidToken(), true);
  assert.equal(stored.size, 0, "failed persistence must not restore the previous account");
  assert.equal(new DriveSession().hasValidToken(), false);
  blocked = true;
  const memoryOnly = new DriveSession(); await memoryOnly.signIn();
  assert.deepEqual(await memoryOnly.libraries(), []);
  assert.equal(new DriveSession().hasValidToken(), false);
  memoryOnly.signOut(); assert.equal(memoryOnly.hasValidToken(), false);
});

test("popup/consent/SDK failures can retry, and an expired grant makes no Drive request", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  let mode = "denied", calls = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void; error_callback: () => void }) => ({ requestAccessToken: () => {
      if (mode === "denied") options.callback({ error: "access_denied", error_description: "private-description" });
      else if (mode === "popup") options.error_callback();
      else if (mode === "throw") throw new Error("private-description");
      else options.callback({ access_token: "fixture-token", expires_in: 1 });
    } }),
  } } } } });
  globalThis.fetch = async () => { calls++; return Response.json({ files: [] }); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const session = new DriveSession();
  for (mode of ["denied", "popup", "throw"]) {
    await assert.rejects(session.signIn(), error => error instanceof Error && !error.message.includes("private-description"));
    await assert.rejects(session.libraries(), /ログイン/);
  }
  mode = "ok"; await session.signIn(); t.mock.timers.tick(1001);
  await assert.rejects(session.libraries(), /有効期限/); assert.equal(calls, 0);
  await session.signIn(); assert.deepEqual(await session.libraries(), []); assert.equal(calls, 1);
});

test("Drive HTTP errors are actionable without leaking response bodies, and the same session can retry", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  let status = 401;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: () => options.callback({ access_token: "fixture", expires_in: 100 }) }),
  } } } } });
  globalThis.fetch = async () => status === 200 ? Response.json({ files: [] }) : new Response("private-server-body", { status });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  const session = new DriveSession(); await session.signIn();
  for (status of [401, 403, 429, 503]) {
    await session.signIn();
    await assert.rejects(session.libraries(), error => error instanceof Error
      && (status === 401 ? error.message.includes("ログイン") : error.message.includes(String(status)))
      && !error.message.includes("private-server-body"));
  }
  status = 200; assert.deepEqual(await session.libraries(), []);
});

test("annotation uploads use the Drive upload endpoint and validated parent metadata", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  let parent = "fixture-folder";
  const calls: { url: string; init?: RequestInit }[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: () => options.callback({ access_token: "fixture", expires_in: 100 }) }),
  } } } } });
  globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return Response.json({ parents: [parent], id: "event" }); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  const session = new DriveSession(); await session.signIn();
  const op = { note: "日本語の書き込み" };
  await session.saveAnnotation("library", undefined, "operation-id", op);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /library\?fields=parents$/);
  assert.match(calls[1].url, /^https:\/\/www.googleapis.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.equal(calls[1].init?.method, "POST");
  const body = String(calls[1].init?.body);
  assert.ok(body.includes(JSON.stringify(op)) && body.includes('"parents":["fixture-folder"]') && body.includes('"library":"library"'));
  assert.ok(calls.every(call => new Headers(call.init?.headers).get("Authorization") === "Bearer fixture"));
  parent = "../invalid";
  await assert.rejects(session.saveAnnotation("library", undefined, "operation-id", op), /保存フォルダー/);
  assert.equal(calls.length, 3, "an invalid parent is not uploaded");
  await assert.rejects(session.annotationFiles("invalid' query"), /不正/);
});
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
    { ...manifest(), items: [{ id }, { id }] }, { ...manifest(), files: [] },
    { ...manifest(), files: { "../secret": { id: "test", sha256: hash, size: 1, mime: "text/plain" } } },
    { ...manifest(), files: { "bad": { id: "test", sha256: "bad", size: -1, mime: "text/plain" } } }]) {
    assert.throws(() => parseManifest(bad));
  }
});

test("Google connection can be cancelled or timed out, ignores late grants, and can be retried", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const callbacks: ((response: object) => void)[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: () => { callbacks.push(options.callback); } }),
  } } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = new DriveSession();
  const cancelled = assert.rejects(session.signIn(), /キャンセル/);
  session.cancelSignIn(); await cancelled;
  callbacks[0]({ access_token: "late-token", expires_in: 100 });
  await assert.rejects(session.libraries(), /ログイン/);
  const expired = assert.rejects(session.signIn(), /時間切れ/);
  t.mock.timers.tick(180_001); await expired;
  callbacks[1]({ access_token: "late-token", expires_in: 100 });
  await assert.rejects(session.libraries(), /ログイン/);
  const next = session.signIn(); callbacks[2]({ access_token: "valid-token", expires_in: 100 }); await next;
  const cancelledByLogout = assert.rejects(session.signIn(), /キャンセル/);
  session.signOut(); await cancelledByLogout;
  callbacks[3]({ access_token: "late-token", expires_in: 100 });
  await assert.rejects(session.libraries(), /ログイン/);
});

test("Drive body reads cannot cross logout and a stalled request has a bounded timeout", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { google: { accounts: { oauth2: {
    initTokenClient: (options: { callback: (response: object) => void }) => ({ requestAccessToken: () => options.callback({ access_token: "test", expires_in: 100 }) }),
  } } } } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window");
  });
  let release = (_buffer: ArrayBuffer) => {};
  const body = new Promise<ArrayBuffer>(resolve => { release = resolve; });
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: () => body } as Response);
  const session = new DriveSession(); await session.signIn();
  const file = { id: "file", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", mime: "text/plain" };
  const cancelled = assert.rejects(session.file(file), /ログイン状態/);
  await Promise.resolve(); session.signOut(); release(new TextEncoder().encode("abc").buffer); await cancelled;
  await session.signIn();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timedOut = assert.rejects(session.libraries(), /時間切れ/);
  t.mock.timers.tick(120_001); await timedOut; session.signOut();
});

test("handwritten PDFs appear first and attachments keep their human title", () => {
  const m = manifest();
  assert.equal(itemFiles(m, id)[0], `web/${id}/original-annotated.pdf`);
  assert.equal(fileLabel(`papers/${id}/attachments/memo.md`, m), "読書メモ");
  assert.deepEqual(itemFiles(m, "unrelated"), []);
});

test("Drive session uses bearer headers, pagination, integrity checks and logout", async () => {
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
