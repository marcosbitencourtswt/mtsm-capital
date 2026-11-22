/** Gerado ao separar a tela em módulos: pages/bancos. */
import { esc, money, br, moneyInput, today, daysLeft } from "../fmt.js";
import { rateOf as implicitRate } from "../juros.js";
import { st, isAdmin, dlgForm, str, openDialog, centsOf, toast } from "../core.js";
import { api, ApiError } from "../api.js";

/* ===================== Bancos e dívidas ===================== */
export type AccType = "CHECKING" | "SAVINGS" | "INVESTMENT" | "CARD" | "LOAN" | "CASH";
export interface Acc { id: string; type: AccType; name: string; institution: string | null; ownerPersonId: string | null; ownerName: string; active: boolean; notes: string | null;
  monthlyRateBp: number | null; rateSource: string | null; creditLimitCents: number | null; closingDay: number | null; dueDay: number | null;
  openingBalanceCents: number; openingDate: string; balanceCents: number | null; openCents: number; openCount: number; availableLimitCents: number | null;
  overdueCents: number; overdueCount: number; maxDaysOverdue: number; negativado: boolean;
  nextDueDate: string | null; nextDueCents: number | null; daysToNext: number | null; }
export interface Contact { id: string; name: string; kind: "EMPRESA" | "PESSOA"; email: string | null; phone: string | null; notes: string | null; products: number;
  openCents: number; openCount: number; nextDue: string | null; daysToNext: number | null; }
const dChip = (iso: string | null) => { const d = daysLeft(iso); return d ? `<span class="chip ${d.cls}">⏳ ${d.txt}</span>` : ""; };
export interface OwnerRow { personId: string | null; name: string; cashCents: number; savedCents: number; cardsOpenCents: number; cardsLimitFreeCents: number;
  debtCents: number; overdueCents: number; overdueCount: number; maxDaysOverdue: number; netWorthCents: number; }
export interface Payoff { totalCents: number; unknownRates: number; monthlyInterestCents: number;
  owners: { name: string; openCents: number; monthlyInterestCents: number; overdueCount: number; negativados: number; unknownRates: number; count: number }[];
  items: { titleId: string; name: string; ownerName: string; nature: string; openCents: number; dueDate: string | null; negativado: boolean; monthlyInterestCents: number | null;
  daysOverdue: number; monthlyRateBp: number | null; institution: string | null; reasons: string[] }[]; }
export const ACC_TYPE: Record<AccType, string> = { CHECKING: "Conta / carteira digital", SAVINGS: "Poupança / reserva", INVESTMENT: "Investimento", CARD: "Cartão de crédito", LOAN: "Empréstimo ou dívida (banco, loja ou pessoa)", CASH: "Dinheiro em espécie" };
export const BANKS = ["Nubank", "Inter", "Itaú", "Bradesco", "Banco do Brasil", "Caixa", "Santander", "C6 Bank", "Mercado Pago", "PicPay", "PagBank", "Cora", "Neon", "Will Bank",
  "Banco Pan", "Sicoob", "Sicredi", "BTG", "XP", "Renner (Realize)", "Riachuelo", "C&A", "Magalu", "Casas Bahia", "Americanas", "Carrefour", "Atacadão", "Assaí"];
export const isCashAcc = (t: AccType) => t === "CHECKING" || t === "SAVINGS" || t === "INVESTMENT" || t === "CASH";
export const rateTxt = (bp: number | null) => (bp == null ? "juros não informado" : `${(bp / 100).toLocaleString("pt-BR")}% ao mês`);
export const STRATEGY = { juros: ["Menos juros", "Atrasados e depois os juros mais altos. Economiza mais dinheiro."],
  rapidas: ["Vitórias rápidas", "Menores primeiro. Fecha dívidas rápido e dá fôlego."],
  nome: ["Limpar o nome", "Negativadas e as atrasadas há mais tempo primeiro."] } as const;

