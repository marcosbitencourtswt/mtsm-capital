/** Gerado ao separar a tela em módulos: pages/push. */
import { st, toast } from "../core.js";
import { root } from "../api.js";

/* ===================== Sessão: login, senha, sair ===================== */
/* ===================== Avisos no celular (Web Push) ===================== */
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export function b64ToBytes(b64: string) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, ch => ch.charCodeAt(0));
}
export async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
/** Card "Avisos no celular": liga/desliga neste aparelho e testa. */
export async function pushCard() {
  if (!pushSupported()) {
    return `<div class="card"><h3>Avisos no celular</h3><p class="muted">${isIOS() && !standalone()
      ? "No iPhone, os avisos só funcionam com o app instalado: Safari → Compartilhar → Adicionar à Tela de Início. Depois abra pelo ícone e volte aqui."
      : "Este navegador não aceita avisos. Use o Chrome (Android/computador) ou o app instalado no iPhone."}</p></div>`;
  }
  const sub = await currentSub();
  const denied = Notification.permission === "denied";
  return `<div class="card"><h3>Avisos no celular</h3>
    <p class="muted">${st.me?.conductOnly ? "Receba aqui quando uma tarefa sua for aprovada." : "Aprovações das crianças, contas que vencem hoje e amanhã e o lembrete do fechamento do mês."} Grátis, direto no aparelho.</p>
    ${denied ? `<p class="neg">Os avisos estão bloqueados neste aparelho. Libere nas configurações do navegador/celular para este site e tente de novo.</p>` : ""}
    <div class="row">${sub ? `<span class="chip SETTLED">ligados neste aparelho</span><button class="ghost sm" data-pushtest>Enviar teste</button><button class="ghost sm" data-pushoff>Desligar</button>`
      : `<button class="sm" data-pushon ${denied ? "disabled" : ""}>Ligar avisos neste aparelho</button>`}</div></div>`;
}
export async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Sem permissão, não dá para avisar. Libere nas configurações do aparelho.", true); return; }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await root<{ publicKey: string }>("/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await root("/push/subscribe", { method: "POST", body: sub.toJSON() });
  await root("/push/test", { method: "POST" });
  toast("Avisos ligados. Mandei um teste.");
}
export async function pushOff() {
  const sub = await currentSub();
  if (sub) { await root("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  toast("Avisos desligados neste aparelho.");
}
