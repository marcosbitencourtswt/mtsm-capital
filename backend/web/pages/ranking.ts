/** Gerado ao separar a tela em módulos: pages/ranking. */
import { esc, money, br, today } from "../fmt.js";
import { getEntity, api } from "../api.js";
import { st, catLabel, isAdmin, openDialog, CATEGORIES, toast } from "../core.js";

/* ===================== Ranking ===================== */
export interface RankRow { personId: string | null; name: string; nickname: string | null; totalCents: number; allCents: number; mandatoryCents: number; count: number; previousCents: number; topCategories: { category: string; cents: number }[]; }
export interface Ranking { week: { start: string; end: string }; mandatoryCategories: string[]; totalCents: number; mandatoryCents: number; board: RankRow[];
  items: { titleId: string; counterparty: string; category: string; personName: string | null; amountCents: number; paidOn: string; mandatory: boolean; reviewed: boolean }[];
  history: { weekStart: string; byPerson: Record<string, number> }[]; }
export const nick = (n: string | null) => (n ? `<span class="nick">${esc(n)}</span>` : "");

/** KPIs do Painel: quem mais e quem menos gastou na semana, SOMANDO os obrigatórios. */
export function spendKpis(rk: Ranking) {
  const people = rk.board.filter(r => r.personId).sort((a, b) => b.allCents - a.allCents);
  if (people.length < 2) return "";
  const most = people[0]!, least = people[people.length - 1]!;
  const card = (label: string, r: RankRow, hero: boolean) => `<div class="card kpi${hero ? " hero" : ""}"><div class="l">${label}</div>
    <div class="v">${money(r.allCents)}</div><div class="who-line"><b>${esc(r.name)}</b>${nick(r.nickname)} · ${money(r.mandatoryCents)} obrigatório, ${money(r.totalCents)} fora</div></div>`;
  return `<div class="grid">${card("Quem mais gastou · semana", most, false)}${card("Quem menos gastou · semana", least, false)}</div>`;
}
export async function rankingPage() {
  if (getEntity() !== "personal") return `<div class="empty">O ranking é da família (entidade Pessoal).</div>`;
  const rk = await api<Ranking>(`/ranking?date=${st.rkDate}`);
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
    ${st.rkDate !== today() ? `<button class="ghost sm" data-rkweek="0">Esta semana</button>` : ""}</div>
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
export function editCats(current: string[]) {
  openDialog("Categorias obrigatórias", `<p class="muted full">Gastos nessas categorias não entram no ranking.</p>
    <div class="full cats">${CATEGORIES.filter(c => c !== "RENDA").map(c => `<label class="inline"><input type="checkbox" name="c" value="${c}" ${current.includes(c) ? "checked" : ""}> ${c}</label>`).join("")}</div>`,
    "Salvar", async f => {
      await api("/settings/mandatory-categories", { method: "PUT", body: { categories: f.getAll("c").map(String) } });
      toast("Categorias atualizadas.");
    });
}
