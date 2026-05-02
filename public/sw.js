// Minimal service worker: cache the app shell so Cypher works offline after first load.
// User audio is NOT cached — it lives in IndexedDB.

const CACHE = "cypher-shell-v13";
// Paths resolve relative to the worker's scope, which Next.js sets to the
// basePath under which the page was served (e.g. /cypher/ on GitHub Pages,
// / locally).
function shellUrls() {
  const scope =
    (self.registration && self.registration.scope) || self.location.origin + "/";
  const base = scope.endsWith("/") ? scope : scope + "/";
  return [base, base + "manifest.webmanifest"];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(shellUrls())).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Stale-while-revalidate for app assets.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
