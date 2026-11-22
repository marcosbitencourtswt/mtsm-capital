/** Gerado ao separar a tela em módulos: core. */
import { type Me, type Person, root, ApiError, api } from "./api.js";
import { type Tab, render } from "./main.js";
import { addMonths, today, esc, parseMoney } from "./fmt.js";
import { type Pending } from "./pages/combinados.js";
import { type Budget } from "./pages/orcamento.js";
import { type Transfer } from "./pages/bancos.js";
import { type UserRow } from "./pages/admin.js";

/** Estado da tela num lugar só (quem está logado, filtros, mês escolhido...). */
export const st = {
  me: null as Me | null,
  people: [] as Person[],
  tab: (location.hash.slice(1) as Tab) || "painel" as Tab,
  statusFilter: "open" as "open" | "settled" | "all",
  personFilter: "",
  extFrom: addMonths(today().slice(0, 7), -5),
  extTo: today().slice(0, 7),
  projMonths: 12,
  simCache: "",
  peopleMonth: today().slice(0, 7),
  pendingCache: [] as Pending[],
  cbDate: today(),
  cbView: "",
  bkOwner: "",
  bkStrategy: "juros" as "juros" | "rapidas" | "nome",
  repMonth: today().slice(0, 7),
  reqPrefill: {} as { d?: string; v?: number; c?: string },
  budgetCache: null as Budget | null,
  trCache: [] as Transfer[],
  rkDate: today(),
  usersCache: [] as UserRow[],
  auditQ: { actor: "", area: "", from: "", to: "" },
  mfaChallenge: "",
};

/* ===================== Infra de UI ===================== */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const view = $("#view");
export const dlg = $<HTMLDialogElement>("#dlg");
export const dlgForm = $<HTMLFormElement>("#dlg-form");

export function toast(msg: string, err = false) {
  const t = $("#toast"); t.textContent = msg; t.className = `show${err ? " err" : ""}`;
  setTimeout(() => (t.className = ""), err ? 5000 : 2500);
}
export const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : "Sem conexão com a API. Ela está rodando?", true);

export const NATURE: Record<string, string> = { EXPENSE: "Conta", DEBT: "Dívida", CARD: "Cartão", INCOME: "Receita", LOAN_IN: "Empréstimo" };
export const STATUS: Record<string, string> = { OPEN: "Em aberto", OVERDUE: "Vencida", SETTLED: "Quitada", NO_VALUE: "Sem valor" };
export const CATEGORIES = ["ALIMENTACAO", "MORADIA", "AGUA", "LUZ", "INTERNET", "FIXO", "TRANSPORTE", "SAUDE", "EDUCACAO",
  "DELIVERY", "RESTAURANTE", "LAZER", "ROUPAS", "BELEZA", "PRESENTES", "ASSINATURAS", "DIVIDA", "CARTAO", "MESADA", "IMPOSTOS", "PRO_LABORE", "LUCROS", "RENDA", "VENDAS", "SERVICOS", "OUTROS"];
export const isAdmin = () => st.me?.role === "ADMIN";
export const isGuardian = () => isAdmin() || !!st.me?.isGuardian;
export const isRoot = () => !!st.me?.isRoot;
export const mine = (createdBy: string | null | undefined) => isAdmin() || (!!createdBy && createdBy === st.me?.id);
/** Código fica igual por dentro (dados não mudam); a tela mostra o nome legível. */
export const CAT_LABEL: Record<string, string> = { ALIMENTACAO: "Alimentação", MORADIA: "Moradia", AGUA: "Água", LUZ: "Luz", INTERNET: "Internet", FIXO: "Fixo",
  TRANSPORTE: "Transporte", SAUDE: "Saúde", EDUCACAO: "Educação", DELIVERY: "Delivery", RESTAURANTE: "Restaurante", LAZER: "Lazer", ROUPAS: "Roupas",
  BELEZA: "Beleza", PRESENTES: "Presentes", ASSINATURAS: "Assinaturas", DIVIDA: "Dívida", CARTAO: "Cartão", MESADA: "Mesada", IMPOSTOS: "Impostos",
  PRO_LABORE: "Pró-labore", LUCROS: "Distribuição de lucros", RENDA: "Renda", VENDAS: "Vendas", SERVICOS: "Serviços", OUTROS: "Outros" };
export const catLabel = (c: string) => CAT_LABEL[c] ?? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ");
export const catOptions = (sel?: string) => [...CATEGORIES, ...(sel && !CATEGORIES.includes(sel) ? [sel] : [])]
  .map(c => `<option value="${esc(c)}" ${c === sel ? "selected" : ""}>${esc(catLabel(c))}</option>`).join("");
export const loadPeople = async () => { st.people = await api<Person[]>("/people"); return st.people; };
export const personOptions = (sel?: string | null, includeInactive = false) =>
  `<option value="">Casa / geral</option>` + st.people.filter(p => p.active || includeInactive || p.id === sel)
    .map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}${p.active ? "" : " (inativa)"}</option>`).join("");
export const personSelect = (sel?: string | null) => `<div><label>Pessoa</label><select name="person">${personOptions(sel)}</select></div>`;

/** Abre um formulário em diálogo. onSubmit retorna false para manter aberto. */
export function openDialog(title: string, body: string, submitLabel: string, onSubmit: (f: FormData) => Promise<boolean | void>) {
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
export const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export function centsOf(f: FormData, k: string, required = true): number | null {
  const v = str(f, k);
  if (!v && !required) return null;
  const c = parseMoney(v);
  if (Number.isNaN(c)) throw new ApiError(400, "INVALID", "Valor inválido. Use, por exemplo, 1.234,56");
  return c;
}