/* ===================== Painel de dívidas ===================== */
export interface DebtRow { personId: string | null; name: string; owedCents: number; debtOpenCents: number; cardsOpenCents: number; paidCents: number; paidThisMonthCents: number;
  progressPct: number; count: number; overdueCount: number; overdueCents: number; negativados: number; monthlyInterestCents: number; unknownRates: number; savedCents: number; }
export interface DebtSummary { owners: DebtRow[]; total: DebtRow; }
export function debtBoard(d: DebtSummary) {
  if (!d.total.count && !d.total.paidCents) return "";
  const box = (r: DebtRow, total = false) => `<${total ? "div" : "button type=\"button\""} class="card debt${total ? " total" : ""}" ${total ? "" : `data-bkowner="${r.personId ?? "none"}" data-goto="bancos" title="Ver dívidas de ${esc(r.name)}"`}>
    <span class="l">${total ? "Dívidas da família" : `Dívidas · ${esc(r.name)}`}</span>
    <span class="v ${r.owedCents ? "" : "pos"}">${money(r.owedCents)}</span>
    <div class="bar" role="progressbar" aria-valuenow="${r.progressPct}" aria-valuemin="0" aria-valuemax="100" aria-label="Quitado"><i style="width:${Math.min(100, r.progressPct)}%"></i></div>
    <span class="meta"><span><b>${r.progressPct.toLocaleString("pt-BR")}%</b> dos empréstimos quitado (${money(r.paidCents)})</span></span>
    <span class="meta">
      <span>Empréstimos <b>${money(r.debtOpenCents)}</b></span><span>Cartões <b>${money(r.cardsOpenCents)}</b></span>
      ${r.overdueCount ? `<span class="neg">${r.overdueCount} atrasada(s) · ${money(r.overdueCents)}</span>` : `<span>nada atrasado</span>`}
      ${r.negativados ? `<span class="neg">${r.negativados} negativada(s)</span>` : ""}
      <span>Juros ≈ <b>${money(r.monthlyInterestCents)}/mês</b>${r.unknownRates ? ` + ${r.unknownRates} sem taxa` : ""}</span>
      <span>Pago este mês <b>${money(r.paidThisMonthCents)}</b></span>
      ${r.savedCents ? `<span class="pos">Economia antecipando/negociando <b>${money(r.savedCents)}</b></span>` : ""}
    </span></${total ? "div" : "button"}>`;
  return `<div class="debts">${d.owners.map(r => box(r)).join("")}${box(d.total, true)}</div>`;
}

