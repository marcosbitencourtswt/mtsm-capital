/** Gerado ao separar a tela em módulos: pages/futuro. */
import { api, type Recurrence, type Kind } from "../api.js";
import { st, centsOf, $ } from "../core.js";
import { moneyInput, monthLabel, money, addMonths, today, esc } from "../fmt.js";
import { jurosCard } from "./lancar.js";

/* ===================== Futuro: projeção + simulador ===================== */
export async function futuro() {
  const [p, recs] = await Promise.all([
    api<{ startingCashCents: number; months: { month: string; inCents: number; outCents: number; netCents: number; accumulatedCents: number; estimatedItems: number }[] }>(`/projection?months=${st.projMonths}`),
    api<Recurrence[]>("/recurrences").catch(() => [] as Recurrence[])]);
  // Sugestão a partir das contas automáticas ativas (nada de valor fixo no código).
  const sum = (k: Kind) => recs.filter(r => r.active && r.kind === k && r.defaultAmountCents).reduce((a, r) => a + (r.defaultAmountCents ?? 0), 0);
  const simInc = sum("RECEIVABLE") ? moneyInput(sum("RECEIVABLE")) : "", simFix = sum("PAYABLE") ? moneyInput(sum("PAYABLE")) : "";
  const opt = (n: number) => `<button class="${st.projMonths === n ? "" : "ghost"} sm" data-proj="${n}">${n >= 12 ? `${n / 12} ano${n > 12 ? "s" : ""}` : `${n} meses`}</button>`;
  return `<h2>Futuro</h2>
  <div class="row" style="margin-bottom:12px">${[6, 12, 24, 36, 60].map(opt).join("")}</div>
  <div class="card scroll"><table>
    <tr><th>Mês</th><th>Entradas</th><th>Saídas</th><th>Saldo do mês</th><th>Acumulado</th></tr>
    ${p.months.map(m => `<tr><td>${monthLabel(m.month)}${m.estimatedItems ? " *" : ""}</td><td class="pos">${money(m.inCents)}</td><td class="neg">${money(m.outCents)}</td>
      <td class="${m.netCents < 0 ? "neg" : "pos"}">${money(m.netCents)}</td><td class="${m.accumulatedCents < 0 ? "neg" : "pos"}">${money(m.accumulatedCents)}</td></tr>`).join("")}
  </table></div>
  <p class="muted">ESTIMATIVA. Parte do caixa atual (${money(p.startingCashCents)}), soma as contas lançadas e as automáticas pelo último valor conhecido (*). Contas vencidas e sem data entram no mês atual.</p>
  <div class="card"><h3>Em quanto tempo saio das dívidas?</h3>
    <form class="form" id="sim">
      <div><label>Renda mensal líquida (R$)</label><input name="inc" inputmode="decimal" placeholder="quanto entra por mês" value="${simInc}" required></div>
      <div><label>Gastos fixos/mês (R$)</label><input name="fix" inputmode="decimal" placeholder="contas fixas do mês" value="${simFix}" required></div>
      <div><label>Extra/mês (R$)</label><input name="ext" inputmode="decimal" value="0"></div>
      <div><label>Caixa hoje (R$)</label><input name="cash" inputmode="decimal" value="0"></div>
      <div><label class="inline"><input type="checkbox" name="roll" checked> Juros por ciclo se atrasar</label>
           <label class="inline"><input type="checkbox" name="cards" checked> Incluir cartões</label></div>
      <div><button>Simular</button></div>
    </form><div id="sim-out">${st.simCache}</div></div>
  ${jurosCard()}`;
}
export interface SimRes { assumptions: string[]; monthlySurplusCents: number; totalDebtCents: number; results: { strategy: string; feasible: boolean; months: number | null; extraInterestCents: number; payoffOrder: string[] }[]; }
export async function runSim(form: HTMLFormElement) {
  const f = new FormData(form);
  const r = await api<SimRes>("/simulate", { method: "POST", body: {
    monthlyIncomeCents: centsOf(f, "inc"), monthlyFixedCents: centsOf(f, "fix"), extraCents: centsOf(f, "ext", false) ?? 0,
    initialCashCents: centsOf(f, "cash", false) ?? 0, rolloverMonthly: f.has("roll"), includeCards: f.has("cards") } });
  const name: Record<string, string> = { AVALANCHE: "Avalanche (juros primeiro)", SNOWBALL: "Bola de neve (menor saldo)" };
  st.simCache = `<p class="muted">Dívidas: ${money(r.totalDebtCents)} · sobra mensal: <b class="${r.monthlySurplusCents <= 0 ? "neg" : ""}">${money(r.monthlySurplusCents)}</b></p>
    <div class="scroll"><table><tr><th>Estratégia</th><th>Prazo</th><th>Quitação</th><th>Juros extras</th></tr>
    ${r.results.map(x => `<tr><td>${name[x.strategy]}</td>${x.feasible
      ? `<td>${x.months} mês(es)</td><td>${monthLabel(addMonths(today().slice(0, 7), x.months ?? 0))}</td><td>${money(x.extraInterestCents)}</td>`
      : `<td colspan="3" class="neg">Não quita em 10 anos</td>`}</tr>`).join("")}</table></div>
    <p class="muted">Premissas: ${r.assumptions.map(esc).join("; ")}.</p>`;
  $("#sim-out").innerHTML = st.simCache;
}
