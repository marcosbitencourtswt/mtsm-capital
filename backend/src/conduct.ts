/**
 * Combinados da família.
 * - Hábitos (HABIT): cada pessoa marca os seus no dia (hoje ou ontem). Dia que passou sem marcar vira falta.
 * - Ocorrências (INFRACTION): só responsáveis registram.
 * - Cada regra tem pontos e multa (centavos). Multas formam um saldo por pessoa, quitado por pagamento ou perdão.
 * Fica fora do livro financeiro da casa: multa entre família não é despesa nem receita.
 */
import type { Db } from "./db.js";
import { AppError, weekOf } from "./service.js";
import type { SessionUser } from "./auth.js";
import { todaySP } from "./domain/finance.js";

type U = SessionUser & { isGuardian?: boolean };
const addDays = (d: string, n: number) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const canJudge = (u: U) => u.role === "ADMIN" || !!u.isGuardian;
const requireJudge = (u: U) => { if (!canJudge(u)) throw new AppError(403, "GUARDIAN_ONLY", "Só os responsáveis podem fazer isso."); };
const requireAdmin = (u: U) => { if (u.role !== "ADMIN") throw new AppError(403, "ADMIN_ONLY", "Só o administrador pode fazer isso."); };

/* ---------- Regras (o administrador cadastra) ---------- */
const RULE_COLS = `id, kind, name, points, fine_cents AS "fineCents", sort, active, starts_on AS "startsOn"`;
export async function listRules(db: Db) {
  return (await db.query(`SELECT ${RULE_COLS} FROM conduct_rule WHERE entity_code = 'PERSONAL' ORDER BY kind, sort, name`)).rows;
}
export interface RuleInput { kind: "HABIT" | "INFRACTION"; name: string; points?: number; fineCents?: number; sort?: number; active?: boolean; }
export async function createRule(db: Db, u: U, i: RuleInput) {
  requireAdmin(u);
  try {
    // Hábito novo só começa a cobrar amanhã: ninguém leva falta por um combinado que não existia.
    const r = await db.query(`INSERT INTO conduct_rule (entity_code, kind, name, points, fine_cents, sort, active, starts_on)
      VALUES ('PERSONAL',$1,$2,$3,$4,$5,$6,$7) RETURNING ${RULE_COLS}`,
      [i.kind, i.name.trim(), i.points ?? 1, i.fineCents ?? 0, i.sort ?? 99, i.active ?? true, i.kind === "HABIT" ? addDays(todaySP(), 1) : todaySP()]);
    return r.rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError(409, "DUPLICATE", "Já existe uma regra com esse nome.");
    throw e;
  }
}
export async function updateRule(db: Db, u: U, id: string, p: Partial<Omit<RuleInput, "kind">>) {
  requireAdmin(u);
  const map: Record<string, string> = { name: "name", points: "points", fineCents: "fine_cents", sort: "sort", active: "active" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push(k === "name" ? String(p.name).trim() : (p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length + 1}`); }
  if (!sets.length) throw new AppError(400, "EMPTY", "Nada para alterar.");
  const r = await db.query(`UPDATE conduct_rule SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${RULE_COLS}`, [id, ...vals]);
  if (!r.rowCount) throw new AppError(404, "RULE_NOT_FOUND", "Regra não encontrada.");
  return r.rows[0]; // valores novos valem para o que acontecer daqui em diante; o histórico guarda o valor da época
}

/* ---------- Faltas de hábito: geradas para os dias que já passaram (idempotente) ---------- */
export async function materializeMisses(db: Db, today = todaySP()) {
  await db.query(`
    INSERT INTO conduct_entry (person_id, kind, rule_id, day, points, amount_cents, note)
    SELECT p.id, 'HABIT_MISS', r.id, d::date, r.points, r.fine_cents, r.name
    FROM conduct_rule r
    CROSS JOIN person p
    CROSS JOIN LATERAL generate_series(GREATEST(r.starts_on, p.created_at::date, $1::date - 60), $1::date - 1, interval '1 day') d
    WHERE r.kind = 'HABIT' AND r.active AND r.entity_code = 'PERSONAL' AND p.active AND p.entity_code = 'PERSONAL'
      AND NOT EXISTS (SELECT 1 FROM habit_check h WHERE h.person_id = p.id AND h.rule_id = r.id AND h.day = d::date)
    ON CONFLICT (person_id, rule_id, day) WHERE kind = 'HABIT_MISS' DO NOTHING`, [today]);
}

/* ---------- Marcar hábito ---------- */
export async function setCheck(db: Db, u: U, i: { personId: string; ruleId: string; day: string; checked: boolean }) {
  const today = todaySP();
  if (i.day > today) throw new AppError(422, "FUTURE_DAY", "Não dá para marcar um dia que ainda não chegou.");
  if (!canJudge(u)) {
    if (u.personId !== i.personId) throw new AppError(403, "NOT_YOURS", "Você só marca os seus próprios hábitos.");
    if (i.day < addDays(today, -1)) throw new AppError(422, "TOO_LATE", "Você pode marcar hoje e ontem. Para dias anteriores, fale com um responsável.");
  }
  const rule = (await db.query("SELECT kind, active, starts_on FROM conduct_rule WHERE id = $1", [i.ruleId])).rows[0];
  if (!rule || rule.kind !== "HABIT" || !rule.active) throw new AppError(422, "RULE_NOT_FOUND", "Hábito não encontrado.");
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

/* ---------- Ocorrências, pagamentos e perdões ---------- */
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
  if (!r.rowCount) throw new AppError(404, "NOT_FOUND", "Registro não encontrado (faltas de hábito somem marcando o hábito).");
}
async function balanceOf(db: Db, personId: string): Promise<number> {
  const r = await db.query<{ v: number }>(`SELECT COALESCE(sum(CASE WHEN kind IN ('HABIT_MISS','INFRACTION') THEN amount_cents ELSE -amount_cents END), 0)::bigint AS v
    FROM conduct_entry WHERE person_id = $1 AND deleted_at IS NULL`, [personId]);
  return r.rows[0]!.v;
}

/* ---------- Visões ---------- */
export async function board(db: Db, date = todaySP()) {
  const today = todaySP();
  await materializeMisses(db, today);
  const w = weekOf(date);
  const habits = (await db.query(`SELECT id, name, starts_on FROM conduct_rule WHERE kind = 'HABIT' AND active AND entity_code = 'PERSONAL' ORDER BY sort, name`)).rows;
  const people = (await db.query(`SELECT p.id, p.name, p.created_at::date AS since, u.nickname, u.id AS user_id
    FROM person p LEFT JOIN app_user u ON u.person_id = p.id AND u.active WHERE p.entity_code = 'PERSONAL' AND p.active ORDER BY p.name`)).rows;
  const checks = (await db.query(`SELECT h.person_id, h.rule_id, h.day::text AS day, h.checked_at, cu.name AS by_name
    FROM habit_check h LEFT JOIN app_user cu ON cu.id = h.checked_by WHERE h.day >= $1 AND h.day < $2`, [w.start, w.next])).rows;
  const entries = (await db.query(`SELECT e.id, e.person_id, e.kind, e.rule_id, e.day::text AS day, e.points, e.amount_cents, e.note, e.created_at, cu.name AS by_name
    FROM conduct_entry e LEFT JOIN app_user cu ON cu.id = e.created_by
    WHERE e.deleted_at IS NULL AND e.day >= $1 AND e.day < $2 ORDER BY e.day DESC, e.created_at DESC`, [w.start, w.next])).rows;
  const balances = new Map((await db.query<{ person_id: string; v: number }>(`SELECT person_id,
      COALESCE(sum(CASE WHEN kind IN ('HABIT_MISS','INFRACTION') THEN amount_cents ELSE -amount_cents END), 0)::bigint AS v
    FROM conduct_entry WHERE deleted_at IS NULL GROUP BY person_id`)).rows.map(r => [r.person_id, r.v]));

  const days: string[] = [];
  for (let d = w.start; d <= w.end && d <= today; d = addDays(d, 1)) days.push(d);
  const rows = people.map(p => {
    const grid = days.map(day => ({ day, habits: habits.map(h => {
      const c = checks.find(x => x.person_id === p.id && x.rule_id === h.id && x.day === day);
      const applies = day >= String(h.starts_on).slice(0, 10) && day >= String(p.since).slice(0, 10);
      return { ruleId: h.id, done: !!c, applies, checkedAt: c?.checked_at ?? null, by: c?.by_name ?? null };
    }) }));
    const due = grid.flatMap(g => g.habits.filter(h => h.applies));
    const mine = entries.filter(e => e.person_id === p.id);
    const fullDays = grid.filter(g => g.habits.some(h => h.applies) && g.habits.filter(h => h.applies).every(h => h.done)).length;
    return {
      personId: p.id, name: p.name, nickname: p.nickname, hasLogin: !!p.user_id,
      grid, fullDays, daysCounted: grid.filter(g => g.habits.some(h => h.applies)).length,
      habitsDone: due.filter(h => h.done).length, habitsDue: due.length,
      infractions: mine.filter(e => e.kind === "INFRACTION").length,
      pointsLost: mine.filter(e => e.kind === "HABIT_MISS" || e.kind === "INFRACTION").reduce((s, e) => s + e.points, 0),
      finesWeekCents: mine.filter(e => e.kind === "HABIT_MISS" || e.kind === "INFRACTION").reduce((s, e) => s + Number(e.amount_cents), 0),
      balanceCents: balances.get(p.id) ?? 0,
    };
  });
  // Mais constante: mais dias completos; empate, menos pontos perdidos.
  const best = [...rows].filter(r => r.daysCounted).sort((a, b) => b.fullDays - a.fullDays || a.pointsLost - b.pointsLost)[0];
  const names = new Map(people.map(p => [p.id, p.name]));
  return {
    week: { start: w.start, end: w.end }, today, habits: habits.map(h => ({ id: h.id, name: h.name })),
    rows, mostConsistent: best && best.fullDays > 0 ? best.personId : null,
    entries: entries.map(e => ({ id: e.id, personId: e.person_id, personName: names.get(e.person_id) ?? "?", kind: e.kind, day: e.day,
      points: e.points, amountCents: Number(e.amount_cents), note: e.note, by: e.by_name, createdAt: e.created_at })),
  };
}
