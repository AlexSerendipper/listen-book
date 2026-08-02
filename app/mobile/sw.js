const SHELL_CACHE = "listen-book-mobile-shell-v9";
const SHELL = [
  "/mobile/",
  "/mobile/index.html",
  "/mobile/styles.css?v=9",
  "/mobile/manifest.webmanifest",
  "/mobile/icons/app-icon.svg",
  "/mobile/src/app.js?v=9",
  "/mobile/src/api.js?v=9",
  "/mobile/src/anchor.js?v=9",
  "/mobile/src/db.js?v=9",
  "/mobile/src/reader.js?v=9",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("listen-book-mobile-shell-") && key !== SHELL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (!url.pathname.startsWith("/mobile/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/mobile/index.html")),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
