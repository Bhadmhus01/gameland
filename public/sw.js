/**
 * AYO service worker.
 * The whole point: a player on a slow or intermittent connection can still
 * play today's round. Static shell is cached; the API is never cached stale.
 */

const SHELL = "ayo-shell-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/main.js",
  "/js/engine.js",
  "/js/countries.js",
  "/js/games.js",
  "/js/views.js",
  "/js/api.js",
  "/js/store.js",
  "/js/ui.js",
  "/fonts/anton-latin-400.woff2",
  "/fonts/inter-latin-var.woff2",
  "/icon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Never serve a stale leaderboard.
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response("{}", { headers: { "content-type": "application/json" } })));
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
