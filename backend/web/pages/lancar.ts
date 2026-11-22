/**
 * Lançar gasto: UM formulário só para "já gastei" e "tenho que pagar".
 * - "Já paguei com <conta/cartão>" → gasto realizado (sai da conta ou entra na fatura do cartão).
 * - "Ainda não paguei" → conta em "Contas a pagar", com vencimento.
 * Também a calculadora de juros (conta feita no próprio aparelho, nada vai para o servidor).
 */
import { api } from "../api.js";
import { st, catOptions, personSelect, str, centsOf, $ } from "../core.js";
import { esc, money, today } from "../fmt.js";
import { type Acc, isCashAcc } from "./bancos.js";
import { calcJuros } from "../juros.js";

const accLabel = (a: Acc) => `${esc(a.institution ? `${a.institution} · ${a.name}` : a.name)}${a.ownerName ? ` (${esc(a.ownerName)})` : ""}`;

export function expenseFields(accs: Acc[], o: { later?: boolean } = {}) {
  const live = accs.filter(a => a.active);
  const cash = live.filter(a => isCashAcc(a.type)).map(a => `<option value="acc:${a.id}">${accLabel(a)}</option>`).join("");
  const card = live.filter(a => a.type === "CARD").map(a => `<option value="card:${a.id}">Cartão ${accLabel(a)}</option>`).join("");
  const later = !!o.later, hide = (h: boolean) => (h ? ` style="display:none"` : "");
  return `
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" placeholder="0,00" required></div>
    <div><label>O quê</label><input name="d" placeholder="ex.: mercado, conta de luz" maxlength="120" required></div>
    <div class="full"><label>Pagamento</label><select name="src" data-src>
      <option value="later" ${later ? "selected" : ""}>Ainda não paguei (vai para Contas a pagar)</option>
      <optgroup label="Já paguei com">${cash}${card}<option value="" ${later ? "" : "selected"}>Já paguei (não sei com qual conta)</option></optgroup>
    </select></div>
    <div data-paid${hide(later)}><label>Data do gasto</label><input name="dt" type="date" value="${today()}"></div>
    <div data-due${hide(!later)}><label>Vence em</label><input name="due" type="date"></div>
    <div><label>Categoria</label><select name="c">${catOptions(later ? "OUTROS" : "ALIMENTACAO")}</select></div>
    ${personSelect(st.me?.personId ?? null)}`;
}

/** Mostra "Vence em" só quando ainda não pagou (vale no Painel e no diálogo). */
document.addEventListener("change", e => {
  const t = e.target as HTMLSelectElement;
  if (!t.matches?.("select[data-src]")) return;
  const form = t.closest("form"), later = t.value === "later";
  form?.querySelectorAll<HTMLElement>("[data-due]").forEach(el => (el.style.display = later ? "" : "none"));
  form?.querySelectorAll<HTMLElement>("[data-paid]").forEach(el => (el.style.display = later ? "none" : ""));
});

export async function submitExpense(f: FormData): Promise<{ msg: string; warn: boolean }> {
  const src = str(f, "src"), personId = str(f, "person") || null;
  if (src === "later") {
    await api("/titles", { method: "POST", body: { kind: "PAYABLE", nature: "EXPENSE", counterparty: str(f, "d"), category: str(f, "c"),
      amountCents: centsOf(f, "v"), dueDate: str(f, "due") || null, personId } });
    return { msg: "Conta lançada em Contas a pagar.", warn: false };
  }
  const via = src.startsWith("acc:") ? { accountId: src.slice(4) } : src.startsWith("card:") ? { cardAccountId: src.slice(5) } : {};
  const r = await api<{ guard: { allowed: boolean; message: string } }>("/expenses/quick", { method: "POST", body: {
    amountCents: centsOf(f, "v"), description: str(f, "d"), category: str(f, "c"), date: str(f, "dt") || undefined, personId, ...via } });
  if (!r.guard.allowed) return { msg: `Registrado com aviso: ${r.guard.message}`, warn: true };
  return { msg: "cardAccountId" in via ? "Gasto registrado na fatura do cartão." : "Gasto registrado.", warn: false };
}

/* ===================== Calculadora de juros ===================== */
export function jurosCard() {
  return `<div class="card"><h3>Calculadora de juros</h3>
    <p class="muted">Informe o valor que você recebeu e a parcela (ou a taxa). O cálculo é feito aqui no aparelho.</p>
    <form class="form" id="juros">
      <div><label>Valor que recebi (R$)</label><input name="pv" inputmode="decimal" placeholder="ex.: 1.000,00" required></div>
      <div><label>Nº de parcelas</label><input name="n" inputmode="numeric" placeholder="ex.: 12" required></div>
      <div><label>Valor da parcela (R$)</label><input name="pmt" inputmode="decimal" placeholder="se souber"></div>
      <div><label>ou Taxa (% ao mês)</label><input name="rate" inputmode="decimal" placeholder="se souber"></div>
      <div><label>Parcelas que faltam</label><input name="left" inputmode="numeric" placeholder="para quitar antes"></div>
      <div><button>Calcular</button></div>
    </form><div id="juros-out"></div></div>`;
}

const pctTxt = (x: number) => `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
export function runJuros(form: HTMLFormElement) {
  const f = new FormData(form), out = $("#juros-out");
  const int = (k: string) => { const v = str(f, k); if (!v) return null; const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 600 ? n : NaN; };
  const pv = centsOf(f, "pv")!, n = int("n"), pmt = centsOf(f, "pmt", false), left = int("left");
  const rateRaw = str(f, "rate"), rate = rateRaw ? Number(rateRaw.replace(",", ".")) / 100 : null;
  const bad = (m: string) => { out.innerHTML = `<div class="alert danger">${m}</div>`; };
  if (!pv || pv <= 0) return bad("Informe o valor recebido.");
  if (n == null || Number.isNaN(n)) return bad("Nº de parcelas inválido.");
  if (left != null && (Number.isNaN(left) || left > n)) return bad("Parcelas que faltam: precisa ser entre 1 e o nº de parcelas.");
  if (pmt == null && (rate == null || !Number.isFinite(rate) || rate < 0)) return bad("Informe a parcela ou a taxa ao mês.");
  if (pmt != null && pmt <= 0) return bad("Parcela inválida.");
  const r = calcJuros(pv, n, pmt, rate, left);
  out.innerHTML = `<div class="grid" style="margin:8px 0 0">
      <div class="kpi"><div class="l">Taxa ao mês</div><div class="v">${pctTxt(r.rateMonth)}</div></div>
      <div class="kpi"><div class="l">Taxa ao ano</div><div class="v">${pctTxt(r.rateYear)}</div></div>
      <div class="kpi"><div class="l">Parcela</div><div class="v">${money(r.pmtCents)}</div></div>
      <div class="kpi"><div class="l">Juros no total</div><div class="v neg">${money(r.interestCents)}</div></div></div>
    <p class="muted">Você paga ${money(r.totalCents)} por ${money(pv)} recebidos.${r.rateMonth === 0 ? " Sem juros." : ""}</p>
    ${r.payoff ? `<div class="alert"><b>Quitar hoje as ${r.payoff.left} parcelas que faltam:</b> deveria custar perto de ${money(r.payoff.todayCents)}
      (em vez de ${money(r.payoff.nominalCents)}). Economia de cerca de <b>${money(r.payoff.savedCents)}</b>. Peça o valor exato ao credor: a lei garante desconto dos juros ao antecipar.</div>` : ""}
    <p class="muted">Estimativa (tabela Price). O valor do contrato pode variar com IOF, seguros e tarifas.</p>`;
}
