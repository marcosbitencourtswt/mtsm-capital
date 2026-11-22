/** Gerado ao separar a tela em módulos: pages/pj. */
import { api } from "../api.js";
import { type Acc, isCashAcc } from "./bancos.js";
import { esc, money, br, today } from "../fmt.js";

/* ===================== PJ: impostos do mês e repasse para a PF ===================== */
export interface Tax { id: string; name: string; category: string; amountCents: number; paidCents: number; dueDate: string | null; status: "pago" | "em aberto" | "atrasado"; }
export async function pjCards() {
  const [taxes, targets, accs] = await Promise.all([api<Tax[]>("/taxes").catch(() => [] as Tax[]), api<{ id: string; label: string; ownerName: string | null }[]>("/bridge/targets").catch(() => []),
    api<Acc[]>("/accounts").catch(() => [] as Acc[])]);
  const pj = accs.filter(a => a.active && isCashAcc(a.type));
  const chip = (s: Tax["status"]) => `<span class="chip ${s === "pago" ? "SETTLED" : s === "atrasado" ? "OVERDUE" : "NO_VALUE"}">${s}</span>`;
  return `<div class="card"><h3>Impostos e pró-labore do mês</h3>
    ${taxes.length ? `<ul class="imp">${taxes.map(t => `<li><div class="row spread"><span><b>${esc(t.name)}</b> · ${money(t.amountCents)}${t.dueDate ? ` · vence ${br(t.dueDate)}` : ""}</span>${chip(t.status)}</div></li>`).join("")}</ul>`
      : `<p class="muted">Nenhum imposto lançado para este mês. Cadastre DAS e INSS como contas automáticas (categoria Impostos).</p>`}</div>
  <div class="card"><h3>Repasse para a conta pessoal</h3>
    <p class="muted">Um lançamento só: sai da conta da PJ e entra na sua conta pessoal. Se a conta automática do mês existir, ela é quitada (nada em dobro).</p>
    <form class="form" id="bridge-f">
      <div><label>Tipo</label><select name="k"><option value="PRO_LABORE">Pró-labore</option><option value="LUCROS">Distribuição de lucros</option></select></div>
      <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" required></div>
      <div><label>Sai da conta PJ</label><select name="from" required>${pj.map(a => `<option value="${a.id}">${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("")}</select></div>
      <div><label>Entra na conta pessoal</label><select name="to" required>${targets.map(t => `<option value="${t.id}">${esc(t.label)}${t.ownerName ? ` (${esc(t.ownerName)})` : ""}</option>`).join("")}</select></div>
      <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
      <div><button ${pj.length && targets.length ? "" : "disabled"}>Fazer repasse</button></div>
    </form>
    ${!pj.length || !targets.length ? `<p class="muted">Cadastre antes a conta da PJ (aqui na Byte4Tech) e a sua conta pessoal (no Pessoal).</p>` : ""}</div>`;
}
