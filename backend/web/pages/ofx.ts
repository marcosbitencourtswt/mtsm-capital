/** Gerado ao separar a tela em módulos: pages/ofx. */
import { api } from "../api.js";
import { type Acc, isCashAcc } from "./bancos.js";
import { br, esc, money } from "../fmt.js";
import { catOptions, personOptions, openDialog, str, toast } from "../core.js";

/* ===================== Importar extrato (OFX) ===================== */
export interface StRow { fitid: string; date: string; amountCents: number; memo: string; status: "novo" | "ja_importado" | "ja_lancado";
  action: "despesa" | "receita" | "transferencia" | "ignorar"; category: string; personId: string | null; toAccountId: string | null; hint: string; }
/** OFX de banco brasileiro costuma vir em Windows-1252; sem isso, acentos viram lixo. */
export async function readOfx(file: File) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder("ascii").decode(buf.slice(0, 600));
  if (/CHARSET:\s*1252|ENCODING:\s*USASCII/i.test(head)) return new TextDecoder("windows-1252").decode(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return new TextDecoder("windows-1252").decode(buf); }
}
export async function importStatement(accountId: string, file: File) {
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
