/**
 * Combinados da família (v2).
 * - Tarefa/hábito (HABIT) atribuída a pessoas, com frequência:
 *     DAILY    todo dia para cada pessoa atribuída
 *     ROTATION revezamento diário entre as pessoas atribuídas (ordem = position)
 *     SPORADIC avulsa: só vale no dia em que um responsável ativar para a pessoa
 *   Cada um marca as suas (hoje e ontem). Dia que passou sem marcar vira falta.
 * - Ocorrência (INFRACTION): só responsáveis registram.
 * - "Apontar o culpado": a falta sai de quem tinha a tarefa e vira ocorrência de quem causou.
 * - Nota do mês = feitas ÷ (devidas + pontos de ocorrência). Mesada = valor × nota (proporcional).
 *   Nota zero aplica a consequência do plano. Multas podem ser descontadas no fechamento.
 * Fica fora do livro financeiro até o fechamento: aí a mesada vira conta a pagar.
 */
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError, weekOf } from "./service.js";
import type { SessionUser } from "./auth.js";
import { todaySP } from "./domain/finance.js";

type U = SessionUser;
type Schedule = "DAILY" | "ROTATION" | "SPORADIC";
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const canJudge = (u: U) => u.role === "ADMIN" || !!u.isGuardian;
const requireJudge = (u: U) => { if (!canJudge(u)) throw new AppError(403, "GUARDIAN_ONLY", "Só os responsáveis podem fazer isso."); };
const requireAdmin = (u: U) => { if (u.role !== "ADMIN") throw new AppError(403, "ADMIN_ONLY", "Só o administrador pode fazer isso."); };
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const nextMonth = (m: string) => { const [y, mo] = m.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10); };

/* ===================== Contexto (regras, atribuições, pessoas) ===================== */
interface RuleRow { id: string; kind: "HABIT" | "INFRACTION"; name: string; points: number; fine_cents: number; schedule: Schedule; active: boolean; starts_on: string; sort: number; description: string | null; }
interface Ctx { rules: RuleRow[]; assigns: Map<string, { personId: string; position: number }[]>; people: { id: string; name: string; since: string }[]; sporadic: Set<string>; }

async function loadCtx(db: Db, from: string, to: string): Promise<Ctx> {
  const rules = (await db.query(`SELECT id, kind, name, points, fine_cents, schedule, active, starts_on::text AS starts_on, sort, description
    FROM conduct_rule WHERE entity_code = 'PERSONAL' ORDER BY sort, name`)).rows as RuleRow[];
  const assigns = new Map<string, { personId: string; position: number }[]>();
  for (const a of (await db.query(`SELECT a.rule_id, a.person_id, a.position FROM conduct_assignment a JOIN person p ON p.id = a.person_id
      WHERE p.active ORDER BY a.position, p.name`)).rows) {
    if (!assigns.has(a.rule_id)) assigns.set(a.rule_id, []);
    assigns.get(a.rule_id)!.push({ personId: a.person_id, position: a.position });
  }
  const people = (await db.query(`SELECT id, name, created_at::date::text AS since FROM person WHERE entity_code = 'PERSONAL' AND active ORDER BY name`)).rows;
  const sporadic = new Set((await db.query(`SELECT rule_id, person_id, day::text AS day FROM conduct_sporadic WHERE day BETWEEN $1 AND $2`, [from, to])).rows
    .map(r => `${r.rule_id}|${r.person_id}|${r.day}`));
  return { rules, assigns, people, sporadic };
}

/** De quem é a vez numa tarefa de revezamento, no dia. */
function rotationPerson(rule: RuleRow, ctx: Ctx, day: string): string | null {
  const list = ctx.assigns.get(rule.id) ?? [];
  if (!list.length) return null;
  const idx = ((daysBetween(rule.starts_on, day) % list.length) + list.length) % list.length;
  return list[idx]!.personId;
}

/** Tarefas devidas por uma pessoa num dia. */
function dueFor(ctx: Ctx, personId: string, day: string): RuleRow[] {
  const person = ctx.people.find(p => p.id === personId);
  if (!person || day < person.since) return [];
  return ctx.rules.filter(r => {
    if (r.kind !== "HABIT" || !r.active || day < r.starts_on) return false;
    if (!(ctx.assigns.get(r.id) ?? []).some(a => a.personId === personId)) return false;
    if (r.schedule === "ROTATION") return rotationPerson(r, ctx, day) === personId;
    if (r.schedule === "SPORADIC") return ctx.sporadic.has(`${r.id}|${personId}|${day}`);
    return true;
  });
}

