import { api, root, ApiError, getEntity, setEntity, type Title, type Recurrence, type Kind, type Settlement, type Person, type Me } from "./api.js";
import { money, parseMoney, moneyInput, today, br, monthLabel, addMonths, pct, esc } from "./fmt.js";

/* ===================== Infra de UI ===================== */
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const view = $("#view");
const dlg = $<HTMLDialogElement>("#dlg");
const dlgForm = $<HTMLFormElement>("#dlg-form");

function toast(msg: string, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = `show${err ? " err" : ""}`;
  setTimeout(() => (t.className = ""), err ? 5000 : 2500);
}
const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : "Sem conexão com a API. Ela está rodando?", true);

const NATURE: Record<string, string> = { EXPENSE: "Conta", DEBT: "Dívida", CARD: "Cartão", INCOME: "Receita", LOAN_IN: "Empréstimo" };
const STATUS: Record<string, string> = { OPEN: "Em aberto", OVERDUE: "Vencida", SETTLED: "Quitada", NO_VALUE: "Sem valor" };
const CATEGORIES = ["ALIMENTACAO", "MORADIA", "AGUA", "LUZ", "INTERNET", "FIXO", "TRANSPORTE", "SAUDE", "EDUCACAO",
  "DELIVERY", "RESTAURANTE", "LAZER", "ROUPAS", "BELEZA", "PRESENTES", "ASSINATURAS", "DIVIDA", "CARTAO", "RENDA", "OUTROS"];

/* Usuário logado */
let me: Me | null = null;
const isAdmin = () => me?.role === "ADMIN";
const isGuardian = () => isAdmin() || !!me?.isGuardian;
const mine = (createdBy: string | null | undefined) => isAdmin() || (!!createdBy && createdBy === me?.id);
const catOptions = (sel?: string) => CATEGORIES.map(c => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");

/* Pessoas da casa: cache usado nos formulários */
let people: Person[] = [];
const loadPeople = async () => { people = await api<Person[]>("/people"); return people; };
const personOptions = (sel?: string | null, includeInactive = false) =>
  `<option value="">Casa / geral</option>` + people.filter(p => p.active || includeInactive || p.id === sel)
    .map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}${p.active ? "" : " (inativa)"}</option>`).join("");
const personSelect = (sel?: string | null) => `<div><label>Pessoa</label><select name="person">${personOptions(sel)}</select></div>`;

/** Abre um formulário em diálogo. onSubmit retorna false para manter aberto. */
function openDialog(title: string, body: string, submitLabel: string, onSubmit: (f: FormData) => Promise<boolean | void>) {
  dlgForm.innerHTML = `<h3>${esc(title)}</h3><div class="form">${body}</div>
    <div class="row end"><button type="button" class="ghost" data-close>Cancelar</button><button type="submit">${esc(submitLabel)}</button></div>`;
  dlgForm.onsubmit = async ev => {
    ev.preventDefault();
    const btn = dlgForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    try { if ((await onSubmit(new FormData(dlgForm))) !== false) { dlg.close(); await render(); } }
    catch (e) { fail(e); }
    finally { btn.disabled = false; }
  };
  dlgForm.querySelector("[data-close]")!.addEventListener("click", () => dlg.close());
  dlg.showModal();
  dlgForm.querySelector<HTMLInputElement>("input:not([type=hidden]), select")?.focus();
}
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function centsOf(f: FormData, k: string, required = true): number | null {
  const v = str(f, k);
  if (!v && !required) return null;
  const c = parseMoney(v);
  if (Number.isNaN(c)) throw new ApiError(400, "INVALID", "Valor inválido. Use, por exemplo, 1.234,56");
  return c;
}

/* ===================== Roteamento ===================== */
type Tab = "painel" | "combinados" | "ranking" | "pagar" | "receber" | "pessoas" | "extrato" | "futuro" | "config";
let tab: Tab = (location.hash.slice(1) as Tab) || "painel";
const renderers: Record<Tab, () => Promise<string>> = { painel, combinados: combinadosPage, ranking: rankingPage, pagar: () => titles("PAYABLE"), receber: () => titles("RECEIVABLE"), pessoas, extrato, futuro, config };
const TITLES: Record<Tab, string> = { painel: "Painel", combinados: "Combinados", ranking: "Ranking da semana", pagar: "Contas a pagar", receber: "Contas a receber", pessoas: "Pessoas da casa", extrato: "Extrato", futuro: "Futuro", config: "Ajustes" };
const side = $("#side"), scrim = $("#scrim");
const menu = (open: boolean) => { side.classList.toggle("open", open); scrim.classList.toggle("open", open); };
$("#menu-btn").addEventListener("click", () => menu(true));
scrim.addEventListener("click", () => menu(false));

async function render() {
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#page-title").textContent = TITLES[tab]; document.title = `${TITLES[tab]} · NOFINANCE`;
  try { await loadPeople(); view.innerHTML = await renderers[tab](); }
  catch (e) { view.innerHTML = `<div class="alert danger">${esc(e instanceof ApiError ? e.message : "Sem conexão com a API. Confira se o npm run dev está rodando.")}</div>`; }
}
$("#tabs").addEventListener("click", e => {
  const t = (e.target as HTMLElement).dataset.tab as Tab | undefined;
  if (t) { tab = t; menu(false); history.pushState(null, "", `#${t}`); scrollTo(0, 0); render(); }
});
const entSel = $<HTMLSelectElement>("#entity");
entSel.value = getEntity();
entSel.addEventListener("change", () => { setEntity(entSel.value); personFilter = ""; render(); });

