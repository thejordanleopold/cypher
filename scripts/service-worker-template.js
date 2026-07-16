/* global Request, URL, caches, fetch, self */

// This file is a template. `generate-service-worker.mjs` replaces both markers
// after Next.js has produced the static `out/` directory.
const BUILD_REVISION = "__CYPHER_BUILD_REVISION__";
const PRECACHE_ENTRIES = /* __CYPHER_PRECACHE_MANIFEST__ */ [];

const PRECACHE_CACHE = `cypher-precache-${BUILD_REVISION}`;
const RUNTIME_CACHE = `cypher-runtime-${BUILD_REVISION}`;
const OWNED_CACHE_PREFIXES = [
  "cypher-precache-",
  "cypher-runtime-",
  "cypher-shell-", // Legacy cache names from the original worker.
];
const SCOPE_URL = self.registration.scope;
const NAVIGATION_FALLBACK_URL = new URL("./", SCOPE_URL).href;

function precacheRequest(entry) {
  return new Request(new URL(entry.url, SCOPE_URL), {
    cache: "reload",
    credentials: "same-origin",
  });
}

function isCacheable(response) {
  return response.ok && response.type !== "opaque";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE_CACHE);
      // addAll rejects the install if any required asset is unavailable. The
      // previous worker therefore remains active instead of claiming a broken
      // partial shell.
      await cache.addAll(PRECACHE_ENTRIES.map(precacheRequest));
      // Do not force an update to take over pages running the previous build.
      // The browser activates this worker immediately on first install, but an
      // update waits until the older worker has no clients. That prevents an
      // open page from requesting old hashed chunks after their cache is gone.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const currentCaches = new Set([PRECACHE_CACHE, RUNTIME_CACHE]);
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(
            (name) =>
              OWNED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
              !currentCaches.has(name),
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const runtime = await caches.open(RUNTIME_CACHE);
      await runtime.put(request, response.clone());
    }
    return response;
  } catch (networkError) {
    const precache = await caches.open(PRECACHE_CACHE);
    const cachedPage = await precache.match(request, { ignoreSearch: true });
    if (cachedPage) return cachedPage;

    const runtime = await caches.open(RUNTIME_CACHE);
    const runtimePage = await runtime.match(request, { ignoreSearch: true });
    if (runtimePage) return runtimePage;

    const fallback = await precache.match(NAVIGATION_FALLBACK_URL);
    if (fallback) return fallback;
    throw networkError;
  }
}

async function handleAsset(request, event) {
  const precache = await caches.open(PRECACHE_CACHE);
  const precached = await precache.match(request, { ignoreSearch: true });
  if (precached) return precached;

  const runtime = await caches.open(RUNTIME_CACHE);
  const cached = await runtime.match(request, { ignoreSearch: true });
  const network = fetch(request).then(async (response) => {
    if (isCacheable(response)) {
      await runtime.put(request, response.clone());
    }
    return response;
  });

  if (cached) {
    event.waitUntil(network.then(() => undefined).catch(() => undefined));
    return cached;
  }
  return network;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    request.mode === "navigate"
      ? handleNavigation(request)
      : handleAsset(request, event),
  );
});
