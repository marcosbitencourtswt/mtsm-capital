/** Gerado ao separar a tela em módulos: pages/indicadores. */
import { api, getEntity } from "../api.js";
import { st, catLabel } from "../core.js";
import { money, monthLabel, br, today, esc } from "../fmt.js";
import { chartSlot, lineChart, hBars, vBars } from "../charts.js";

/* ===================== Indicadores (dashboard + relatório) ===================== */
export interface Report { month: string;
  kpis: { incomeCents: number; expenseCents: number; resultCents: number; savingsRatePct: number | null; debtOwedCents: number; debtPaidCents: number; debtProgressPct: number;
    debtDueThisMonthCents: number; debtLoadPct: number | null; interestPaidCents: number; savedByEarlyPayCents: number };
  trend: { month: string; incomeCents: number; expenseCents: number; resultCents: number; amortizationCents: number }[];
  byCategory: { category: string; cents: number; count: number }[]; byPerson: { name: string; cents: number; count: number }[];
  topExpenses: { what: string; category: string; cents: number; day: string; who: string | null }[]; }
export const pctTxt = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
export async function indicadoresPage() {
  const r = await api<Report>(`/report?month=${st.repMonth}`), k = r.kpis;
  const tile = (label: string, value: string, sub = "", cls = "") => `<div class="card kpi"><div class="l">${label}</div><div class="v ${cls}">${value}</div>${sub ? `<div class="muted">${sub}</div>` : ""}</div>`;
  // Leitura em uma frase: o que o mês diz, sem precisar interpretar gráfico.
  const verdict = k.incomeCents === 0 && k.expenseCents === 0 ? "Sem lançamentos neste mês ainda."
    : k.resultCents >= 0 ? `Sobrou ${money(k.resultCents)} (${pctTxt(k.savingsRatePct)} da receita).` : `Faltou ${money(-k.resultCents)}: as despesas passaram a receita.`;
  const load = k.debtLoadPct == null ? "" : k.debtLoadPct >= 50 ? "neg" : k.debtLoadPct >= 30 ? "warn-txt" : "pos";
  const months = r.trend.map(t => t.month);
  return `<div class="row spread rep-head"><h2>Indicadores</h2>
      <form class="rep-f" id="rep-f"><input type="month" name="m" value="${r.month}" aria-label="Mês"><button class="ghost sm">Ver</button>
      <button type="button" class="sm" data-print>Gerar relatório (PDF)</button></form></div>
    <p class="print-only muted">MTSM Capital · ${getEntity() === "personal" ? "Pessoal" : "Byte4Tech (PJ)"} · ${monthLabel(r.month)} · gerado em ${br(today())}</p>
    <div class="alert ${k.resultCents < 0 ? "danger" : ""}"><b>${monthLabel(r.month)}:</b> ${verdict}</div>
    <div class="grid kpis-6" role="list">
      ${tile("Receitas", money(k.incomeCents))}
      ${tile("Despesas", money(k.expenseCents), k.interestPaidCents ? `inclui ${money(k.interestPaidCents)} de juros` : "")}
      ${tile("Resultado", money(k.resultCents), "", k.resultCents < 0 ? "neg" : "pos")}
      ${tile("Taxa de poupança", pctTxt(k.savingsRatePct), "do que entrou, quanto sobrou")}
      ${tile("Renda comprometida", pctTxt(k.debtLoadPct), `${money(k.debtDueThisMonthCents)} em parcelas e faturas do mês`, load)}
      ${tile("Dívidas em aberto", money(k.debtOwedCents), `${pctTxt(k.debtProgressPct)} dos empréstimos já quitado${k.savedByEarlyPayCents ? ` · economia ${money(k.savedByEarlyPayCents)}` : ""}`)}
    </div>
    <div class="card">${chartSlot(w => lineChart(months, [{ name: "Receitas", cls: "s1", values: r.trend.map(t => t.incomeCents) }, { name: "Despesas", cls: "s2", values: r.trend.map(t => t.expenseCents) }], "Receitas × despesas · 12 meses", w))}
      <details><summary>Ver em tabela</summary><div class="scroll"><table><tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Resultado</th><th>Dívida quitada</th></tr>
        ${r.trend.map(t => `<tr><td>${monthLabel(t.month)}</td><td>${money(t.incomeCents)}</td><td>${money(t.expenseCents)}</td><td class="${t.resultCents < 0 ? "neg" : "pos"}">${money(t.resultCents)}</td><td>${money(t.amortizationCents)}</td></tr>`).join("")}
      </table></div></details></div>
    <div class="grid two">
      <div class="card">${chartSlot(w => hBars(r.byCategory.map(c => ({ label: catLabel(c.category), cents: c.cents, tip: `${catLabel(c.category)}: ${money(c.cents)} em ${c.count} lançamento(s)` })), `Para onde foi o dinheiro · ${monthLabel(r.month)}`, 8, w))}</div>
      <div class="card">${chartSlot(w => vBars(months, r.trend.map(t => t.amortizationCents), "Dívida quitada por mês", w))}
        <p class="muted">Quanto do principal das dívidas foi pago (sem contar juros).</p></div>
    </div>
    <div class="grid two">
      <div class="card"><h3>Gasto por pessoa</h3>${r.byPerson.length ? `<table><tr><th>Pessoa</th><th>Gasto</th><th>Lançamentos</th></tr>
        ${r.byPerson.map(p => `<tr><td>${esc(p.name)}</td><td>${money(p.cents)}</td><td>${p.count}</td></tr>`).join("")}</table>` : `<p class="muted">Sem gastos no mês.</p>`}</div>
      <div class="card"><h3>Maiores gastos</h3>${r.topExpenses.length ? `<div class="scroll"><table><tr><th>O quê</th><th>Valor</th><th>Dia</th></tr>
        ${r.topExpenses.map(x => `<tr><td>${esc(x.what)} <span class="muted">· ${esc(catLabel(x.category))}${x.who ? ` · ${esc(x.who)}` : ""}</span></td><td>${money(x.cents)}</td><td>${br(x.day).slice(0, 5)}</td></tr>`).join("")}</table></div>` : `<p class="muted">Sem gastos no mês.</p>`}</div>
    </div>
    <p class="muted">Regime de caixa: conta o que foi pago/recebido no mês. Compra no cartão conta na data da compra. Pagar parcela de empréstimo é quitação (não é despesa); só os juros são despesa.</p>`;
}