export async function bancosPage() {
  const q = `?strategy=${st.bkStrategy}${st.bkOwner ? `&person=${st.bkOwner}` : ""}`;
  const [accs, ov, po, ds, trs, cts] = await Promise.all([api<Acc[]>("/accounts"), api<{ people: OwnerRow[] }>("/overview"), api<Payoff>(`/payoff-order${q}`), api<DebtSummary>("/debts/summary"),
    api<Transfer[]>("/transfers?limit=20").catch(() => [] as Transfer[]), api<Contact[]>("/contacts").catch(() => [] as Contact[])]);
  st.trCache = trs;
  const owners = [{ id: "", name: "Todos" }, ...st.people.filter(p => p.active).map(p => ({ id: p.id, name: p.name })), { id: "none", name: "Dos dois / casa" }];
  const shown = accs.filter(a => a.active && (st.bkOwner === "" || (st.bkOwner === "none" ? !a.ownerPersonId : a.ownerPersonId === st.bkOwner)));
  const card = (o: OwnerRow) => `<div class="card">
    <div class="row spread"><h3 style="margin:0">${esc(o.name)}</h3>${o.overdueCount ? `<span class="chip OVERDUE">${o.overdueCount} atrasada(s) · até ${o.maxDaysOverdue} dias</span>` : `<span class="chip SETTLED">nada atrasado</span>`}</div>
    <div class="grid" style="margin:12px 0 0;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div class="kpi"><div class="l">Em conta</div><div class="v" style="font-size:18px">${money(o.cashCents)}</div></div>
      <div class="kpi"><div class="l">Guardado</div><div class="v" style="font-size:18px">${money(o.savedCents)}</div></div>
      <div class="kpi"><div class="l">Dívidas</div><div class="v neg" style="font-size:18px">${money(o.debtCents)}</div></div>
      <div class="kpi"><div class="l">Atrasado</div><div class="v ${o.overdueCents ? "neg" : ""}" style="font-size:18px">${money(o.overdueCents)}</div></div>
      <div class="kpi"><div class="l">Cartões abertos</div><div class="v" style="font-size:18px">${money(o.cardsOpenCents)}</div><div class="muted">limite livre ${money(o.cardsLimitFreeCents)}</div></div>
      <div class="kpi"><div class="l">Patrimônio</div><div class="v ${o.netWorthCents < 0 ? "neg" : "pos"}" style="font-size:18px">${money(o.netWorthCents)}</div></div>
    </div></div>`;
  const item = (a: Acc) => `<div class="item">
    <div class="head"><span class="who">${esc(a.institution ? `${a.institution} · ${a.name}` : a.name)}</span>
      <span class="amt">${isCashAcc(a.type) ? money(a.balanceCents ?? 0) : money(a.openCents)}</span></div>
    <div class="meta"><span class="chip">${ACC_TYPE[a.type]}</span><span class="chip person">👤 ${esc(a.ownerName)}</span>
      ${a.overdueCount ? `<span class="chip OVERDUE">${a.overdueCount} atrasada(s) · ${a.maxDaysOverdue} dias · ${money(a.overdueCents)}</span>` : ""}
      ${a.type === "CARD" || a.type === "LOAN" ? `<span class="chip ${a.monthlyRateBp == null ? "NO_VALUE" : ""}">${rateTxt(a.monthlyRateBp)}</span>` : ""}
      ${a.negativado ? `<span class="chip OVERDUE">nome negativado</span>` : ""}
      ${(a.type === "LOAN" || a.type === "CARD") && a.nextDueDate && !a.overdueCount ? dChip(a.nextDueDate) : ""}</div>
    <div class="muted" style="margin-top:4px">${a.type === "CARD" ? `Limite ${a.creditLimitCents != null ? money(a.creditLimitCents) : "não informado"}${a.availableLimitCents != null ? ` · livre ${money(a.availableLimitCents)}` : ""}${a.closingDay ? ` · fecha dia ${a.closingDay}` : ""}${a.dueDay ? ` · vence dia ${a.dueDay}` : ""} · em aberto ${money(a.openCents)}`
      : a.type === "LOAN" ? `${a.openCount} parcela(s) em aberto · ${money(a.openCents)}${a.nextDueDate ? ` · próxima ${money(a.nextDueCents ?? 0)} em ${br(a.nextDueDate)}` : ""}`
      : `Saldo informado ${money(a.openingBalanceCents)} em ${br(a.openingDate)}`}${a.notes ? ` · ${esc(a.notes)}` : ""}</div>
    <div class="actions"><button class="ghost sm" data-editacc="${a.id}">Editar</button>
      ${a.type === "CARD" ? `<button class="ghost sm" data-bill="${a.id}">Nova fatura</button>` : ""}
      ${isCashAcc(a.type) ? `<button class="ghost sm" data-transfer="${a.id}">Transferir</button>` : ""}
      ${isCashAcc(a.type) || a.type === "CARD" ? `<label class="btnlike sm-like"><input type="file" accept=".ofx,.OFX,application/x-ofx,text/plain" data-ofx="${a.id}" style="position:absolute;width:1px;height:1px;opacity:0">Importar extrato</label>` : ""}
      ${a.openCount ? `<button class="ghost sm" data-goto="pagar">Ver contas</button>` : ""}</div></div>`;
  return `<div class="row spread"><h2>Bancos e dívidas</h2><button data-newacc>+ Adicionar</button></div>
  <p class="muted">Cada banco pode ter só saldo, só dívida, conta e cartão… Cadastre produto por produto, com o dono. Informe o saldo de hoje; o sistema calcula o resto.</p>
  ${debtBoard(ds)}
  <div class="person-tabs">${owners.map(o => `<button class="${st.bkOwner === o.id ? "on" : ""}" data-bkowner="${o.id}">${esc(o.name)}</button>`).join("")}</div>
  ${ov.people.filter(o => st.bkOwner === "" || (st.bkOwner === "none" ? o.personId === null : o.personId === st.bkOwner)).map(card).join("")}
  <h3 style="margin-top:20px">Produtos</h3>
  <div class="list">${shown.map(item).join("") || `<div class="empty">Nada cadastrado ainda. Toque em "+ Adicionar".</div>`}</div>
  ${creditors(cts)}
  ${trs.length ? `<h3 style="margin-top:20px">Últimas transferências</h3>
  <div class="card scroll"><table><tr><th>Data</th><th>De</th><th>Para</th><th>Valor</th><th>Quem lançou</th><th></th></tr>
    ${trs.map(t => `<tr><td>${br(t.day)}</td><td>${esc(t.fromLabel)}</td><td>${esc(t.toLabel)}</td><td>${money(t.amountCents)}</td><td>${esc(t.createdByName ?? "—")}</td>
      <td>${isAdmin() || t.createdBy === st.me?.id ? `<button class="ghost sm" data-edittr="${t.id}">Editar</button> <button class="danger sm" data-deltr="${t.id}">Excluir</button>` : ""}</td></tr>`).join("")}</table></div>` : ""}
  <div class="card" style="margin-top:20px"><div class="row spread"><h3 style="margin:0">Por onde começar</h3><span class="muted">total ${money(po.totalCents)} · juros ≈ <b class="neg">${money(po.monthlyInterestCents)}/mês</b></span></div>
    <div class="scroll" style="margin-top:10px"><table><tr><th>De quem</th><th>Deve</th><th>Juros por mês</th><th>Atrasadas</th><th>Negativadas</th></tr>
      ${po.owners.map(o => `<tr><td>${esc(o.name)}</td><td>${money(o.openCents)}</td><td class="${o.monthlyInterestCents ? "neg" : ""}">${money(o.monthlyInterestCents)}${o.unknownRates ? ` <span class="muted">+ ${o.unknownRates} sem taxa</span>` : ""}</td>
        <td>${o.overdueCount}</td><td>${o.negativados}</td></tr>`).join("")}</table></div>
    <div class="person-tabs" style="margin-top:14px">${(Object.keys(STRATEGY) as (keyof typeof STRATEGY)[]).map(k => `<button class="${st.bkStrategy === k ? "on" : ""}" data-strategy="${k}">${STRATEGY[k][0]}</button>`).join("")}</div>
    <p class="muted">${STRATEGY[st.bkStrategy][1]} ${po.unknownRates ? `<b>${po.unknownRates} item(ns) sem juros informado</b>: complete a taxa (fatura, linha CET) ou espere a pesquisa.` : ""}</p>
    ${po.items.length ? `<ol class="payoff">${po.items.map(x => `<li><div class="row spread"><b>${esc(x.name)}</b><span class="${x.daysOverdue ? "neg" : ""}">${money(x.openCents)}</span></div>
      <span class="muted">${esc(x.ownerName)} · ${x.dueDate ? `vence ${br(x.dueDate)}` : "sem data"} · ${x.reasons.map(esc).join(" · ")}${x.monthlyInterestCents ? ` · custa ≈ ${money(x.monthlyInterestCents)}/mês` : ""}</span></li>`).join("")}</ol>` : `<p class="muted">Nenhuma dívida em aberto.</p>`}</div>`;
}

