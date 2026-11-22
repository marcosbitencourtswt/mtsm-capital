/** Gerado ao separar a tela em módulos: pages/pedidos. */
import { esc, money, br, moneyInput } from "../fmt.js";
import { getEntity, api } from "../api.js";
import { isGuardian, st, mine, catLabel, catOptions, personOptions } from "../core.js";
import { receiptCard } from "./cupons.js";

/* ===================== Pedidos de compra ===================== */
export interface PReq { id: string; description: string; amountCents: number; category: string; status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED"; reviewNote: string | null;
  createdAt: string; reviewedAt: string | null; requestedBy: string; requestedByName: string; forPersonId: string | null; forPersonName: string | null;
  accountId: string | null; accountLabel: string | null; paidAccountId: string | null; paidAccountLabel: string | null; reviewedByName: string | null; }
export interface PSource { id: string; type: string; label: string; ownerName: string | null; }
export const REQ_ST: Record<PReq["status"], string> = { PENDING: `<span class="chip NO_VALUE">aguardando</span>`, APPROVED: `<span class="chip SETTLED">aprovado</span>`,
  REJECTED: `<span class="chip OVERDUE">não aprovado</span>`, CANCELED: `<span class="chip">cancelado</span>` };
export const srcLabel = (s: PSource) => `${s.type === "CARD" ? "Cartão " : ""}${esc(s.label)}${s.ownerName ? ` (${esc(s.ownerName)})` : ""}`;
export async function pedidosPage() {
  if (getEntity() !== "personal") return `<div class="empty">Pedidos de compra são da família (entidade Pessoal).</div>`;
  const [list, src] = await Promise.all([api<PReq[]>("/requests"), api<PSource[]>("/requests/sources")]);
  const judge = isGuardian() && !st.me?.conductOnly;
  const toDecide = judge ? list.filter(r => r.status === "PENDING" && r.requestedBy !== st.me?.id) : [];
  const mine = list.filter(r => r.requestedBy === st.me?.id || !judge);
  const others = judge ? list.filter(r => r.requestedBy !== st.me?.id && r.status !== "PENDING").slice(0, 20) : [];
  const opts = (sel: string | null) => `<option value="">Escolha de onde sai</option>${src.map(s => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${srcLabel(s)}</option>`).join("")}`;
  const row = (r: PReq) => `<li><div class="row spread"><span><b>${esc(r.description)}</b> · ${money(r.amountCents)}</span>${REQ_ST[r.status]}</div>
    <div class="muted">${esc(r.requestedByName)}${r.forPersonName && r.forPersonName !== r.requestedByName ? ` para ${esc(r.forPersonName)}` : ""} · ${br(r.createdAt.slice(0, 10))}
      ${r.accountLabel ? ` · pediu pelo ${esc(r.accountLabel)}` : ""}${r.paidAccountLabel && r.status === "APPROVED" ? ` · saiu do ${esc(r.paidAccountLabel)}` : ""}</div>
    ${r.reviewNote ? `<div>${r.status === "REJECTED" ? "Motivo" : "Recado"}: <b>${esc(r.reviewNote)}</b>${r.reviewedByName ? ` <span class="muted">— ${esc(r.reviewedByName)}</span>` : ""}</div>` : ""}
    ${r.requestedBy === st.me?.id && r.status === "PENDING" ? `<div class="row"><button class="ghost sm" data-reqcancel="${r.id}">Cancelar pedido</button></div>` : ""}
    ${r.requestedBy === st.me?.id && r.status === "REJECTED" ? `<div class="row"><button class="ghost sm" data-reqagain="${r.id}">Pedir de novo</button></div>` : ""}</li>`;
  const decide = (r: PReq) => `<li><div><b>${esc(r.requestedByName)}</b>${r.forPersonName && r.forPersonName !== r.requestedByName ? ` (para ${esc(r.forPersonName)})` : ""} pede:
      <b>${esc(r.description)}</b> · <b>${money(r.amountCents)}</b> <span class="muted">· ${esc(catLabel(r.category))} · ${br(r.createdAt.slice(0, 10))}</span></div>
    <div class="st-grid"><select id="racc-${r.id}" aria-label="De onde sai">${opts(r.accountId)}</select><input id="rnote-${r.id}" placeholder="Recado (obrigatório se recusar)" maxlength="200"></div>
    <div class="row"><button class="sm" data-reqok="${r.id}">Aprovar e lançar</button><button class="ghost sm" data-reqno="${r.id}">Recusar</button></div></li>`;
  const p = st.reqPrefill; st.reqPrefill = {};
  return `<h2>Pedidos de compra</h2>
  ${toDecide.length ? `<div class="card pending-card"><h3>Aguardando sua decisão (${toDecide.length})</h3><ul class="imp">${toDecide.map(decide).join("")}</ul>
    <p class="muted">Aprovar lança o gasto na conta escolhida, em nome de quem vai usar. Sem saldo onde pediram? Troque a conta ou recuse com um recado.</p></div>` : ""}
  <div class="card"><h3>Pedir autorização</h3>
    <form class="form" id="req-f">
      <div class="full"><label>O que vai comprar</label><input name="d" required maxlength="120" placeholder="ex.: tênis da escola" value="${esc(p.d ?? "")}"></div>
      <div><label>Quanto (R$)</label><input name="v" inputmode="decimal" required placeholder="0,00" value="${p.v ? moneyInput(p.v) : ""}"></div>
      <div><label>Categoria</label><select name="c">${catOptions(p.c ?? "OUTROS")}</select></div>
      <div class="full"><label>De onde você sugere sair</label><select name="a">${opts(null)}</select></div>
      ${st.me?.conductOnly ? "" : `<div><label>Para quem</label><select name="person">${personOptions(st.me?.personId ?? null)}</select></div>`}
      <div class="full"><button>Pedir autorização</button></div>
    </form></div>
  ${st.me?.conductOnly ? await receiptCard() : ""}
  <div class="card"><h3>${judge ? "Meus pedidos" : "Seus pedidos"}</h3>${mine.length ? `<ul class="imp">${mine.map(row).join("")}</ul>` : `<p class="muted">Nenhum pedido ainda.</p>`}</div>
  ${others.length ? `<div class="card"><h3>Decididos recentemente</h3><ul class="imp">${others.map(row).join("")}</ul></div>` : ""}`;
}
