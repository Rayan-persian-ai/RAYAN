// RAYAN service worker: keeps the app shell, brand assets and the wllama runtime available offline,
// so the in-browser model can answer without a network. API calls are never cached.
const CACHE = "rayan-shell-v4";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/brand/orb.png", "/brand/orb-64.png", "/brand/wordmark.png", "/brand/favicon-32.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("rayan-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  if (e.request.mode === "navigate") {
    // network first for pages, cached shell when offline
    e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("/index.html", cp)); return r; }).catch(() => caches.match("/index.html")));
    return;
  }
  if (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/brand/") || u.pathname.startsWith("/vendor/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })));
  }
});
