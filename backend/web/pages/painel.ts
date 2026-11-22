/** Gerado ao separar a tela em módulos: pages/painel. */
import { type Title, getEntity, api } from "../api.js";
import { type Ranking, spendKpis } from "./ranking.js";
import { type Board, type Pending, pendingCard, todayCard } from "./combinados.js";
import { type Acc, type DebtSummary, isCashAcc, debtBoard } from "./bancos.js";
import { st, isGuardian, isRoot, catOptions, personSelect } from "../core.js";
import { type Budget, budgetCard } from "./orcamento.js";
import { type PReq } from "./pedidos.js";
import { esc, money, today, br, pct } from "../fmt.js";
import { pjCards } from "./pj.js";
import { receiptCard } from "./cupons.js";

/* ===================== Painel ===================== */
export interface Dashboard {
  payableOpenCents: number; receivableOpenCents: number; projectedBalanceCents: number; debtOpenCents: number; debtInterestCents: number;
  overdue: Title[]; missingValue: Title[]; nextDue: Title[];
  debtPriority: { id: string; counterparty: string; rateBp: number; openCents: number; dueDate: string | null }[];
  thisMonth: { incomeCents: number; expenseCents: number; resultCents: number; cashBalanceCents: number } | null;
}
export async function painel() {
  const personal = getEntity() === "personal";
  const [d, rk, cb, accs] = await Promise.all([api<Dashboard>("/dashboard"), personal ? api<Ranking>("/ranking") : Promise.resolve(null),
    personal ? api<Board>("/conduct/board").catch(() => null) : Promise.resolve(null), api<Acc[]>("/accounts").catch(() => [] as Acc[])]);
  const ds = personal ? await api<DebtSummary>("/debts/summary").catch(() => null) : null;
  st.pendingCache = personal && isGuardian() ? await api<Pending[]>("/conduct/pending").catch(() => []) : [];
  st.budgetCache = await api<Budget>("/budget").catch(() => null);
  const waitingReq = personal && isGuardian() ? (await api<PReq[]>("/requests").catch(() => [] as PReq[])).filter(r => r.status === "PENDING" && r.requestedBy !== st.me?.id) : [];
  const live = accs.filter(a => a.active);
  const accLabel = (a: Acc) => `${esc(a.institution ? `${a.institution} · ${a.name}` : a.name)}${a.ownerName ? ` (${esc(a.ownerName)})` : ""}`;
  const cashOpts = live.filter(a => isCashAcc(a.type)).map(a => `<option value="acc:${a.id}">${accLabel(a)}</option>`).join("");
  const cardOpts = live.filter(a => a.type === "CARD").map(a => `<option value="card:${a.id}">Cartão ${accLabel(a)}</option>`).join("");
  const paidWith = `<div><label>Pago com</label><select name="src"><option value="">Não sei / não informar</option>${cashOpts}${cardOpts}</select></div>`;
  const cameIn = `<div><label>Entrou em</label><select name="src"><option value="">Não informar</option>${cashOpts}</select></div>`;
  const trOpts = live.filter(a => isCashAcc(a.type)).map(a => `<option value="${a.id}">${accLabel(a)}</option>`).join("");
  const kpi = (l: string, v: number, cls = "", hero = false) => `<div class="card kpi${hero ? " hero" : ""}"><div class="l">${l}</div><div class="v ${cls}">${money(v)}</div></div>`;
  const m = d.thisMonth;
  return `
  <div class="grid kpis">
    ${kpi("Saldo previsto", d.projectedBalanceCents, d.projectedBalanceCents < 0 ? "neg" : "", true)}
    ${kpi("A pagar", d.payableOpenCents)}${kpi("A receber", d.receivableOpenCents)}${kpi("Empréstimos", d.debtOpenCents)}
  </div>
  ${waitingReq.length ? `<div class="alert"><b>${waitingReq.length} pedido(s) de compra aguardando você:</b> ${waitingReq.slice(0, 3).map(r => `${esc(r.requestedByName)} · ${esc(r.description)} ${money(r.amountCents)}`).join(" · ")}
    <button class="sm" data-goto="pedidos">Decidir</button></div>` : ""}
  ${!personal && isRoot() ? await pjCards() : ""}
  ${pendingCard(st.pendingCache)}
  ${ds ? debtBoard(ds) : ""}
  ${budgetCard(st.budgetCache)}
  ${personal ? await receiptCard() : ""}
  ${cb ? todayCard(cb) : ""}
  ${rk ? spendKpis(rk) : ""}
  ${d.overdue.length ? `<div class="alert danger"><b>${d.overdue.length} conta(s) vencida(s):</b> ${d.overdue.map(t => `${esc(t.counterparty)} ${money(t.openCents)}`).join(" · ")}</div>` : ""}
  ${d.missingValue.length ? `<div class="alert"><b>Sem valor:</b> ${d.missingValue.map(t => `<button class="ghost sm" data-edit="${t.id}">${esc(t.counterparty)}</button>`).join(" ")} <span class="muted">toque para informar</span></div>` : ""}
  <div class="card">
    <h3>Já gastei</h3>
    <form class="form" id="quick">
      <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" required></div>
      <div><label>O quê</label><input name="d" placeholder="ex.: mercado" required></div>
      <div><label>Categoria</label><select name="c">${catOptions("ALIMENTACAO")}</select></div>
      <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
      ${personSelect()}
      ${paidWith}
      <div><button>Registrar</button></div>
    </form>
  </div>
  <div class="card">
    <h3>Já recebi</h3>
    <form class="form" id="quick-in">
      <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" required></div>
      <div><label>De quê</label><input name="d" placeholder="ex.: escova, venda de cosmético" required></div>
      <div><label>Tipo</label><select name="c"><option value="SERVICOS">Serviço</option><option value="VENDAS">Venda</option><option value="RENDA">Renda</option><option value="OUTROS">Outros</option></select></div>
      <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
      ${personSelect(st.me?.personId)}
      ${cameIn}
      <div><button>Registrar</button></div>
    </form>
  </div>
  ${live.filter(a => isCashAcc(a.type)).length >= 2 ? `<div class="card">
    <h3>Transferi entre contas</h3>
    <form class="form" id="quick-tr">
      <div><label>De</label><select name="from" required>${trOpts}</select></div>
      <div><label>Para</label><select name="to" required>${trOpts}</select></div>
      <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" required></div>
      <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
      <div><button>Transferir</button></div>
    </form>
    <p class="muted">Sai de uma conta e entra na outra num lançamento só. Não é gasto nem receita.</p>
  </div>` : ""}
  ${m ? `<div class="card"><h3>Este mês (realizado)</h3><div class="grid" style="margin:0">
     <div class="kpi"><div class="l">Receitas</div><div class="v pos">${money(m.incomeCents)}</div></div>
     <div class="kpi"><div class="l">Despesas</div><div class="v">${money(m.expenseCents)}</div></div>
     <div class="kpi"><div class="l">Resultado</div><div class="v ${m.resultCents < 0 ? "neg" : "pos"}">${money(m.resultCents)}</div></div>
     <div class="kpi"><div class="l">Caixa</div><div class="v">${money(m.cashBalanceCents)}</div></div></div></div>` : ""}
  <div class="card"><h3>Próximos vencimentos</h3>${d.nextDue.length ? `<div class="scroll"><table>
    <tr><th>Conta</th><th>Vence</th><th>Valor</th></tr>
    ${d.nextDue.map(t => `<tr><td>${esc(t.counterparty)}</td><td>${br(t.dueDate)}</td><td class="${t.kind === "PAYABLE" ? "" : "pos"}">${money(t.openCents)}</td></tr>`).join("")}
  </table></div>` : `<p class="muted">Nada programado.</p>`}</div>
  ${d.debtPriority.length ? `<div class="card"><h3>Ordem para quitar dívidas <span class="muted">(juros primeiro)</span></h3><div class="scroll"><table>
    <tr><th>Credor</th><th>Juros</th><th>Saldo</th></tr>
    ${d.debtPriority.map((x, i) => `<tr><td>${i + 1}. ${esc(x.counterparty)}</td><td>${x.rateBp ? pct(x.rateBp) : "—"}</td><td>${money(x.openCents)}</td></tr>`).join("")}
  </table></div><p class="muted">Juros embutidos: ${money(d.debtInterestCents)}</p></div>` : ""}`;
}
