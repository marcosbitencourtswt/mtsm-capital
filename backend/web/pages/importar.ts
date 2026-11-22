/** Gerado ao separar a tela em módulos: pages/importar. */
import { toast, openDialog } from "../core.js";
import { api } from "../api.js";
import { esc } from "../fmt.js";

/* ===================== Importar cadastro ===================== */
export interface ImportRes { dryRun: boolean; created: number; rows: { index: number; status: "novo" | "ja_existe" | "erro"; type: string; label: string; owner: string; summary: string; error?: string }[]; }
export const IMPORT_TYPE: Record<string, string> = { EXPENSE: "Gasto", RECURRENCE: "Automática", CHECKING: "Conta", SAVINGS: "Poupança", INVESTMENT: "Investimento", CARD: "Cartão", LOAN: "Dívida", CASH: "Dinheiro" };
export async function importFile(file: File) {
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