/* ===================== Regras (o administrador cadastra) ===================== */
const RULE_COLS = `r.id, r.kind, r.name, r.points, r.fine_cents AS "fineCents", r.sort, r.active, r.starts_on AS "startsOn", r.schedule, r.description,
  COALESCE((SELECT json_agg(json_build_object('personId', a.person_id, 'position', a.position) ORDER BY a.position)
            FROM conduct_assignment a WHERE a.rule_id = r.id), '[]') AS assignees`;
export async function listRules(db: Db) {
  return (await db.query(`SELECT ${RULE_COLS} FROM conduct_rule r WHERE r.entity_code = 'PERSONAL' ORDER BY r.kind, r.sort, r.name`)).rows;
}
export interface RuleInput { kind: "HABIT" | "INFRACTION"; name: string; points?: number; fineCents?: number; sort?: number; active?: boolean;
  schedule?: Schedule; description?: string | null; assignees?: { personId: string; position?: number }[]; }

async function saveAssignees(db: Db, ruleId: string, list: { personId: string; position?: number }[]) {
  await db.query("DELETE FROM conduct_assignment WHERE rule_id = $1", [ruleId]);
  for (const [i, a] of list.entries())
    await db.query(`INSERT INTO conduct_assignment (rule_id, person_id, position) SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM person WHERE id = $2 AND entity_code = 'PERSONAL')`, [ruleId, a.personId, a.position ?? i + 1]);
}
export async function createRule(db: Db, u: U, i: RuleInput) {
  requireAdmin(u);
  try {
    // Tarefa nova começa a valer amanhã: ninguém leva falta por um combinado que não existia.
    const r = await db.query(`INSERT INTO conduct_rule (entity_code, kind, name, points, fine_cents, sort, active, starts_on, schedule, description)
      VALUES ('PERSONAL',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [i.kind, i.name.trim(), i.points ?? 1, i.fineCents ?? 0, i.sort ?? 99, i.active ?? true,
       i.kind === "HABIT" ? addDays(todaySP(), 1) : todaySP(), i.schedule ?? "DAILY", i.description?.trim() || null]);
    const id = r.rows[0].id;
    if (i.assignees) await saveAssignees(db, id, i.assignees);
    return (await db.query(`SELECT ${RULE_COLS} FROM conduct_rule r WHERE r.id = $1`, [id])).rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError(409, "DUPLICATE", "Já existe uma regra com esse nome.");
    throw e;
  }
}
export async function updateRule(db: Db, u: U, id: string, p: Partial<Omit<RuleInput, "kind">>) {
  requireAdmin(u);
  const map: Record<string, string> = { name: "name", points: "points", fineCents: "fine_cents", sort: "sort", active: "active", schedule: "schedule", description: "description" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push(k === "name" ? String(p.name).trim() : (p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length + 1}`); }
  if (!sets.length && !p.assignees) throw new AppError(400, "EMPTY", "Nada para alterar.");
  if (sets.length) {
    const r = await db.query(`UPDATE conduct_rule SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, [id, ...vals]);
    if (!r.rowCount) throw new AppError(404, "RULE_NOT_FOUND", "Regra não encontrada.");
  }
  if (p.assignees) await saveAssignees(db, id, p.assignees);
  const out = (await db.query(`SELECT ${RULE_COLS} FROM conduct_rule r WHERE r.id = $1`, [id])).rows[0];
  if (!out) throw new AppError(404, "RULE_NOT_FOUND", "Regra não encontrada.");
  return out; // valores novos valem daqui em diante; o histórico guarda o valor da época
}

/* ===================== Faltas: geradas para os dias que já passaram (idempotente) ===================== */
export async function materializeMisses(db: Db, today = todaySP()) {
  const from = addDays(today, -45), to = addDays(today, -1);
  const ctx = await loadCtx(db, from, to);
  const checks = new Set((await db.query(`SELECT person_id, rule_id, day::text AS day FROM habit_check WHERE day BETWEEN $1 AND $2`, [from, to])).rows
    .map(r => `${r.rule_id}|${r.person_id}|${r.day}`));
  const rows: [string, string, string, number, number, string][] = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    for (const p of ctx.people) for (const r of dueFor(ctx, p.id, d))
      if (!checks.has(`${r.id}|${p.id}|${d}`)) rows.push([p.id, r.id, d, r.points, r.fine_cents, r.name]);
  if (!rows.length) return;
  await db.query(`INSERT INTO conduct_entry (person_id, kind, rule_id, day, points, amount_cents, note)
    SELECT x.person_id, 'HABIT_MISS', x.rule_id, x.day, x.points, x.amount, x.note
    FROM unnest($1::uuid[], $2::uuid[], $3::date[], $4::int[], $5::bigint[], $6::text[]) AS x(person_id, rule_id, day, points, amount, note)
    ON CONFLICT (person_id, rule_id, day) WHERE kind = 'HABIT_MISS' DO NOTHING`,
    [rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2]), rows.map(r => r[3]), rows.map(r => r[4]), rows.map(r => r[5])]);
}

/* ===================== Marcar tarefa ===================== */
export async function setCheck(db: Db, u: U, i: { personId: string; ruleId: string; day: string; checked: boolean }) {
  const today = todaySP();
  if (i.day > today) throw new AppError(422, "FUTURE_DAY", "Não dá para marcar um dia que ainda não chegou.");
  if (!canJudge(u)) {
    if (u.personId !== i.personId) throw new AppError(403, "NOT_YOURS", "Você só marca as suas próprias tarefas.");
    if (i.day < addDays(today, -1)) throw new AppError(422, "TOO_LATE", "Você pode marcar hoje e ontem. Para dias anteriores, fale com um responsável.");
  }
  const rule = (await db.query("SELECT kind, active FROM conduct_rule WHERE id = $1", [i.ruleId])).rows[0];
  if (!rule || rule.kind !== "HABIT" || !rule.active) throw new AppError(422, "RULE_NOT_FOUND", "Tarefa não encontrada.");
  const person = await db.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = 'PERSONAL' AND active", [i.personId]);
  if (!person.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  if (i.checked) {
    await db.query(`INSERT INTO habit_check (person_id, rule_id, day, checked_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [i.personId, i.ruleId, i.day, u.id]);
    await db.query(`UPDATE conduct_entry SET deleted_at = now() WHERE kind = 'HABIT_MISS' AND person_id = $1 AND rule_id = $2 AND day = $3 AND deleted_at IS NULL`, [i.personId, i.ruleId, i.day]);
  } else {
    await db.query(`DELETE FROM habit_check WHERE person_id = $1 AND rule_id = $2 AND day = $3`, [i.personId, i.ruleId, i.day]);
    if (i.day < today) await db.query(`UPDATE conduct_entry SET deleted_at = NULL WHERE kind = 'HABIT_MISS' AND person_id = $1 AND rule_id = $2 AND day = $3`, [i.personId, i.ruleId, i.day]);
  }
  return { ok: true };
}

/** Responsável ativa (ou desativa) uma tarefa avulsa para alguém num dia. */
export async function setSporadic(db: Db, u: U, i: { ruleId: string; personId: string; day: string; active: boolean }) {
  requireJudge(u);
  const r = (await db.query("SELECT schedule FROM conduct_rule WHERE id = $1 AND kind = 'HABIT' AND active", [i.ruleId])).rows[0];
  if (!r || r.schedule !== "SPORADIC") throw new AppError(422, "NOT_SPORADIC", "Só tarefas avulsas são ativadas por dia.");
  if (i.active) await db.query(`INSERT INTO conduct_sporadic (rule_id, person_id, day, assigned_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [i.ruleId, i.personId, i.day, u.id]);
  else {
    await db.query(`DELETE FROM conduct_sporadic WHERE rule_id = $1 AND person_id = $2 AND day = $3`, [i.ruleId, i.personId, i.day]);
    await db.query(`UPDATE conduct_entry SET deleted_at = now() WHERE kind = 'HABIT_MISS' AND rule_id = $1 AND person_id = $2 AND day = $3 AND deleted_at IS NULL`, [i.ruleId, i.personId, i.day]);
  }
  return { ok: true };
}

/**
 * Apontar o culpado: a tarefa de "from" não foi cumprida por causa de "to".
 * "from" fica sem falta (marcado como dispensado pelo responsável); "to" recebe a ocorrência com os pontos e a multa da tarefa.
 */
export async function blame(db: Db, u: U, i: { ruleId: string; day: string; fromPersonId: string; toPersonId: string; note?: string | null }) {
  requireJudge(u);
  if (i.fromPersonId === i.toPersonId) throw new AppError(422, "SAME_PERSON", "Escolha outra pessoa como responsável pela falha.");
  if (i.day > todaySP()) throw new AppError(422, "FUTURE_DAY", "Data no futuro.");
  const r = (await db.query("SELECT name, points, fine_cents FROM conduct_rule WHERE id = $1 AND kind = 'HABIT'", [i.ruleId])).rows[0];
  if (!r) throw new AppError(422, "RULE_NOT_FOUND", "Tarefa não encontrada.");
  const names = new Map((await db.query("SELECT id, name FROM person WHERE id = ANY($1) AND entity_code = 'PERSONAL'", [[i.fromPersonId, i.toPersonId]])).rows.map(x => [x.id, x.name]));
  if (names.size !== 2) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  return withTx(db, async c => {
    await c.query(`INSERT INTO habit_check (person_id, rule_id, day, checked_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [i.fromPersonId, i.ruleId, i.day, u.id]);
    await c.query(`UPDATE conduct_entry SET deleted_at = now() WHERE kind = 'HABIT_MISS' AND person_id = $1 AND rule_id = $2 AND day = $3 AND deleted_at IS NULL`, [i.fromPersonId, i.ruleId, i.day]);
    const note = `${r.name}: falha causada por ${names.get(i.toPersonId)} (era de ${names.get(i.fromPersonId)})${i.note?.trim() ? ` · ${i.note.trim()}` : ""}`;
    const e = await c.query(`INSERT INTO conduct_entry (person_id, kind, rule_id, day, points, amount_cents, note, created_by)
      VALUES ($1, 'INFRACTION', $2, $3, $4, $5, $6, $7) RETURNING id`, [i.toPersonId, i.ruleId, i.day, r.points, r.fine_cents, note, u.id]);
    return { id: e.rows[0].id };
  });
}

