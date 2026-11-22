/** Gerado ao separar a tela em módulos: pages/admin. */
import { st, isRoot, openDialog, str, toast, isAdmin } from "../core.js";
import { root } from "../api.js";
import { esc, br } from "../fmt.js";
import { nick } from "./ranking.js";
import { tokenCard } from "./cupons.js";

/* ===================== Usuários (administrador) ===================== */
export interface UserRow { id: string; email: string; name: string; nickname: string | null; role: "ADMIN" | "MEMBER"; personId: string | null; isGuardian: boolean; isRoot: boolean; active: boolean; mustChangePassword: boolean; lastLoginAt: string | null; totpEnabled?: boolean; conductOnly?: boolean; }
export async function usersSection() {
  st.usersCache = await root<UserRow[]>("/admin/users");
  return `<div class="row spread" style="margin-top:24px"><h2>Usuários</h2><button data-newuser>+ Novo usuário</button></div>
  <p class="muted">Cada pessoa entra com e-mail e senha. Você cria a conta com uma senha provisória; no primeiro acesso ela troca.</p>
  <div class="list">${st.usersCache.map(u => `<div class="item">
    <div class="head"><span class="who">${esc(u.name)}${nick(u.nickname)}</span><span class="chip${u.isRoot ? " NO_VALUE" : ""}">${u.isRoot ? "Root" : u.role === "ADMIN" ? "Administrador" : u.isGuardian ? "Responsável" : "Membro"}</span></div>
    <div class="meta"><span class="muted">${esc(u.email)}</span>${u.active ? "" : `<span class="chip OVERDUE">desativado</span>`}
      ${u.mustChangePassword ? `<span class="chip NO_VALUE">senha provisória</span>` : ""}${u.totpEnabled ? `<span class="chip SETTLED">2 etapas</span>` : ""}${u.conductOnly ? `<span class="chip">só combinados</span>` : ""}
      <span class="muted">último acesso: ${u.lastLoginAt ? br(u.lastLoginAt) : "nunca"}</span></div>
    ${u.id !== st.me?.id && !u.isRoot && (isRoot() || u.role !== "ADMIN") ? `<div class="actions"><button class="ghost sm" data-edituser="${u.id}">Editar</button><button class="ghost sm" data-resetuser="${u.id}">Nova senha</button>${u.totpEnabled ? `<button class="ghost sm" data-reset2fa="${u.id}">Zerar 2 etapas</button>` : ""}
      <button class="ghost sm" data-toggleuser="${u.id}" data-active="${u.active}">${u.active ? "Desativar" : "Reativar"}</button></div>` : ""}
  </div>`).join("")}</div>`;
}
export function userForm(u?: UserRow) {
  return `<div class="full"><label>Nome</label><input name="name" required value="${esc(u?.name)}"></div>
    <div class="full"><label>E-mail</label><input name="email" type="email" required value="${esc(u?.email)}"></div>
    <div><label>Apelido</label><input name="nick" placeholder="ex.: Gastadora" value="${esc(u?.nickname)}"></div>
    <div><label>Perfil</label><select name="role"><option value="MEMBER" ${u?.role === "MEMBER" ? "selected" : ""}>Membro</option>${isRoot() ? `<option value="ADMIN" ${u?.role === "ADMIN" ? "selected" : ""}>Administrador</option>` : ""}</select></div>
    <label class="inline full"><input type="checkbox" name="guard" ${u?.isGuardian ? "checked" : ""}> Responsável (registra ocorrências e corrige hábitos)</label>
    <label class="inline full"><input type="checkbox" name="conly" ${u?.conductOnly ? "checked" : ""}> Só combinados (vê e marca só as tarefas e a mesada dela; nada de finanças)</label>
    <div class="full"><label>É quem em Pessoas da casa</label><select name="person"><option value="">—</option>${st.people.map(p => `<option value="${p.id}" ${u?.personId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    ${u ? "" : `<div class="full"><label>Senha provisória (mín. 10 caracteres)</label><input name="pw" type="text" minlength="10" required autocomplete="off"></div>`}`;
}
export function newUser() {
  openDialog("Novo usuário", userForm(), "Criar", async f => {
    await root("/admin/users", { method: "POST", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard") && !f.has("conly"), conductOnly: f.has("conly"), password: str(f, "pw") } });
    toast("Usuário criado. Passe a senha provisória pessoalmente.");
  });
}
export function editUser(id: string) {
  const u = st.usersCache.find(x => x.id === id); if (!u) return;
  openDialog("Editar usuário", userForm(u), "Salvar", async f => {
    await root(`/admin/users/${id}`, { method: "PATCH", body: { name: str(f, "name"), email: str(f, "email"), nickname: str(f, "nick") || null,
      role: str(f, "role"), personId: str(f, "person") || null, isGuardian: f.has("guard") && !f.has("conly"), conductOnly: f.has("conly") } });
    toast("Usuário alterado.");
  });
}
export function resetUser(id: string) {
  const u = st.usersCache.find(x => x.id === id); if (!u) return;
  openDialog(`Nova senha · ${u.name}`, `<div class="full"><label>Senha provisória (mín. 10 caracteres)</label><input name="pw" type="text" minlength="10" required autocomplete="off"></div>
    <p class="muted full">A pessoa sai de todos os aparelhos e troca a senha no próximo acesso.</p>`, "Definir", async f => {
    await root(`/admin/users/${id}`, { method: "PATCH", body: { password: str(f, "pw") } });
    toast("Senha provisória definida.");
  });
}

/* ===================== Administração ===================== */
export interface Status { ok: boolean; dbLatencyMs: number; database: { version: string; size: string }; counts: Record<string, number>;
  migrations: { name: string; appliedAt: string }[]; runtime: { node: string; vercel: boolean; region: string | null; commit: string | null }; }
export interface Sess { id: string; name: string; email: string; isRoot: boolean; device: string; lastSeenAt: string; createdAt: string; current: boolean; }
export interface Audit { id: number; at: string; who: string; what: string; action: string; label: string; changed: string[]; }
export const AREAS: [string, string][] = [["", "Tudo"], ["contas", "Contas"], ["pagamentos", "Pagamentos"], ["bancos", "Bancos e dívidas"], ["transferencias", "Transferências"],
  ["combinados", "Combinados"], ["pessoas", "Pessoas e usuários"], ["ajustes", "Ajustes"]];
export const dt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export async function adminPage() {
  if (!isAdmin()) return `<div class="empty">Área só para administradores.</div>`;
  const aq = new URLSearchParams(Object.entries({ limit: "60", ...st.auditQ }).filter(([, v]) => v));
  const [stData, sessions, log, ret] = await Promise.all([root<Status>("/admin/status"), root<Sess[]>("/admin/sessions"), root<Audit[]>(`/admin/audit?${aq}`),
    root<{ months: number }>("/admin/audit/retention")]);
  const c = stData.counts;
  const kpi = (l: string, v: string | number) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  return `<div class="alert ${stData.ok ? "ok" : "danger"}"><b>${stData.ok ? "Sistema funcionando" : "Problema no sistema"}</b> · banco PostgreSQL ${esc(stData.database.version)} · ${esc(stData.database.size)} · resposta ${stData.dbLatencyMs} ms
      ${stData.runtime.vercel ? `· Vercel ${esc(stData.runtime.region ?? "")}${stData.runtime.commit ? ` · versão ${esc(stData.runtime.commit)}` : ""}` : "· servidor local"}</div>
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
      <div><label>Quem</label><select name="actor"><option value="">Todos</option>${st.usersCache.map(u => `<option value="${u.id}" ${st.auditQ.actor === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}
        <option value="system" ${st.auditQ.actor === "system" ? "selected" : ""}>Sistema (automático)</option></select></div>
      <div><label>O quê</label><select name="area">${AREAS.map(([v, l]) => `<option value="${v}" ${st.auditQ.area === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label>De</label><input name="from" type="date" value="${st.auditQ.from}"></div>
      <div><label>Até</label><input name="to" type="date" value="${st.auditQ.to}"></div>
      <div><button>Filtrar</button></div>
    </form>
    <div class="card">${log.length ? `<ul class="pays">${log.map(l => `<li><span><b>${esc(l.who)}</b> ${esc(l.action)} <b>${esc(l.what.toLowerCase())}</b>${l.label ? `: ${esc(l.label)}` : ""}${l.changed.length ? ` <span class="muted">(${l.changed.slice(0, 5).map(esc).join(", ")})</span>` : ""}</span><span class="muted">${dt(l.at)}</span></li>`).join("")}</ul>` : `<p class="muted">Nada encontrado com esses filtros.</p>`}</div>
    ${isRoot() ? `<form class="form card" id="ret-f"><div><label>Guardar o registro por (meses, 0 = sem limite)</label><input name="m" type="number" min="0" max="600" value="${ret.months}" required></div>
      <div><button class="ghost">Salvar</button></div><p class="muted full">Recomendado: 0 (sem limite). Se limitar, o que sair do banco fica só nas cópias mensais permanentes do backup.</p></form>` : ""}
    ${isRoot() ? await tokenCard() : ""}
    <details class="card"><summary>Versão do banco (${stData.migrations.length} atualizações aplicadas)</summary><ul class="pays">${stData.migrations.map(m => `<li><span>${esc(m.name)}</span><span class="muted">${dt(m.appliedAt)}</span></li>`).join("")}</ul></details>`;
}