export function accForm(a?: Acc, known: string[] = []) {
  const own = (sel: string | null | undefined) => `<option value="">Dos dois / casa</option>${st.people.filter(p => p.active).map(p => `<option value="${p.id}" ${sel === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  const t = a?.type;
  return `<datalist id="banks">${[...new Set([...known, ...BANKS])].map(b => `<option value="${esc(b)}">`).join("")}</datalist>
    ${a ? "" : `<div class="full"><label>O que é</label><select name="type">${(Object.keys(ACC_TYPE) as AccType[]).map(k => `<option value="${k}">${ACC_TYPE[k]}</option>`).join("")}</select></div>`}
    <div><label>Credor: banco, loja ou pessoa</label><input name="inst" list="banks" maxlength="80" value="${esc(a?.institution)}" placeholder="ex.: Nubank, João"></div>
    <div><label>Apelido</label><input name="name" required maxlength="80" value="${esc(a?.name ?? "")}" placeholder="ex.: Conta, Cartão roxo"></div>
    <div class="full"><label>De quem</label><select name="owner">${own(a?.ownerPersonId ?? st.me?.personId)}</select></div>
    <div data-f="cash"><label>Saldo de hoje (R$)</label><input name="bal" inputmode="decimal" value="${a ? moneyInput(a.openingBalanceCents) : "0,00"}"></div>
    <div data-f="card"><label>Limite (R$)</label><input name="lim" inputmode="decimal" value="${a?.creditLimitCents != null ? moneyInput(a.creditLimitCents) : ""}"></div>
    <div data-f="card"><label>Dia que fecha</label><input name="close" type="number" min="1" max="31" value="${a?.closingDay ?? ""}"></div>
    <div data-f="card loan"><label>Dia que vence</label><input name="due" type="number" min="1" max="31" value="${a?.dueDay ?? ""}"></div>
    ${a ? "" : `<div data-f="card"><label>Fatura atual (R$)</label><input name="bill" inputmode="decimal" placeholder="0,00"></div>
    <div data-f="card"><label>Vencimento da fatura</label><input name="billdue" type="date"></div>
    <div data-f="loan"><label>Valor da parcela (R$)</label><input name="inst_v" inputmode="decimal"></div>
    <div data-f="loan"><label>Parcelas que faltam</label><input name="rem" type="number" min="1" max="480"></div>
    <div data-f="loan"><label>Total de parcelas (se souber)</label><input name="tot" type="number" min="1" max="480"></div>
    <div data-f="loan"><label>Vencimento da parcela mais antiga em aberto</label><input name="first" type="date"></div>
    <div data-f="loan"><label>Quanto você recebeu (R$)</label><input name="recv" inputmode="decimal" placeholder="para calcular os juros"></div>
    <p class="muted full" data-f="loan" data-ratehint>Informe quanto recebeu, a parcela e o total de parcelas: o app calcula os juros sozinho.</p>
    <p class="muted full" data-f="loan">Se há parcelas atrasadas, informe a data da mais antiga: o sistema mostra o atraso sozinho.</p>`}
    <div data-f="card loan"><label>Juros ao mês (%)</label><input name="rate" inputmode="decimal" placeholder="se souber" value="${a?.monthlyRateBp != null ? String(a.monthlyRateBp / 100).replace(".", ",") : ""}"></div>
    <div data-f="card loan"><label>Fonte dos juros</label><input name="src" maxlength="80" placeholder="ex.: fatura (CET)" value="${esc(a?.rateSource)}"></div>
    <div class="full"><label>Observação</label><input name="notes" maxlength="300" value="${esc(a?.notes)}"></div>
    <label class="inline full" data-f="card loan"><input type="checkbox" name="neg" ${a?.negativado ? "checked" : ""}> Nome negativado por essa dívida (Serasa/SPC)</label>
    ${a ? `<label class="inline full"><input type="checkbox" name="active" ${a.active ? "checked" : ""}> Ativo</label>` : ""}`;
}
export function wireAccForm(fixed?: AccType) {
  const sel = dlgForm.querySelector<HTMLSelectElement>("select[name=type]");
  const apply = () => {
    const t = (fixed ?? sel?.value) as AccType, kind = isCashAcc(t) ? "cash" : t === "CARD" ? "card" : "loan";
    dlgForm.querySelectorAll<HTMLElement>("[data-f]").forEach(e => (e.hidden = !e.dataset.f!.split(" ").includes(kind)));
  };
  sel?.addEventListener("change", apply); apply();
  // oninput (não addEventListener): o diálogo é reaproveitado, então não acumula ouvintes.
  dlgForm.oninput = () => { const h = dlgForm.querySelector<HTMLElement>("[data-ratehint]"); if (!h) return;
    try { h.innerHTML = loanRate(new FormData(dlgForm)).hint; } catch { h.textContent = "Confira os valores (use, por exemplo, 1.234,56)."; } };
}
/** Juros do empréstimo a partir do que se recebeu e das parcelas (tabela Price, parcelas mensais). */
export function loanRate(f: FormData): { bp: number | null; hint: string; source: string | null } {
  const recv = centsOf(f, "recv", false), inst = str(f, "inst_v") ? centsOf(f, "inst_v", false) : null, tot = intOf(f, "tot");
  const base = "Informe quanto recebeu, a parcela e o total de parcelas: o app calcula os juros sozinho.";
  if (!recv || !inst) return { bp: null, hint: base, source: null };
  if (!tot) return { bp: null, hint: "Para calcular os juros, informe também o <b>total de parcelas</b> do contrato.", source: null };
  const i = implicitRate(recv, inst, tot), total = inst * tot;
  const pctT = (x: number) => `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
  return { bp: Math.round(i * 10000),
    hint: i === 0 ? `Sem juros: você devolve ${money(total)} por ${money(recv)}.` : `<b>Juros calculado: ${pctT(i)} ao mês</b> (${pctT((1 + i) ** 12 - 1)} ao ano). Você devolve ${money(total)} por ${money(recv)}: ${money(total - recv)} de juros.`,
    source: `Calculado: recebeu ${money(recv)}, ${tot}× ${money(inst)}` };
}
export const rateOf = (f: FormData) => { const v = str(f, "rate").replace(",", "."); if (!v) return null; const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "INVALID", "Juros inválido."); return n; };
export const intOf = (f: FormData, k: string) => (str(f, k) ? Number(str(f, k)) : null);
export async function newAccount() {
  const known = (await api<Contact[]>("/contacts").catch(() => [] as Contact[])).map(c => c.name);
  openDialog("Adicionar banco, cartão ou dívida", accForm(undefined, known), "Salvar", async f => {
    const type = str(f, "type") as AccType;
    const body: Record<string, unknown> = { type, name: str(f, "name"), institution: str(f, "inst") || null, ownerPersonId: str(f, "owner") || null,
      notes: str(f, "notes") || null };
    if (isCashAcc(type)) body.openingBalanceCents = centsOf(f, "bal", false) ?? 0;
    if (type === "CARD" || type === "LOAN") Object.assign(body, { monthlyRateBp: rateOf(f), rateSource: str(f, "src") || null, dueDay: intOf(f, "due"), negativado: f.has("neg") });
    if (type === "CARD") {
      Object.assign(body, { creditLimitCents: centsOf(f, "lim", false), closingDay: intOf(f, "close") });
      const bill = centsOf(f, "bill", false);
      if (bill) { if (!str(f, "billdue")) throw new ApiError(400, "INVALID", "Informe o vencimento da fatura."); body.currentBill = { amountCents: bill, dueDate: str(f, "billdue") }; }
    }
    if (type === "LOAN") {
      if (!str(f, "inst_v") || !str(f, "rem") || !str(f, "first")) throw new ApiError(400, "INVALID", "Informe parcela, quantas faltam e o vencimento da mais antiga em aberto.");
      body.loan = { installmentCents: centsOf(f, "inst_v"), remaining: Number(str(f, "rem")), firstOpenDueDate: str(f, "first"), totalInstallments: intOf(f, "tot") };
      const lr = loanRate(f);
      if (body.monthlyRateBp == null && lr.bp != null) { body.monthlyRateBp = lr.bp; body.rateSource = body.rateSource ?? lr.source; }
    }
    await api("/accounts", { method: "POST", body });
    toast("Cadastrado.");
  });
  wireAccForm();
}
export async function editAccount(id: string) {
  const a = (await api<Acc[]>("/accounts")).find(x => x.id === id); if (!a) return;
  openDialog(`Editar · ${a.institution ?? ""} ${a.name}`, accForm(a), "Salvar", async f => {
    const body: Record<string, unknown> = { name: str(f, "name"), institution: str(f, "inst") || null, ownerPersonId: str(f, "owner") || null, notes: str(f, "notes") || null, active: f.has("active") };
    if (isCashAcc(a.type)) body.openingBalanceCents = centsOf(f, "bal", false) ?? 0;
    if (a.type === "CARD" || a.type === "LOAN") Object.assign(body, { monthlyRateBp: rateOf(f), rateSource: str(f, "src") || null, dueDay: intOf(f, "due"), negativado: f.has("neg") });
    if (a.type === "CARD") Object.assign(body, { creditLimitCents: centsOf(f, "lim", false), closingDay: intOf(f, "close") });
    await api(`/accounts/${id}`, { method: "PATCH", body });
    toast("Alterado.");
  });
  wireAccForm(a.type);
}
export function billDialog(id: string) {
  openDialog("Nova fatura do cartão", `<div><label>Valor da fatura (R$)</label><input name="v" inputmode="decimal" required></div>
    <div><label>Vencimento</label><input name="d" type="date" required></div>`, "Salvar", async f => {
    await api(`/accounts/${id}/bill`, { method: "POST", body: { amountCents: centsOf(f, "v"), dueDate: str(f, "d") } });
    toast("Fatura lançada em Contas a pagar.");
  });
}
export interface Transfer { id: string; amountCents: number; day: string; note: string | null; createdBy: string | null; createdByName: string | null;
  fromAccountId: string; toAccountId: string; fromLabel: string; toLabel: string; }
export async function editTransfer(id: string) {
  const t = st.trCache.find(x => x.id === id); if (!t) return;
  const accs = (await api<Acc[]>("/accounts")).filter(a => a.active && isCashAcc(a.type));
  const opts = (sel: string) => accs.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.ownerName)} · ${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("");
  openDialog("Corrigir transferência", `<div class="full"><label>De</label><select name="from">${opts(t.fromAccountId)}</select></div>
    <div class="full"><label>Para</label><select name="to">${opts(t.toAccountId)}</select></div>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(t.amountCents)}" required></div>
    <div><label>Data</label><input name="d" type="date" value="${t.day}"></div>
    <p class="muted full">A correção fica no registro de alterações, com o valor de antes e o de agora.</p>`, "Salvar", async f => {
    await api(`/transfers/${id}`, { method: "PATCH", body: { fromAccountId: str(f, "from"), toAccountId: str(f, "to"), amountCents: centsOf(f, "v"), day: str(f, "d") } });
    toast("Transferência corrigida. Saldos recalculados.");
  });
}
export async function transferDialog(fromId: string) {
  const accs = (await api<Acc[]>("/accounts")).filter(a => a.active && isCashAcc(a.type) && a.id !== fromId);
  openDialog("Transferir entre contas", `<div class="full"><label>Para</label><select name="to" required>${accs.map(a => `<option value="${a.id}">${esc(a.ownerName)} · ${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("")}</select></div>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" required></div><div><label>Data</label><input name="d" type="date" value="${today()}"></div>
    <p class="muted full">Transferência entre contas de vocês não é receita nem despesa.</p>`, "Transferir", async f => {
    await api("/transfers", { method: "POST", body: { fromAccountId: fromId, toAccountId: str(f, "to"), amountCents: centsOf(f, "v"), day: str(f, "d") || undefined } });
    toast("Transferência registrada.");
  });
}

/* ===================== Credores (bancos, lojas e pessoas de fora da família) ===================== */
function creditors(cts: Contact[]) {
  const people = cts.filter(c => c.kind === "PESSOA" || c.openCents > 0);
  return `<div class="card" style="margin-top:20px"><div class="row spread"><h3 style="margin:0">Credores</h3><button class="sm" data-newcontact>+ Credor</button></div>
    <p class="muted">Quem empresta: bancos, lojas e pessoas (ex.: um amigo). Para cadastrar a dívida, use "+ Adicionar" → Empréstimo e escolha o credor.</p>
    ${people.length ? `<div class="list">${people.map(c => `<div class="item"><div class="head"><span class="who">${c.kind === "PESSOA" ? "👤 " : ""}${esc(c.name)}</span>
      <span class="amt">${c.openCents ? money(c.openCents) : "nada em aberto"}</span></div>
      <div class="meta">${c.openCount ? `<span class="chip">${c.openCount} parcela(s)</span>` : ""}${c.nextDue ? `<span class="muted">próxima ${br(c.nextDue)}</span> ${dChip(c.nextDue)}` : ""}
        ${c.phone ? `<span class="muted">📞 ${esc(c.phone)}</span>` : ""}${c.email ? `<span class="muted">✉️ ${esc(c.email)}</span>` : ""}</div>
      ${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ""}
      <div class="actions"><button class="ghost sm" data-editcontact="${c.id}">Editar</button></div></div>`).join("")}</div>`
      : `<div class="empty">Nenhum credor pessoa cadastrado.</div>`}</div>`;
}
const contactForm = (c?: Contact) => `
  <div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(c?.name)}"></div>
  <div><label>Tipo</label><select name="kind"><option value="PESSOA" ${c?.kind !== "EMPRESA" ? "selected" : ""}>Pessoa física</option><option value="EMPRESA" ${c?.kind === "EMPRESA" ? "selected" : ""}>Banco / loja / empresa</option></select></div>
  <div><label>Telefone (opcional)</label><input name="phone" inputmode="tel" maxlength="30" value="${esc(c?.phone)}"></div>
  <div class="full"><label>E-mail (opcional, para lembretes no futuro)</label><input name="email" type="email" maxlength="120" value="${esc(c?.email)}"></div>
  <div class="full"><label>Observação</label><input name="notes" maxlength="300" value="${esc(c?.notes)}"></div>
  <p class="muted full">Dado de outra pessoa: guarde só o necessário.</p>`;
const contactBody = (f: FormData) => ({ name: str(f, "name"), kind: str(f, "kind"), phone: str(f, "phone") || null, email: str(f, "email") || null, notes: str(f, "notes") || null });
export function newContact() {
  openDialog("Novo credor", contactForm(), "Salvar", async f => { await api("/contacts", { method: "POST", body: contactBody(f) }); toast("Credor cadastrado."); });
}
export async function editContact(id: string) {
  const c = (await api<Contact[]>("/contacts")).find(x => x.id === id); if (!c) return;
  openDialog(`Editar · ${c.name}`, contactForm(c), "Salvar", async f => { await api(`/contacts/${id}`, { method: "PATCH", body: contactBody(f) }); toast("Alterado."); });
}
