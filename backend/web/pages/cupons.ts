/** Gerado ao separar a tela em módulos: pages/cupons. */
import { getEntity, api, ApiError, root } from "../api.js";
import { type PSource, srcLabel } from "./pedidos.js";
import { br, esc } from "../fmt.js";
import { st, isGuardian, toast, str } from "../core.js";

/* ===================== Caixa de cupons ===================== */
export interface Receipt { id: string; status: "PENDING" | "READ" | "DISCARDED"; note: string | null; createdAt: string; uploadedByName: string; personName: string | null; accountLabel: string | null; uploadedBy: string; }
/** Reduz a foto no próprio aparelho (lado maior 1600 px, JPEG): cabe no banco grátis e continua legível. */
export async function shrinkPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d")!.drawImage(bmp, 0, 0, cv.width, cv.height);
  const blob: Blob = await new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error("foto"))), "image/jpeg", 0.8));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const RC_ST: Record<Receipt["status"], string> = { PENDING: `<span class="chip NO_VALUE">aguardando leitura</span>`, READ: `<span class="chip SETTLED">lido</span>`, DISCARDED: `<span class="chip">descartado</span>` };
export async function receiptCard() {
  if (getEntity() !== "personal") return "";
  const [list, src] = await Promise.all([api<Receipt[]>("/receipts").catch(() => [] as Receipt[]), api<PSource[]>("/requests/sources").catch(() => [] as PSource[])]);
  const pending = list.filter(r => r.status === "PENDING");
  const shown = list.slice(0, 6);
  return `<div class="card"><div class="row spread"><h3 style="margin:0">Cupons</h3>${pending.length ? `<span class="chip NO_VALUE">${pending.length} aguardando</span>` : ""}</div>
    <p class="muted">Tire a foto do cupom e diga como pagou. O responsável pede para ler tudo de uma vez e os gastos são lançados depois de conferidos.</p>
    <form class="form" id="rc-f">
      <div class="full"><label>Como pagou</label><select name="a"><option value="">Não sei / dinheiro</option>${src.map(s => `<option value="${s.id}">${srcLabel(s)}</option>`).join("")}</select></div>
      <div class="full"><label>Observação (opcional)</label><input name="n" maxlength="200" placeholder="ex.: lanche da escola"></div>
      <div class="full"><label class="btnlike rc-btn"><input type="file" accept="image/*" capture="environment" data-rcfile style="position:absolute;width:1px;height:1px;opacity:0">📷 Fotografar e enviar cupom</label></div>
    </form>
    ${shown.length ? `<ul class="imp">${shown.map(r => `<li><div class="row spread"><span>${br(r.createdAt.slice(0, 10))} · ${esc(r.personName ?? r.uploadedByName)}${r.accountLabel ? ` · ${esc(r.accountLabel)}` : ""}</span>${RC_ST[r.status]}</div>
      ${r.note ? `<div class="muted">${esc(r.note)}</div>` : ""}
      <div class="row"><a class="btnlike sm-like" href="/api/v1/personal/receipts/${r.id}/image" target="_blank" rel="noopener">Ver foto</a>
        ${r.status === "PENDING" && (r.uploadedBy === st.me?.id || isGuardian()) ? `<button class="ghost sm" data-rcdel="${r.id}">Descartar</button>` : ""}</div></li>`).join("")}</ul>` : ""}
  </div>`;
}
export async function sendReceipt(file: File) {
  const f = new FormData(document.getElementById("rc-f") as HTMLFormElement);
  toast("Enviando o cupom…");
  const image = await shrinkPhoto(file).catch(() => { throw new ApiError(422, "PHOTO", "Não consegui abrir essa foto. Tente tirar de novo."); });
  await api("/receipts", { method: "POST", body: { image, accountId: str(f, "a") || null, note: str(f, "n") || null } });
  toast("Cupom enviado. Pode jogar o papel fora.");
}

export interface WToken { id: string; label: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null; }
export async function tokenCard() {
  const toks = await root<WToken[]>("/admin/worker-tokens").catch(() => [] as WToken[]);
  const active = toks.filter(t => !t.revokedAt && new Date(t.expiresAt) > new Date());
  return `<div class="card"><h3>Chave do leitor de cupons</h3>
    <p class="muted">Chave limitada que o Claude usa, numa conversa sua, para ler os cupons enviados. Só enxerga a caixa de cupons (nada de saldos ou dívidas) e não lança nada sozinha. Vence em 90 dias.</p>
    ${active.length ? `<ul class="imp">${active.map(t => `<li><div class="row spread"><span>${esc(t.label)} · vence ${br(t.expiresAt.slice(0, 10))}${t.lastUsedAt ? ` · último uso ${br(t.lastUsedAt.slice(0, 10))}` : " · nunca usada"}</span>
      <button class="danger sm" data-tokrevoke="${t.id}">Revogar</button></div></li>`).join("")}</ul>` : `<p class="muted">Nenhuma chave ativa.</p>`}
    <div class="row"><button class="sm" data-toknew>Criar chave</button></div></div>`;
}