/* ===================== Ocorrências, pagamentos e perdões ===================== */
export async function addInfraction(db: Db, u: U, i: { personId: string; ruleId: string; day?: string; note?: string | null }) {
  requireJudge(u);
  const r = (await db.query("SELECT kind, active, points, fine_cents, name FROM conduct_rule WHERE id = $1", [i.ruleId])).rows[0];
  if (!r || r.kind !== "INFRACTION" || !r.active) throw new AppError(422, "RULE_NOT_FOUND", "Ocorrência não encontrada.");
  const day = i.day ?? todaySP();
  if (day > todaySP()) throw new AppError(422, "FUTURE_DAY", "Data no futuro.");
  const ins = await db.query(`INSERT INTO conduct_entry (person_id, kind, rule_id, day, points, amount_cents, note, created_by)
    SELECT $1, 'INFRACTION', $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM person WHERE id = $1 AND entity_code = 'PERSONAL') RETURNING id`,
    [i.personId, i.ruleId, day, r.points, r.fine_cents, i.note?.trim() || r.name, u.id]);
  if (!ins.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  return { id: ins.rows[0].id };
}
export async function settle(db: Db, u: U, i: { personId: string; kind: "PAYMENT" | "WAIVER"; amountCents: number; note?: string | null }) {
  requireAdmin(u);
  const bal = await balanceOf(db, i.personId);
  if (i.amountCents > bal) throw new AppError(422, "OVER_BALANCE", "Valor maior que o saldo de multas da pessoa.");
  await db.query(`INSERT INTO conduct_entry (person_id, kind, day, amount_cents, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [i.personId, i.kind, todaySP(), i.amountCents, i.note?.trim() || (i.kind === "PAYMENT" ? "Multa paga" : "Multa perdoada"), u.id]);
  return { balanceCents: bal - i.amountCents };
}
export async function deleteEntry(db: Db, u: U, id: string) {
  requireJudge(u);
  const r = await db.query(`UPDATE conduct_entry SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND kind IN ('INFRACTION','PAYMENT','WAIVER') RETURNING id`, [id]);
  if (!r.rowCount) throw new AppError(404, "NOT_FOUND", "Registro não encontrado (faltas de tarefa somem marcando a tarefa).");
}
async function balanceOf(db: Db, personId: string): Promise<number> {
  const r = await db.query<{ v: number }>(`SELECT COALESCE(sum(CASE WHEN kind IN ('HABIT_MISS','INFRACTION') THEN amount_cents ELSE -amount_cents END), 0)::bigint AS v
    FROM conduct_entry WHERE person_id = $1 AND deleted_at IS NULL`, [personId]);
  return Number(r.rows[0]!.v);
}

/* ===================== Nota do mês e mesada ===================== */
export interface MonthScore { due: number; done: number; penaltyPoints: number; percent: number; }
async function monthScores(db: Db, month: string, upTo: string): Promise<Map<string, MonthScore>> {
  const from = monthStart(month), last = addDays(nextMonth(month), -1), to = upTo < last ? upTo : last;
  const ctx = await loadCtx(db, from, to);
  const checks = new Set((await db.query(`SELECT person_id, rule_id, day::text AS day FROM habit_check WHERE day BETWEEN $1 AND $2`, [from, to])).rows
    .map(r => `${r.rule_id}|${r.person_id}|${r.day}`));
  const pen = new Map((await db.query(`SELECT person_id, COALESCE(sum(points), 0)::int AS p FROM conduct_entry
    WHERE kind = 'INFRACTION' AND deleted_at IS NULL AND day BETWEEN $1 AND $2 GROUP BY person_id`, [from, to])).rows.map(r => [r.person_id, r.p as number]));
  const out = new Map<string, MonthScore>();
  for (const p of ctx.people) {
    let due = 0, done = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) for (const r of dueFor(ctx, p.id, d)) { due++; if (checks.has(`${r.id}|${p.id}|${d}`)) done++; }
    const penaltyPoints = pen.get(p.id) ?? 0, denom = due + penaltyPoints;
    out.set(p.id, { due, done, penaltyPoints, percent: denom === 0 ? 100 : Math.round((done / denom) * 10000) / 100 });
  }
  return out;
}

export async function setPlan(db: Db, u: U, personId: string, p: { mode: "MONEY" | "STARS" | "NONE"; amountCents?: number; consequence?: string | null; deductFines?: boolean }) {
  requireAdmin(u);
  const ok = await db.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = 'PERSONAL'", [personId]);
  if (!ok.rowCount) throw new AppError(404, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  await db.query(`INSERT INTO allowance_plan (person_id, mode, amount_cents, consequence, deduct_fines) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (person_id) DO UPDATE SET mode = EXCLUDED.mode, amount_cents = EXCLUDED.amount_cents, consequence = EXCLUDED.consequence, deduct_fines = EXCLUDED.deduct_fines`,
    [personId, p.mode, p.mode === "MONEY" ? p.amountCents ?? 0 : 0, p.consequence?.trim() || null, p.deductFines ?? true]);
  return { ok: true };
}

/** Prévia (mês em andamento) ou resultado (mês fechado) da mesada de cada pessoa. */
export async function allowance(db: Db, month = todaySP().slice(0, 7)) {
  const today = todaySP(), m = monthStart(month);
  await materializeMisses(db, today);
  const scores = await monthScores(db, m, today);
  const people = (await db.query(`SELECT p.id, p.name, u.nickname, ap.mode, ap.amount_cents, ap.consequence, ap.deduct_fines
    FROM person p LEFT JOIN allowance_plan ap ON ap.person_id = p.id LEFT JOIN app_user u ON u.person_id = p.id AND u.active
    WHERE p.entity_code = 'PERSONAL' AND p.active ORDER BY p.name`)).rows;
  const closings = new Map((await db.query(`SELECT person_id, percent::float AS percent, payout_cents, fines_deducted_cents, stars, consequence, title_id, created_at
    FROM allowance_closing WHERE month = $1`, [m])).rows.map(r => [r.person_id, r]));
  const out = [];
  for (const p of people) {
    const s = scores.get(p.id) ?? { due: 0, done: 0, penaltyPoints: 0, percent: 100 };
    const mode = (p.mode ?? "NONE") as "MONEY" | "STARS" | "NONE";
    const base = mode === "MONEY" ? Number(p.amount_cents) : 0;
    const gross = Math.round(base * s.percent / 100);
    const fines = await balanceOf(db, p.id);
    const deduct = mode === "MONEY" && p.deduct_fines ? Math.min(fines, gross) : 0;
    const c = closings.get(p.id);
    out.push({
      personId: p.id, name: p.name, nickname: p.nickname, mode, baseCents: base, consequence: p.consequence, deductFines: p.deduct_fines ?? true,
      ...s, grossCents: gross, finesBalanceCents: fines, finesToDeductCents: deduct, payoutCents: gross - deduct,
      stars: mode === "STARS" ? s.done : 0, zeroed: s.due > 0 && s.percent === 0,
      closed: c ? { percent: c.percent, payoutCents: Number(c.payout_cents), finesDeductedCents: Number(c.fines_deducted_cents), stars: c.stars, consequence: c.consequence, titleId: c.title_id, at: c.created_at } : null,
    });
  }
  return { month: m.slice(0, 7), inProgress: today < nextMonth(m), people: out };
}

/** Fecha o mês de uma pessoa: grava o resultado e, se houver dinheiro, cria a conta a pagar da mesada. */
export async function closeMonth(db: Db, u: U, i: { personId: string; month: string; deductFines?: boolean }) {
  requireAdmin(u);
  const m = monthStart(i.month);
  if (m > monthStart(todaySP())) throw new AppError(422, "FUTURE_MONTH", "Esse mês ainda não começou.");
  const a = (await allowance(db, m)).people.find(p => p.personId === i.personId);
  if (!a) throw new AppError(404, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  if (a.closed) throw new AppError(409, "ALREADY_CLOSED", "Esse mês já foi fechado para essa pessoa.");
  const deduct = i.deductFines === false ? 0 : a.finesToDeductCents;
  const payout = a.grossCents - deduct;
  const label = new Date(`${m}T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  return withTx(db, async c => {
    let titleId: string | null = null;
    if (a.mode === "MONEY" && payout > 0) {
      const t = await c.query(`INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, notes, person_id, created_by)
        VALUES ('PERSONAL','PAYABLE','EXPENSE',$1,'MESADA',$2,$3,$3,$4,$5,$6) RETURNING id`,
        [`Mesada ${a.name} · ${label}`, payout, todaySP(), `Nota ${a.percent}% de ${a.baseCents / 100} reais${deduct ? `; multas descontadas ${deduct / 100}` : ""}`, a.personId, u.id]);
      titleId = t.rows[0].id;
    }
    if (deduct > 0) await c.query(`INSERT INTO conduct_entry (person_id, kind, day, amount_cents, note, created_by) VALUES ($1,'PAYMENT',$2,$3,$4,$5)`,
      [a.personId, todaySP(), deduct, `Descontado da mesada de ${label}`, u.id]);
    const consequence = a.zeroed ? a.consequence : null;
    await c.query(`INSERT INTO allowance_closing (person_id, month, mode, percent, done, due, penalty_points, base_cents, fines_deducted_cents, payout_cents, stars, consequence, title_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [a.personId, m, a.mode, a.percent, a.done, a.due, a.penaltyPoints, a.baseCents, deduct, a.mode === "MONEY" ? payout : 0, a.stars, consequence, titleId, u.id]);
    return { percent: a.percent, payoutCents: a.mode === "MONEY" ? payout : 0, finesDeductedCents: deduct, stars: a.stars, consequence, titleId };
  });
}

/* ===================== Visões ===================== */
export async function board(db: Db, date = todaySP()) {
  const today = todaySP();
  await materializeMisses(db, today);
  const w = weekOf(date), to = w.end < today ? w.end : today;
  const ctx = await loadCtx(db, w.start, w.end);
  const checks = (await db.query(`SELECT h.person_id, h.rule_id, h.day::text AS day, h.checked_at, cu.name AS by_name
    FROM habit_check h LEFT JOIN app_user cu ON cu.id = h.checked_by WHERE h.day >= $1 AND h.day < $2`, [w.start, w.next])).rows;
  const entries = (await db.query(`SELECT e.id, e.person_id, e.kind, e.rule_id, e.day::text AS day, e.points, e.amount_cents, e.note, cu.name AS by_name
    FROM conduct_entry e LEFT JOIN app_user cu ON cu.id = e.created_by
    WHERE e.deleted_at IS NULL AND e.day >= $1 AND e.day < $2 ORDER BY e.day DESC, e.created_at DESC`, [w.start, w.next])).rows;
  const people = (await db.query(`SELECT p.id, p.name, u.nickname, u.id AS user_id FROM person p LEFT JOIN app_user u ON u.person_id = p.id AND u.active
    WHERE p.entity_code = 'PERSONAL' AND p.active ORDER BY p.name`)).rows;
  const month = await monthScores(db, monthStart(today), today);
  const names = new Map(people.map(p => [p.id, p.name]));
  const balances = new Map((await db.query<{ person_id: string; v: number }>(`SELECT person_id,
      COALESCE(sum(CASE WHEN kind IN ('HABIT_MISS','INFRACTION') THEN amount_cents ELSE -amount_cents END), 0)::bigint AS v
    FROM conduct_entry WHERE deleted_at IS NULL GROUP BY person_id`)).rows.map(r => [r.person_id, Number(r.v)]));

  const days: string[] = [];
  for (let d = w.start; d <= to; d = addDays(d, 1)) days.push(d);
  const rows = people.map(p => {
    const grid = days.map(day => ({ day, items: dueFor(ctx, p.id, day).map(r => {
      const c = checks.find(x => x.person_id === p.id && x.rule_id === r.id && x.day === day);
      return { ruleId: r.id, name: r.name, schedule: r.schedule, done: !!c, checkedAt: c?.checked_at ?? null, by: c?.by_name ?? null };
    }) }));
    const all = grid.flatMap(g => g.items), mine = entries.filter(e => e.person_id === p.id);
    const fullDays = grid.filter(g => g.items.length && g.items.every(x => x.done)).length;
    return {
      personId: p.id, name: p.name, nickname: p.nickname, hasLogin: !!p.user_id, grid, fullDays,
      daysCounted: grid.filter(g => g.items.length).length, habitsDone: all.filter(x => x.done).length, habitsDue: all.length,
      infractions: mine.filter(e => e.kind === "INFRACTION").length,
      pointsLost: mine.filter(e => e.kind === "HABIT_MISS" || e.kind === "INFRACTION").reduce((s, e) => s + e.points, 0),
      finesWeekCents: mine.filter(e => e.kind === "HABIT_MISS" || e.kind === "INFRACTION").reduce((s, e) => s + Number(e.amount_cents), 0),
      month: month.get(p.id) ?? { due: 0, done: 0, penaltyPoints: 0, percent: 100 },
      balanceCents: balances.get(p.id) ?? 0,
    };
  });
  // Vez de hoje nos revezamentos e tarefas avulsas disponíveis para ativar.
  const rotations = ctx.rules.filter(r => r.kind === "HABIT" && r.active && r.schedule === "ROTATION" && today >= r.starts_on)
    .map(r => ({ ruleId: r.id, name: r.name, today: names.get(rotationPerson(r, ctx, today) ?? "") ?? null, tomorrow: names.get(rotationPerson(r, ctx, addDays(today, 1)) ?? "") ?? null }));
  const sporadic = ctx.rules.filter(r => r.kind === "HABIT" && r.active && r.schedule === "SPORADIC")
    .map(r => ({ ruleId: r.id, name: r.name, people: (ctx.assigns.get(r.id) ?? []).map(a => ({ personId: a.personId, name: names.get(a.personId), activeToday: ctx.sporadic.has(`${r.id}|${a.personId}|${today}`) })) }));
  const best = [...rows].filter(r => r.daysCounted).sort((a, b) => b.fullDays - a.fullDays || a.pointsLost - b.pointsLost)[0];
  return {
    week: { start: w.start, end: w.end }, today, rows, rotations, sporadic,
    mostConsistent: best && best.fullDays > 0 ? best.personId : null,
    entries: entries.map(e => ({ id: e.id, personId: e.person_id, personName: names.get(e.person_id) ?? "?", kind: e.kind, ruleId: e.rule_id, day: e.day,
      points: e.points, amountCents: Number(e.amount_cents), note: e.note, by: e.by_name })),
  };
}

/* ===================== Modelo da família (pré-cadastro) ===================== */
/** Cria as tarefas combinadas e os planos de mesada da família MTSM, ligando pelas pessoas cadastradas. Não duplica. */
export async function applyFamilyTemplate(db: Db, u: U) {
  requireAdmin(u);
  const people = (await db.query("SELECT id, name FROM person WHERE entity_code = 'PERSONAL' AND active")).rows as { id: string; name: string }[];
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const find = (n: string) => people.find(p => norm(p.name).split(/\s+/)[0] === norm(n))?.id;
  const P = { marcos: find("Marcos"), thais: find("Thais"), sara: find("Sara"), maria: find("Maria") };
  const missing = Object.entries(P).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new AppError(422, "MISSING_PEOPLE", `Cadastre antes em Pessoas da casa: ${missing.join(", ")}.`);
  const ids = (ks: (keyof typeof P)[]) => ks.map((k, i) => ({ personId: P[k]!, position: i + 1 }));
  const tasks: { name: string; schedule: Schedule; who: (keyof typeof P)[]; sort: number; description?: string; fine?: number }[] = [
    { name: "Louça", schedule: "ROTATION", who: ["sara", "marcos", "thais"], sort: 1, description: "Revezamento diário." },
    { name: "Ajeitar a casa", schedule: "ROTATION", who: ["sara", "marcos", "thais"], sort: 2, description: "Revezamento diário." },
    { name: "Limpar o quarto", schedule: "DAILY", who: ["sara", "thais", "marcos"], sort: 3, description: "Cada um cuida do seu." },
    { name: "Cuidar da irmã", schedule: "SPORADIC", who: ["sara"], sort: 4, description: "Quando um responsável pedir." },
    { name: "Chegar na escola na hora", schedule: "DAILY", who: ["thais"], sort: 5, description: "Se atrasar por causa de outra pessoa, o responsável aponta o culpado." },
    { name: "Fazer jantar", schedule: "DAILY", who: ["thais"], sort: 6 },
    { name: "Fazer marmita para o almoço", schedule: "DAILY", who: ["thais"], sort: 7 },
    { name: "Dormir antes da meia-noite", schedule: "DAILY", who: ["marcos", "thais", "sara"], sort: 8 },
    { name: "Acordar cedo e apoiar a Thaís na escola", schedule: "DAILY", who: ["marcos"], sort: 9 },
    { name: "Comprar pão pela manhã", schedule: "DAILY", who: ["marcos"], sort: 10 },
    { name: "Escovar os dentes", schedule: "DAILY", who: ["maria"], sort: 20, description: "Trilha da Maria: um responsável marca." },
    { name: "Guardar os brinquedos", schedule: "DAILY", who: ["maria"], sort: 21, description: "Trilha da Maria: um responsável marca." },
    { name: "Dormir no horário", schedule: "DAILY", who: ["maria"], sort: 22, description: "Trilha da Maria: um responsável marca." },
  ];
  const created: string[] = [];
  for (const t of tasks) {
    const exists = await db.query("SELECT 1 FROM conduct_rule WHERE entity_code = 'PERSONAL' AND kind = 'HABIT' AND lower(name) = lower($1)", [t.name]);
    if (exists.rowCount) continue;
    await createRule(db, u, { kind: "HABIT", name: t.name, schedule: t.schedule, sort: t.sort, description: t.description ?? null, points: 1, fineCents: t.fine ?? 0, assignees: ids(t.who) });
    created.push(t.name);
  }
  // Hábitos da versão 1 que não estão no modelo ficam pausados (dá para reativar em Regras).
  const paused = (await db.query(`UPDATE conduct_rule SET active = false WHERE entity_code = 'PERSONAL' AND kind = 'HABIT' AND active
    AND name IN ('Dormiu na hora', 'Estudou', 'Treinou', 'Orou') RETURNING name`)).rows.map(r => r.name);
  const plans: [keyof typeof P, "MONEY" | "STARS" | "NONE", number, string | null][] = [
    ["sara", "MONEY", 20000, "Sem celular"], ["thais", "MONEY", 200000, null], ["maria", "STARS", 0, null], ["marcos", "NONE", 0, null]];
  for (const [k, mode, amount, consequence] of plans)
    await db.query(`INSERT INTO allowance_plan (person_id, mode, amount_cents, consequence) VALUES ($1,$2,$3,$4) ON CONFLICT (person_id) DO NOTHING`, [P[k], mode, amount, consequence]);
  return { created, paused };
}

export { iso };
