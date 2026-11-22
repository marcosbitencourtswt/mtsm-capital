/* Service worker do MTSM: guarda SÓ a casca do app (HTML, CSS, JS, ícones) para abrir rápido e instalar.
   Dados financeiros (/api) nunca são guardados no aparelho: sempre vêm da rede. */
const CACHE = "mtsm-shell-v2";
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

/* Avisos no celular: mostra a notificação e, ao tocar, abre (ou foca) o app na tela certa. */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "MTSM Capital", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "MTSM Capital", {
    body: d.body || "", tag: d.tag, renotify: !!d.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && "focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
