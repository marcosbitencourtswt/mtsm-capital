import { api, root, ApiError, getEntity, setEntity, type Title, type Recurrence, type Kind, type Settlement, type Person, type Me } from "./api.js";
import qrcode from "qrcode-generator";
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
  "DELIVERY", "RESTAURANTE", "LAZER", "ROUPAS", "BELEZA", "PRESENTES", "ASSINATURAS", "DIVIDA", "CARTAO", "MESADA", "IMPOSTOS", "PRO_LABORE", "RENDA", "VENDAS", "SERVICOS", "OUTROS"];

/* Usuário logado */
let me: Me | null = null;
const isAdmin = () => me?.role === "ADMIN";
const isGuardian = () => isAdmin() || !!me?.isGuardian;
const isRoot = () => !!me?.isRoot;
const mine = (createdBy: string | null | undefined) => isAdmin() || (!!createdBy && createdBy === me?.id);
/** Código fica igual por dentro (dados não mudam); a tela mostra o nome legível. */
const CAT_LABEL: Record<string, string> = { ALIMENTACAO: "Alimentação", MORADIA: "Moradia", AGUA: "Água", LUZ: "Luz", INTERNET: "Internet", FIXO: "Fixo",
  TRANSPORTE: "Transporte", SAUDE: "Saúde", EDUCACAO: "Educação", DELIVERY: "Delivery", RESTAURANTE: "Restaurante", LAZER: "Lazer", ROUPAS: "Roupas",
  BELEZA: "Beleza", PRESENTES: "Presentes", ASSINATURAS: "Assinaturas", DIVIDA: "Dívida", CARTAO: "Cartão", MESADA: "Mesada", IMPOSTOS: "Impostos",
  PRO_LABORE: "Pró-labore", RENDA: "Renda", VENDAS: "Vendas", SERVICOS: "Serviços", OUTROS: "Outros" };
const catLabel = (c: string) => CAT_LABEL[c] ?? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ");
const catOptions = (sel?: string) => [...CATEGORIES, ...(sel && !CATEGORIES.includes(sel) ? [sel] : [])]
  .map(c => `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(catLabel(c))}</option>`).join("");

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
type Tab = "painel" | "admin" | "bancos" | "combinados" | "pedidos" | "ranking" | "pagar" | "receber" | "pessoas" | "extrato" | "futuro" | "config";
let tab: Tab = (location.hash.slice(1) as Tab) || "painel";
const renderers: Record<Tab, () => Promise<string>> = { painel, admin: adminPage, bancos: bancosPage, combinados: combinadosPage, pedidos: pedidosPage, ranking: rankingPage, pagar: () => titles("PAYABLE"), receber: () => titles("RECEIVABLE"), pessoas, extrato, futuro, config };
const TITLES: Record<Tab, string> = { painel: "Painel", admin: "Administração", bancos: "Bancos e dívidas", combinados: "Combinados", pedidos: "Pedidos de compra", ranking: "Ranking da semana", pagar: "Contas a pagar", receber: "Contas a receber", pessoas: "Pessoas da casa", extrato: "Extrato", futuro: "Futuro", config: "Ajustes" };
const side = $("#side"), scrim = $("#scrim");
const menu = (open: boolean) => { side.classList.toggle("open", open); scrim.classList.toggle("open", open); };
$("#menu-btn").addEventListener("click", () => menu(true));
scrim.addEventListener("click", () => menu(false));

