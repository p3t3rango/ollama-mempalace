// Minimal service worker — just enough to satisfy PWA install requirements
// and cache static assets for fast offline-startup. We DON'T cache /api/*
// (always live) or "/" (re-fetch each load to pick up HTML changes).

const CACHE = "ollama-mempalace-v1";
const STATIC_ASSETS = [
  "/static/app.css",
  "/static/app.js",
  "/static/icon.svg",
  "/static/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET. Always pass-through for API + root + cross-origin.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/"
  ) {
    return;
  }
  // Cache-first for static assets
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            // Stash a copy for next time
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
            return res;
          }),
      ),
    );
  }
});
