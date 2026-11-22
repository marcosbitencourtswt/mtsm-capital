/** Gerado ao separar a tela em módulos: pages/orcamento. */
import { CATEGORIES, catLabel } from "../core.js";
import { esc, money, moneyInput } from "../fmt.js";

/* ===================== Orçamento ===================== */
export interface Budget { month: string; monthElapsedPct: number; items: { category: string; limitCents: number; spentCents: number; leftCents: number; pct: number }[]; }
export const SPEND_CATS = CATEGORIES.filter(c => !["RENDA", "VENDAS", "SERVICOS", "DIVIDA", "CARTAO", "IMPOSTOS", "PRO_LABORE", "LUCROS"].includes(c));
export function budgetCard(b: Budget | null) {
  if (!b || !b.items.length) return "";
  return `<div class="card"><div class="row spread"><h3 style="margin:0">Orçamento do mês</h3><span class="muted">${b.monthElapsedPct}% do mês passou</span></div>
    <ul class="imp">${b.items.map(i => `<li><div class="row spread"><b>${esc(catLabel(i.category))}</b><span class="${i.pct >= 100 ? "neg" : ""}">${money(i.spentCents)} de ${money(i.limitCents)}</span></div>
      <div class="bar budget ${i.pct >= 100 ? "over" : i.pct >= 80 ? "warn" : ""}" role="progressbar" aria-valuenow="${i.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(catLabel(i.category))}"><i style="width:${Math.min(100, i.pct)}%"></i></div>
      <div class="muted">${i.leftCents >= 0 ? `sobram ${money(i.leftCents)}` : `<span class="neg">passou ${money(-i.leftCents)}</span>`}${i.pct > b.monthElapsedPct + 10 && i.pct < 100 ? " · ritmo acima do mês" : ""}</div></li>`).join("")}</ul></div>`;
}
export function budgetForm(b: Budget) {
  const lim = new Map(b.items.map(i => [i.category, i.limitCents]));
  return `<div class="card"><h3>Orçamento por categoria</h3>
    <p class="muted">Defina um teto mensal só nas categorias que quer vigiar (deixe vazio nas outras). O Painel mostra a barra e vocês dois recebem aviso ao passar de 80% e de 100%.</p>
    <form class="form" id="budget-f">${SPEND_CATS.map(c => `<div><label>${esc(catLabel(c))}</label><input name="b_${c}" inputmode="decimal" placeholder="sem teto" value="${lim.has(c) ? moneyInput(lim.get(c)!) : ""}"></div>`).join("")}
      <div class="full"><button>Salvar orçamento</button></div></form></div>`;
}