/* ===================== Painel ===================== */
interface Dashboard {
  payableOpenCents: number; receivableOpenCents: number; projectedBalanceCents: number; debtOpenCents: number; debtInterestCents: number;
  overdue: Title[]; missingValue: Title[]; nextDue: Title[];
  debtPriority: { id: string; counterparty: string; rateBp: number; openCents: number; dueDate: string | null }[];
  thisMonth: { incomeCents: number; expenseCents: number; resultCents: number; cashBalanceCents: number } | null;
}
async function painel() {
  const personal = getEntity() === "personal";
  const [d, rk, cb] = await Promise.all([api<Dashboard>("/dashboard"), personal ? api<Ranking>("/ranking") : Promise.resolve(null),
    personal ? api<Board>("/conduct/board").catch(() => null) : Promise.resolve(null)]);
  const kpi = (l: string, v: number, cls = "", hero = false) => `<div class="card kpi${hero ? " hero" : ""}"><div class="l">${l}</div><div class="v ${cls}">${money(v)}</div></div>`;
  const m = d.thisMonth;
  return `
  <div class="grid kpis">
    ${kpi("Saldo previsto", d.projectedBalanceCents, d.projectedBalanceCents < 0 ? "neg" : "", true)}
    ${kpi("A pagar", d.payableOpenCents)}${kpi("A receber", d.receivableOpenCents)}${kpi("Dívidas", d.debtOpenCents)}
  </div>
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
      <div><button>Registrar</button></div>
    </form>
  </div>
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

/* ===================== Contas a pagar / receber ===================== */
let statusFilter: "open" | "settled" | "all" = "open";
let personFilter = ""; // "" = todas, "none" = casa/geral, ou id
async function titles(kind: Kind) {
  const list = await api<Title[]>(`/titles?kind=${kind}&status=${statusFilter}${personFilter ? `&person=${personFilter}` : ""}`);
  const label = kind === "PAYABLE" ? "Contas a pagar" : "Contas a receber";
  const total = list.reduce((s, t) => s + Math.max(0, t.openCents), 0);
  const f = (v: typeof statusFilter, l: string) => `<button class="${statusFilter === v ? "" : "ghost"} sm" data-filter="${v}">${l}</button>`;
  return `
  <div class="row spread"><h2>${label}</h2><button data-new="${kind}">+ Nova</button></div>
  <div class="row" style="margin-bottom:12px">${f("open", "Em aberto")}${f("settled", kind === "PAYABLE" ? "Pagas" : "Recebidas")}${f("all", "Todas")}
    <select id="pfilter" style="width:auto"><option value="">Todas as pessoas</option><option value="none" ${personFilter === "none" ? "selected" : ""}>Casa / geral</option>
      ${people.map(p => `<option value="${p.id}" ${personFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    <span class="muted" style="margin-left:auto">Em aberto: <b>${money(total)}</b></span></div>
  <div class="list">${list.length ? list.map(titleItem).join("") : `<div class="empty">Nenhuma conta aqui. Toque em "+ Nova".</div>`}</div>`;
}
function titleItem(t: Title) {
  const payLabel = t.kind === "PAYABLE" ? "Pagar" : "Receber";
  return `<div class="item">
    <div class="head"><span class="who">${esc(t.counterparty)}</span><span class="amt">${money(t.openCents)}</span></div>
    <div class="meta">
      <span class="chip ${t.status}">${STATUS[t.status]}</span><span class="chip">${NATURE[t.nature]}</span><span class="chip">${esc(t.category)}</span>
      ${t.personName ? `<span class="chip person">👤 ${esc(t.personName)}</span>` : ""}
      <span class="muted">vence ${br(t.dueDate)}</span>
      ${t.rateBp ? `<span class="chip">${pct(t.rateBp)} juros</span>` : ""}
      ${t.recurrenceId ? `<span class="chip">automática</span>` : ""}
    </div>
    <div class="muted" style="margin-top:4px">Valor ${money(t.amountCents)}${t.interestCents ? ` + juros ${money(t.interestCents)}` : ""} · pago ${money(t.settledCents)}${t.notes ? ` · ${esc(t.notes)}` : ""}</div>
    <div class="actions">
      ${t.status !== "SETTLED" ? `<button class="sm" data-pay="${t.id}">${payLabel}</button>` : ""}
      ${mine(t.createdBy) ? `<button class="ghost sm" data-edit="${t.id}">Editar</button>` : ""}
      ${t.settledCents ? `<button class="ghost sm" data-pays="${t.id}">Pagamentos</button>` : ""}
      ${mine(t.createdBy) ? `<button class="danger sm" data-del="${t.id}">Excluir</button>` : ""}
    </div>
    <div data-pays-box="${t.id}"></div>
  </div>`;
}

function titleForm(kind: Kind, t?: Title) {
  const natures = kind === "PAYABLE" ? ["EXPENSE", "DEBT", "CARD"] : ["INCOME", "LOAN_IN"];
  const isNew = !t;
  return `
    <div class="full"><label>${kind === "PAYABLE" ? "Para quem / o quê" : "De quem"}</label><input name="who" required value="${esc(t?.counterparty)}"></div>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" value="${t ? moneyInput(t.amountCents) : ""}"></div>
    <div><label>Vencimento</label><input name="due" type="date" value="${t?.dueDate ?? ""}"></div>
    <div><label>Tipo</label><select name="nat" ${isNew ? "" : "disabled"}>${natures.map(n => `<option value="${n}" ${t?.nature === n ? "selected" : ""}>${NATURE[n]}</option>`).join("")}</select></div>
    <div><label>Categoria</label><select name="cat">${catOptions(t?.category ?? (kind === "PAYABLE" ? "OUTROS" : "RENDA"))}</select></div>
    ${personSelect(t ? t.personId : personFilter && personFilter !== "none" ? personFilter : null)}
    <div data-int><label>Juros</label><select name="model">
      ${[["NONE", "Sem juros"], ["FIXED_ONCE", "% uma vez"], ["MONTHLY_SIMPLE", "% ao mês simples"], ["MONTHLY_COMPOUND", "% ao mês composto"]]
        .map(([v, l]) => `<option value="${v}" ${t?.interestModel === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div data-int><label>Taxa (%)</label><input name="rate" inputmode="decimal" value="${t ? (t.rateBp / 100).toString().replace(".", ",") : "0"}"></div>
    <div class="full"><label>Observação</label><input name="notes" value="${esc(t?.notes)}"></div>
    ${isNew && kind === "RECEIVABLE" ? `<p class="muted full" data-loan>Empréstimo não é receita: o sistema cria a dívida em "A pagar" com os juros acima.</p>` : ""}`;
}
/** Mostra juros só para dívida/empréstimo. */
function wireInterestVisibility(kind: Kind, nature?: string) {
  const sel = dlgForm.querySelector<HTMLSelectElement>("select[name=nat]")!;
  const apply = () => {
    const n = nature ?? sel.value, show = n === "DEBT" || n === "LOAN_IN";
    dlgForm.querySelectorAll<HTMLElement>("[data-int]").forEach(e => (e.style.display = show ? "" : "none"));
    dlgForm.querySelectorAll<HTMLElement>("[data-loan]").forEach(e => (e.style.display = n === "LOAN_IN" ? "" : "none"));
  };
  sel.addEventListener("change", apply); apply();
  void kind;
}
function interestFrom(f: FormData) {
  const model = str(f, "model") || "NONE";
  const rateBp = Math.round(Number(str(f, "rate").replace(",", ".") || "0") * 100);
  if (!Number.isFinite(rateBp) || rateBp < 0) throw new ApiError(400, "INVALID", "Taxa inválida.");
  return model === "NONE" || rateBp === 0 ? { interestModel: "NONE", rateBp: 0 } : { interestModel: model, rateBp };
}

function newTitle(kind: Kind) {
  openDialog(kind === "PAYABLE" ? "Nova conta a pagar" : "Nova conta a receber", titleForm(kind), "Salvar", async f => {
    const nat = str(f, "nat"), int = interestFrom(f);
    const body: Record<string, unknown> = {
      kind, nature: nat, counterparty: str(f, "who"), category: str(f, "cat"),
      amountCents: centsOf(f, "v", false) ?? 0, dueDate: str(f, "due") || null, notes: str(f, "notes") || null,
      personId: str(f, "person") || null,
    };
    if (nat === "DEBT") Object.assign(body, int);
    if (nat === "LOAN_IN") body.loan = { ...int, dueDate: str(f, "due") || null };
    await api("/titles", { method: "POST", body });
    toast(nat === "LOAN_IN" ? "Empréstimo lançado e dívida criada em A pagar." : "Conta lançada.");
  });
  wireInterestVisibility(kind);
}

async function editTitle(id: string) {
  const t = await api<Title>(`/titles/${id}`);
  openDialog("Editar conta", titleForm(t.kind, t), "Salvar", async f => {
    const body: Record<string, unknown> = {
      counterparty: str(f, "who"), category: str(f, "cat"), amountCents: centsOf(f, "v", false) ?? 0,
      dueDate: str(f, "due") || null, notes: str(f, "notes") || null, personId: str(f, "person") || null,
    };
    if (t.nature === "DEBT") Object.assign(body, interestFrom(f));
    await api(`/titles/${id}`, { method: "PATCH", body });
    toast("Alterado. Saldos recalculados.");
  });
  wireInterestVisibility(t.kind, t.nature);
}

async function payTitle(id: string) {
  const t = await api<Title>(`/titles/${id}`);
  const key = crypto.randomUUID(); // evita duplicar com duplo toque
  const verb = t.kind === "PAYABLE" ? "Pagar" : "Receber";
  openDialog(`${verb}: ${t.counterparty}`, `
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${t.openCents > 0 ? moneyInput(t.openCents) : ""}" required></div>
    <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
    ${t.kind === "PAYABLE" ? `<div class="full"><label>Pago com</label><select name="m"><option value="ACCOUNT">Conta / Pix / dinheiro</option><option value="CARD">Cartão de crédito</option></select></div>` : ""}
    <div class="full"><label>Observação</label><input name="notes"></div>
    <p class="muted full">Em aberto: ${money(t.openCents)}</p>`, verb, async f => {
    const r = await api<Title>(`/titles/${id}/settlements`, { method: "POST", headers: { "idempotency-key": key },
      body: { amountCents: centsOf(f, "v"), paidOn: str(f, "dt") || undefined, method: (str(f, "m") || "ACCOUNT"), notes: str(f, "notes") || null } });
    const w = r.settlements?.at(-1)?.warnings ?? [];
    toast(w.length ? `Registrado com aviso: ${w.join("; ")}` : "Registrado.", w.length > 0);
  });
}

async function showPays(id: string) {
  const box = $(`[data-pays-box="${id}"]`);
  if (box.innerHTML) { box.innerHTML = ""; return; }
  const t = await api<Title>(`/titles/${id}`);
  box.innerHTML = `<ul class="pays">${(t.settlements ?? []).map((s: Settlement) => `<li>
    <span>${br(s.paidOn)} · ${money(s.amountCents)}${s.method === "CARD" ? " · cartão" : ""}${s.warnings.length ? ` <span class="chip OVERDUE">aviso</span>` : ""}</span>
    <span class="row"><button class="ghost sm" data-pedit="${s.id}" data-amt="${s.amountCents}" data-dt="${s.paidOn}">Editar</button>
    <button class="danger sm" data-pdel="${s.id}">Excluir</button></span></li>`).join("")}</ul>`;
}
function editPay(id: string, amt: number, dt: string) {
  openDialog("Editar pagamento", `
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(amt)}" required></div>
    <div><label>Data</label><input name="dt" type="date" value="${dt}"></div>`, "Salvar", async f => {
    await api(`/settlements/${id}`, { method: "PATCH", body: { amountCents: centsOf(f, "v"), paidOn: str(f, "dt") } });
    toast("Pagamento alterado.");
  });
}

/* ===================== Extrato ===================== */
let extFrom = addMonths(today().slice(0, 7), -5), extTo = today().slice(0, 7);
interface Month { month: string; incomeCents: number; expenseCents: number; interestPaidCents: number; amortizationCents: number; loansInCents: number; resultCents: number; cashBalanceCents: number; }
async function extrato() {
  const st = await api<{ months: Month[] }>(`/statement?from=${extFrom}&to=${extTo}`);
  const tot = (k: keyof Month) => st.months.reduce((s, m) => s + (m[k] as number), 0);
  const cell = (v: number, sign = false) => `<td class="${sign ? (v < 0 ? "neg" : "pos") : ""}">${money(v)}</td>`;
  return `<h2>Extrato realizado</h2>
  <form class="card form" id="ext">
    <div><label>De</label><input type="month" name="from" value="${extFrom}"></div>
    <div><label>Até</label><input type="month" name="to" value="${extTo}"></div>
    <div><button>Ver</button></div>
  </form>
  <div class="card scroll"><table>
    <tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Juros pagos</th><th>Amortização</th><th>Empréstimos</th><th>Resultado</th><th>Caixa</th></tr>
    ${st.months.map(m => `<tr><td>${monthLabel(m.month)}</td>${cell(m.incomeCents)}${cell(m.expenseCents)}${cell(m.interestPaidCents)}${cell(m.amortizationCents)}${cell(m.loansInCents)}${cell(m.resultCents, true)}${cell(m.cashBalanceCents, true)}</tr>`).join("")}
    <tr><th>Total</th><th>${money(tot("incomeCents"))}</th><th>${money(tot("expenseCents"))}</th><th>${money(tot("interestPaidCents"))}</th><th>${money(tot("amortizationCents"))}</th><th>${money(tot("loansInCents"))}</th><th>${money(tot("resultCents"))}</th><th></th></tr>
  </table></div>
  <p class="muted">Despesa = contas pagas + juros. Devolver o valor emprestado é amortização (sai do caixa, não é despesa). Empréstimo recebido entra no caixa, mas não é receita.</p>`;
}

/* ===================== Futuro: projeção + simulador ===================== */
let projMonths = 12;
let simCache = "";
async function futuro() {
  const p = await api<{ startingCashCents: number; months: { month: string; inCents: number; outCents: number; netCents: number; accumulatedCents: number; estimatedItems: number }[] }>(`/projection?months=${projMonths}`);
  const opt = (n: number) => `<button class="${projMonths === n ? "" : "ghost"} sm" data-proj="${n}">${n >= 12 ? `${n / 12} ano${n > 12 ? "s" : ""}` : `${n} meses`}</button>`;
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
      <div><label>Renda mensal líquida (R$)</label><input name="inc" inputmode="decimal" value="15.599,00" required></div>
      <div><label>Gastos fixos/mês (R$)</label><input name="fix" inputmode="decimal" value="3.250,00" required></div>
      <div><label>Extra/mês (R$)</label><input name="ext" inputmode="decimal" value="0"></div>
      <div><label>Caixa hoje (R$)</label><input name="cash" inputmode="decimal" value="0"></div>
      <div><label class="inline"><input type="checkbox" name="roll" checked> Juros por ciclo se atrasar</label>
           <label class="inline"><input type="checkbox" name="cards" checked> Incluir cartões</label></div>
      <div><button>Simular</button></div>
    </form><div id="sim-out">${simCache}</div></div>`;
}
interface SimRes { assumptions: string[]; monthlySurplusCents: number; totalDebtCents: number; results: { strategy: string; feasible: boolean; months: number | null; extraInterestCents: number; payoffOrder: string[] }[]; }
async function runSim(form: HTMLFormElement) {
  const f = new FormData(form);
  const r = await api<SimRes>("/simulate", { method: "POST", body: {
    monthlyIncomeCents: centsOf(f, "inc"), monthlyFixedCents: centsOf(f, "fix"), extraCents: centsOf(f, "ext", false) ?? 0,
    initialCashCents: centsOf(f, "cash", false) ?? 0, rolloverMonthly: f.has("roll"), includeCards: f.has("cards") } });
  const name: Record<string, string> = { AVALANCHE: "Avalanche (juros primeiro)", SNOWBALL: "Bola de neve (menor saldo)" };
  simCache = `<p class="muted">Dívidas: ${money(r.totalDebtCents)} · sobra mensal: <b class="${r.monthlySurplusCents <= 0 ? "neg" : ""}">${money(r.monthlySurplusCents)}</b></p>
    <div class="scroll"><table><tr><th>Estratégia</th><th>Prazo</th><th>Quitação</th><th>Juros extras</th></tr>
    ${r.results.map(x => `<tr><td>${name[x.strategy]}</td>${x.feasible
      ? `<td>${x.months} mês(es)</td><td>${monthLabel(addMonths(today().slice(0, 7), x.months ?? 0))}</td><td>${money(x.extraInterestCents)}</td>`
      : `<td colspan="3" class="neg">Não quita em 10 anos</td>`}</tr>`).join("")}</table></div>
    <p class="muted">Premissas: ${r.assumptions.map(esc).join("; ")}.</p>`;
  $("#sim-out").innerHTML = simCache;
}

/* ===================== Ajustes: automáticas + avisos ===================== */
async function config() {
  const [recs, warns] = await Promise.all([
    api<Recurrence[]>("/recurrences"),
    api<{ id: string; paidOn: string; amountCents: number; warnings: string[]; counterparty: string }[]>("/warnings"),
  ]);
  return `<div class="row spread"><h2>Contas automáticas</h2>${isAdmin() ? "<button data-newrec>+ Nova</button>" : ""}</div>
  <p class="muted">Geradas todo mês sozinhas (mês atual e próximo). Sem valor padrão, a conta nasce "sem valor" e o 1º pagamento define; o mês seguinte usa o último valor.</p>
  <div class="list">${recs.length ? recs.map(r => `<div class="item">
    <div class="head"><span class="who">${esc(r.description)}</span><span class="amt">${r.defaultAmountCents != null ? money(r.defaultAmountCents) : "varia"}</span></div>
    <div class="meta"><span class="chip">${r.kind === "PAYABLE" ? "A pagar" : "A receber"}</span><span class="chip">${esc(r.category)}</span>
      ${r.personName ? `<span class="chip person">👤 ${esc(r.personName)}</span>` : ""}
      <span class="muted">dia ${r.dueDay ?? "—"} · desde ${br(r.startMonth).slice(3)}</span>${r.active ? "" : `<span class="chip OVERDUE">pausada</span>`}</div>
    ${isAdmin() ? `<div class="actions"><button class="ghost sm" data-editrec="${r.id}">Editar</button>
      <button class="ghost sm" data-togglerec="${r.id}" data-active="${r.active}">${r.active ? "Pausar" : "Reativar"}</button></div>` : ""}</div>`).join("")
    : `<div class="empty">Nenhuma. Cadastre aluguel, água, luz, internet e a renda.</div>`}</div>
  <h2 style="margin-top:20px">Avisos registrados</h2>
  <p class="muted">Nada é bloqueado. O que passou fora da regra fica aqui.</p>
  <div class="card">${warns.length ? `<ul class="pays">${warns.map(w => `<li><span>${br(w.paidOn)} · ${esc(w.counterparty)} · ${money(w.amountCents)}</span><span class="muted">${w.warnings.map(esc).join("; ")}</span></li>`).join("")}</ul>` : `<p class="muted">Nenhum aviso.</p>`}</div>
  <div class="row"><a href="/api/v1/${getEntity()}/export.csv"><button class="ghost">Exportar tudo (CSV para Excel)</button></a></div>
  ${isAdmin() ? await usersSection() : ""}`;
}
function recForm(r?: Recurrence) {
  return `
    <div class="full"><label>Descrição</label><input name="d" required value="${esc(r?.description)}" placeholder="ex.: Aluguel"></div>
    <div><label>Tipo</label><select name="k" ${r ? "disabled" : ""}><option value="PAYABLE" ${r?.kind === "PAYABLE" ? "selected" : ""}>A pagar</option><option value="RECEIVABLE" ${r?.kind === "RECEIVABLE" ? "selected" : ""}>A receber</option></select></div>
    <div><label>Categoria</label><select name="c">${catOptions(r?.category ?? "MORADIA")}</select></div>
    <div><label>Valor padrão (vazio se varia)</label><input name="v" inputmode="decimal" value="${r?.defaultAmountCents != null ? moneyInput(r.defaultAmountCents) : ""}"></div>
    <div><label>Dia do vencimento</label><input name="day" type="number" min="1" max="31" value="${r?.dueDay ?? ""}"></div>
    ${personSelect(r?.personId)}
    ${r ? "" : `<div class="full"><label>Começa em</label><input name="start" type="month" value="${today().slice(0, 7)}"></div>`}`;
}
function newRec() {
  openDialog("Nova conta automática", recForm(), "Salvar", async f => {
    const kind = str(f, "k") as Kind;
    await api("/recurrences", { method: "POST", body: {
      kind, nature: kind === "PAYABLE" ? "EXPENSE" : "INCOME", description: str(f, "d"), category: str(f, "c"),
      defaultAmountCents: centsOf(f, "v", false), dueDay: str(f, "day") ? Number(str(f, "day")) : null, startMonth: str(f, "start"),
      personId: str(f, "person") || null } });
    const m = str(f, "start");
    await api(`/recurrences/generate?month=${m}`, { method: "POST" });
    await api(`/recurrences/generate?month=${addMonths(m, 1)}`, { method: "POST" });
    toast("Conta automática criada e lançada.");
  });
}
async function editRec(id: string) {
  const r = (await api<Recurrence[]>("/recurrences")).find(x => x.id === id);
  if (!r) return;
  openDialog("Editar conta automática", recForm(r), "Salvar", async f => {
    await api(`/recurrences/${id}`, { method: "PATCH", body: {
      description: str(f, "d"), category: str(f, "c"), defaultAmountCents: centsOf(f, "v", false),
      dueDay: str(f, "day") ? Number(str(f, "day")) : null, personId: str(f, "person") || null } });
    toast("Alterada. Vale para os próximos meses.");
  });
}

/* ===================== Pessoas da casa ===================== */
let peopleMonth = today().slice(0, 7);
interface PeopleSummary { totalPaidCents: number; people: { personId: string | null; name: string; active: boolean; paidCents: number; openCents: number; openCount: number; byCategory: { category: string; cents: number }[] }[]; }
async function pessoas() {
  const s = await api<PeopleSummary>(`/people/summary?from=${peopleMonth}&to=${peopleMonth}`);
  const share = (v: number) => (s.totalPaidCents ? Math.round((v / s.totalPaidCents) * 100) : 0);
  return `<div class="row spread"><h2>Pessoas da casa</h2>${isAdmin() ? "<button data-newperson>+ Nova pessoa</button>" : ""}</div>
  <p class="muted">Vincule contas a uma pessoa (no cadastro da conta, no "Já gastei" ou na conta automática) para ver quanto cada uma custa.</p>
  <form class="card form" id="pmonth"><div><label>Mês</label><input type="month" name="m" value="${peopleMonth}"></div><div><button>Ver</button></div></form>
  <div class="list">${s.people.filter(p => p.active || p.paidCents || p.openCents).map(p => {
    const rel = people.find(x => x.id === p.personId)?.relation;
    return `<div class="item">
    <div class="head"><span class="who">${esc(p.name)}${rel ? ` <span class="muted">· ${esc(rel)}</span>` : ""}${p.active ? "" : ` <span class="chip OVERDUE">inativa</span>`}</span>
      <span class="amt">${money(p.paidCents)}</span></div>
    <div class="meta"><span class="muted">pago no mês · ${share(p.paidCents)}% do total</span>
      ${p.openCents ? `<span class="chip OPEN">em aberto ${money(p.openCents)} (${p.openCount})</span>` : ""}</div>
    ${p.byCategory.length ? `<div class="muted" style="margin-top:6px">${p.byCategory.slice(0, 5).map(c => `${esc(c.category)} ${money(c.cents)}`).join(" · ")}</div>` : ""}
    <div class="actions"><button class="ghost sm" data-seeperson="${p.personId ?? "none"}">Ver contas</button>
      ${p.personId && isAdmin() ? `<button class="ghost sm" data-editperson="${p.personId}">Editar</button>
      <button class="ghost sm" data-toggleperson="${p.personId}" data-active="${p.active}">${p.active ? "Desativar" : "Reativar"}</button>` : ""}</div>
  </div>`; }).join("")}</div>
  <p class="muted">Total pago no mês: <b>${money(s.totalPaidCents)}</b>. "Pago" é o que saiu do caixa no mês (regime de caixa), em contas a pagar.</p>`;
}
function personForm(p?: Person) {
  return `<div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(p?.name)}"></div>
    <div class="full"><label>Relação (opcional)</label><input name="rel" maxlength="40" placeholder="ex.: esposa, filho, mãe" value="${esc(p?.relation)}"></div>`;
}
function newPerson() {
  openDialog("Nova pessoa", personForm(), "Salvar", async f => {
    await api("/people", { method: "POST", body: { name: str(f, "name"), relation: str(f, "rel") || null } });
    toast("Pessoa cadastrada.");
  });
}
function editPerson(id: string) {
  const p = people.find(x => x.id === id); if (!p) return;
  openDialog("Editar pessoa", personForm(p), "Salvar", async f => {
    await api(`/people/${id}`, { method: "PATCH", body: { name: str(f, "name"), relation: str(f, "rel") || null } });
    toast("Alterado.");
  });
}

/* ===================== Combinados ===================== */
interface Cell { ruleId: string; done: boolean; applies: boolean; checkedAt: string | null; by: string | null; }
interface BoardRow { personId: string; name: string; nickname: string | null; hasLogin: boolean; grid: { day: string; habits: Cell[] }[]; fullDays: number; daysCounted: number;
  habitsDone: number; habitsDue: number; infractions: number; pointsLost: number; finesWeekCents: number; balanceCents: number; }
interface Board { week: { start: string; end: string }; today: string; habits: { id: string; name: string }[]; rows: BoardRow[]; mostConsistent: string | null;
  entries: { id: string; personId: string; personName: string; kind: "HABIT_MISS" | "INFRACTION" | "PAYMENT" | "WAIVER"; day: string; points: number; amountCents: number; note: string | null; by: string | null }[]; }
interface Rule { id: string; kind: "HABIT" | "INFRACTION"; name: string; points: number; fineCents: number; sort: number; active: boolean; }

const dayOf = (r: BoardRow, day: string) => r.grid.find(g => g.day === day);
const dots = (cells: Cell[] | undefined, habits: Board["habits"]) => `<span class="dots" role="img" aria-label="${cells ? cells.filter(c => c.done).length : 0} de ${habits.length} hábitos">${
  habits.map((h, i) => { const c = cells?.[i]; return `<i class="${c?.done ? "on" : c && !c.applies ? "na" : ""}" title="${esc(h.name)}${c?.done ? " ✓" : ""}"></i>`; }).join("")}</span>`;

/** Painel: bolinhas de hoje de todo mundo + cobrança para quem está logado. */
function todayCard(b: Board) {
  if (!b.habits.length || !b.rows.length) return "";
  const meRow = b.rows.find(r => r.personId === me?.personId);
  const missing = meRow ? b.habits.filter((_, i) => !dayOf(meRow, b.today)?.habits[i]?.done && dayOf(meRow, b.today)?.habits[i]?.applies) : [];
  return `${missing.length ? `<div class="alert danger"><b>Combinados de hoje:</b> falta ${missing.map(h => esc(h.name)).join(", ")}.
      <button class="sm" data-goto="combinados">Marcar agora</button></div>` : ""}
    <div class="card"><div class="row spread"><h3 style="margin:0">Combinados de hoje</h3><button class="ghost sm" data-goto="combinados">Ver placar</button></div>
    <div class="today-list">${b.rows.map(r => `<div><span>${esc(r.name)}${nick(r.nickname)}</span>${dots(dayOf(r, b.today)?.habits, b.habits)}</div>`).join("")}</div></div>`;
}

let cbDate = today();
async function combinadosPage() {
  if (getEntity() !== "personal") return `<div class="empty">Os Combinados são da família (entidade Pessoal).</div>`;
  const [b, rules] = await Promise.all([api<Board>(`/conduct/board?date=${cbDate}`), api<Rule[]>("/conduct/rules")]);
  const meRow = b.rows.find(r => r.personId === me?.personId);
  const yesterday = (() => { const x = new Date(`${b.today}T12:00:00`); x.setDate(x.getDate() - 1); return x.toLocaleDateString("sv-SE"); })();
  const toggles = (row: BoardRow, day: string, label: string) => {
    const cells = dayOf(row, day)?.habits ?? [];
    return `<div class="habit-day"><span class="muted">${label}</span><div class="habit-btns">${b.habits.map((h, i) => {
      const c = cells[i]; if (c && !c.applies) return "";
      return `<button class="habit ${c?.done ? "done" : ""}" data-check="${h.id}" data-person="${row.personId}" data-day="${day}" data-val="${!c?.done}" aria-pressed="${!!c?.done}">
        <span class="tick">${c?.done ? "✓" : ""}</span>${esc(h.name)}</button>`; }).join("")}</div></div>`;
  };
  const isThisWeek = b.week.start <= b.today && b.today <= b.week.end;
  const fines = (r: BoardRow) => r.balanceCents ? `<span class="chip OVERDUE">deve ${money(r.balanceCents)}</span>` : `<span class="chip SETTLED">sem multa</span>`;
  const kindLabel: Record<string, string> = { HABIT_MISS: "Não fez", INFRACTION: "Ocorrência", PAYMENT: "Pagou multa", WAIVER: "Multa perdoada" };
  return `<p class="muted">Cada um marca os próprios hábitos (hoje e ontem). Dia que passa sem marcar vira falta. Tudo fica visível para a família, com quem marcou e a hora.</p>
  ${meRow && isThisWeek ? `<div class="card"><h3>Meus combinados</h3>${toggles(meRow, b.today, "Hoje")}${dayOf(meRow, yesterday) ? toggles(meRow, yesterday, "Ontem") : ""}</div>` : ""}
  <div class="weeknav"><button class="ghost sm" data-cbweek="-7" aria-label="Semana anterior">◀</button><b>${br(b.week.start)} a ${br(b.week.end)}</b>
    <button class="ghost sm" data-cbweek="7" aria-label="Próxima semana">▶</button>${cbDate !== today() ? `<button class="ghost sm" data-cbweek="0">Esta semana</button>` : ""}
    ${isGuardian() ? `<button class="sm" data-infraction style="margin-left:auto">Registrar ocorrência</button>` : ""}</div>
  <div class="podium">${b.rows.map(r => `<div class="rk${r.personId === b.mostConsistent ? " first" : ""}">
    <span class="pos">${r.personId === b.mostConsistent ? "Mais constante da semana" : `${r.fullDays} de ${r.daysCounted} dias completos`}</span>
    <span class="name">${esc(r.name)}${nick(r.nickname)}</span>
    <div class="week-grid">${r.grid.map(g => `<div><small>${["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(`${g.day}T12:00:00`).getDay()]}</small>${dots(g.habits, b.habits)}</div>`).join("")}</div>
    <span class="sub">${r.habitsDone} de ${r.habitsDue} hábitos · ${r.infractions} ocorrência(s) · −${r.pointsLost} pts</span>
    <span class="sub">Multas na semana: ${money(r.finesWeekCents)}</span>
    <div class="row">${fines(r)}${isAdmin() && r.balanceCents ? `<button class="ghost sm" data-settle="${r.personId}" data-bal="${r.balanceCents}">Quitar</button>` : ""}
      ${isGuardian() && r.personId !== me?.personId && isThisWeek ? `<button class="ghost sm" data-markfor="${r.personId}">Marcar por ${esc(r.name)}</button>` : ""}</div>
  </div>`).join("") || `<div class="empty">Cadastre as pessoas em Pessoas da casa.</div>`}</div>
  <div class="card"><h3>Registro da semana</h3>${b.entries.length ? `<ul class="pays">${b.entries.map(e => `<li>
    <span><b>${esc(e.personName)}</b> · ${kindLabel[e.kind]}: ${esc((e.note ?? "").replace(/^Não marcou: /, ""))}${e.by ? ` <span class="muted">(por ${esc(e.by)})</span>` : ""}</span>
    <span class="row"><span class="muted">${br(e.day)}</span>${e.amountCents ? `<span class="${e.kind === "PAYMENT" || e.kind === "WAIVER" ? "pos" : "neg"}">${money(e.amountCents)}</span>` : ""}${e.points ? `<span class="muted">−${e.points} pts</span>` : ""}
    ${isGuardian() && e.kind !== "HABIT_MISS" ? `<button class="danger sm" data-delentry="${e.id}">Excluir</button>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">Nada registrado nesta semana.</p>`}</div>
  <div class="card"><div class="row spread"><h3 style="margin:0">Regras</h3>${isAdmin() ? `<button class="ghost sm" data-newrule>+ Nova regra</button>` : ""}</div>
    <div class="scroll"><table><tr><th>Regra</th><th>Tipo</th><th>Pontos</th><th>Multa</th><th></th></tr>
    ${rules.map(r => `<tr><td>${esc(r.name)}${r.active ? "" : ` <span class="chip OVERDUE">pausada</span>`}</td><td>${r.kind === "HABIT" ? "Hábito diário" : "Ocorrência"}</td>
      <td>−${r.points}</td><td>${r.fineCents ? money(r.fineCents) : "—"}</td><td>${isAdmin() ? `<button class="ghost sm" data-editrule="${r.id}">Editar</button>` : ""}</td></tr>`).join("")}</table></div>
    <p class="muted">Hábito: multa por dia sem marcar. Ocorrência: multa a cada registro. Mudar o valor vale daqui em diante.</p></div>`;
}
function ruleForm(r?: Rule) {
  return `<div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(r?.name)}"></div>
    ${r ? "" : `<div class="full"><label>Tipo</label><select name="kind"><option value="HABIT">Hábito diário (cada um marca)</option><option value="INFRACTION">Ocorrência (responsável registra)</option></select></div>`}
    <div><label>Pontos perdidos</label><input name="pts" type="number" min="0" max="1000" value="${r?.points ?? 1}"></div>
    <div><label>Multa (R$)</label><input name="fine" inputmode="decimal" value="${r ? moneyInput(r.fineCents) : "0,00"}"></div>
    ${r ? `<label class="inline full"><input type="checkbox" name="active" ${r.active ? "checked" : ""}> Ativa</label>` : `<p class="muted full">Hábito novo começa a valer amanhã.</p>`}`;
}
async function editRule(id?: string) {
  const r = id ? (await api<Rule[]>("/conduct/rules")).find(x => x.id === id) : undefined;
  openDialog(r ? "Editar regra" : "Nova regra", ruleForm(r), "Salvar", async f => {
    const body = { name: str(f, "name"), points: Number(str(f, "pts") || 0), fineCents: centsOf(f, "fine", false) ?? 0 };
    if (r) await api(`/conduct/rules/${r.id}`, { method: "PATCH", body: { ...body, active: f.has("active") } });
    else await api("/conduct/rules", { method: "POST", body: { ...body, kind: str(f, "kind") } });
    toast("Regra salva.");
  });
}
async function infractionDialog() {
  const [rules, b] = await Promise.all([api<Rule[]>("/conduct/rules"), api<Board>("/conduct/board")]);
  openDialog("Registrar ocorrência", `
    <div class="full"><label>Quem</label><select name="p" required>${b.rows.map(r => `<option value="${r.personId}">${esc(r.name)}</option>`).join("")}</select></div>
    <div class="full"><label>O que aconteceu</label><select name="r" required>${rules.filter(r => r.kind === "INFRACTION" && r.active).map(r => `<option value="${r.id}">${esc(r.name)} (−${r.points} pts${r.fineCents ? `, ${money(r.fineCents)}` : ""})</option>`).join("")}</select></div>
    <div><label>Dia</label><input name="d" type="date" value="${today()}" max="${today()}"></div>
    <div><label>Observação</label><input name="n" maxlength="200" placeholder="opcional"></div>`, "Registrar", async f => {
    await api("/conduct/infractions", { method: "POST", body: { personId: str(f, "p"), ruleId: str(f, "r"), day: str(f, "d") || undefined, note: str(f, "n") || null } });
    toast("Ocorrência registrada.");
  });
}
async function markFor(personId: string) {
  const b = await api<Board>("/conduct/board"); const row = b.rows.find(r => r.personId === personId); if (!row) return;
  openDialog(`Marcar hábitos · ${row.name}`, `<p class="muted full">Como responsável, você pode marcar por quem esqueceu. Fica registrado que foi você.</p>
    <div class="full">${b.habits.map((h, i) => `<label class="inline"><input type="checkbox" name="h" value="${h.id}" ${dayOf(row, b.today)?.habits[i]?.done ? "checked" : ""}> ${esc(h.name)}</label>`).join("")}</div>
    <div class="full"><label>Dia</label><input name="d" type="date" value="${b.today}" max="${b.today}"></div>`, "Salvar", async f => {
    const sel = new Set(f.getAll("h").map(String)), day = str(f, "d") || b.today;
    for (const h of b.habits) await api("/conduct/checks", { method: "POST", body: { personId, ruleId: h.id, day, checked: sel.has(h.id) } });
    toast("Hábitos atualizados.");
  });
}
function settleDialog(personId: string, bal: number) {
  openDialog("Quitar multas", `<p class="muted full">Saldo de multas: <b>${money(bal)}</b></p>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(bal)}" required></div>
    <div><label>Como</label><select name="k"><option value="PAYMENT">Pagou</option><option value="WAIVER">Perdoar</option></select></div>
    <div class="full"><label>Observação</label><input name="n" maxlength="200" placeholder="opcional"></div>`, "Confirmar", async f => {
    await api("/conduct/settle", { method: "POST", body: { personId, kind: str(f, "k"), amountCents: centsOf(f, "v"), note: str(f, "n") || null } });
    toast("Saldo de multas atualizado.");
  });
}

/* ===================== Ranking ===================== */
interface RankRow { personId: string | null; name: string; nickname: string | null; totalCents: number; allCents: number; mandatoryCents: number; count: number; previousCents: number; topCategories: { category: string; cents: number }[]; }
interface Ranking { week: { start: string; end: string }; mandatoryCategories: string[]; totalCents: number; mandatoryCents: number; board: RankRow[];
  items: { titleId: string; counterparty: string; category: string; personName: string | null; amountCents: number; paidOn: string; mandatory: boolean; reviewed: boolean }[];
  history: { weekStart: string; byPerson: Record<string, number> }[]; }
const nick = (n: string | null) => (n ? `<span class="nick">${esc(n)}</span>` : "");

/** KPIs do Painel: quem mais e quem menos gastou na semana, SOMANDO os obrigatórios. */
function spendKpis(rk: Ranking) {
  const people = rk.board.filter(r => r.personId).sort((a, b) => b.allCents - a.allCents);
  if (people.length < 2) return "";
  const most = people[0]!, least = people[people.length - 1]!;
  const card = (label: string, r: RankRow, hero: boolean) => `<div class="card kpi${hero ? " hero" : ""}"><div class="l">${label}</div>
    <div class="v">${money(r.allCents)}</div><div class="who-line"><b>${esc(r.name)}</b>${nick(r.nickname)} · ${money(r.mandatoryCents)} obrigatório, ${money(r.totalCents)} fora</div></div>`;
  return `<div class="grid">${card("Quem mais gastou · semana", most, false)}${card("Quem menos gastou · semana", least, false)}</div>`;
}

let rkDate = today();
async function rankingPage() {
  if (getEntity() !== "personal") return `<div class="empty">O ranking é da família (entidade Pessoal).</div>`;
  const rk = await api<Ranking>(`/ranking?date=${rkDate}`);
  const board = rk.board.filter(r => r.personId || r.totalCents);
  const max = Math.max(1, ...board.map(r => r.totalCents));
  const delta = (r: RankRow) => {
    if (!r.previousCents && !r.totalCents) return "igual à semana passada";
    const d = r.totalCents - r.previousCents;
    return d === 0 ? "igual à semana passada" : `${d > 0 ? "↑" : "↓"} ${money(Math.abs(d))} vs. semana passada`;
  };
  const pos = (i: number, r: RankRow) => r.totalCents === 0 ? "Nada fora do obrigatório" : i === 0 ? "1º · quem mais gastou" : `${i + 1}º`;
  const hist = (pid: string | null) => pid ? `<div class="spark-weeks" title="Últimas 8 semanas">${rk.history.map(h => {
    const v = h.byPerson[pid] ?? 0, top = Math.max(1, ...rk.history.flatMap(x => Object.values(x.byPerson)));
    return `<i style="height:${Math.max(4, Math.round(v / top * 100))}%"></i>`; }).join("")}</div>` : "";
  return `<p class="muted">Quem mais gastou com o que <b>não era obrigatório</b>. Contas fixas e obrigatórias ficam de fora (categorias abaixo). Semana de segunda a domingo.</p>
  <div class="weeknav"><button class="ghost sm" data-rkweek="-7" aria-label="Semana anterior">◀</button>
    <b>${br(rk.week.start)} a ${br(rk.week.end)}</b>
    <button class="ghost sm" data-rkweek="7" aria-label="Próxima semana">▶</button>
    ${rkDate !== today() ? `<button class="ghost sm" data-rkweek="0">Esta semana</button>` : ""}</div>
  <div class="podium">${board.map((r, i) => `<div class="rk${i === 0 && r.totalCents ? " first" : ""}">
    <span class="pos">${pos(i, r)}</span>
    <span class="name">${esc(r.name)}${nick(r.nickname)}</span>
    <span class="val">${money(r.totalCents)}</span>
    <div class="bar"><i style="width:${Math.round(r.totalCents / max * 100)}%"></i></div>
    <span class="sub">${r.count} gasto(s) · ${delta(r)}</span>
    ${r.topCategories.length ? `<span class="sub">${r.topCategories.map(c => `${esc(c.category)} ${money(c.cents)}`).join(" · ")}</span>` : ""}
    <span class="sub">Com obrigatórios: ${money(r.allCents)}</span>
    ${hist(r.personId)}
  </div>`).join("") || `<div class="empty">Ninguém cadastrado em Pessoas da casa.</div>`}</div>
  <div class="card"><div class="row spread"><h3 style="margin:0">Gastos da semana</h3><span class="muted">fora do obrigatório: <b>${money(rk.totalCents)}</b> · obrigatório: ${money(rk.mandatoryCents)}</span></div>
    ${rk.items.length ? `<div class="scroll"><table><tr><th>Gasto</th><th>Valor</th><th>Pessoa</th><th>Classificação</th><th>Categoria</th><th>Data</th></tr>
    ${rk.items.map(i => `<tr><td>${esc(i.counterparty)}</td><td>${money(i.amountCents)}</td><td>${esc(i.personName ?? "Sem pessoa")}</td>
      <td>${isAdmin() ? `<button class="ghost sm" data-mand="${i.titleId}" data-val="${!i.mandatory}">${i.mandatory ? "Obrigatório" : "Não obrigatório"}${i.reviewed ? " ✓" : ""}</button>`
        : `<span class="chip ${i.mandatory ? "SETTLED" : "OPEN"}">${i.mandatory ? "Obrigatório" : "Não obrigatório"}</span>`}</td><td>${esc(i.category)}</td><td>${br(i.paidOn)}</td></tr>`).join("")}
    </table></div>` : `<p class="muted">Nenhum gasto pago nesta semana.</p>`}
    ${isAdmin() ? `<p class="muted">Toque na classificação para revisar (✓ = revisado por você).</p>` : ""}</div>
  <div class="card"><div class="row spread"><h3 style="margin:0">Categorias obrigatórias</h3>${isAdmin() ? `<button class="ghost sm" data-editcats>Alterar</button>` : ""}</div>
    <div class="cats" style="margin-top:10px">${rk.mandatoryCategories.map(c => `<span class="chip">${esc(c)}</span>`).join("")}</div></div>`;
}
function editCats(current: string[]) {
  openDialog("Categorias obrigatórias", `<p class="muted full">Gastos nessas categorias não entram no ranking.</p>
    <div class="full cats">${CATEGORIES.filter(c => c !== "RENDA").map(c => `<label class="inline"><input type="checkbox" name="c" value="${c}" ${current.includes(c) ? "checked" : ""}> ${c}</label>`).join("")}</div>`,
    "Salvar", async f => {
      await api("/settings/mandatory-categories", { method: "PUT", body: { categories: f.getAll("c").map(String) } });
      toast("Categorias atualizadas.");
    });
}

/* ===================== Usuários (administrador) ===================== */
interface UserRow { id: string; email: string; name: string; nickname: string | null; role: "ADMIN" | "MEMBER"; personId: string | null; isGuardian: boolean; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; }
let usersCache: UserRow[] = [];
async function usersSection() {
  usersCache = await root<UserRow[]>("/admin/users");
  return `<div class="row spread" style="margin-top:24px"><h2>Usuários</h2><button data-newuser>+ Novo usuário</button></div>
  <p class="muted">Cada pessoa entra com e-mail e senha. Você cria a conta com uma senha provisória; no primeiro acesso ela troca.</p>
  <div class="list">${usersCache.map(u => `<div class="item">
    <div class="head"><span class="who">${esc(u.name)}${nick(u.nickname)}</span><span class="chip">${u.role === "ADMIN" ? "Administrador" : u.isGuardian ? "Responsável" : "Membro"}</span></div>
    <div class="meta"><span class="muted">${esc(u.email)}</span>${u.active ? "" : `<span class="chip OVERDUE">desativado</span>`}
      ${u.mustChangePassword ? `<span class="chip NO_VALUE">senha provisória</span>` : ""}
      <span class="muted">último acesso: ${u.lastLoginAt ? br(u.lastLoginAt) : "nunca"}</span></div>
    ${u.id !== me?.id ? `<div class="actions"><button class="ghost sm" data-edituser="${u.id}">Editar</button><button class="ghost sm" data-resetuser="${u.id}">Nova senha</button>
      <button class="ghost sm" data-toggleuser="${u.id}" data-active="${u.active}">${u.active ? "Desativar" : "Reativar"}</button></div>` : ""}
  </div>`).join("")}</div>`;
}
function userForm(u?: UserRow) {
  return `<div class="full"><label>Nome</label><input name="name" required value="${esc(u?.name)}"></div>
    <div class="full"><label>E-mail</label><input name="email" type="email" required value="${esc(u?.email)}"></div>
    <div><label>Apelido</label><input name="nick" placeholder="ex.: Gastadora" value="${esc(u?.nickname)}"></div>
    <div><label>Perfil</label><select name="role"><option value="MEMBER" ${u?.role === "MEMBER" ? "selected" : ""}>Membro</option><option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Administrador</option></select></div>
    <label class="inline full"><input type="checkbox" name="guard" ${u?.isGuardian ? "checked" : ""}> Responsável (registra ocorrências e corrige hábitos)</label>
    <div class="full"><label>É quem em Pessoas da casa</label><select name="person"><option value="">—</option>${people.map(p => `<option value="${p.id}" ${u?.personId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    ${u ? "" : `<div class="full"><label>Senha provisória (mín. 10 caracteres)</label><input name="pw" type="text" minlength="10" required autocomplete="off"></div>`}`;
}
function newUser() {
  openDialog("Novo usuário", userForm(), "Criar", async f => {
    await root("/admin/users", { method: "POST", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard"), password: str(f, "pw") } });
    toast("Usuário criado. Passe a senha provisória pessoalmente.");
  });
}
function editUser(id: string) {
  const u = usersCache.find(x => x.id === id); if (!u) return;
  openDialog("Editar usuário", userForm(u), "Salvar", async f => {
    await root(`/admin/users/${id}`, { method: "PATCH", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard") } });
    toast("Usuário alterado.");
  });
}
function resetUser(id: string) {
  const u = usersCache.find(x => x.id === id); if (!u) return;
  openDialog(`Nova senha · ${u.name}`, `<div class="full"><label>Senha provisória (mín. 10 caracteres)</label><input name="pw" type="text" minlength="10" required autocomplete="off"></div>
    <p class="muted full">A pessoa sai de todos os aparelhos e troca a senha no próximo acesso.</p>`, "Definir", async f => {
    await root(`/admin/users/${id}`, { method: "PATCH", body: { password: str(f, "pw") } });
    toast("Senha provisória definida.");
  });
}

/* ===================== Sessão: login, senha, sair ===================== */
function changePassword(forced: boolean) {
  openDialog(forced ? "Crie sua senha" : "Trocar senha", `${forced ? `<p class="muted full">Primeiro acesso: troque a senha provisória por uma só sua.</p>` : ""}
    <div class="full"><label>Senha atual</label><input name="cur" type="password" autocomplete="current-password" required></div>
    <div class="full"><label>Nova senha (mín. 10 caracteres)</label><input name="nxt" type="password" autocomplete="new-password" minlength="10" required></div>
    <div class="full"><label>Repita a nova senha</label><input name="nxt2" type="password" autocomplete="new-password" required></div>`, "Salvar", async f => {
    if (str(f, "nxt") !== str(f, "nxt2")) throw new ApiError(400, "MISMATCH", "As senhas novas não conferem.");
    await root("/auth/password", { method: "POST", body: { current: str(f, "cur"), next: str(f, "nxt") } });
    if (me) me.mustChangePassword = false;
    toast("Senha alterada. Os outros aparelhos foram desconectados.");
  });
  if (forced) dlgForm.querySelector<HTMLElement>("[data-close]")!.hidden = true;
}
function renderMe() {
  $("#me").innerHTML = me ? `<div><b>${esc(me.name)}</b>${me.nickname ? ` <small>· ${esc(me.nickname)}</small>` : ""}<br><small>${me.role === "ADMIN" ? "Administrador" : me.isGuardian ? "Responsável" : "Membro"}</small></div>
    <div class="row"><button data-act="password">Trocar senha</button><button data-act="logout">Sair</button></div>` : "";
  entSel.hidden = !isAdmin();
  if (!isAdmin() && getEntity() !== "personal") { setEntity("personal"); entSel.value = "personal"; }
}
function showLogin() {
  me = null; document.documentElement.dataset.auth = "out"; dlg.close();
  root<{ needed: boolean }>("/auth/setup").then(r => {
    $("#setup-form").hidden = !r.needed; $("#login-form").hidden = r.needed;
    $<HTMLInputElement>(r.needed ? "#st-token" : "#lg-email").focus();
  }).catch(e => {
    // Banco desconectado ou servidor fora do ar: diz o motivo em vez de mostrar um login que não vai funcionar.
    $("#login-err").textContent = e instanceof ApiError ? e.message : "Servidor indisponível. Tente de novo em instantes.";
    $<HTMLInputElement>("#lg-email").focus();
  });
}
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement, f = new FormData(form), err = $("#setup-err"), btn = form.querySelector("button")!;
  err.textContent = "";
  if (String(f.get("password")) !== String(f.get("password2"))) { err.textContent = "As senhas não conferem."; return; }
  btn.disabled = true;
  try {
    const u = await root<Me>("/auth/setup", { method: "POST", body: { token: String(f.get("token")), name: str(f, "name"), email: str(f, "email"), password: String(f.get("password")) } });
    form.reset(); $("#setup-form").hidden = true; $("#login-form").hidden = false; await enter(u);
    toast("Sistema instalado. Cadastre as pessoas da casa e os usuários.");
  } catch (x) { err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor."; }
  finally { btn.disabled = false; }
});
async function enter(user: Me) {
  me = user; document.documentElement.dataset.auth = "in";
  renderMe(); await render();
  if (me.mustChangePassword) changePassword(true);
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement), err = $("#login-err"), btn = (e.target as HTMLFormElement).querySelector("button")!;
  err.textContent = ""; btn.disabled = true;
  try { await enter(await root<Me>("/auth/login", { method: "POST", body: { email: str(f, "email"), password: String(f.get("password") ?? "") } })); (e.target as HTMLFormElement).reset(); }
  catch (x) { err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor."; }
  finally { btn.disabled = false; }
});
$("#me").addEventListener("click", async e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (a === "password") changePassword(false);
  if (a === "logout") { await root("/auth/logout", { method: "POST" }).catch(() => {}); showLogin(); }
});
window.addEventListener("nf:unauthenticated", showLogin);
// Botão "voltar" do celular e links com #: troca de tela pelo endereço.
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1) as Tab;
  if (t in renderers && t !== tab && me) { tab = t; menu(false); scrollTo(0, 0); render(); }
});

/* ===================== Eventos (delegação) ===================== */
view.addEventListener("click", async e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  const d = b.dataset;
  try {
    if (d.new) newTitle(d.new as Kind);
    else if (d.edit) await editTitle(d.edit);
    else if (d.pay) await payTitle(d.pay);
    else if (d.pays) await showPays(d.pays);
    else if (d.pedit) editPay(d.pedit, Number(d.amt), d.dt!);
    else if (d.pdel) { if (confirm("Excluir este pagamento? O saldo volta a ficar em aberto.")) { await api(`/settlements/${d.pdel}`, { method: "DELETE" }); toast("Pagamento excluído."); await render(); } }
    else if (d.del) { if (confirm("Excluir esta conta? Ela some das listas (fica no histórico).")) { await api(`/titles/${d.del}`, { method: "DELETE" }); toast("Conta excluída."); await render(); } }
    else if (d.filter) { statusFilter = d.filter as typeof statusFilter; await render(); }
    else if (d.proj) { projMonths = Number(d.proj); await render(); }
    else if (d.newrec !== undefined) newRec();
    else if (d.newperson !== undefined) newPerson();
    else if (d.goto) { tab = d.goto as Tab; history.pushState(null, "", `#${tab}`); scrollTo(0, 0); await render(); }
    else if (d.check) { await api("/conduct/checks", { method: "POST", body: { personId: d.person, ruleId: d.check, day: d.day, checked: d.val === "true" } }); await render(); }
    else if (d.cbweek !== undefined) { const n = Number(d.cbweek); if (n === 0) cbDate = today(); else { const x = new Date(`${cbDate}T12:00:00`); x.setDate(x.getDate() + n); cbDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.infraction !== undefined) await infractionDialog();
    else if (d.markfor) await markFor(d.markfor);
    else if (d.settle) settleDialog(d.settle, Number(d.bal));
    else if (d.delentry) { if (confirm("Excluir este registro? Os pontos e a multa voltam.")) { await api(`/conduct/entries/${d.delentry}`, { method: "DELETE" }); toast("Registro excluído."); await render(); } }
    else if (d.newrule !== undefined) await editRule();
    else if (d.editrule) await editRule(d.editrule);
    else if (d.rkweek !== undefined) { const n = Number(d.rkweek); if (n === 0) rkDate = today(); else { const x = new Date(`${rkDate}T12:00:00`); x.setDate(x.getDate() + n); rkDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.mand) { await api(`/titles/${d.mand}`, { method: "PATCH", body: { mandatory: d.val === "true" } }); toast("Classificação revisada."); await render(); }
    else if (d.editcats !== undefined) editCats((await api<string[]>("/settings/mandatory-categories")));
    else if (d.newuser !== undefined) newUser();
    else if (d.edituser) editUser(d.edituser);
    else if (d.resetuser) resetUser(d.resetuser);
    else if (d.toggleuser) { await root(`/admin/users/${d.toggleuser}`, { method: "PATCH", body: { active: d.active !== "true" } }); toast(d.active === "true" ? "Usuário desativado." : "Usuário reativado."); await render(); }
    else if (d.editperson) editPerson(d.editperson);
    else if (d.toggleperson) { await api(`/people/${d.toggleperson}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
    else if (d.seeperson) { personFilter = d.seeperson; statusFilter = "all"; tab = "pagar"; history.replaceState(null, "", "#pagar"); await render(); }
    else if (d.editrec) await editRec(d.editrec);
    else if (d.togglerec) { await api(`/recurrences/${d.togglerec}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
  } catch (err) { fail(err); }
});
view.addEventListener("submit", async e => {
  const form = e.target as HTMLFormElement;
  e.preventDefault();
  try {
    if (form.id === "quick") {
      const f = new FormData(form);
      const r = await api<{ guard: { allowed: boolean; message: string } }>("/expenses/quick", { method: "POST", body: {
        amountCents: centsOf(f, "v"), description: str(f, "d"), category: str(f, "c"), date: str(f, "dt") || undefined, personId: str(f, "person") || null } });
      toast(r.guard.allowed ? "Gasto registrado." : `Registrado com aviso: ${r.guard.message}`, !r.guard.allowed);
      await render();
    } else if (form.id === "ext") {
      const f = new FormData(form); extFrom = str(f, "from") || extFrom; extTo = str(f, "to") || extTo;
      if (extFrom > extTo) [extFrom, extTo] = [extTo, extFrom];
      await render();
    } else if (form.id === "sim") await runSim(form);
    else if (form.id === "pmonth") { peopleMonth = str(new FormData(form), "m") || peopleMonth; await render(); }
  } catch (err) { fail(err); }
});

/* ===================== Aparência: paleta + tema ===================== */
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem storage */ } } };
const darkMq = matchMedia("(prefers-color-scheme: dark)");
const modeSel = $<HTMLSelectElement>("#mode");
function applyLook() {
  const palette = store.get("palette") ?? "verde", mode = store.get("mode") ?? "auto";
  const root = document.documentElement;
  root.dataset.palette = palette;
  root.dataset.mode = mode === "dark" || (mode === "auto" && darkMq.matches) ? "dark" : "light";
  modeSel.value = mode;
  document.querySelectorAll<HTMLButtonElement>(".palettes button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.palette === palette)));
}
$(".palettes").addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-palette]");
  if (b) { store.set("palette", b.dataset.palette!); applyLook(); }
});
modeSel.addEventListener("change", () => { store.set("mode", modeSel.value); applyLook(); });
darkMq.addEventListener("change", applyLook);
applyLook();

view.addEventListener("change", e => {
  const el = e.target as HTMLSelectElement;
  if (el.id === "pfilter") { personFilter = el.value; render(); }
});

root<Me>("/auth/me").then(enter).catch(showLogin);
