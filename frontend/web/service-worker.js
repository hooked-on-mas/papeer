/* Only build-generated public assets are cached. No Google/Drive requests or user data. */
const VERSION = __PAPEER_VERSION__;
const ASSETS = __PAPEER_ASSETS__;
const BASE = new URL("./", self.location.href);
const PREFIX = `papeer-shell:${BASE.pathname}:`;
const CACHE = PREFIX + VERSION;
const URLS = new Set(ASSETS.map(name => new URL(name, BASE).href));
const INDEX = new URL("index.html", BASE).href;

self.addEventListener("install", event => {
  // Atomic install: keep the current version if a deployment is incomplete or offline.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...URLS].map(url => new Request(url, { cache: "reload", credentials: "omit" })));
  })());
  // Wait by default: switching versions requires an explicit request from the only reader.
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// An explicit update may reload only its requesting window. Keep other readers
// on their current version, where they may still have a stroke or unsaved text.
self.addEventListener("message", event => {
  if (event.data?.type !== "PAPEER_APPLY_UPDATE" || !event.ports[0]) return;
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .filter(client => new URL(client.url).pathname.startsWith(BASE.pathname));
    if (windows.length !== 1 || windows[0].id !== event.source?.id) {
      event.ports[0].postMessage("other-windows"); return;
    }
    event.ports[0].postMessage("updating");
    await self.skipWaiting();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== BASE.origin
      || request.headers.has("authorization") || request.headers.has("range")) return;
  const navigation = request.mode === "navigate"
    && (url.pathname === BASE.pathname || url.pathname === new URL(INDEX).pathname);
  // No wildcard runtime caching, query-string requests, fallback for arbitrary routes,
  // documents, OAuth redirects, or other apps sharing this GitHub Pages origin.
  if (!navigation && (url.search || !URLS.has(url.href))) return;
  const key = navigation ? INDEX : url.href;
  event.respondWith((async () => {
    const cached = await (await caches.open(CACHE)).match(key);
    return cached || fetch(request);
  })());
});
