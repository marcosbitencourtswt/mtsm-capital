/* Service worker do MTSM: guarda SÓ a casca do app (HTML, CSS, JS, ícones) para abrir rápido e instalar.
   Dados financeiros (/api) nunca são guardados no aparelho: sempre vêm da rede. */
const CACHE = "mtsm-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/theme.js", "/app.js", "/favicon.svg", "/manifest.json", "/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return; // rede pura
  // Rede primeiro (versão nova sempre que houver internet); cache só se estiver offline.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match("/index.html"))));
});
