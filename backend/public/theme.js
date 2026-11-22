/* Aplica paleta e tema antes de pintar (evita piscar). Arquivo próprio: a política de segurança não permite script embutido. */
try {
  var p = localStorage.getItem("palette") || "verde", m = localStorage.getItem("mode") || "auto";
  var dark = m === "dark" || (m === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.palette = p; document.documentElement.dataset.mode = dark ? "dark" : "light";
} catch (e) {}

/* PWA: instala o app no celular (Adicionar à tela inicial). */
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