async function render() {
  if (me?.conductOnly && tab !== "combinados" && tab !== "pedidos") tab = "combinados";
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  if (moreBox.querySelector(`[data-tab="${tab}"]`)) setMore(true);
  $("#page-title").textContent = TITLES[tab]; document.title = `${TITLES[tab]} · NOFINANCE`;
  try { await loadPeople(); view.innerHTML = await renderers[tab](); }
  catch (e) { view.innerHTML = `<div class="alert danger">${esc(e instanceof ApiError ? e.message : "Sem conexão com a API. Confira se o npm run dev está rodando.")}</div>`; }
}
/** "Mais": telas menos usadas ficam recolhidas; abrem sozinhas se a tela atual estiver lá. */
const moreBtn = $<HTMLButtonElement>("#more-btn"), moreBox = $("#more-tabs");
const setMore = (open: boolean) => { moreBox.hidden = !open; moreBtn.setAttribute("aria-expanded", String(open)); moreBtn.classList.toggle("open", open); };
moreBtn.addEventListener("click", () => setMore(moreBox.hidden));
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
  const [d, rk, cb, accs] = await Promise.all([api<Dashboard>("/dashboard"), personal ? api<Ranking>("/ranking") : Promise.resolve(null),
    personal ? api<Board>("/conduct/board").catch(() => null) : Promise.resolve(null), api<Acc[]>("/accounts").catch(() => [] as Acc[])]);
  const ds = personal ? await api<DebtSummary>("/debts/summary").catch(() => null) : null;
  pendingCache = personal && isGuardian() ? await api<Pending[]>("/conduct/pending").catch(() => []) : [];
  budgetCache = await api<Budget>("/budget").catch(() => null);
  const waitingReq = personal && isGuardian() ? (await api<PReq[]>("/requests").catch(() => [] as PReq[])).filter(r => r.status === "PENDING" && r.requestedBy !== me?.id) : [];
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
  ${pendingCard(pendingCache)}
  ${ds ? debtBoard(ds) : ""}
  ${budgetCard(budgetCache)}
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
      ${personSelect(me?.personId)}
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
      <span class="chip ${t.status}">${STATUS[t.status]}</span><span class="chip">${NATURE[t.nature]}</span><span class="chip">${esc(catLabel(t.category))}</span>
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
  // Dívidas e faturas de cartão se cadastram em "Bancos e dívidas" (um lugar só). Aqui, só edição das antigas.
  const natures = kind === "PAYABLE" ? (t ? ["EXPENSE", "DEBT", "CARD"] : ["EXPENSE"]) : ["INCOME", "LOAN_IN"];
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
    ${isNew && kind === "PAYABLE" ? `<p class="muted full">Dívida, empréstimo ou cartão? Cadastre em <b>Bancos e dívidas</b>: lá o sistema gera as parcelas, a fatura e a ordem de pagamento.</p>` : ""}
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
  const [t, accs] = await Promise.all([api<Title>(`/titles/${id}`), api<Acc[]>("/accounts").catch(() => [] as Acc[])]);
  const cashAccs = accs.filter(a => a.active && isCashAcc(a.type));
  const cards = t.kind === "PAYABLE" && t.nature === "EXPENSE" ? accs.filter(a => a.active && a.type === "CARD") : [];
  const key = crypto.randomUUID(); // evita duplicar com duplo toque
  const verb = t.kind === "PAYABLE" ? "Pagar" : "Receber";
  openDialog(`${verb}: ${t.counterparty}`, `
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${t.openCents > 0 ? moneyInput(t.openCents) : ""}" required></div>
    <div><label>Data</label><input name="dt" type="date" value="${today()}"></div>
    ${t.kind === "PAYABLE" ? `<div class="full"><label>Pago com</label><select name="m"><option value="ACCOUNT">Conta / Pix / dinheiro</option>${cards.map(a => `<option value="card:${a.id}">Cartão ${esc(a.institution ?? "")} ${esc(a.name)} (${esc(a.ownerName)}) · vai para a fatura</option>`).join("")}</select></div>` : ""}
    <div class="full"><label>${t.kind === "PAYABLE" ? "Saiu de qual conta" : "Entrou em qual conta"} (opcional)</label><select name="acc"><option value="">Não informar</option>
      ${cashAccs.map(a => `<option value="${a.id}">${esc(a.ownerName)} · ${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("")}</select></div>
    <div class="full"><label>Observação</label><input name="notes"></div>
    ${t.kind === "PAYABLE" ? `<label class="inline full"><input type="checkbox" name="disc"> Paguei menos e quitei (antecipei ou negociei)</label>
      <div class="full saving" data-saving hidden>Valor da dívida <b>${money(t.openCents)}</b> → pago <b data-paid></b> → <span class="pos">economia <b data-save></b></span></div>` : ""}
    <p class="muted full">Em aberto: ${money(t.openCents)}</p>`, verb, async f => {
    const r = await api<Title>(`/titles/${id}/settlements`, { method: "POST", headers: { "idempotency-key": key },
      body: { amountCents: centsOf(f, "v"), paidOn: str(f, "dt") || undefined, ...(str(f, "m").startsWith("card:") ? { cardAccountId: str(f, "m").slice(5) } : { method: "ACCOUNT", accountId: str(f, "acc") || null }), notes: str(f, "notes") || null, ...(f.has("disc") ? { discountRest: true } : {}) } });
    const w = r.settlements?.find(s => s.method !== "DISCOUNT" && s.warnings.length)?.warnings ?? [];
    const saved = f.has("disc") ? t.openCents - (centsOf(f, "v") ?? t.openCents) : 0;
    toast(w.length ? `Registrado com aviso: ${w.join("; ")}` : saved > 0 ? `Quitado. Economia de ${money(saved)}.` : "Registrado.", w.length > 0);
  });
  // "Devia X → paguei Y → economizei Z", calculado enquanto digita.
  const box = dlgForm.querySelector<HTMLElement>("[data-saving]");
  if (box) {
    const v = dlgForm.querySelector<HTMLInputElement>("input[name=v]")!, disc = dlgForm.querySelector<HTMLInputElement>("input[name=disc]")!;
    const upd = () => {
      const paid = parseMoney(v.value), ok = disc.checked && Number.isFinite(paid) && paid > 0 && paid < t.openCents;
      box.hidden = !ok;
      if (ok) { box.querySelector("[data-paid]")!.textContent = money(paid); box.querySelector("[data-save]")!.textContent = money(t.openCents - paid); }
    };
    v.addEventListener("input", upd); disc.addEventListener("change", () => { if (disc.checked && parseMoney(v.value) >= t.openCents) v.select(); upd(); });
  }
}

async function showPays(id: string) {
  const box = $(`[data-pays-box="${id}"]`);
  if (box.innerHTML) { box.innerHTML = ""; return; }
  const t = await api<Title>(`/titles/${id}`);
  box.innerHTML = `<ul class="pays">${(t.settlements ?? []).map((s: Settlement) => `<li>
    <span>${br(s.paidOn)} · ${money(s.amountCents)}${s.method === "CARD" ? " · cartão" : s.method === "DISCOUNT" ? " · desconto" : ""}${s.warnings.length ? ` <span class="chip OVERDUE">aviso</span>` : ""}</span>
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
  const y = Number(today().slice(0, 4));
  const isYear = (yy: number) => extFrom === `${yy}-01` && extTo === `${yy}-12`;
  const n = st.months.length || 1;
  return `<h2>Extrato realizado</h2>
  <div class="row" style="margin-bottom:12px">${[y, y - 1, y - 2].map(yy => `<button class="${isYear(yy) ? "" : "ghost"} sm" data-extyear="${yy}">Ano ${yy}</button>`).join("")}
    <button class="ghost sm" data-extyear="last6">Últimos 6 meses</button></div>
  <form class="card form" id="ext">
    <div><label>De</label><input type="month" name="from" value="${extFrom}"></div>
    <div><label>Até</label><input type="month" name="to" value="${extTo}"></div>
    <div><button>Ver</button></div>
  </form>
  <div class="card scroll"><table>
    <tr><th>Mês</th><th>Receitas</th><th>Despesas</th><th>Juros pagos</th><th>Amortização</th><th>Empréstimos</th><th>Resultado</th><th>Caixa</th></tr>
    ${st.months.map(m => `<tr><td>${monthLabel(m.month)}</td>${cell(m.incomeCents)}${cell(m.expenseCents)}${cell(m.interestPaidCents)}${cell(m.amortizationCents)}${cell(m.loansInCents)}${cell(m.resultCents, true)}${cell(m.cashBalanceCents, true)}</tr>`).join("")}
    ${st.months.length > 1 ? `<tr><td class="muted">Média/mês</td><td class="muted">${money(Math.round(tot("incomeCents") / n))}</td><td class="muted">${money(Math.round(tot("expenseCents") / n))}</td><td class="muted">${money(Math.round(tot("interestPaidCents") / n))}</td><td></td><td></td><td class="muted">${money(Math.round(tot("resultCents") / n))}</td><td></td></tr>` : ""}
    <tr><th>Total</th><th>${money(tot("incomeCents"))}</th><th>${money(tot("expenseCents"))}</th><th>${money(tot("interestPaidCents"))}</th><th>${money(tot("amortizationCents"))}</th><th>${money(tot("loansInCents"))}</th><th>${money(tot("resultCents"))}</th><th></th></tr>
  </table></div>
  <p class="muted">Despesa = contas pagas + juros. Devolver o valor emprestado é amortização (sai do caixa, não é despesa). Empréstimo recebido entra no caixa, mas não é receita.</p>`;
}

/* ===================== Futuro: projeção + simulador ===================== */
let projMonths = 12;
let simCache = "";
async function futuro() {
  const [p, recs] = await Promise.all([
    api<{ startingCashCents: number; months: { month: string; inCents: number; outCents: number; netCents: number; accumulatedCents: number; estimatedItems: number }[] }>(`/projection?months=${projMonths}`),
    api<Recurrence[]>("/recurrences").catch(() => [] as Recurrence[])]);
  // Sugestão a partir das contas automáticas ativas (nada de valor fixo no código).
  const sum = (k: Kind) => recs.filter(r => r.active && r.kind === k && r.defaultAmountCents).reduce((a, r) => a + (r.defaultAmountCents ?? 0), 0);
  const simInc = sum("RECEIVABLE") ? moneyInput(sum("RECEIVABLE")) : "", simFix = sum("PAYABLE") ? moneyInput(sum("PAYABLE")) : "";
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
      <div><label>Renda mensal líquida (R$)</label><input name="inc" inputmode="decimal" placeholder="quanto entra por mês" value="${simInc}" required></div>
      <div><label>Gastos fixos/mês (R$)</label><input name="fix" inputmode="decimal" placeholder="contas fixas do mês" value="${simFix}" required></div>
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
  const bForm = isGuardian() ? budgetForm(await api<Budget>("/budget")) : "";
  return `${await pushCard()}${bForm}<div class="card"><h3>Verificação em duas etapas</h3>
    ${me?.totpEnabled
      ? `<p><span class="chip SETTLED">Ativa</span> Ao entrar num aparelho novo, além da senha o sistema pede o código do app autenticador.</p>
         <div class="row"><button class="ghost sm" data-mfaoff>Desativar</button></div>`
      : `<p class="muted">Protege sua conta mesmo se alguém descobrir sua senha. Grátis: usa o Google Authenticator ou o Microsoft Authenticator no celular (sem SMS).</p>
         <div class="row"><button class="sm" data-mfaon>Ativar</button></div>`}</div>
  ${isAdmin() ? `<div class="card"><h3>Importar cadastro</h3>
    <p class="muted">Carga inicial de bancos, cartões e dívidas a partir do arquivo que o assistente gera com os seus prints. Antes de gravar, o sistema mostra a prévia. Importar o mesmo arquivo de novo não duplica.</p>
    <label class="inline"><input type="file" accept=".json,application/json" data-importfile style="position:absolute;width:1px;height:1px;opacity:0"><span class="btnlike">Escolher arquivo .json</span></label></div>` : ""}
  <div class="row spread"><h2>Contas automáticas</h2>${isAdmin() ? "<button data-newrec>+ Nova</button>" : ""}</div>
  <p class="muted">Geradas todo mês sozinhas (mês atual e próximo). Sem valor padrão, a conta nasce "sem valor" e o 1º pagamento define; o mês seguinte usa o último valor.</p>
  <div class="list">${recs.length ? recs.map(r => `<div class="item">
    <div class="head"><span class="who">${esc(r.description)}</span><span class="amt">${r.defaultAmountCents != null ? money(r.defaultAmountCents) : "varia"}</span></div>
    <div class="meta"><span class="chip">${r.kind === "PAYABLE" ? "A pagar" : "A receber"}</span><span class="chip">${esc(catLabel(r.category))}</span>
      ${r.personName ? `<span class="chip person">👤 ${esc(r.personName)}</span>` : ""}
      <span class="muted">dia ${r.dueDay ?? "—"} · desde ${br(r.startMonth).slice(3)}</span>${r.active ? "" : `<span class="chip OVERDUE">pausada</span>`}</div>
    ${isAdmin() ? `<div class="actions"><button class="ghost sm" data-editrec="${r.id}">Editar</button>
      <button class="ghost sm" data-togglerec="${r.id}" data-active="${r.active}">${r.active ? "Pausar" : "Reativar"}</button></div>` : ""}</div>`).join("")
    : `<div class="empty">Nenhuma. Cadastre aluguel, água, luz, internet e a renda.</div>`}</div>
  <h2 style="margin-top:20px">Avisos registrados</h2>
  <p class="muted">Nada é bloqueado. O que passou fora da regra fica aqui.</p>
  <div class="card">${warns.length ? `<ul class="pays">${warns.map(w => `<li><span>${br(w.paidOn)} · ${esc(w.counterparty)} · ${money(w.amountCents)}</span><span class="muted">${w.warnings.map(esc).join("; ")}</span></li>`).join("")}</ul>` : `<p class="muted">Nenhum aviso.</p>`}</div>
  <div class="row"><a href="/api/v1/${getEntity()}/export.csv"><button class="ghost">Exportar tudo (CSV para Excel)</button></a></div>
  ${isAdmin() ? `<p class="muted">Usuários, sessões e registro de alterações ficam em <button class="ghost sm" data-goto="admin">Administração</button>.</p>` : ""}`;
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
    ${p.byCategory.length ? `<div class="muted" style="margin-top:6px">${p.byCategory.slice(0, 5).map(c => `${esc(catLabel(c.category))} ${money(c.cents)}`).join(" · ")}</div>` : ""}
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
interface Item { ruleId: string; name: string; schedule: "DAILY" | "ROTATION" | "SPORADIC"; done: boolean; pending?: boolean; checkedAt: string | null; by: string | null; }
interface Pending { personId: string; personName: string; ruleId: string; ruleName: string; day: string; }
/** Card de aprovações para os responsáveis: o que a criança marcou e ainda não conta na nota. */
function pendingCard(list: Pending[]) {
  if (!list.length) return "";
  return `<div class="card pending-card"><div class="row spread"><h3 style="margin:0">Aguardando sua aprovação (${list.length})</h3></div>
    <ul class="imp">${list.map(p => `<li><div><b>${esc(p.personName)}</b> · ${esc(p.ruleName)} <span class="muted">· ${br(p.day)}</span></div>
      <div class="row"><button class="sm" data-review="${p.ruleId}" data-person="${p.personId}" data-day="${p.day}" data-val="true">Aprovar</button>
        <button class="ghost sm" data-review="${p.ruleId}" data-person="${p.personId}" data-day="${p.day}" data-val="false">Recusar</button></div></li>`).join("")}</ul>
    ${list.length > 1 ? `<div class="row"><button class="ghost sm" data-reviewall>Aprovar todos</button></div>` : ""}</div>`;
}
let pendingCache: Pending[] = [];
interface Score { due: number; done: number; penaltyPoints: number; percent: number; }
interface BoardRow { personId: string; name: string; nickname: string | null; hasLogin: boolean; grid: { day: string; items: Item[] }[]; fullDays: number; daysCounted: number;
  habitsDone: number; habitsDue: number; infractions: number; pointsLost: number; finesWeekCents: number; balanceCents: number; month: Score; }
interface Board { week: { start: string; end: string }; today: string; rows: BoardRow[]; mostConsistent: string | null;
  rotations: { ruleId: string; name: string; today: string | null; tomorrow: string | null }[];
  sporadic: { ruleId: string; name: string; people: { personId: string; name: string; activeToday: boolean }[] }[];
  entries: { id: string; personId: string; personName: string; kind: "HABIT_MISS" | "INFRACTION" | "PAYMENT" | "WAIVER"; ruleId: string | null; day: string; points: number; amountCents: number; note: string | null; by: string | null }[]; }
interface Rule { id: string; kind: "HABIT" | "INFRACTION"; name: string; points: number; fineCents: number; sort: number; active: boolean;
  schedule: "DAILY" | "ROTATION" | "SPORADIC"; description: string | null; assignees: { personId: string; position: number }[]; }
interface Allow { personId: string; name: string; nickname: string | null; mode: "MONEY" | "STARS" | "NONE"; baseCents: number; consequence: string | null; deductFines: boolean;
  due: number; done: number; penaltyPoints: number; percent: number; grossCents: number; finesBalanceCents: number; finesToDeductCents: number; payoutCents: number;
  stars: number; zeroed: boolean; closed: null | { percent: number; payoutCents: number; finesDeductedCents: number; stars: number; consequence: string | null }; }
interface AllowanceResp { month: string; inProgress: boolean; people: Allow[]; }

const SCHED: Record<string, string> = { DAILY: "Todo dia", ROTATION: "Revezamento", SPORADIC: "Avulsa" };
const dayOf = (r: BoardRow, day: string) => r.grid.find(g => g.day === day);
const dots = (items: Item[] | undefined) => items && items.length ? `<span class="dots" role="img" aria-label="${items.filter(c => c.done).length} de ${items.length} tarefas">${
  items.map(c => `<i class="${c.done ? "on" : c.pending ? "wait" : ""}" title="${esc(c.name)}${c.done ? " ✓" : c.pending ? " (aguardando aprovação)" : ""}"></i>`).join("")}</span>` : `<span class="muted">—</span>`;
const pctBar = (p: number) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p))}%;background:${p >= 70 ? "var(--success)" : p >= 40 ? "var(--warning)" : "var(--danger)"}"></i></div>`;
const fmtPct = (p: number) => `${p.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const stars = (n: number) => n ? `${"★".repeat(Math.min(n, 30))}${n > 30 ? ` +${n - 30}` : ""}` : "nenhuma ainda";

/** Painel: tarefas de hoje de todo mundo + cobrança para quem está logado. */
function todayCard(b: Board) {
  if (!b.rows.some(r => dayOf(r, b.today)?.items.length)) return "";
  const meRow = b.rows.find(r => r.personId === me?.personId);
  const missing = meRow ? (dayOf(meRow, b.today)?.items ?? []).filter(i => !i.done && !i.pending) : [];
  return `${missing.length ? `<div class="alert danger"><b>Seus combinados de hoje:</b> falta ${missing.map(h => esc(h.name)).join(", ")}.
      <button class="sm" data-goto="combinados">Marcar agora</button></div>` : ""}
    <div class="card"><div class="row spread"><h3 style="margin:0">Combinados de hoje</h3><button class="ghost sm" data-goto="combinados">Ver tudo</button></div>
    ${b.rotations.length ? `<p class="muted" style="margin:8px 0 0">${b.rotations.map(r => `${esc(r.name)}: <b>${esc(r.today ?? "—")}</b>`).join(" · ")}</p>` : ""}
    <div class="today-list">${b.rows.filter(r => dayOf(r, b.today)?.items.length).map(r => `<div><span>${esc(r.name)}${nick(r.nickname)}</span>${dots(dayOf(r, b.today)?.items)}</div>`).join("")}</div></div>`;
}

let cbDate = today();
let cbView = ""; // "" = família; senão id da pessoa
async function combinadosPage() {
  if (getEntity() !== "personal") return `<div class="empty">Os Combinados são da família (entidade Pessoal).</div>`;
  const [b, rules, al] = await Promise.all([api<Board>(`/conduct/board?date=${cbDate}`), api<Rule[]>("/conduct/rules"), api<AllowanceResp>("/conduct/allowance")]);
  if (!cbView && me?.personId && b.rows.some(r => r.personId === me!.personId) && !isGuardian()) cbView = me.personId;
  if (me?.conductOnly && cbView !== "" && cbView !== me.personId) cbView = me.personId ?? "";
  const pushTop = me?.conductOnly && !(await currentSub()) ? await pushCard() : "";
  const tabs = `<div class="person-tabs" role="tablist">
    <button role="tab" class="${cbView === "" ? "on" : ""}" data-cbperson="">Família</button>
    ${b.rows.filter(r => !me?.conductOnly || r.personId === me.personId).map(r => `<button role="tab" class="${cbView === r.personId ? "on" : ""}" data-cbperson="${r.personId}">${esc(r.name)}${r.personId === me?.personId ? " (eu)" : ""}</button>`).join("")}
    ${isAdmin() ? `<button role="tab" class="${cbView === "admin" ? "on" : ""}" data-cbperson="admin">Regras e mesadas</button>` : ""}</div>`;
  if (cbView === "admin" && isAdmin()) return tabs + await combinadosAdmin(rules, al);
  if (isGuardian()) { pendingCache = await api<Pending[]>("/conduct/pending").catch(() => []); if (cbView === "") return tabs + pendingCard(pendingCache) + familyView(b, al); }
  const row = b.rows.find(r => r.personId === cbView);
  return pushTop + tabs + (row ? personView(b, row, al.people.find(a => a.personId === row.personId)) : familyView(b, al));
}

function weekNav(b: Board) {
  return `<div class="weeknav"><button class="ghost sm" data-cbweek="-7" aria-label="Semana anterior">◀</button><b>${br(b.week.start)} a ${br(b.week.end)}</b>
    <button class="ghost sm" data-cbweek="7" aria-label="Próxima semana">▶</button>${cbDate !== today() ? `<button class="ghost sm" data-cbweek="0">Esta semana</button>` : ""}
    ${isGuardian() ? `<button class="sm" data-infraction style="margin-left:auto">Registrar ocorrência</button>` : ""}</div>`;
}
function rewardLine(a: Allow | undefined) {
  if (!a || a.mode === "NONE") return `<span class="muted">Participa da nota, sem mesada.</span>`;
  if (a.mode === "STARS") return `<span class="stars" aria-label="${a.stars} estrelas">${stars(a.stars)}</span>`;
  return `Previsão da mesada: <b>${money(a.payoutCents)}</b> <span class="muted">de ${money(a.baseCents)}${a.finesToDeductCents ? ` · −${money(a.finesToDeductCents)} de multas` : ""}</span>`;
}

function familyView(b: Board, al: AllowanceResp) {
  const kindLabel: Record<string, string> = { HABIT_MISS: "Não fez", INFRACTION: "Ocorrência", PAYMENT: "Pagou multa", WAIVER: "Multa perdoada" };
  return `${b.rotations.length ? `<div class="card"><h3>Revezamento</h3><div class="today-list">${b.rotations.map(r => `<div><span>${esc(r.name)}</span>
      <span>hoje <b>${esc(r.today ?? "—")}</b> · amanhã ${esc(r.tomorrow ?? "—")}</span></div>`).join("")}</div></div>` : ""}
  ${isGuardian() && b.sporadic.length ? `<div class="card"><h3>Tarefas avulsas de hoje</h3><div class="row">${b.sporadic.flatMap(s => s.people.map(p =>
      `<button class="${p.activeToday ? "" : "ghost"} sm" data-sporadic="${s.ruleId}" data-person="${p.personId}" data-val="${!p.activeToday}">${p.activeToday ? "✓ " : "+ "}${esc(s.name)} · ${esc(p.name)}</button>`)).join("")}</div>
      <p class="muted">Ative quando pedir a tarefa; a pessoa marca quando fizer.</p></div>` : ""}
  ${weekNav(b)}
  <div class="podium">${b.rows.map(r => { const a = al.people.find(x => x.personId === r.personId); return `<div class="rk${r.personId === b.mostConsistent ? " first" : ""}">
    <span class="pos">${r.personId === b.mostConsistent ? "Mais constante da semana" : `${r.fullDays} de ${r.daysCounted} dias completos`}</span>
    <span class="name">${esc(r.name)}${nick(r.nickname)}</span>
    <div class="row spread"><span class="sub">Nota do mês</span><b>${fmtPct(r.month.percent)}</b></div>${pctBar(r.month.percent)}
    <span class="sub">${rewardLine(a)}</span>
    <div class="week-grid">${r.grid.map(g => `<div><small>${["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(`${g.day}T12:00:00`).getDay()]}</small>${dots(g.items)}</div>`).join("")}</div>
    <div class="row">${r.balanceCents ? `<span class="chip OVERDUE">deve ${money(r.balanceCents)}</span>` : `<span class="chip SETTLED">sem multa</span>`}
      <button class="ghost sm" data-cbperson="${r.personId}">Abrir</button></div>
  </div>`; }).join("") || `<div class="empty">Cadastre as pessoas em Pessoas da casa.</div>`}</div>
  <div class="card"><h3>Registro da semana</h3>${b.entries.length ? `<ul class="pays">${b.entries.map(e => `<li>
    <span><b>${esc(e.personName)}</b> · ${kindLabel[e.kind]}: ${esc((e.note ?? "").replace(/^Não marcou: /, ""))}${e.by ? ` <span class="muted">(por ${esc(e.by)})</span>` : ""}</span>
    <span class="row"><span class="muted">${br(e.day)}</span>${e.amountCents ? `<span class="${e.kind === "PAYMENT" || e.kind === "WAIVER" ? "pos" : "neg"}">${money(e.amountCents)}</span>` : ""}${e.points ? `<span class="muted">−${e.points} pts</span>` : ""}
    ${isGuardian() && e.kind === "HABIT_MISS" && e.ruleId ? `<button class="ghost sm" data-blame="${e.ruleId}" data-person="${e.personId}" data-day="${e.day}">Apontar culpado</button>` : ""}
    ${isGuardian() && e.kind !== "HABIT_MISS" ? `<button class="danger sm" data-delentry="${e.id}">Excluir</button>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">Nada registrado nesta semana.</p>`}</div>`;
}

function personView(b: Board, r: BoardRow, a: Allow | undefined) {
  const self = r.personId === me?.personId, canMark = self || isGuardian();
  const yesterday = (() => { const x = new Date(`${b.today}T12:00:00`); x.setDate(x.getDate() - 1); return x.toLocaleDateString("sv-SE"); })();
  const toggles = (day: string, label: string) => {
    const items = dayOf(r, day)?.items ?? [];
    if (!items.length) return `<div class="habit-day"><span class="muted">${label}: nenhuma tarefa.</span></div>`;
    return `<div class="habit-day"><span class="muted">${label}</span><div class="habit-btns">${items.map(i => `<div class="habit-wrap">
      <button class="habit ${i.done ? "done" : i.pending ? "wait" : ""}" ${canMark ? "" : "disabled"} data-check="${i.ruleId}" data-person="${r.personId}" data-day="${day}"
        data-val="${i.pending ? String(isGuardian()) : String(!i.done)}" aria-pressed="${i.done}" ${i.pending ? `aria-label="${esc(i.name)}: aguardando aprovação"` : ""}>
        <span class="tick">${i.done ? "✓" : i.pending ? "⏳" : ""}</span><span>${esc(i.name)}${i.schedule !== "DAILY" ? `<small class="muted"> · ${SCHED[i.schedule]}</small>` : ""}</span></button>
      ${isGuardian() && !i.done ? `<button class="ghost sm" data-blame="${i.ruleId}" data-person="${r.personId}" data-day="${day}">Culpa de outro</button>` : ""}
      ${i.done && i.by ? `<small class="muted">marcado por ${esc(i.by)}</small>` : ""}
      ${i.pending ? (isGuardian() ? `<span class="row"><button class="sm" data-review="${i.ruleId}" data-person="${r.personId}" data-day="${day}" data-val="true">Aprovar</button>
        <button class="ghost sm" data-review="${i.ruleId}" data-person="${r.personId}" data-day="${day}" data-val="false">Recusar</button></span>`
        : `<small class="muted">aguardando aprovação de um responsável</small>`) : ""}</div>`).join("")}</div></div>`;
  };
  const m = r.month;
  const isThisWeek = b.week.start <= b.today && b.today <= b.week.end;
  return `<div class="card person-head${a?.mode === "STARS" ? " kid" : ""}">
    <div class="row spread"><div><span class="name" style="font:600 22px/28px var(--font-display)">${esc(r.name)}</span>${nick(r.nickname)}</div>
      ${r.balanceCents ? `<span class="chip OVERDUE">deve ${money(r.balanceCents)} em multas</span>` : ""}</div>
    <div class="grid" style="margin:12px 0 0">
      <div class="kpi"><div class="l">Nota do mês</div><div class="v">${fmtPct(m.percent)}</div>${pctBar(m.percent)}<div class="muted">${m.done} de ${m.due} feitas${m.penaltyPoints ? ` · −${m.penaltyPoints} por ocorrências` : ""}</div></div>
      <div class="kpi"><div class="l">${a?.mode === "STARS" ? "Estrelas do mês" : "Recompensa"}</div><div class="v" style="font-size:18px">${rewardLine(a)}</div>
        ${a?.zeroed && a.consequence ? `<div class="alert danger" style="margin:8px 0 0">Nota zerada: <b>${esc(a.consequence)}</b></div>` : a?.consequence ? `<div class="muted">Se zerar: ${esc(a.consequence)}</div>` : ""}</div>
    </div></div>
  ${isThisWeek ? `<div class="card"><h3>${self ? "Meus compromissos" : `Compromissos de ${esc(r.name)}`}</h3>${toggles(b.today, "Hoje")}${dayOf(r, yesterday) ? toggles(yesterday, "Ontem") : ""}
    ${!canMark ? `<p class="muted">Só ${esc(r.name)} e os responsáveis marcam.</p>` : ""}</div>` : ""}
  ${weekNav(b)}
  <div class="card scroll"><table><tr><th>Dia</th><th>Tarefas</th><th>Feitas</th></tr>
    ${r.grid.map(g => `<tr><td>${br(g.day)}</td><td>${dots(g.items)}</td><td>${g.items.filter(i => i.done).length}/${g.items.length}</td></tr>`).join("")}</table></div>`;
}

async function combinadosAdmin(rules: Rule[], al: AllowanceResp) {
  const names = new Map(people.map(p => [p.id, p.name]));
  const who = (r: Rule) => r.assignees.map(a => esc(names.get(a.personId) ?? "?")).join(r.schedule === "ROTATION" ? " → " : ", ") || `<span class="neg">ninguém</span>`;
  const month = al.month;
  return `<div class="card"><div class="row spread"><h3 style="margin:0">Modelo da família</h3><button class="ghost sm" data-template>Aplicar modelo</button></div>
      <p class="muted">Cria as 10 atividades combinadas (louça e casa em revezamento, quarto, irmã, escola, jantar, marmita, dormir, apoio na escola, pão), a trilha da Maria e as mesadas (Sara R$ 200, Thaís R$ 2.000, Maria estrelas). Não duplica o que já existe; tudo fica editável.</p></div>
    <div class="card"><div class="row spread"><h3 style="margin:0">Mesadas · ${monthLabel(month)}</h3><span class="muted">${al.inProgress ? "mês em andamento (prévia)" : "mês encerrado"}</span></div>
      <div class="scroll"><table><tr><th>Pessoa</th><th>Plano</th><th>Nota</th><th>Valor</th><th>Multas</th><th>A pagar</th><th></th></tr>
      ${al.people.map(a => `<tr><td>${esc(a.name)}</td><td>${a.mode === "MONEY" ? money(a.baseCents) : a.mode === "STARS" ? "Estrelas" : "Sem mesada"}</td>
        <td>${fmtPct(a.percent)}</td><td>${a.mode === "MONEY" ? money(a.grossCents) : a.mode === "STARS" ? `${a.stars} ★` : "—"}</td>
        <td>${a.finesToDeductCents ? `−${money(a.finesToDeductCents)}` : "—"}</td><td><b>${a.closed ? `${money(a.closed.payoutCents)} ✓` : a.mode === "MONEY" ? money(a.payoutCents) : "—"}</b></td>
        <td class="row"><button class="ghost sm" data-plan="${a.personId}">Plano</button>${a.closed ? `<span class="chip SETTLED">fechado</span>` : a.mode !== "NONE" ? `<button class="sm" data-close="${a.personId}" data-month="${month}">Fechar mês</button>` : ""}</td></tr>`).join("")}</table></div>
      <p class="muted">Mesada = valor × nota do mês (proporcional). Nota zero aplica a consequência. Ao fechar, a mesada vira conta a pagar (categoria MESADA) e as multas podem ser descontadas.</p></div>
    <div class="card"><div class="row spread"><h3 style="margin:0">Tarefas e ocorrências</h3><button class="ghost sm" data-newrule>+ Nova regra</button></div>
      <div class="scroll"><table><tr><th>Regra</th><th>Frequência</th><th>Quem</th><th>Pontos</th><th>Multa</th><th></th></tr>
      ${rules.map(r => `<tr><td>${esc(r.name)}${r.active ? "" : ` <span class="chip OVERDUE">pausada</span>`}</td><td>${r.kind === "HABIT" ? SCHED[r.schedule] : "Ocorrência"}</td>
        <td>${r.kind === "HABIT" ? who(r) : "quem causar"}</td><td>−${r.points}</td><td>${r.fineCents ? money(r.fineCents) : "—"}</td><td><button class="ghost sm" data-editrule="${r.id}">Editar</button></td></tr>`).join("")}</table></div>
      <p class="muted">Tarefa: multa por dia sem marcar. Ocorrência: multa a cada registro. Mudar valores vale daqui em diante.</p></div>`;
}

function ruleForm(r?: Rule) {
  const pos = new Map((r?.assignees ?? []).map(a => [a.personId, a.position]));
  return `<div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(r?.name)}"></div>
    ${r ? "" : `<div class="full"><label>Tipo</label><select name="kind"><option value="HABIT">Tarefa / hábito (a pessoa marca)</option><option value="INFRACTION">Ocorrência (responsável registra)</option></select></div>`}
    ${!r || r.kind === "HABIT" ? `<div class="full" data-habit><label>Frequência</label><select name="schedule">
      ${(["DAILY", "ROTATION", "SPORADIC"] as const).map(s => `<option value="${s}" ${r?.schedule === s ? "selected" : ""}>${s === "DAILY" ? "Todo dia (cada pessoa marcada)" : s === "ROTATION" ? "Revezamento diário (um por dia, na ordem)" : "Avulsa (responsável ativa no dia)"}</option>`).join("")}</select></div>
    <div class="full" data-habit><label>Quem faz (e a ordem do revezamento)</label><div class="assignees">${people.filter(p => p.active).map(p => `<label class="inline">
      <input type="checkbox" name="who" value="${p.id}" ${pos.has(p.id) ? "checked" : ""}> ${esc(p.name)}
      <input type="number" name="pos_${p.id}" min="1" max="20" value="${pos.get(p.id) ?? ""}" placeholder="ordem" style="width:72px;height:32px"></label>`).join("")}</div></div>` : ""}
    <div><label>Pontos perdidos</label><input name="pts" type="number" min="0" max="1000" value="${r?.points ?? 1}"></div>
    <div><label>Multa (R$)</label><input name="fine" inputmode="decimal" value="${r ? moneyInput(r.fineCents) : "0,00"}"></div>
    <div class="full"><label>Observação</label><input name="desc" maxlength="200" value="${esc(r?.description)}"></div>
    ${r ? `<label class="inline full"><input type="checkbox" name="active" ${r.active ? "checked" : ""}> Ativa</label>` : `<p class="muted full">Tarefa nova começa a valer amanhã.</p>`}`;
}
async function editRule(id?: string) {
  const r = id ? (await api<Rule[]>("/conduct/rules")).find(x => x.id === id) : undefined;
  openDialog(r ? "Editar regra" : "Nova regra", ruleForm(r), "Salvar", async f => {
    const who = f.getAll("who").map(String);
    const assignees = who.map((personId, i) => ({ personId, position: Number(str(f, `pos_${personId}`)) || i + 1 })).sort((a, b) => a.position - b.position);
    const body: Record<string, unknown> = { name: str(f, "name"), points: Number(str(f, "pts") || 0), fineCents: centsOf(f, "fine", false) ?? 0, description: str(f, "desc") || null };
    const isHabit = r ? r.kind === "HABIT" : str(f, "kind") === "HABIT";
    if (isHabit) Object.assign(body, { schedule: str(f, "schedule") || "DAILY", assignees });
    if (r) await api(`/conduct/rules/${r.id}`, { method: "PATCH", body: { ...body, active: f.has("active") } });
    else await api("/conduct/rules", { method: "POST", body: { ...body, kind: str(f, "kind") } });
    toast("Regra salva.");
  });
  const kindSel = dlgForm.querySelector<HTMLSelectElement>("select[name=kind]");
  const sync = () => dlgForm.querySelectorAll<HTMLElement>("[data-habit]").forEach(e => (e.hidden = !!kindSel && kindSel.value !== "HABIT"));
  kindSel?.addEventListener("change", sync); sync();
}
async function planDialog(personId: string) {
  const a = (await api<AllowanceResp>("/conduct/allowance")).people.find(x => x.personId === personId); if (!a) return;
  openDialog(`Recompensa · ${a.name}`, `
    <div class="full"><label>Tipo</label><select name="mode"><option value="MONEY" ${a.mode === "MONEY" ? "selected" : ""}>Mesada em dinheiro (proporcional à nota)</option>
      <option value="STARS" ${a.mode === "STARS" ? "selected" : ""}>Estrelas (crianças)</option><option value="NONE" ${a.mode === "NONE" ? "selected" : ""}>Só participa da nota</option></select></div>
    <div><label>Valor mensal (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(a.baseCents)}"></div>
    <div><label>Se a nota zerar</label><input name="cons" maxlength="120" placeholder="ex.: Sem celular" value="${esc(a.consequence)}"></div>
    <label class="inline full"><input type="checkbox" name="ded" ${a.deductFines ? "checked" : ""}> Descontar multas em aberto no fechamento</label>`, "Salvar", async f => {
    await api(`/conduct/allowance/plan/${personId}`, { method: "PUT", body: { mode: str(f, "mode"), amountCents: centsOf(f, "v", false) ?? 0, consequence: str(f, "cons") || null, deductFines: f.has("ded") } });
    toast("Plano salvo.");
  });
}
async function closeDialog(personId: string, month: string) {
  const al = await api<AllowanceResp>(`/conduct/allowance?month=${month}`); const a = al.people.find(x => x.personId === personId); if (!a) return;
  openDialog(`Fechar ${monthLabel(month)} · ${a.name}`, `
    <div class="full"><p>Nota: <b>${fmtPct(a.percent)}</b> (${a.done} de ${a.due} tarefas${a.penaltyPoints ? `, −${a.penaltyPoints} por ocorrências` : ""})</p>
      ${a.mode === "MONEY" ? `<p>Mesada: ${money(a.baseCents)} × ${fmtPct(a.percent)} = <b>${money(a.grossCents)}</b></p>
        <p>Multas em aberto: ${money(a.finesBalanceCents)}</p>` : `<p>Estrelas: <b>${a.stars}</b></p>`}
      ${a.zeroed && a.consequence ? `<div class="alert danger">Nota zerada: <b>${esc(a.consequence)}</b></div>` : ""}
      ${al.inProgress ? `<div class="alert">O mês ainda não acabou: os dias que faltam não entram.</div>` : ""}</div>
    ${a.mode === "MONEY" && a.finesBalanceCents ? `<label class="inline full"><input type="checkbox" name="ded" ${a.deductFines ? "checked" : ""}> Descontar multas (−${money(a.finesToDeductCents)})</label>` : ""}
    <p class="muted full">${a.mode === "MONEY" ? "A mesada vira uma conta a pagar (categoria MESADA) no nome da pessoa." : "Fica registrado no histórico."} Não dá para desfazer pelo app.</p>`, "Fechar mês", async f => {
    const r = await api<{ payoutCents: number; consequence: string | null }>("/conduct/allowance/close", { method: "POST", body: { personId, month, deductFines: f.has("ded") } });
    toast(r.consequence ? `Mês fechado. Consequência: ${r.consequence}` : `Mês fechado${r.payoutCents ? `: ${money(r.payoutCents)} em Contas a pagar` : ""}.`);
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
async function blameDialog(ruleId: string, fromPersonId: string, day: string) {
  const b = await api<Board>("/conduct/board"); const from = b.rows.find(r => r.personId === fromPersonId);
  openDialog("Apontar o culpado", `<p class="muted full">A tarefa de ${esc(from?.name ?? "")} em ${br(day)} não foi cumprida por causa de outra pessoa. ${esc(from?.name ?? "")} fica sem a falta; quem causou recebe a ocorrência com os pontos e a multa da tarefa.</p>
    <div class="full"><label>Quem causou</label><select name="to" required>${b.rows.filter(r => r.personId !== fromPersonId).map(r => `<option value="${r.personId}">${esc(r.name)}</option>`).join("")}</select></div>
    <div class="full"><label>O que aconteceu</label><input name="n" maxlength="200" placeholder="ex.: demorou para se arrumar"></div>`, "Confirmar", async f => {
    await api("/conduct/blame", { method: "POST", body: { ruleId, day, fromPersonId, toPersonId: str(f, "to"), note: str(f, "n") || null } });
    toast("Culpa transferida.");
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

/* ===================== Bancos e dívidas ===================== */
type AccType = "CHECKING" | "SAVINGS" | "INVESTMENT" | "CARD" | "LOAN" | "CASH";
interface Acc { id: string; type: AccType; name: string; institution: string | null; ownerPersonId: string | null; ownerName: string; active: boolean; notes: string | null;
  monthlyRateBp: number | null; rateSource: string | null; creditLimitCents: number | null; closingDay: number | null; dueDay: number | null;
  openingBalanceCents: number; openingDate: string; balanceCents: number | null; openCents: number; openCount: number; availableLimitCents: number | null;
  overdueCents: number; overdueCount: number; maxDaysOverdue: number; negativado: boolean; }
interface OwnerRow { personId: string | null; name: string; cashCents: number; savedCents: number; cardsOpenCents: number; cardsLimitFreeCents: number;
  debtCents: number; overdueCents: number; overdueCount: number; maxDaysOverdue: number; netWorthCents: number; }
interface Payoff { totalCents: number; unknownRates: number; monthlyInterestCents: number;
  owners: { name: string; openCents: number; monthlyInterestCents: number; overdueCount: number; negativados: number; unknownRates: number; count: number }[];
  items: { titleId: string; name: string; ownerName: string; nature: string; openCents: number; dueDate: string | null; negativado: boolean; monthlyInterestCents: number | null;
  daysOverdue: number; monthlyRateBp: number | null; institution: string | null; reasons: string[] }[]; }
const ACC_TYPE: Record<AccType, string> = { CHECKING: "Conta / carteira digital", SAVINGS: "Poupança / reserva", INVESTMENT: "Investimento", CARD: "Cartão de crédito", LOAN: "Empréstimo ou dívida (banco, loja ou pessoa)", CASH: "Dinheiro em espécie" };
const BANKS = ["Nubank", "Inter", "Itaú", "Bradesco", "Banco do Brasil", "Caixa", "Santander", "C6 Bank", "Mercado Pago", "PicPay", "PagBank", "Cora", "Neon", "Will Bank",
  "Banco Pan", "Sicoob", "Sicredi", "BTG", "XP", "Renner (Realize)", "Riachuelo", "C&A", "Magalu", "Casas Bahia", "Americanas", "Carrefour", "Atacadão", "Assaí"];
const isCashAcc = (t: AccType) => t === "CHECKING" || t === "SAVINGS" || t === "INVESTMENT" || t === "CASH";
const rateTxt = (bp: number | null) => (bp == null ? "juros não informado" : `${(bp / 100).toLocaleString("pt-BR")}% ao mês`);

let bkOwner = ""; // "" = todos; "none" = dos dois; id da pessoa
let bkStrategy: "juros" | "rapidas" | "nome" = "juros";
const STRATEGY = { juros: ["Menos juros", "Atrasados e depois os juros mais altos. Economiza mais dinheiro."],
  rapidas: ["Vitórias rápidas", "Menores primeiro. Fecha dívidas rápido e dá fôlego."],
  nome: ["Limpar o nome", "Negativadas e as atrasadas há mais tempo primeiro."] } as const;
/* ===================== Pedidos de compra ===================== */
interface PReq { id: string; description: string; amountCents: number; category: string; status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED"; reviewNote: string | null;
  createdAt: string; reviewedAt: string | null; requestedBy: string; requestedByName: string; forPersonId: string | null; forPersonName: string | null;
  accountId: string | null; accountLabel: string | null; paidAccountId: string | null; paidAccountLabel: string | null; reviewedByName: string | null; }
interface PSource { id: string; type: string; label: string; ownerName: string | null; }
const REQ_ST: Record<PReq["status"], string> = { PENDING: `<span class="chip NO_VALUE">aguardando</span>`, APPROVED: `<span class="chip SETTLED">aprovado</span>`,
  REJECTED: `<span class="chip OVERDUE">não aprovado</span>`, CANCELED: `<span class="chip">cancelado</span>` };
let reqPrefill: { d?: string; v?: number; c?: string } = {};
const srcLabel = (s: PSource) => `${s.type === "CARD" ? "Cartão " : ""}${esc(s.label)}${s.ownerName ? ` (${esc(s.ownerName)})` : ""}`;
async function pedidosPage() {
  if (getEntity() !== "personal") return `<div class="empty">Pedidos de compra são da família (entidade Pessoal).</div>`;
  const [list, src] = await Promise.all([api<PReq[]>("/requests"), api<PSource[]>("/requests/sources")]);
  const judge = isGuardian() && !me?.conductOnly;
  const toDecide = judge ? list.filter(r => r.status === "PENDING" && r.requestedBy !== me?.id) : [];
  const mine = list.filter(r => r.requestedBy === me?.id || !judge);
  const others = judge ? list.filter(r => r.requestedBy !== me?.id && r.status !== "PENDING").slice(0, 20) : [];
  const opts = (sel: string | null) => `<option value="">Escolha de onde sai</option>${src.map(s => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${srcLabel(s)}</option>`).join("")}`;
  const row = (r: PReq) => `<li><div class="row spread"><span><b>${esc(r.description)}</b> · ${money(r.amountCents)}</span>${REQ_ST[r.status]}</div>
    <div class="muted">${esc(r.requestedByName)}${r.forPersonName && r.forPersonName !== r.requestedByName ? ` para ${esc(r.forPersonName)}` : ""} · ${br(r.createdAt.slice(0, 10))}
      ${r.accountLabel ? ` · pediu pelo ${esc(r.accountLabel)}` : ""}${r.paidAccountLabel && r.status === "APPROVED" ? ` · saiu do ${esc(r.paidAccountLabel)}` : ""}</div>
    ${r.reviewNote ? `<div>${r.status === "REJECTED" ? "Motivo" : "Recado"}: <b>${esc(r.reviewNote)}</b>${r.reviewedByName ? ` <span class="muted">— ${esc(r.reviewedByName)}</span>` : ""}</div>` : ""}
    ${r.requestedBy === me?.id && r.status === "PENDING" ? `<div class="row"><button class="ghost sm" data-reqcancel="${r.id}">Cancelar pedido</button></div>` : ""}
    ${r.requestedBy === me?.id && r.status === "REJECTED" ? `<div class="row"><button class="ghost sm" data-reqagain="${r.id}">Pedir de novo</button></div>` : ""}</li>`;
  const decide = (r: PReq) => `<li><div><b>${esc(r.requestedByName)}</b>${r.forPersonName && r.forPersonName !== r.requestedByName ? ` (para ${esc(r.forPersonName)})` : ""} pede:
      <b>${esc(r.description)}</b> · <b>${money(r.amountCents)}</b> <span class="muted">· ${esc(catLabel(r.category))} · ${br(r.createdAt.slice(0, 10))}</span></div>
    <div class="st-grid"><select id="racc-${r.id}" aria-label="De onde sai">${opts(r.accountId)}</select><input id="rnote-${r.id}" placeholder="Recado (obrigatório se recusar)" maxlength="200"></div>
    <div class="row"><button class="sm" data-reqok="${r.id}">Aprovar e lançar</button><button class="ghost sm" data-reqno="${r.id}">Recusar</button></div></li>`;
  const p = reqPrefill; reqPrefill = {};
  return `<h2>Pedidos de compra</h2>
  ${toDecide.length ? `<div class="card pending-card"><h3>Aguardando sua decisão (${toDecide.length})</h3><ul class="imp">${toDecide.map(decide).join("")}</ul>
    <p class="muted">Aprovar lança o gasto na conta escolhida, em nome de quem vai usar. Sem saldo onde pediram? Troque a conta ou recuse com um recado.</p></div>` : ""}
  <div class="card"><h3>Pedir autorização</h3>
    <form class="form" id="req-f">
      <div class="full"><label>O que vai comprar</label><input name="d" required maxlength="120" placeholder="ex.: tênis da escola" value="${esc(p.d ?? "")}"></div>
      <div><label>Quanto (R$)</label><input name="v" inputmode="decimal" required placeholder="0,00" value="${p.v ? moneyInput(p.v) : ""}"></div>
      <div><label>Categoria</label><select name="c">${catOptions(p.c ?? "OUTROS")}</select></div>
      <div class="full"><label>De onde você sugere sair</label><select name="a">${opts(null)}</select></div>
      ${me?.conductOnly ? "" : `<div><label>Para quem</label><select name="person">${personOptions(me?.personId ?? null)}</select></div>`}
      <div class="full"><button>Pedir autorização</button></div>
    </form></div>
  <div class="card"><h3>${judge ? "Meus pedidos" : "Seus pedidos"}</h3>${mine.length ? `<ul class="imp">${mine.map(row).join("")}</ul>` : `<p class="muted">Nenhum pedido ainda.</p>`}</div>
  ${others.length ? `<div class="card"><h3>Decididos recentemente</h3><ul class="imp">${others.map(row).join("")}</ul></div>` : ""}`;
}


/* ===================== Orçamento ===================== */
interface Budget { month: string; monthElapsedPct: number; items: { category: string; limitCents: number; spentCents: number; leftCents: number; pct: number }[]; }
const SPEND_CATS = CATEGORIES.filter(c => !["RENDA", "VENDAS", "SERVICOS", "DIVIDA", "CARTAO", "IMPOSTOS", "PRO_LABORE"].includes(c));
let budgetCache: Budget | null = null;
function budgetCard(b: Budget | null) {
  if (!b || !b.items.length) return "";
  return `<div class="card"><div class="row spread"><h3 style="margin:0">Orçamento do mês</h3><span class="muted">${b.monthElapsedPct}% do mês passou</span></div>
    <ul class="imp">${b.items.map(i => `<li><div class="row spread"><b>${esc(catLabel(i.category))}</b><span class="${i.pct >= 100 ? "neg" : ""}">${money(i.spentCents)} de ${money(i.limitCents)}</span></div>
      <div class="bar budget ${i.pct >= 100 ? "over" : i.pct >= 80 ? "warn" : ""}" role="progressbar" aria-valuenow="${i.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(catLabel(i.category))}"><i style="width:${Math.min(100, i.pct)}%"></i></div>
      <div class="muted">${i.leftCents >= 0 ? `sobram ${money(i.leftCents)}` : `<span class="neg">passou ${money(-i.leftCents)}</span>`}${i.pct > b.monthElapsedPct + 10 && i.pct < 100 ? " · ritmo acima do mês" : ""}</div></li>`).join("")}</ul></div>`;
}
function budgetForm(b: Budget) {
  const lim = new Map(b.items.map(i => [i.category, i.limitCents]));
  return `<div class="card"><h3>Orçamento por categoria</h3>
    <p class="muted">Defina um teto mensal só nas categorias que quer vigiar (deixe vazio nas outras). O Painel mostra a barra e vocês dois recebem aviso ao passar de 80% e de 100%.</p>
    <form class="form" id="budget-f">${SPEND_CATS.map(c => `<div><label>${esc(catLabel(c))}</label><input name="b_${c}" inputmode="decimal" placeholder="sem teto" value="${lim.has(c) ? moneyInput(lim.get(c)!) : ""}"></div>`).join("")}
      <div class="full"><button>Salvar orçamento</button></div></form></div>`;
}

/* ===================== Painel de dívidas ===================== */
interface DebtRow { personId: string | null; name: string; owedCents: number; debtOpenCents: number; cardsOpenCents: number; paidCents: number; paidThisMonthCents: number;
  progressPct: number; count: number; overdueCount: number; overdueCents: number; negativados: number; monthlyInterestCents: number; unknownRates: number; savedCents: number; }
interface DebtSummary { owners: DebtRow[]; total: DebtRow; }
function debtBoard(d: DebtSummary) {
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

async function bancosPage() {
  const q = `?strategy=${bkStrategy}${bkOwner ? `&person=${bkOwner}` : ""}`;
  const [accs, ov, po, ds, trs] = await Promise.all([api<Acc[]>("/accounts"), api<{ people: OwnerRow[] }>("/overview"), api<Payoff>(`/payoff-order${q}`), api<DebtSummary>("/debts/summary"),
    api<Transfer[]>("/transfers?limit=20").catch(() => [] as Transfer[])]);
  trCache = trs;
  const owners = [{ id: "", name: "Todos" }, ...people.filter(p => p.active).map(p => ({ id: p.id, name: p.name })), { id: "none", name: "Dos dois / casa" }];
  const shown = accs.filter(a => a.active && (bkOwner === "" || (bkOwner === "none" ? !a.ownerPersonId : a.ownerPersonId === bkOwner)));
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
      ${a.negativado ? `<span class="chip OVERDUE">nome negativado</span>` : ""}</div>
    <div class="muted" style="margin-top:4px">${a.type === "CARD" ? `Limite ${a.creditLimitCents != null ? money(a.creditLimitCents) : "não informado"}${a.availableLimitCents != null ? ` · livre ${money(a.availableLimitCents)}` : ""}${a.closingDay ? ` · fecha dia ${a.closingDay}` : ""}${a.dueDay ? ` · vence dia ${a.dueDay}` : ""} · em aberto ${money(a.openCents)}`
      : a.type === "LOAN" ? `${a.openCount} parcela(s) em aberto · ${money(a.openCents)}`
      : `Saldo informado ${money(a.openingBalanceCents)} em ${br(a.openingDate)}`}${a.notes ? ` · ${esc(a.notes)}` : ""}</div>
    <div class="actions"><button class="ghost sm" data-editacc="${a.id}">Editar</button>
      ${a.type === "CARD" ? `<button class="ghost sm" data-bill="${a.id}">Nova fatura</button>` : ""}
      ${isCashAcc(a.type) ? `<button class="ghost sm" data-transfer="${a.id}">Transferir</button>` : ""}
      ${isCashAcc(a.type) || a.type === "CARD" ? `<label class="btnlike sm-like"><input type="file" accept=".ofx,.OFX,application/x-ofx,text/plain" data-ofx="${a.id}" style="position:absolute;width:1px;height:1px;opacity:0">Importar extrato</label>` : ""}
      ${a.openCount ? `<button class="ghost sm" data-goto="pagar">Ver contas</button>` : ""}</div></div>`;
  return `<div class="row spread"><h2>Bancos e dívidas</h2><button data-newacc>+ Adicionar</button></div>
  <p class="muted">Cada banco pode ter só saldo, só dívida, conta e cartão… Cadastre produto por produto, com o dono. Informe o saldo de hoje; o sistema calcula o resto.</p>
  ${debtBoard(ds)}
  <div class="person-tabs">${owners.map(o => `<button class="${bkOwner === o.id ? "on" : ""}" data-bkowner="${o.id}">${esc(o.name)}</button>`).join("")}</div>
  ${ov.people.filter(o => bkOwner === "" || (bkOwner === "none" ? o.personId === null : o.personId === bkOwner)).map(card).join("")}
  <h3 style="margin-top:20px">Produtos</h3>
  <div class="list">${shown.map(item).join("") || `<div class="empty">Nada cadastrado ainda. Toque em "+ Adicionar".</div>`}</div>
  ${trs.length ? `<h3 style="margin-top:20px">Últimas transferências</h3>
  <div class="card scroll"><table><tr><th>Data</th><th>De</th><th>Para</th><th>Valor</th><th>Quem lançou</th><th></th></tr>
    ${trs.map(t => `<tr><td>${br(t.day)}</td><td>${esc(t.fromLabel)}</td><td>${esc(t.toLabel)}</td><td>${money(t.amountCents)}</td><td>${esc(t.createdByName ?? "—")}</td>
      <td>${isAdmin() || t.createdBy === me?.id ? `<button class="ghost sm" data-edittr="${t.id}">Editar</button> <button class="danger sm" data-deltr="${t.id}">Excluir</button>` : ""}</td></tr>`).join("")}</table></div>` : ""}
  <div class="card" style="margin-top:20px"><div class="row spread"><h3 style="margin:0">Por onde começar</h3><span class="muted">total ${money(po.totalCents)} · juros ≈ <b class="neg">${money(po.monthlyInterestCents)}/mês</b></span></div>
    <div class="scroll" style="margin-top:10px"><table><tr><th>De quem</th><th>Deve</th><th>Juros por mês</th><th>Atrasadas</th><th>Negativadas</th></tr>
      ${po.owners.map(o => `<tr><td>${esc(o.name)}</td><td>${money(o.openCents)}</td><td class="${o.monthlyInterestCents ? "neg" : ""}">${money(o.monthlyInterestCents)}${o.unknownRates ? ` <span class="muted">+ ${o.unknownRates} sem taxa</span>` : ""}</td>
        <td>${o.overdueCount}</td><td>${o.negativados}</td></tr>`).join("")}</table></div>
    <div class="person-tabs" style="margin-top:14px">${(Object.keys(STRATEGY) as (keyof typeof STRATEGY)[]).map(k => `<button class="${bkStrategy === k ? "on" : ""}" data-strategy="${k}">${STRATEGY[k][0]}</button>`).join("")}</div>
    <p class="muted">${STRATEGY[bkStrategy][1]} ${po.unknownRates ? `<b>${po.unknownRates} item(ns) sem juros informado</b>: complete a taxa (fatura, linha CET) ou espere a pesquisa.` : ""}</p>
    ${po.items.length ? `<ol class="payoff">${po.items.map(x => `<li><div class="row spread"><b>${esc(x.name)}</b><span class="${x.daysOverdue ? "neg" : ""}">${money(x.openCents)}</span></div>
      <span class="muted">${esc(x.ownerName)} · ${x.dueDate ? `vence ${br(x.dueDate)}` : "sem data"} · ${x.reasons.map(esc).join(" · ")}${x.monthlyInterestCents ? ` · custa ≈ ${money(x.monthlyInterestCents)}/mês` : ""}</span></li>`).join("")}</ol>` : `<p class="muted">Nenhuma dívida em aberto.</p>`}</div>`;
}

function accForm(a?: Acc) {
  const own = (sel: string | null | undefined) => `<option value="">Dos dois / casa</option>${people.filter(p => p.active).map(p => `<option value="${p.id}" ${sel === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  const t = a?.type;
  return `<datalist id="banks">${BANKS.map(b => `<option value="${b}">`).join("")}</datalist>
    ${a ? "" : `<div class="full"><label>O que é</label><select name="type">${(Object.keys(ACC_TYPE) as AccType[]).map(k => `<option value="${k}">${ACC_TYPE[k]}</option>`).join("")}</select></div>`}
    <div><label>Banco / app / loja</label><input name="inst" list="banks" maxlength="80" value="${esc(a?.institution)}" placeholder="ex.: Nubank"></div>
    <div><label>Apelido</label><input name="name" required maxlength="80" value="${esc(a?.name ?? "")}" placeholder="ex.: Conta, Cartão roxo"></div>
    <div class="full"><label>De quem</label><select name="owner">${own(a?.ownerPersonId ?? me?.personId)}</select></div>
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
    <p class="muted full" data-f="loan">Se há parcelas atrasadas, informe a data da mais antiga: o sistema mostra o atraso sozinho.</p>`}
    <div data-f="card loan"><label>Juros ao mês (%)</label><input name="rate" inputmode="decimal" placeholder="se souber" value="${a?.monthlyRateBp != null ? String(a.monthlyRateBp / 100).replace(".", ",") : ""}"></div>
    <div data-f="card loan"><label>Fonte dos juros</label><input name="src" maxlength="80" placeholder="ex.: fatura (CET)" value="${esc(a?.rateSource)}"></div>
    <div class="full"><label>Observação</label><input name="notes" maxlength="300" value="${esc(a?.notes)}"></div>
    <label class="inline full" data-f="card loan"><input type="checkbox" name="neg" ${a?.negativado ? "checked" : ""}> Nome negativado por essa dívida (Serasa/SPC)</label>
    ${a ? `<label class="inline full"><input type="checkbox" name="active" ${a.active ? "checked" : ""}> Ativo</label>` : ""}`;
}
function wireAccForm(fixed?: AccType) {
  const sel = dlgForm.querySelector<HTMLSelectElement>("select[name=type]");
  const apply = () => {
    const t = (fixed ?? sel?.value) as AccType, kind = isCashAcc(t) ? "cash" : t === "CARD" ? "card" : "loan";
    dlgForm.querySelectorAll<HTMLElement>("[data-f]").forEach(e => (e.hidden = !e.dataset.f!.split(" ").includes(kind)));
  };
  sel?.addEventListener("change", apply); apply();
}
const rateOf = (f: FormData) => { const v = str(f, "rate").replace(",", "."); if (!v) return null; const n = Math.round(Number(v) * 100); if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "INVALID", "Juros inválido."); return n; };
const intOf = (f: FormData, k: string) => (str(f, k) ? Number(str(f, k)) : null);
function newAccount() {
  openDialog("Adicionar banco, cartão ou dívida", accForm(), "Salvar", async f => {
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
    }
    await api("/accounts", { method: "POST", body });
    toast("Cadastrado.");
  });
  wireAccForm();
}
async function editAccount(id: string) {
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
function billDialog(id: string) {
  openDialog("Nova fatura do cartão", `<div><label>Valor da fatura (R$)</label><input name="v" inputmode="decimal" required></div>
    <div><label>Vencimento</label><input name="d" type="date" required></div>`, "Salvar", async f => {
    await api(`/accounts/${id}/bill`, { method: "POST", body: { amountCents: centsOf(f, "v"), dueDate: str(f, "d") } });
    toast("Fatura lançada em Contas a pagar.");
  });
}
interface Transfer { id: string; amountCents: number; day: string; note: string | null; createdBy: string | null; createdByName: string | null;
  fromAccountId: string; toAccountId: string; fromLabel: string; toLabel: string; }
let trCache: Transfer[] = [];
async function editTransfer(id: string) {
  const t = trCache.find(x => x.id === id); if (!t) return;
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
async function transferDialog(fromId: string) {
  const accs = (await api<Acc[]>("/accounts")).filter(a => a.active && isCashAcc(a.type) && a.id !== fromId);
  openDialog("Transferir entre contas", `<div class="full"><label>Para</label><select name="to" required>${accs.map(a => `<option value="${a.id}">${esc(a.ownerName)} · ${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("")}</select></div>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" required></div><div><label>Data</label><input name="d" type="date" value="${today()}"></div>
    <p class="muted full">Transferência entre contas de vocês não é receita nem despesa.</p>`, "Transferir", async f => {
    await api("/transfers", { method: "POST", body: { fromAccountId: fromId, toAccountId: str(f, "to"), amountCents: centsOf(f, "v"), day: str(f, "d") || undefined } });
    toast("Transferência registrada.");
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
    ${r.topCategories.length ? `<span class="sub">${r.topCategories.map(c => `${esc(catLabel(c.category))} ${money(c.cents)}`).join(" · ")}</span>` : ""}
    <span class="sub">Com obrigatórios: ${money(r.allCents)}</span>
    ${hist(r.personId)}
  </div>`).join("") || `<div class="empty">Ninguém cadastrado em Pessoas da casa.</div>`}</div>
  <div class="card"><div class="row spread"><h3 style="margin:0">Gastos da semana</h3><span class="muted">fora do obrigatório: <b>${money(rk.totalCents)}</b> · obrigatório: ${money(rk.mandatoryCents)}</span></div>
    ${rk.items.length ? `<div class="scroll"><table><tr><th>Gasto</th><th>Valor</th><th>Pessoa</th><th>Classificação</th><th>Categoria</th><th>Data</th></tr>
    ${rk.items.map(i => `<tr><td>${esc(i.counterparty)}</td><td>${money(i.amountCents)}</td><td>${esc(i.personName ?? "Sem pessoa")}</td>
      <td>${isAdmin() ? `<button class="ghost sm" data-mand="${i.titleId}" data-val="${!i.mandatory}">${i.mandatory ? "Obrigatório" : "Não obrigatório"}${i.reviewed ? " ✓" : ""}</button>`
        : `<span class="chip ${i.mandatory ? "SETTLED" : "OPEN"}">${i.mandatory ? "Obrigatório" : "Não obrigatório"}</span>`}</td><td>${esc(catLabel(i.category))}</td><td>${br(i.paidOn)}</td></tr>`).join("")}
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
interface UserRow { id: string; email: string; name: string; nickname: string | null; role: "ADMIN" | "MEMBER"; personId: string | null; isGuardian: boolean; isRoot: boolean; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; totpEnabled?: boolean; conductOnly?: boolean; }
let usersCache: UserRow[] = [];
async function usersSection() {
  usersCache = await root<UserRow[]>("/admin/users");
  return `<div class="row spread" style="margin-top:24px"><h2>Usuários</h2><button data-newuser>+ Novo usuário</button></div>
  <p class="muted">Cada pessoa entra com e-mail e senha. Você cria a conta com uma senha provisória; no primeiro acesso ela troca.</p>
  <div class="list">${usersCache.map(u => `<div class="item">
    <div class="head"><span class="who">${esc(u.name)}${nick(u.nickname)}</span><span class="chip${u.isRoot ? " NO_VALUE" : ""}">${u.isRoot ? "Root" : u.role === "ADMIN" ? "Administrador" : u.isGuardian ? "Responsável" : "Membro"}</span></div>
    <div class="meta"><span class="muted">${esc(u.email)}</span>${u.active ? "" : `<span class="chip OVERDUE">desativado</span>`}
      ${u.mustChangePassword ? `<span class="chip NO_VALUE">senha provisória</span>` : ""}${u.totpEnabled ? `<span class="chip SETTLED">2 etapas</span>` : ""}${u.conductOnly ? `<span class="chip">só combinados</span>` : ""}
      <span class="muted">último acesso: ${u.lastLoginAt ? br(u.lastLoginAt) : "nunca"}</span></div>
    ${u.id !== me?.id && !u.isRoot && (isRoot() || u.role !== "ADMIN") ? `<div class="actions"><button class="ghost sm" data-edituser="${u.id}">Editar</button><button class="ghost sm" data-resetuser="${u.id}">Nova senha</button>${u.totpEnabled ? `<button class="ghost sm" data-reset2fa="${u.id}">Zerar 2 etapas</button>` : ""}
      <button class="ghost sm" data-toggleuser="${u.id}" data-active="${u.active}">${u.active ? "Desativar" : "Reativar"}</button></div>` : ""}
  </div>`).join("")}</div>`;
}
function userForm(u?: UserRow) {
  return `<div class="full"><label>Nome</label><input name="name" required value="${esc(u?.name)}"></div>
    <div class="full"><label>E-mail</label><input name="email" type="email" required value="${esc(u?.email)}"></div>
    <div><label>Apelido</label><input name="nick" placeholder="ex.: Gastadora" value="${esc(u?.nickname)}"></div>
    <div><label>Perfil</label><select name="role"><option value="MEMBER" ${u?.role === "MEMBER" ? "selected" : ""}>Membro</option>${isRoot() ? `<option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Administrador</option>` : ""}</select></div>
    <label class="inline full"><input type="checkbox" name="guard" ${u?.isGuardian ? "checked" : ""}> Responsável (registra ocorrências e corrige hábitos)</label>
    <label class="inline full"><input type="checkbox" name="conly" ${u?.conductOnly ? "checked" : ""}> Só combinados (vê e marca só as tarefas e a mesada dela; nada de finanças)</label>
    <div class="full"><label>É quem em Pessoas da casa</label><select name="person"><option value="">—</option>${people.map(p => `<option value="${p.id}" ${u?.personId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    ${u ? "" : `<div class="full"><label>Senha provisória (mín. 10 caracteres)</label><input name="pw" type="text" minlength="10" required autocomplete="off"></div>`}`;
}
function newUser() {
  openDialog("Novo usuário", userForm(), "Criar", async f => {
    await root("/admin/users", { method: "POST", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard") && !f.has("conly"), conductOnly: f.has("conly"), password: str(f, "pw") } });
    toast("Usuário criado. Passe a senha provisória pessoalmente.");
  });
}
function editUser(id: string) {
  const u = usersCache.find(x => x.id === id); if (!u) return;
  openDialog("Editar usuário", userForm(u), "Salvar", async f => {
    await root(`/admin/users/${id}`, { method: "PATCH", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard") && !f.has("conly"), conductOnly: f.has("conly") } });
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

/* ===================== Administração ===================== */
interface Status { ok: boolean; dbLatencyMs: number; database: { version: string; size: string }; counts: Record<string, number>;
  migrations: { name: string; appliedAt: string }[]; runtime: { node: string; vercel: boolean; region: string | null; commit: string | null }; }
interface Sess { id: string; name: string; email: string; isRoot: boolean; device: string; lastSeenAt: string; createdAt: string; current: boolean; }
interface Audit { id: number; at: string; who: string; what: string; action: string; label: string; changed: string[]; }
let auditQ = { actor: "", area: "", from: "", to: "" };
const AREAS: [string, string][] = [["", "Tudo"], ["contas", "Contas"], ["pagamentos", "Pagamentos"], ["bancos", "Bancos e dívidas"], ["transferencias", "Transferências"],
  ["combinados", "Combinados"], ["pessoas", "Pessoas e usuários"], ["ajustes", "Ajustes"]];
const dt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
async function adminPage() {
  if (!isAdmin()) return `<div class="empty">Área só para administradores.</div>`;
  const aq = new URLSearchParams(Object.entries({ limit: "60", ...auditQ }).filter(([, v]) => v));
  const [st, sessions, log, ret] = await Promise.all([root<Status>("/admin/status"), root<Sess[]>("/admin/sessions"), root<Audit[]>(`/admin/audit?${aq}`),
    root<{ months: number }>("/admin/audit/retention")]);
  const c = st.counts;
  const kpi = (l: string, v: string | number) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  return `<div class="alert ${st.ok ? "ok" : "danger"}"><b>${st.ok ? "Sistema funcionando" : "Problema no sistema"}</b> · banco PostgreSQL ${esc(st.database.version)} · ${esc(st.database.size)} · resposta ${st.dbLatencyMs} ms
      ${st.runtime.vercel ? `· Vercel ${esc(st.runtime.region ?? "")}${st.runtime.commit ? ` · versão ${esc(st.runtime.commit)}` : ""}` : "· servidor local"}</div>
    <div class="grid">${kpi("Usuários ativos", c.users ?? 0)}${kpi("Pessoas da casa", c.people ?? 0)}${kpi("Sessões abertas", c.sessions ?? 0)}${kpi("Lançamentos 30 dias", c.settlements30d ?? 0)}</div>
    ${await usersSection()}
    <h2 style="margin-top:24px">Sessões abertas</h2>
    <p class="muted">Aparelhos com login ativo. Encerre se um celular for perdido ou emprestado.</p>
    <div class="card scroll"><table><tr><th>Quem</th><th>Aparelho</th><th>Último uso</th><th>Desde</th><th></th></tr>
      ${sessions.map(x => `<tr><td>${esc(x.name)}${x.isRoot ? ` <span class="chip NO_VALUE">Root</span>` : ""}</td><td>${esc(x.device)}</td><td>${dt(x.lastSeenAt)}</td><td>${dt(x.createdAt)}</td>
        <td>${x.current ? `<span class="chip SETTLED">este aparelho</span>` : !x.isRoot || isRoot() ? `<button class="danger sm" data-endsess="${x.id}">Encerrar</button>` : ""}</td></tr>`).join("")}</table></div>
    <h2 style="margin-top:24px">Registro de alterações</h2>
    <p class="muted">Toda criação, correção e exclusão, com quem fez e quando. ${ret.months ? `Guardado por ${ret.months} ${ret.months === 1 ? "mês" : "meses"} no banco.` : "Guardado sem limite de tempo."} Cópia mensal permanente no backup.</p>
    <form class="form card" id="audit-f">
      <div><label>Quem</label><select name="actor"><option value="">Todos</option>${usersCache.map(u => `<option value="${u.id}" ${auditQ.actor === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
        <option value="system" ${auditQ.actor === "system" ? "selected" : ""}>Sistema (automático)</option></select></div>
      <div><label>O quê</label><select name="area">${AREAS.map(([v, l]) => `<option value="${v}" ${auditQ.area === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label>De</label><input name="from" type="date" value="${auditQ.from}"></div>
      <div><label>Até</label><input name="to" type="date" value="${auditQ.to}"></div>
      <div><button>Filtrar</button></div>
    </form>
    <div class="card">${log.length ? `<ul class="pays">${log.map(l => `<li><span><b>${esc(l.who)}</b> ${esc(l.action)} <b>${esc(l.what.toLowerCase())}</b>${l.label ? `: ${esc(l.label)}` : ""}${l.changed.length ? ` <span class="muted">(${l.changed.slice(0, 5).map(esc).join(", ")})</span>` : ""}</span><span class="muted">${dt(l.at)}</span></li>`).join("")}</ul>` : `<p class="muted">Nada encontrado com esses filtros.</p>`}</div>
    ${isRoot() ? `<form class="form card" id="ret-f"><div><label>Guardar o registro por (meses, 0 = sem limite)</label><input name="m" type="number" min="0" max="600" value="${ret.months}" required></div>
      <div><button class="ghost">Salvar</button></div><p class="muted full">Recomendado: 0 (sem limite). Se limitar, o que sair do banco fica só nas cópias mensais permanentes do backup.</p></form>` : ""}
    <details class="card"><summary>Versão do banco (${st.migrations.length} atualizações aplicadas)</summary><ul class="pays">${st.migrations.map(m => `<li><span>${esc(m.name)}</span><span class="muted">${dt(m.appliedAt)}</span></li>`).join("")}</ul></details>`;
}

/* ===================== Sessão: login, senha, sair ===================== */
/* ===================== Avisos no celular (Web Push) ===================== */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
function b64ToBytes(b64: string) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, ch => ch.charCodeAt(0));
}
async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
/** Card "Avisos no celular": liga/desliga neste aparelho e testa. */
async function pushCard() {
  if (!pushSupported()) {
    return `<div class="card"><h3>Avisos no celular</h3><p class="muted">${isIOS() && !standalone()
      ? "No iPhone, os avisos só funcionam com o app instalado: Safari → Compartilhar → Adicionar à Tela de Início. Depois abra pelo ícone e volte aqui."
      : "Este navegador não aceita avisos. Use o Chrome (Android/computador) ou o app instalado no iPhone."}</p></div>`;
  }
  const sub = await currentSub();
  const denied = Notification.permission === "denied";
  return `<div class="card"><h3>Avisos no celular</h3>
    <p class="muted">${me?.conductOnly ? "Receba aqui quando uma tarefa sua for aprovada." : "Aprovações das crianças, contas que vencem hoje e amanhã e o lembrete do fechamento do mês."} Grátis, direto no aparelho.</p>
    ${denied ? `<p class="neg">Os avisos estão bloqueados neste aparelho. Libere nas configurações do navegador/celular para este site e tente de novo.</p>` : ""}
    <div class="row">${sub ? `<span class="chip SETTLED">ligados neste aparelho</span><button class="ghost sm" data-pushtest>Enviar teste</button><button class="ghost sm" data-pushoff>Desligar</button>`
      : `<button class="sm" data-pushon ${denied ? "disabled" : ""}>Ligar avisos neste aparelho</button>`}</div></div>`;
}
async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Sem permissão, não dá para avisar. Libere nas configurações do aparelho.", true); return; }
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await root<{ publicKey: string }>("/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await root("/push/subscribe", { method: "POST", body: sub.toJSON() });
  await root("/push/test", { method: "POST" });
  toast("Avisos ligados. Mandei um teste.");
}
async function pushOff() {
  const sub = await currentSub();
  if (sub) { await root("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  toast("Avisos desligados neste aparelho.");
}

/* ===================== Importar extrato (OFX) ===================== */
interface StRow { fitid: string; date: string; amountCents: number; memo: string; status: "novo" | "ja_importado" | "ja_lancado";
  action: "despesa" | "receita" | "transferencia" | "ignorar"; category: string; personId: string | null; toAccountId: string | null; hint: string; }
/** OFX de banco brasileiro costuma vir em Windows-1252; sem isso, acentos viram lixo. */
async function readOfx(file: File) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder("ascii").decode(buf.slice(0, 600));
  if (/CHARSET:\s*1252|ENCODING:\s*USASCII/i.test(head)) return new TextDecoder("windows-1252").decode(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}
async function importStatement(accountId: string, file: File) {
  const text = await readOfx(file);
  const [pre, accs] = await Promise.all([api<{ isCard: boolean; rows: StRow[] }>("/import/statement/preview", { method: "POST", body: { accountId, text } }), api<Acc[]>("/accounts")]);
  const acc = accs.find(a => a.id === accountId);
  const targets = accs.filter(a => a.active && isCashAcc(a.type) && a.id !== accountId);
  const rows = pre.rows, novos = rows.filter(r => r.status === "novo");
  const ACT: Record<StRow["action"], string> = { despesa: "Gasto", receita: "Receita", transferencia: "Transferência", ignorar: "Ignorar" };
  const line = (r: StRow, i: number) => r.status !== "novo"
    ? `<li class="muted"><div>${br(r.date)} · ${esc(r.memo)} · <b>${money(r.amountCents)}</b></div><div><span class="chip NO_VALUE">${esc(r.hint)}</span></div></li>`
    : `<li><div>${br(r.date)} · ${esc(r.memo)} · <b class="${r.amountCents < 0 ? "neg" : "pos"}">${money(r.amountCents)}</b>${r.hint ? ` <span class="muted">· ${esc(r.hint)}</span>` : ""}</div>
      <div class="st-grid">
        <select name="a${i}" aria-label="O que é">${(Object.keys(ACT) as StRow["action"][]).map(k => `<option value="${k}" ${r.action === k ? "selected" : ""}>${ACT[k]}</option>`).join("")}</select>
        <select name="c${i}" aria-label="Categoria">${catOptions(r.category)}</select>
        <select name="p${i}" aria-label="De quem">${personOptions(r.personId)}</select>
        <select name="t${i}" aria-label="Conta de destino"><option value="">Transferir para…</option>${targets.map(a => `<option value="${a.id}" ${r.toAccountId === a.id ? "selected" : ""}>${esc(a.ownerName)} · ${esc(a.institution ?? "")} ${esc(a.name)}</option>`).join("")}</select>
      </div></li>`;
  const count = (s: StRow["status"]) => rows.filter(r => r.status === s).length;
  openDialog(`Extrato · ${acc ? `${acc.institution ?? ""} ${acc.name}` : ""}`, `
    <p class="full"><b>${novos.length}</b> novas · ${count("ja_lancado")} já lançadas à mão · ${count("ja_importado")} já importadas</p>
    <p class="muted full">Confira cada linha: o que é, categoria e de quem. "Ignorar" não lança nada (e não volta a aparecer). Transferência entre contas de vocês não é gasto nem receita.</p>
    <div class="full" style="max-height:58vh;overflow:auto"><ul class="imp">${rows.map(line).join("")}</ul></div>`,
    novos.length ? `Lançar ${novos.length}` : "Fechar", async f => {
    if (!novos.length) return;
    const body = rows.map((r, i) => r.status === "novo"
      ? { fitid: r.fitid, date: r.date, amountCents: r.amountCents, memo: r.memo, action: str(f, `a${i}`) as StRow["action"], category: str(f, `c${i}`) || undefined,
          personId: str(f, `p${i}`) || null, toAccountId: str(f, `t${i}`) || null }
      : r.status === "ja_lancado" ? { fitid: r.fitid, date: r.date, amountCents: r.amountCents, memo: r.memo, action: "ignorar" as const } : null).filter(Boolean);
    const bad = body.find(b => b!.action === "transferencia" && !b!.toAccountId);
    if (bad) { toast(`Escolha a conta de destino da transferência "${bad.memo}".`, true); return false; }
    const r = await api<{ despesas: number; receitas: number; transferencias: number; ignorados: number; erros: { memo: string; erro: string }[] }>("/import/statement", { method: "POST", body: { accountId, rows: body } });
    toast(`Lançados: ${r.despesas} gasto(s), ${r.receitas} receita(s), ${r.transferencias} transferência(s).${r.erros.length ? ` ${r.erros.length} com erro.` : ""}`, r.erros.length > 0);
    if (r.erros.length) alert(`Não lançados:\n${r.erros.map(e => `• ${e.memo}: ${e.erro}`).join("\n")}`);
  });
}

/* ===================== Importar cadastro ===================== */
interface ImportRes { dryRun: boolean; created: number; rows: { index: number; status: "novo" | "ja_existe" | "erro"; type: string; label: string; owner: string; summary: string; error?: string }[]; }
const IMPORT_TYPE: Record<string, string> = { RECURRENCE: "Automática", CHECKING: "Conta", SAVINGS: "Poupança", INVESTMENT: "Investimento", CARD: "Cartão", LOAN: "Dívida", CASH: "Dinheiro" };
async function importFile(file: File) {
  let data: unknown;
  try { data = JSON.parse(await file.text()); } catch { toast("Arquivo inválido: não é um JSON.", true); return; }
  const pre = await api<ImportRes>("/import/accounts?dryRun=1", { method: "POST", body: data });
  const n = (s: string) => pre.rows.filter(r => r.status === s).length;
  const ST = { novo: `<span class="chip SETTLED">criar</span>`, ja_existe: `<span class="chip NO_VALUE">já existe</span>`, erro: `<span class="chip OVERDUE">erro</span>` };
  openDialog("Prévia da importação", `
    <p class="full"><b>${n("novo")}</b> para criar · ${n("ja_existe")} já existem (serão ignorados) · ${n("erro") ? `<b class="neg">${n("erro")} com erro</b>` : "nenhum erro"}</p>
    <div class="full" style="max-height:55vh;overflow:auto"><ul class="imp">${pre.rows.map(r => `<li>
      <div>${ST[r.status]} <b>${esc(IMPORT_TYPE[r.type] ?? r.type)}</b> · ${esc(r.label)}</div>
      <div class="muted">${esc(r.owner)} · ${r.error ? `<span class="neg">${esc(r.error)}</span>` : esc(r.summary)}</div></li>`).join("")}</ul></div>
    <p class="muted full">Confira cada linha com o app do banco. Itens com erro não são gravados; corrija e importe de novo.</p>`,
    n("novo") ? `Criar ${n("novo")}` : "Fechar", async () => {
    if (!n("novo")) return;
    const r = await api<ImportRes>("/import/accounts", { method: "POST", body: data });
    toast(`${r.created} cadastro(s) criado(s). Veja em Bancos e dívidas.`);
  });
}

/* ===================== Verificação em duas etapas ===================== */
async function mfaSetup() {
  const s = await root<{ secret: string; uri: string }>("/auth/2fa/setup", { method: "POST" });
  const qr = qrcode(0, "M"); qr.addData(s.uri); qr.make();
  openDialog("Ativar verificação em duas etapas", `
    <ol class="full muted" style="margin:0;padding-left:18px">
      <li>Instale o <b>Google Authenticator</b> ou o <b>Microsoft Authenticator</b> no celular.</li>
      <li>No app, toque em <b>+</b> e leia o QR abaixo. Se estiver no próprio celular, escolha "inserir chave" e copie a chave.</li>
      <li>Digite os 6 números que aparecerem.</li></ol>
    <div class="full" style="text-align:center;background:#fff;padding:12px;border-radius:12px"><img alt="QR para o app autenticador" src="${qr.createDataURL(5, 2)}" width="220" height="220" style="image-rendering:pixelated"></div>
    <div class="full"><label>Chave (se não der para ler o QR)</label><input readonly value="${esc(s.secret.replace(/(.{4})/g, "$1 ").trim())}" style="font-family:monospace"></div>
    <div class="full"><label>Código de 6 números</label><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>`, "Ativar", async f => {
    const r = await root<{ recoveryCodes: string[] }>("/auth/2fa/enable", { method: "POST", body: { code: str(f, "code") } });
    me = await root<Me>("/auth/me"); dlg.close();
    openDialog("Guarde os códigos de recuperação", `
      <p class="full">Cada código entra <b>uma vez</b> se você perder o celular. Tire um print ou anote e guarde fora do celular. Eles não aparecem de novo.</p>
      <pre class="full" style="font-size:1.05rem;line-height:1.8;margin:0">${r.recoveryCodes.map(esc).join("\n")}</pre>`, "Já guardei", async () => { toast("Verificação em duas etapas ativada."); });
    dlgForm.querySelector<HTMLButtonElement>("[data-close]")!.hidden = true;
    return false;
  });
}
function mfaDisable() {
  openDialog("Desativar verificação em duas etapas", `<p class="muted full">Sua conta volta a pedir só a senha.</p>
    <div class="full"><label>Sua senha</label><input name="pw" type="password" autocomplete="current-password" required></div>`, "Desativar", async f => {
    await root("/auth/2fa/disable", { method: "POST", body: { password: String(f.get("pw") ?? "") } });
    me = await root<Me>("/auth/me"); toast("Verificação em duas etapas desativada.");
  });
}
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
  $("#me").innerHTML = me ? `<div><b>${esc(me.name)}</b>${me.nickname ? ` <small>· ${esc(me.nickname)}</small>` : ""}<br><small>${me.isRoot ? "Root" : me.role === "ADMIN" ? "Administrador" : me.isGuardian ? "Responsável" : "Membro"}</small></div>
    <div class="row"><button data-act="password">Trocar senha</button><button data-act="logout">Sair</button></div>` : "";
  entSel.hidden = !isAdmin();
  $("#tab-admin").hidden = !isAdmin();
  const conly = !!me?.conductOnly;
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach(b => { if (b.id !== "tab-admin") b.hidden = conly && b.dataset.tab !== "combinados" && b.dataset.tab !== "pedidos"; });
  moreBtn.hidden = conly;
  if (conly && tab !== "pedidos") { tab = "combinados"; if (location.hash !== "#combinados") history.replaceState(null, "", "#combinados"); }
  if (!isAdmin() && tab === "admin") tab = "painel";
  if (!isAdmin() && getEntity() !== "personal") { setEntity("personal"); entSel.value = "personal"; }
}
function showLogin() {
  me = null; document.documentElement.dataset.auth = "out"; dlg.close(); $("#mfa-form").hidden = true;
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
  try {
    const r = await root<Me & { mfaRequired?: boolean; challenge?: string }>("/auth/login", { method: "POST", body: { email: str(f, "email"), password: String(f.get("password") ?? "") } });
    (e.target as HTMLFormElement).reset();
    if (r.mfaRequired) { mfaChallenge = r.challenge!; $("#login-form").hidden = true; $("#mfa-form").hidden = false; $("#mfa-err").textContent = ""; $<HTMLInputElement>("#mfa-code").focus(); }
    else await enter(r);
  }
  catch (x) { err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor."; }
  finally { btn.disabled = false; }
});
let mfaChallenge = "";
$("#mfa-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement, err = $("#mfa-err"), btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  err.textContent = ""; btn.disabled = true;
  try {
    const u = await root<Me>("/auth/login/mfa", { method: "POST", body: { challenge: mfaChallenge, code: str(new FormData(form), "code") } });
    form.reset(); mfaChallenge = ""; $("#mfa-form").hidden = true; $("#login-form").hidden = false; await enter(u);
  } catch (x) {
    err.textContent = x instanceof ApiError ? x.message : "Sem conexão com o servidor.";
    if (x instanceof ApiError && x.code === "MFA_EXPIRED") setTimeout(() => { $("#mfa-form").hidden = true; $("#login-form").hidden = false; }, 2500);
  } finally { btn.disabled = false; }
});
$("#mfa-back").addEventListener("click", () => { mfaChallenge = ""; $("#mfa-form").hidden = true; $("#login-form").hidden = false; });
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
    else if (d.extyear) { if (d.extyear === "last6") { extTo = today().slice(0, 7); extFrom = addMonths(extTo, -5).slice(0, 7); } else { extFrom = `${d.extyear}-01`; extTo = `${d.extyear}-12`; } await render(); }
    else if (d.newrec !== undefined) newRec();
    else if (d.newperson !== undefined) newPerson();
    else if (d.goto) { if (d.bkowner !== undefined) bkOwner = d.bkowner; tab = d.goto as Tab; history.pushState(null, "", `#${tab}`); scrollTo(0, 0); await render(); }
    else if (d.reqok || d.reqno) {
      const id = (d.reqok ?? d.reqno)!, acc = (document.getElementById(`racc-${id}`) as HTMLSelectElement | null)?.value || null;
      const note = (document.getElementById(`rnote-${id}`) as HTMLInputElement | null)?.value.trim() || null;
      if (d.reqno && !note) { toast("Escreva o motivo no recado (ex.: sem saldo no Nubank, peça pelo Inter).", true); return; }
      if (d.reqok && !acc) { toast("Escolha de onde sai o dinheiro.", true); return; }
      await api(`/requests/${id}/review`, { method: "POST", body: { approve: !!d.reqok, accountId: acc, note } });
      toast(d.reqok ? "Aprovado e lançado." : "Recusado. A pessoa recebe o recado."); await render();
    }
    else if (d.reqcancel) { await api(`/requests/${d.reqcancel}/cancel`, { method: "POST" }); toast("Pedido cancelado."); await render(); }
    else if (d.reqagain) { const r = (await api<PReq[]>("/requests")).find(x => x.id === d.reqagain); if (r) reqPrefill = { d: r.description, v: r.amountCents, c: r.category }; await render(); scrollTo(0, 0); }
    else if (d.review) { await api("/conduct/checks/review", { method: "POST", body: { personId: d.person, ruleId: d.review, day: d.day, approve: d.val === "true" } }); toast(d.val === "true" ? "Aprovado." : "Recusado: não conta na nota."); await render(); }
    else if (d.reviewall !== undefined) { for (const p of pendingCache) await api("/conduct/checks/review", { method: "POST", body: { personId: p.personId, ruleId: p.ruleId, day: p.day, approve: true } }); toast(`${pendingCache.length} aprovados.`); await render(); }
    else if (d.check) { await api("/conduct/checks", { method: "POST", body: { personId: d.person, ruleId: d.check, day: d.day, checked: d.val === "true" } }); await render(); }
    else if (d.cbweek !== undefined) { const n = Number(d.cbweek); if (n === 0) cbDate = today(); else { const x = new Date(`${cbDate}T12:00:00`); x.setDate(x.getDate() + n); cbDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.infraction !== undefined) await infractionDialog();
    else if (d.newacc !== undefined) newAccount();
    else if (d.editacc) await editAccount(d.editacc);
    else if (d.bill) billDialog(d.bill);
    else if (d.edittr) await editTransfer(d.edittr);
    else if (d.deltr) { if (confirm("Excluir esta transferência? Os saldos das duas contas voltam ao que eram. Fica no registro de alterações.")) { await api(`/transfers/${d.deltr}`, { method: "DELETE" }); toast("Transferência excluída."); await render(); } }
    else if (d.transfer) await transferDialog(d.transfer);
    else if (d.bkowner !== undefined) { bkOwner = d.bkowner; await render(); }
    else if (d.strategy) { bkStrategy = d.strategy as typeof bkStrategy; await render(); }
    else if (d.cbperson !== undefined) { cbView = d.cbperson; scrollTo(0, 0); await render(); }
    else if (d.sporadic) { await api("/conduct/sporadic", { method: "POST", body: { ruleId: d.sporadic, personId: d.person, day: today(), active: d.val === "true" } }); toast(d.val === "true" ? "Tarefa ativada para hoje." : "Tarefa desativada."); await render(); }
    else if (d.blame) await blameDialog(d.blame, d.person!, d.day!);
    else if (d.plan) await planDialog(d.plan);
    else if (d.close) await closeDialog(d.close, d.month!);
    else if (d.template !== undefined) { const r = await api<{ created: string[]; paused: string[] }>("/conduct/template", { method: "POST" }); toast(r.created.length ? `Criadas ${r.created.length} tarefas e mesadas do modelo.` : "O modelo já estava aplicado."); await render(); }
    else if (d.settle) settleDialog(d.settle, Number(d.bal));
    else if (d.delentry) { if (confirm("Excluir este registro? Os pontos e a multa voltam.")) { await api(`/conduct/entries/${d.delentry}`, { method: "DELETE" }); toast("Registro excluído."); await render(); } }
    else if (d.newrule !== undefined) await editRule();
    else if (d.editrule) await editRule(d.editrule);
    else if (d.rkweek !== undefined) { const n = Number(d.rkweek); if (n === 0) rkDate = today(); else { const x = new Date(`${rkDate}T12:00:00`); x.setDate(x.getDate() + n); rkDate = x.toLocaleDateString("sv-SE"); } await render(); }
    else if (d.mand) { await api(`/titles/${d.mand}`, { method: "PATCH", body: { mandatory: d.val === "true" } }); toast("Classificação revisada."); await render(); }
    else if (d.editcats !== undefined) editCats((await api<string[]>("/settings/mandatory-categories")));
    else if (d.newuser !== undefined) newUser();
    else if (d.endsess) { if (confirm("Encerrar esta sessão? A pessoa terá que entrar de novo nesse aparelho.")) { await root(`/admin/sessions/${d.endsess}`, { method: "DELETE" }); toast("Sessão encerrada."); await render(); } }
    else if (d.edituser) editUser(d.edituser);
    else if (d.resetuser) resetUser(d.resetuser);
    else if (d.reset2fa) { if (confirm("Desligar a verificação em duas etapas desta pessoa? Use quando ela perdeu o celular. Ela vai entrar só com a senha e poderá ativar de novo.")) { await root(`/admin/users/${d.reset2fa}/reset-2fa`, { method: "POST" }); toast("Verificação em duas etapas desligada."); await render(); } }
    else if (d.mfaon !== undefined) await mfaSetup();
    else if (d.pushon !== undefined) { await pushOn(); await render(); }
    else if (d.pushoff !== undefined) { await pushOff(); await render(); }
    else if (d.pushtest !== undefined) { const r = await root<{ sent: number }>("/push/test", { method: "POST" }); toast(r.sent ? "Teste enviado. Deve chegar em segundos." : "Nenhum aparelho recebeu. Desligue e ligue de novo.", !r.sent); }
    else if (d.mfaoff !== undefined) mfaDisable();
    else if (d.toggleuser) { await root(`/admin/users/${d.toggleuser}`, { method: "PATCH", body: { active: d.active !== "true" } }); toast(d.active === "true" ? "Usuário desativado." : "Usuário reativado."); await render(); }
    else if (d.editperson) editPerson(d.editperson);
    else if (d.toggleperson) { await api(`/people/${d.toggleperson}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
    else if (d.seeperson) { personFilter = d.seeperson; statusFilter = "all"; tab = "pagar"; history.replaceState(null, "", "#pagar"); await render(); }
    else if (d.editrec) await editRec(d.editrec);
    else if (d.togglerec) { await api(`/recurrences/${d.togglerec}`, { method: "PATCH", body: { active: d.active !== "true" } }); await render(); }
  } catch (err) { fail(err); }
});
/** "acc:<id>" → conta de onde saiu/entrou; "card:<id>" → compra no cartão (vai para a fatura). */
function srcOf(f: FormData): { accountId?: string; cardAccountId?: string } {
  const v = str(f, "src");
  if (v.startsWith("acc:")) return { accountId: v.slice(4) };
  if (v.startsWith("card:")) return { cardAccountId: v.slice(5) };
  return {};
}
view.addEventListener("change", async e => {
  const t = e.target as HTMLInputElement;
  if (t.matches("[data-ofx]") && t.files?.[0]) { try { await importStatement(t.dataset.ofx!, t.files[0]); } catch (err) { fail(err); } finally { t.value = ""; } return; }
  if (t.matches("[data-importfile]") && t.files?.[0]) { try { await importFile(t.files[0]); } catch (err) { fail(err); } finally { t.value = ""; } }
});
view.addEventListener("submit", async e => {
  const form = e.target as HTMLFormElement;
  e.preventDefault();
  try {
    if (form.id === "quick") {
      const f = new FormData(form);
      const r = await api<{ guard: { allowed: boolean; message: string } }>("/expenses/quick", { method: "POST", body: {
        amountCents: centsOf(f, "v"), description: str(f, "d"), category: str(f, "c"), date: str(f, "dt") || undefined, personId: str(f, "person") || null, ...srcOf(f) } });
      const viaCard = str(f, "src").startsWith("card:");
      toast(r.guard.allowed ? (viaCard ? "Gasto registrado na fatura do cartão." : "Gasto registrado.") : `Registrado com aviso: ${r.guard.message}`, !r.guard.allowed);
      await render();
    } else if (form.id === "quick-tr") {
      const f = new FormData(form);
      if (str(f, "from") === str(f, "to")) { toast("Escolha contas diferentes em De e Para.", true); return; }
      await api("/transfers", { method: "POST", body: { fromAccountId: str(f, "from"), toAccountId: str(f, "to"), amountCents: centsOf(f, "v"), day: str(f, "dt") || undefined } });
      toast("Transferência registrada."); await render();
    } else if (form.id === "req-f") {
      const f = new FormData(form);
      const body: Record<string, unknown> = { description: str(f, "d"), amountCents: centsOf(f, "v"), category: str(f, "c") || undefined, accountId: str(f, "a") || null };
      if (f.has("person")) body.forPersonId = str(f, "person") || null;
      await api("/requests", { method: "POST", body });
      toast("Pedido enviado. Você recebe a resposta aqui (e no celular, se os avisos estiverem ligados)."); await render();
    } else if (form.id === "budget-f") {
      const f = new FormData(form), cur = await api<Budget>("/budget"), old = new Map(cur.items.map(i => [i.category, i.limitCents]));
      let n = 0;
      for (const c of SPEND_CATS) {
        const raw = str(f, `b_${c}`), v = raw ? parseMoney(raw) : null;
        if (raw && (v == null || !Number.isFinite(v) || v <= 0)) { toast(`Valor inválido em ${c}.`, true); return; }
        if ((old.get(c) ?? null) !== v) { await api(`/budget/${c}`, { method: "PUT", body: { limitCents: v } }); n++; }
      }
      toast(n ? `Orçamento salvo (${n} categoria${n > 1 ? "s" : ""}).` : "Nada mudou."); await render();
    } else if (form.id === "audit-f") {
      const f = new FormData(form); auditQ = { actor: str(f, "actor"), area: str(f, "area"), from: str(f, "from"), to: str(f, "to") }; await render();
    } else if (form.id === "ret-f") {
      const months = Number(str(new FormData(form), "m"));
      await root("/admin/audit/retention", { method: "PUT", body: { months } }); toast(months ? `Registro guardado por ${months} ${months === 1 ? "mês" : "meses"}.` : "Registro guardado sem limite."); await render();
    } else if (form.id === "quick-in") {
      const f = new FormData(form);
      const src = srcOf(f);
      await api("/incomes/quick", { method: "POST", body: { amountCents: centsOf(f, "v"), description: str(f, "d"), category: str(f, "c"), date: str(f, "dt") || undefined, personId: str(f, "person") || null, accountId: src.accountId ?? null } });
      toast("Recebimento registrado."); await render();
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
