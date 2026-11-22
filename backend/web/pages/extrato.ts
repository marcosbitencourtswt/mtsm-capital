/** Gerado ao separar a tela em módulos: pages/extrato. */
import { api } from "../api.js";
import { st } from "../core.js";
import { money, today, monthLabel } from "../fmt.js";

/* ===================== Extrato ===================== */
export interface Month { month: string; incomeCents: number; expenseCents: number; interestPaidCents: number; amortizationCents: number; loansInCents: number; resultCents: number; cashBalanceCents: number; }
export async function extrato() {
  const stData = await api<{ months: Month[] }>(`/statement?from=${st.extFrom}&to=${st.extTo}`);
  const tot = (k: keyof Month) => stData.months.reduce((s, m) => s + (m[k] as number), 0);
  const cell = (v: number, sign = false) => `<td class="${sign ? (v < 0 ? "neg" : "pos") : ""}">${money(v)}</td>`;
  const y = Number(today().slice(0, 4));
  const isYear = (yy: number) => st.extFrom === `${yy}-01` && st.extTo === `${yy}-12`;
  const n = stData.months.length || 1;
  return `<h2>Extrato realizado</h2>
  <div class="row" style="margin-bottom:12px">${[y, y - 1, y - 2].map(yy => `<button class="${isYear(yy) ? "" : "ghost"} sm" data-extyear="${yy}">Ano ${yy}</button>`).join("")}
    <button class="ghost sm" data-extyear="last6">Últimos 6 meses</button></div>
  <form class="card form" id="ext">
    <div><label>De</label><input type="month" name="from" value="${st.extFrom}"></div>
    <div><label>Até</label><input type="month" name="to" value="${st.extTo}"></div>
    <div><button>Ver</button></div>
  </form>
  <div class="card scroll"><table>
    <tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Juros pagos</th><th>Amortização</th><th>Empréstimos</th><th>Resultado</th><th>Caixa</th></tr>
    ${stData.months.map(m => `<tr><td>${monthLabel(m.month)}</td>${cell(m.incomeCents)}${cell(m.expenseCents)}${cell(m.interestPaidCents)}${cell(m.amortizationCents)}${cell(m.loansInCents)}${cell(m.resultCents, true)}${cell(m.cashBalanceCents, true)}</tr>`).join("")}
    ${stData.months.length > 1 ? `<tr><td class="muted">Média/mês</td><td class="muted">${money(Math.round(tot("incomeCents") / n))}</td><td class="muted">${money(Math.round(tot("expenseCents") / n))}</td><td class="muted">${money(Math.round(tot("interestPaidCents") / n))}</td><td></td><td></td><td class="muted">${money(Math.round(tot("resultCents") / n))}</td><td></td></tr>` : ""}
    <tr><th>Total</th><th>${money(tot("incomeCents"))}</th><th>${money(tot("expenseCents"))}</th><th>${money(tot("interestPaidCents"))}</th><th>${money(tot("amortizationCents"))}</th><th>${money(tot("loansInCents"))}</th><th>${money(tot("resultCents"))}</th><th></th></tr>
  </table></div>
  <p class="muted">Despesa = contas pagas + juros. Devolver o valor emprestado é amortização (sai do caixa, não é despesa). Empréstimo recebido entra no caixa, mas não é receita.</p>`;
}
