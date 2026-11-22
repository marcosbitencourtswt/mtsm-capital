/** Gerado ao separar a tela em módulos: pages/titles. */
import { type Kind, api, type Title, ApiError, type Settlement, getEntity } from "../api.js";
import { st, STATUS, NATURE, catLabel, mine, catOptions, personSelect, dlgForm, str, openDialog, centsOf, toast, $ } from "../core.js";
import { esc, money, br, pct, moneyInput, today, parseMoney, daysLeft } from "../fmt.js";
import { type Acc, isCashAcc } from "./bancos.js";
import { dt } from "./admin.js";
import { expenseFields, submitExpense, incomeFields, submitIncome } from "./lancar.js";
 // "" = todas, "none" = casa/geral, ou id
/* ===================== Contas a pagar / receber ===================== */
export async function titles(kind: Kind) {
  const myP = st.me?.personId ?? null;
  if (!st.personFilterSet && myP && getEntity() === "personal") { st.personFilter = `${myP}+none`; st.personFilterSet = true; }
  const list = await api<Title[]>(`/titles?kind=${kind}&status=${st.statusFilter}${st.personFilter ? `&person=${st.personFilter}` : ""}`);
  const label = kind === "PAYABLE" ? "Contas a pagar" : "Contas a receber";
  const total = list.reduce((s, t) => s + Math.max(0, t.openCents), 0);
  const f = (v: typeof st.statusFilter, l: string) => `<button class="${st.statusFilter === v ? "" : "ghost"} sm" data-filter="${v}">${l}</button>`;
  return `
  <div class="row spread"><h2>${label}</h2><button data-new="${kind}">+ Nova</button></div>
  <div class="row" style="margin-bottom:12px">${f("open", "Em aberto")}${f("settled", kind === "PAYABLE" ? "Pagas" : "Recebidas")}${f("all", "Todas")}
    <span class="muted" style="margin-left:auto">Em aberto: <b>${money(total)}</b></span></div>
  ${getEntity() === "personal" ? `<div class="row tabs-p" style="margin-bottom:12px">${pTab(myP ? `${myP}+none` : null, "Minhas + casa")}
    ${st.people.filter(p => p.active && p.id !== myP).map(p => pTab(p.id, esc(p.name))).join("")}${pTab("none", "Só da casa")}${pTab("", "Todas")}</div>` : ""}
  <div class="list">${list.length ? list.map(titleItem).join("") : `<div class="empty">Nenhuma conta aqui. Toque em "+ Nova".</div>`}</div>`;
}
const pTab = (v: string | null, l: string) => (v == null ? "" : `<button class="${st.personFilter === v ? "" : "ghost"} sm" data-pf="${v}">${l}</button>`);
export function titleItem(t: Title) {
  const payLabel = t.kind === "PAYABLE" ? "Pagar" : "Receber";
  return `<div class="item">
    <div class="head"><span class="who">${esc(t.counterparty)}</span><span class="amt">${money(t.openCents)}</span></div>
    <div class="meta">
      <span class="chip ${t.status}">${STATUS[t.status]}</span><span class="chip">${NATURE[t.nature]}</span><span class="chip">${esc(catLabel(t.category))}</span>
      ${t.personName ? `<span class="chip person">👤 ${esc(t.personName)}</span>` : ""}
      <span class="muted">vence ${br(t.dueDate)}</span>
      ${t.status !== "SETTLED" ? ((d) => (d ? `<span class="chip ${d.cls}">⏳ ${d.txt}</span>` : ""))(daysLeft(t.dueDate)) : ""}
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

export function titleForm(kind: Kind, t?: Title) {
  // Dívidas e faturas de cartão se cadastram em "Bancos e dívidas" (um lugar só). Aqui, só edição das antigas.
  const natures = kind === "PAYABLE" ? (t ? ["EXPENSE", "DEBT", "CARD"] : ["EXPENSE"]) : ["INCOME", "LOAN_IN"];
  const isNew = !t;
  return `
    <div class="full"><label>${kind === "PAYABLE" ? "Para quem / o quê" : "De quem"}</label><input name="who" required value="${esc(t?.counterparty)}"></div>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" value="${t ? moneyInput(t.amountCents) : ""}"></div>
    <div><label>Vencimento</label><input name="due" type="date" value="${t?.dueDate ?? ""}"></div>
    <div><label>Tipo</label><select name="nat" ${isNew ? "" : "disabled"}>${natures.map(n => `<option value="${n}" ${t?.nature === n ? "selected" : ""}>${NATURE[n]}</option>`).join("")}</select></div>
    <div><label>Categoria</label><select name="cat">${catOptions(t?.category ?? (kind === "PAYABLE" ? "OUTROS" : "RENDA"))}</select></div>
    ${personSelect(t ? t.personId : st.personFilter && st.personFilter !== "none" ? st.personFilter : null)}
    <div data-int><label>Juros</label><select name="model">
      ${[["NONE", "Sem juros"], ["FIXED_ONCE", "% uma vez"], ["MONTHLY_SIMPLE", "% ao mês simples"], ["MONTHLY_COMPOUND", "% ao mês composto"]]
        .map(([v, l]) => `<option value="${v}" ${t?.interestModel === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div data-int><label>Taxa (%)</label><input name="rate" inputmode="decimal" value="${t ? (t.rateBp / 100).toString().replace(".", ",") : "0"}"></div>
    <div class="full"><label>Observação</label><input name="notes" value="${esc(t?.notes)}"></div>
    ${isNew && kind === "PAYABLE" ? `<p class="muted full">Dívida, empréstimo ou cartão? Cadastre em <b>Bancos e dívidas</b>: lá o sistema gera as parcelas, a fatura e a ordem de pagamento.</p>` : ""}
    ${isNew && kind === "RECEIVABLE" ? `<p class="muted full" data-loan>Empréstimo não é receita: o sistema cria a dívida em "A pagar" com os juros acima.</p>` : ""}`;
}
/** Mostra juros só para dívida/empréstimo. */
export function wireInterestVisibility(kind: Kind, nature?: string) {
  const sel = dlgForm.querySelector<HTMLSelectElement>("select[name=nat]")!;
  const apply = () => {
    const n = nature ?? sel.value, show = n === "DEBT" || n === "LOAN_IN";
    dlgForm.querySelectorAll<HTMLElement>("[data-int]").forEach(e => (e.style.display = show ? "" : "none"));
    dlgForm.querySelectorAll<HTMLElement>("[data-loan]").forEach(e => (e.style.display = n === "LOAN_IN" ? "" : "none"));
  };
  sel.addEventListener("change", apply); apply();
  void kind;
}
export function interestFrom(f: FormData) {
  const model = str(f, "model") || "NONE";
  const rateBp = Math.round(Number(str(f, "rate").replace(",", ".") || "0") * 100);
  if (!Number.isFinite(rateBp) || rateBp < 0) throw new ApiError(400, "INVALID", "Taxa inválida.");
  return model === "NONE" || rateBp === 0 ? { interestModel: "NONE", rateBp: 0 } : { interestModel: model, rateBp };
}

export async function newTitle(kind: Kind) {
  if (kind === "PAYABLE") {
    const accs = await api<Acc[]>("/accounts").catch(() => [] as Acc[]);
    openDialog("Novo gasto ou conta a pagar", `${expenseFields(accs, { later: true })}
      <p class="muted full">Já pagou? Escolha com qual conta ou cartão: vira gasto e sai do saldo. Dívida, empréstimo ou cartão novo? Cadastre em <b>Bancos e dívidas</b>.</p>`,
      "Salvar", async f => { const r = await submitExpense(f); toast(r.msg, r.warn); });
    return;
  }
  if (kind === "RECEIVABLE") {
    const accs = await api<Acc[]>("/accounts").catch(() => [] as Acc[]);
    openDialog("Nova receita ou conta a receber", `${incomeFields(accs, { later: true })}
      <p class="muted full">Pegou dinheiro emprestado? Não é receita: cadastre em <b>Bancos e dívidas</b> → Empréstimo (o app calcula os juros).</p>`,
      "Salvar", async f => { toast(await submitIncome(f)); });
    return;
  }
}

export async function editTitle(id: string) {
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

export async function payTitle(id: string) {
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

export async function showPays(id: string) {
  const box = $(`[data-pays-box="${id}"]`);
  if (box.innerHTML) { box.innerHTML = ""; return; }
  const t = await api<Title>(`/titles/${id}`);
  box.innerHTML = `<ul class="pays">${(t.settlements ?? []).map((s: Settlement) => `<li>
    <span>${br(s.paidOn)} · ${money(s.amountCents)}${s.method === "CARD" ? " · cartão" : s.method === "DISCOUNT" ? " · desconto" : ""}${s.warnings.length ? ` <span class="chip OVERDUE">aviso</span>` : ""}</span>
    <span class="row"><button class="ghost sm" data-pedit="${s.id}" data-amt="${s.amountCents}" data-dt="${s.paidOn}">Editar</button>
    <button class="danger sm" data-pdel="${s.id}">Excluir</button></span></li>`).join("")}</ul>`;
}
export function editPay(id: string, amt: number, dt: string) {
  openDialog("Editar pagamento", `
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(amt)}" required></div>
    <div><label>Data</label><input name="dt" type="date" value="${dt}"></div>`, "Salvar", async f => {
    await api(`/settlements/${id}`, { method: "PATCH", body: { amountCents: centsOf(f, "v"), paidOn: str(f, "dt") } });
    toast("Pagamento alterado.");
  });
}
