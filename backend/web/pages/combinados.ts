/** Gerado ao separar a tela em módulos: pages/combinados. */
import { esc, br, today, money, monthLabel, moneyInput } from "../fmt.js";
import { st, isGuardian, isAdmin, openDialog, str, centsOf, toast, dlgForm } from "../core.js";
import { nick } from "./ranking.js";
import { getEntity, api } from "../api.js";
import { currentSub, pushCard } from "./push.js";

/* ===================== Combinados ===================== */
export interface Item { ruleId: string; name: string; schedule: "DAILY" | "ROTATION" | "SPORADIC"; done: boolean; pending?: boolean; checkedAt: string | null; by: string | null; }
export interface Pending { personId: string; personName: string; ruleId: string; ruleName: string; day: string; }
/** Card de aprovações para os responsáveis: o que a criança marcou e ainda não conta na nota. */
export function pendingCard(list: Pending[]) {
  if (!list.length) return "";
  return `<div class="card pending-card"><div class="row spread"><h3 style="margin:0">Aguardando sua aprovação (${list.length})</h3></div>
    <ul class="imp">${list.map(p => `<li><div><b>${esc(p.personName)}</b> · ${esc(p.ruleName)} <span class="muted">· ${br(p.day)}</span></div>
      <div class="row"><button class="sm" data-review="${p.ruleId}" data-person="${p.personId}" data-day="${p.day}" data-val="true">Aprovar</button>
        <button class="ghost sm" data-review="${p.ruleId}" data-person="${p.personId}" data-day="${p.day}" data-val="false">Recusar</button></div></li>`).join("")}</ul>
    ${list.length > 1 ? `<div class="row"><button class="ghost sm" data-reviewall>Aprovar todos</button></div>` : ""}</div>`;
}
export interface Score { due: number; done: number; penaltyPoints: number; percent: number; }
export interface BoardRow { personId: string; name: string; nickname: string | null; hasLogin: boolean; grid: { day: string; items: Item[] }[]; fullDays: number; daysCounted: number;
  habitsDone: number; habitsDue: number; infractions: number; pointsLost: number; finesWeekCents: number; balanceCents: number; month: Score; }
export interface Board { week: { start: string; end: string }; today: string; rows: BoardRow[]; mostConsistent: string | null;
  rotations: { ruleId: string; name: string; today: string | null; tomorrow: string | null }[];
  sporadic: { ruleId: string; name: string; people: { personId: string; name: string; activeToday: boolean }[] }[];
  entries: { id: string; personId: string; personName: string; kind: "HABIT_MISS" | "INFRACTION" | "PAYMENT" | "WAIVER"; ruleId: string | null; day: string; points: number; amountCents: number; note: string | null; by: string | null }[]; }
export interface Rule { id: string; kind: "HABIT" | "INFRACTION"; name: string; points: number; fineCents: number; sort: number; active: boolean;
  schedule: "DAILY" | "ROTATION" | "SPORADIC"; description: string | null; assignees: { personId: string; position: number }[]; }
export interface Allow { personId: string; name: string; nickname: string | null; mode: "MONEY" | "STARS" | "NONE"; baseCents: number; consequence: string | null; deductFines: boolean;
  due: number; done: number; penaltyPoints: number; percent: number; grossCents: number; finesBalanceCents: number; finesToDeductCents: number; payoutCents: number;
  stars: number; zeroed: boolean; closed: null | { percent: number; payoutCents: number; finesDeductedCents: number; stars: number; consequence: string | null }; }
export interface AllowanceResp { month: string; inProgress: boolean; people: Allow[]; }

export const SCHED: Record<string, string> = { DAILY: "Todo dia", ROTATION: "Revezamento", SPORADIC: "Avulsa" };
export const dayOf = (r: BoardRow, day: string) => r.grid.find(g => g.day === day);
export const dots = (items: Item[] | undefined) => items && items.length ? `<span class="dots" role="img" aria-label="${items.filter(c => c.done).length} de ${items.length} tarefas">${
  items.map(c => `<i class="${c.done ? "on" : c.pending ? "wait" : ""}" title="${esc(c.name)}${c.done ? " ✓" : c.pending ? " (aguardando aprovação)" : ""}"></i>`).join("")}</span>` : `<span class="muted">—</span>`;
