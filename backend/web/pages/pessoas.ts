/** Gerado ao separar a tela em módulos: pages/pessoas. */
import { api, type Person } from "../api.js";
import { st, isAdmin, catLabel, openDialog, str, toast } from "../core.js";
import { esc, money } from "../fmt.js";

/* ===================== Pessoas da casa ===================== */
export interface PeopleSummary { totalPaidCents: number; people: { personId: string | null; name: string; active: boolean; paidCents: number; openCents: number; openCount: number; byCategory: { category: string; cents: number }[] }[]; }
export async function pessoas() {
  const s = await api<PeopleSummary>(`/people/summary?from=${st.peopleMonth}&to=${st.peopleMonth}`);
  const share = (v: number) => (s.totalPaidCents ? Math.round((v / s.totalPaidCents) * 100) : 0);
  return `<div class="row spread"><h2>Pessoas da casa</h2>${isAdmin() ? "<button data-newperson>+ Nova pessoa</button>" : ""}</div>
  <p class="muted">Vincule contas a uma pessoa (no cadastro da conta, no "Já gastei" ou na conta automática) para ver quanto cada uma custa.</p>
  <form class="card form" id="pmonth"><div><label>Mês</label><input type="month" name="m" value="${st.peopleMonth}"></div><div><button>Ver</button></div></form>
  <div class="list">${s.people.filter(p => p.active || p.paidCents || p.openCents).map(p => {
    const rel = st.people.find(x => x.id === p.personId)?.relation;
    return `<div class="item">
    <div class="head"><span class="who">${esc(p.name)}${rel ? ` <span class="muted">· ${esc(rel)}</span>` : ""}${p.active ? "" : ` <span class="chip OVERDUE">inativa</span>`}</span>
      <span class="amt">${money(p.paidCents)}</span></div>
    <div class="meta"><span class="muted">pago no mês · ${share(p.paidCents)}% do total</span>
      ${p.openCents ? `<span class="chip OPEN">em aberto ${money(p.openCents)} (${p.openCount})</span>` : ""}</div>
    ${p.byCategory.length ? `<div class="muted" style="margin-top:6px">${p.byCategory.slice(0, 5).map(c => `${esc(catLabel(c.category))} ${money(c.cents)}`).join(" · ")}</div>` : ""}
    <div class="actions"><button class="ghost sm" data-seeperson="${p.personId ?? "none"}">Ver contas</button>
      ${p.personId && isAdmin() ? `<button class="ghost sm" data-editperson="${p.personId}">Editar</button>
      <button class="ghost sm" data-toggleperson="${p.personId}" data-active="${p.active}">${p.active ? "Desativar" : "Reativar"}</button>` : ""}</div>
  </div>`; }).join("")}</div>
  <p class="muted">Total pago no mês: <b>${money(s.totalPaidCents)}</b>. "Pago" é o que saiu do caixa no mês (regime de caixa), em contas a pagar.</p>`;
}
export function personForm(p?: Person) {
  return `<div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(p?.name)}"></div>
    <div class="full"><label>Relação (opcional)</label><input name="rel" maxlength="40" placeholder="ex.: esposa, filho, mãe" value="${esc(p?.relation)}"></div>`;
}
export function newPerson() {
  openDialog("Nova pessoa", personForm(), "Salvar", async f => {
    await api("/people", { method: "POST", body: { name: str(f, "name"), relation: str(f, "rel") || null } });
    toast("Pessoa cadastrada.");
  });
}
export function editPerson(id: string) {
  const p = st.people.find(x => x.id === id); if (!p) return;
  openDialog("Editar pessoa", personForm(p), "Salvar", async f => {
    await api(`/people/${id}`, { method: "PATCH", body: { name: str(f, "name"), relation: str(f, "rel") || null } });
    toast("Alterado.");
  });
}
