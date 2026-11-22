/** Gerado ao separar a tela em módulos: pages/config. */
import { api, type Recurrence, getEntity, type Kind } from "../api.js";
import { isGuardian, st, isAdmin, catLabel, catOptions, personSelect, openDialog, str, centsOf, toast } from "../core.js";
import { budgetForm, type Budget } from "./orcamento.js";
import { pushCard } from "./push.js";
import { esc, money, br, moneyInput, today, addMonths } from "../fmt.js";

/* ===================== Ajustes: automáticas + avisos ===================== */
export async function config() {
  const [recs, warns] = await Promise.all([
    api<Recurrence[]>("/recurrences"),
    api<{ id: string; paidOn: string; amountCents: number; warnings: string[]; counterparty: string }[]>("/warnings"),
  ]);
  const bForm = isGuardian() ? budgetForm(await api<Budget>("/budget")) : "";
  return `${await pushCard()}${bForm}<div class="card"><h3>Verificação em duas etapas</h3>
    ${st.me?.totpEnabled
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
export function recForm(r?: Recurrence) {
  return `
    <div class="full"><label>Descrição</label><input name="d" required value="${esc(r?.description)}" placeholder="ex.: Aluguel"></div>
    <div><label>Tipo</label><select name="k" ${r ? "disabled" : ""}><option value="PAYABLE" ${r?.kind === "PAYABLE" ? "selected" : ""}>A pagar</option><option value="RECEIVABLE" ${r?.kind === "RECEIVABLE" ? "selected" : ""}>A receber</option></select></div>
    <div><label>Categoria</label><select name="c">${catOptions(r?.category ?? "MORADIA")}</select></div>
    <div><label>Valor padrão (vazio se varia)</label><input name="v" inputmode="decimal" value="${r?.defaultAmountCents != null ? moneyInput(r.defaultAmountCents) : ""}"></div>
    <div><label>Dia do vencimento</label><input name="day" type="number" min="1" max="31" value="${r?.dueDay ?? ""}"></div>
    ${personSelect(r?.personId)}
    ${r ? "" : `<div class="full"><label>Começa em</label><input name="start" type="month" value="${today().slice(0, 7)}"></div>`}`;
}
export function newRec() {
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
export async function editRec(id: string) {
  const r = (await api<Recurrence[]>("/recurrences")).find(x => x.id === id);
  if (!r) return;
  openDialog("Editar conta automática", recForm(r), "Salvar", async f => {
    await api(`/recurrences/${id}`, { method: "PATCH", body: {
      description: str(f, "d"), category: str(f, "c"), defaultAmountCents: centsOf(f, "v", false),
      dueDay: str(f, "day") ? Number(str(f, "day")) : null, personId: str(f, "person") || null } });
    toast("Alterada. Vale para os próximos meses.");
  });
}