export const pctBar = (p: number) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p))}%;background:${p >= 70 ? "var(--success)" : p >= 40 ? "var(--warning)" : "var(--danger)"}"></i></div>`;
export const fmtPct = (p: number) => `${p.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
export const stars = (n: number) => n ? `${"★".repeat(Math.min(n, 30))}${n > 30 ? ` +${n - 30}` : ""}` : "nenhuma ainda";

/** Painel: tarefas de hoje de todo mundo + cobrança para quem está logado. */
export function todayCard(b: Board) {
  if (!b.rows.some(r => dayOf(r, b.today)?.items.length)) return "";
  const meRow = b.rows.find(r => r.personId === st.me?.personId);
  const missing = meRow ? (dayOf(meRow, b.today)?.items ?? []).filter(i => !i.done && !i.pending) : [];
  return `${missing.length ? `<div class="alert danger"><b>Seus combinados de hoje:</b> falta ${missing.map(h => esc(h.name)).join(", ")}.
      <button class="sm" data-goto="combinados">Marcar agora</button></div>` : ""}
    <div class="card"><div class="row spread"><h3 style="margin:0">Combinados de hoje</h3><button class="ghost sm" data-goto="combinados">Ver tudo</button></div>
    ${b.rotations.length ? `<p class="muted" style="margin:8px 0 0">${b.rotations.map(r => `${esc(r.name)}: <b>${esc(r.today ?? "—")}</b>`).join(" · ")}</p>` : ""}
    <div class="today-list">${b.rows.filter(r => dayOf(r, b.today)?.items.length).map(r => `<div><span>${esc(r.name)}${nick(r.nickname)}</span>${dots(dayOf(r, b.today)?.items)}</div>`).join("")}</div></div>`;
} // "" = família; senão id da pessoa
export async function combinadosPage() {
  if (getEntity() !== "personal") return `<div class="empty">Os Combinados são da família (entidade Pessoal).</div>`;
  const [b, rules, al] = await Promise.all([api<Board>(`/conduct/board?date=${st.cbDate}`), api<Rule[]>("/conduct/rules"), api<AllowanceResp>("/conduct/allowance")]);
  if (!st.cbView && st.me?.personId && b.rows.some(r => r.personId === st.me!.personId) && !isGuardian()) st.cbView = st.me.personId;
  if (st.me?.conductOnly && st.cbView !== "" && st.cbView !== st.me.personId) st.cbView = st.me.personId ?? "";
  const pushTop = st.me?.conductOnly && !(await currentSub()) ? await pushCard() : "";
  const tabs = `<div class="person-tabs" role="tablist">
    <button role="tab" class="${st.cbView === "" ? "on" : ""}" data-cbperson="">Família</button>
    ${b.rows.filter(r => !st.me?.conductOnly || r.personId === st.me.personId).map(r => `<button role="tab" class="${st.cbView === r.personId ? "on" : ""}" data-cbperson="${r.personId}">${esc(r.name)}${r.personId === st.me?.personId ? " (eu)" : ""}</button>`).join("")}
    ${isAdmin() ? `<button role="tab" class="${st.cbView === "admin" ? "on" : ""}" data-cbperson="admin">Regras e mesadas</button>` : ""}</div>`;
  if (st.cbView === "admin" && isAdmin()) return tabs + await combinadosAdmin(rules, al);
  if (isGuardian()) { st.pendingCache = await api<Pending[]>("/conduct/pending").catch(() => []); if (st.cbView === "") return tabs + pendingCard(st.pendingCache) + familyView(b, al); }
  const row = b.rows.find(r => r.personId === st.cbView);
  return pushTop + tabs + (row ? personView(b, row, al.people.find(a => a.personId === row.personId)) : familyView(b, al));
}

export function weekNav(b: Board) {
  return `<div class="weeknav"><button class="ghost sm" data-cbweek="-7" aria-label="Semana anterior">◀</button><b>${br(b.week.start)} a ${br(b.week.end)}</b>
    <button class="ghost sm" data-cbweek="7" aria-label="Próxima semana">▶</button>${st.cbDate !== today() ? `<button class="ghost sm" data-cbweek="0">Esta semana</button>` : ""}
    ${isGuardian() ? `<button class="sm" data-infraction style="margin-left:auto">Registrar ocorrência</button>` : ""}</div>`;
}
export function rewardLine(a: Allow | undefined) {
  if (!a || a.mode === "NONE") return `<span class="muted">Participa da nota, sem mesada.</span>`;
  if (a.mode === "STARS") return `<span class="stars" aria-label="${a.stars} estrelas">${stars(a.stars)}</span>`;
  return `Previsão da mesada: <b>${money(a.payoutCents)}</b> <span class="muted">de ${money(a.baseCents)}${a.finesToDeductCents ? ` · −${money(a.finesToDeductCents)} de multas` : ""}</span>`;
}

export function familyView(b: Board, al: AllowanceResp) {
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

export function personView(b: Board, r: BoardRow, a: Allow | undefined) {
  const self = r.personId === st.me?.personId, canMark = self || isGuardian();
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

export async function combinadosAdmin(rules: Rule[], al: AllowanceResp) {
  const names = new Map(st.people.map(p => [p.id, p.name]));
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

export function ruleForm(r?: Rule) {
  const pos = new Map((r?.assignees ?? []).map(a => [a.personId, a.position]));
  return `<div class="full"><label>Nome</label><input name="name" required maxlength="80" value="${esc(r?.name)}"></div>
    ${r ? "" : `<div class="full"><label>Tipo</label><select name="kind"><option value="HABIT">Tarefa / hábito (a pessoa marca)</option><option value="INFRACTION">Ocorrência (responsável registra)</option></select></div>`}
    ${!r || r.kind === "HABIT" ? `<div class="full" data-habit><label>Frequência</label><select name="schedule">
      ${(["DAILY", "ROTATION", "SPORADIC"] as const).map(s => `<option value="${s}" ${r?.schedule === s ? "selected" : ""}>${s === "DAILY" ? "Todo dia (cada pessoa marcada)" : s === "ROTATION" ? "Revezamento diário (um por dia, na ordem)" : "Avulsa (responsável ativa no dia)"}</option>`).join("")}</select></div>
    <div class="full" data-habit><label>Quem faz (e a ordem do revezamento)</label><div class="assignees">${st.people.filter(p => p.active).map(p => `<label class="inline">
      <input type="checkbox" name="who" value="${p.id}" ${pos.has(p.id) ? "checked" : ""}> ${esc(p.name)}
      <input type="number" name="pos_${p.id}" min="1" max="20" value="${pos.get(p.id) ?? ""}" placeholder="ordem" style="width:72px;height:32px"></label>`).join("")}</div></div>` : ""}
    <div><label>Pontos perdidos</label><input name="pts" type="number" min="0" max="1000" value="${r?.points ?? 1}"></div>
    <div><label>Multa (R$)</label><input name="fine" inputmode="decimal" value="${r ? moneyInput(r.fineCents) : "0,00"}"></div>
    <div class="full"><label>Observação</label><input name="desc" maxlength="200" value="${esc(r?.description)}"></div>
    ${r ? `<label class="inline full"><input type="checkbox" name="active" ${r.active ? "checked" : ""}> Ativa</label>` : `<p class="muted full">Tarefa nova começa a valer amanhã.</p>`}`;
}
export async function editRule(id?: string) {
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
export async function planDialog(personId: string) {
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
export async function closeDialog(personId: string, month: string) {
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
export async function infractionDialog() {
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
export async function blameDialog(ruleId: string, fromPersonId: string, day: string) {
  const b = await api<Board>("/conduct/board"); const from = b.rows.find(r => r.personId === fromPersonId);
  openDialog("Apontar o culpado", `<p class="muted full">A tarefa de ${esc(from?.name ?? "")} em ${br(day)} não foi cumprida por causa de outra pessoa. ${esc(from?.name ?? "")} fica sem a falta; quem causou recebe a ocorrência com os pontos e a multa da tarefa.</p>
    <div class="full"><label>Quem causou</label><select name="to" required>${b.rows.filter(r => r.personId !== fromPersonId).map(r => `<option value="${r.personId}">${esc(r.name)}</option>`).join("")}</select></div>
    <div class="full"><label>O que aconteceu</label><input name="n" maxlength="200" placeholder="ex.: demorou para se arrumar"></div>`, "Confirmar", async f => {
    await api("/conduct/blame", { method: "POST", body: { ruleId, day, fromPersonId, toPersonId: str(f, "to"), note: str(f, "n") || null } });
    toast("Culpa transferida.");
  });
}
export function settleDialog(personId: string, bal: number) {
  openDialog("Quitar multas", `<p class="muted full">Saldo de multas: <b>${money(bal)}</b></p>
    <div><label>Valor (R$)</label><input name="v" inputmode="decimal" value="${moneyInput(bal)}" required></div>
    <div><label>Como</label><select name="k"><option value="PAYMENT">Pagou</option><option value="WAIVER">Perdoar</option></select></div>
    <div class="full"><label>Observação</label><input name="n" maxlength="200" placeholder="opcional"></div>`, "Confirmar", async f => {
    await api("/conduct/settle", { method: "POST", body: { personId, kind: str(f, "k"), amountCents: centsOf(f, "v"), note: str(f, "n") || null } });
    toast("Saldo de multas atualizado.");
  });
}
