// The typed client (src/api/client.ts: api and unwrap) as the app's requests use it, against a stubbed
// fetch: where and how a request with a body is sent (read out as bytes, decoded here), a refusal during a background sync sent again with
// the same body, an error answer, and a stopped request. Vite loads the module as the app does (its "@/"
// imports and import.meta.env).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

Object.assign(globalThis, { window: globalThis, __PAPEER_PORT: 4321, __PAPEER_TOKEN: "secret" });

let server;
let client;
let libraryBusy;
const realFetch = globalThis.fetch;
let sent = [];
let answers = [];

before(async () => {
  server = await createServer({
    configFile: false, root: path(".."), logLevel: "error", appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    resolve: { alias: [{ find: "@", replacement: path("../src") }] },
  });
  client = await server.ssrLoadModule("/src/api/client.ts");
  libraryBusy = await server.ssrLoadModule("/src/lib/libraryBusy.ts");
  globalThis.fetch = async (input, init = {}) => {
    const request = { url: String(input), method: init.method, headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : new TextDecoder().decode(init.body), signal: init.signal };
    sent.push(request);
    if (init.signal?.aborted) throw new DOMException("stopped", "AbortError");
    const [status, body] = answers.shift() ?? [200, {}];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await server?.close();
});

function reset(...next) {
  sent = [];
  answers = next;
}

test("a request with a body goes to the sidecar's port with the token, its body as JSON text", async () => {
  const { api, unwrap } = client;
  reset([200, { status: "updated" }]);
  const answer = await unwrap(api.PATCH("/api/papers/{paper_id}", { params: { path: { paper_id: "p1" } }, body: { tags: ["重要"] } }));
  assert.deepEqual(answer, { status: "updated" });
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.url, "http://127.0.0.1:4321/api/papers/p1");
  assert.equal(request.method, "PATCH");
  assert.equal(request.headers.get("Authorization"), "Bearer secret");
  assert.equal(request.headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), { tags: ["重要"] });
});

test("a request without a body sends none, and path and query values are encoded", async () => {
  const { api, unwrap } = client;
  reset([200, { moved: [], undo_token: "t" }], [200, { affected: 0 }]);
  await unwrap(api.DELETE("/api/collections/{name}", { params: { path: { name: "ML / NLP" } } }));
  await unwrap(api.DELETE("/api/tags", { params: { query: { name: "a&b" } } }));
  assert.equal(sent[0].url, "http://127.0.0.1:4321/api/collections/ML%20%2F%20NLP");
  assert.equal(sent[0].body, undefined);
  assert.equal(sent[0].headers.get("Content-Type"), null);
  assert.equal(sent[1].url, "http://127.0.0.1:4321/api/tags?name=a%26b");
});

test("one refused during a background sync is sent again, with the same body, once the sync lets it", async () => {
  const { api, unwrap } = client;
  let waited = 0;
  libraryBusy.setLibraryBusyWaiter(async () => { waited++; return true; });
  try {
    reset([409, { detail: "同期中です。", code: "library_busy" }], [200, { status: "updated" }]);
    await unwrap(api.PATCH("/api/papers/{paper_id}", { params: { path: { paper_id: "p1" } }, body: { note: "memo" } }));
    assert.equal(waited, 1);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((request) => JSON.parse(request.body)), [{ note: "memo" }, { note: "memo" }]);
  } finally {
    libraryBusy.setLibraryBusyWaiter(async () => false);
  }
});

test("a refusal throws the ApiError apiRequest would, with the body's message and code", async () => {
  const { api, unwrap, ApiError } = client;
  reset([409, { detail: "同期中です。", code: "library_busy" }]);
  await assert.rejects(unwrap(api.POST("/api/collections", { body: { name: "ML" } })), (error) =>
    error instanceof ApiError && error.status === 409 && error.code === "library_busy" && error.message === "同期中です。");
  reset([400, { detail: [{ msg: "短すぎます" }] }]);
  await assert.rejects(unwrap(api.POST("/api/collections", { body: { name: "" } })), (error) =>
    error instanceof ApiError && error.status === 400 && error.code === undefined && error.message === "短すぎます");
});

test("a stopped request rejects with its AbortError, an unreachable sidecar with an ApiError", async () => {
  const { api, unwrap, ApiError } = client;
  const controller = new AbortController();
  controller.abort();
  reset();
  await assert.rejects(unwrap(api.GET("/api/library-search", { params: { query: { q: "x" } }, signal: controller.signal })),
    (error) => error.name === "AbortError");
  const stub = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    await assert.rejects(unwrap(api.GET("/api/jobs")), (error) => error instanceof ApiError && error.status === 0);
  } finally {
    globalThis.fetch = stub;
  }
});
