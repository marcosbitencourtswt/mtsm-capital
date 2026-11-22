import type { Db, Tx } from "./db.js";
import { withTx } from "./db.js";
import {
  type Title, type TitleView, type Kind, type Nature, type InterestModel, type Realized,
  viewTitle, classifySettlement, emptyRealized, guardCheck, simulate, pctOf,
  todaySP, monthStart, addMonths, dueDateFor,
} from "./domain/finance.js";

export type Entity = "PERSONAL" | "BYTE4TECH";

export class AppError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 422 | 503, public code: string, message: string, public details?: unknown) { super(message); }
}

type Q = Db | Tx;

/* ---------- Mapeamento ---------- */
interface TitleRow {
  id: string; kind: Kind; nature: Nature; counterparty: string; category: string; amount_cents: number;
  interest_model: InterestModel; rate_bp: number; due_date: string | null; start_date: string;
  competence_month: string | null; recurrence_id: string | null; linked_title_id: string | null; notes: string | null;
  person_id: string | null; person_name: string | null; settled_cents: number;
  created_by: string | null; mandatory: boolean | null;
}
const toTitle = (r: TitleRow): Title & { competenceMonth: string | null; recurrenceId: string | null; linkedTitleId: string | null; notes: string | null; personId: string | null; personName: string | null; createdBy: string | null; mandatory: boolean | null } => ({
  id: r.id, kind: r.kind, nature: r.nature, counterparty: r.counterparty, category: r.category, amountCents: r.amount_cents,
  interestModel: r.interest_model, rateBp: r.rate_bp, dueDate: r.due_date, startDate: r.start_date,
  competenceMonth: r.competence_month, recurrenceId: r.recurrence_id, linkedTitleId: r.linked_title_id, notes: r.notes,
  personId: r.person_id, personName: r.person_name, createdBy: r.created_by, mandatory: r.mandatory,
});

const TITLE_SELECT = `
  SELECT t.*, (SELECT p.name FROM person p WHERE p.id = t.person_id) AS person_name, COALESCE((SELECT sum(s.amount_cents) FROM settlement s WHERE s.title_id = t.id AND s.deleted_at IS NULL), 0)::bigint AS settled_cents
  FROM title t WHERE t.deleted_at IS NULL AND t.entity_code = $1`;

async function loadViews(q: Q, e: Entity, asOf: string, extra = "", params: unknown[] = []) {
  const { rows } = await q.query<TitleRow>(`${TITLE_SELECT} ${extra} ORDER BY t.due_date NULLS LAST, t.created_at`, [e, ...params]);
  return rows.map(r => ({ ...viewTitle(toTitle(r), r.settled_cents, asOf), ...pick(toTitle(r)) }));
}
const pick = (t: ReturnType<typeof toTitle>) => ({ competenceMonth: t.competenceMonth, recurrenceId: t.recurrenceId, linkedTitleId: t.linkedTitleId, notes: t.notes, personId: t.personId, personName: t.personName, createdBy: t.createdBy, mandatory: t.mandatory });

export async function getTitle(q: Q, e: Entity, id: string, asOf = todaySP()) {
  const [t] = await loadViews(q, e, asOf, "AND t.id = $2", [id]);
  if (!t) throw new AppError(404, "TITLE_NOT_FOUND", "Conta não encontrada.");
  const { rows } = await q.query(
    `SELECT id, amount_cents AS "amountCents", paid_on AS "paidOn", method, notes, warnings, created_at AS "createdAt"
     FROM settlement WHERE title_id = $1 AND deleted_at IS NULL ORDER BY paid_on, created_at`, [id]);
  return { ...t, settlements: rows };
}

/* ---------- Contas (títulos) ---------- */
export interface TitleFilter { kind?: Kind; status?: "open" | "settled" | "all"; from?: string; to?: string; personId?: string; }
export async function listTitles(db: Db, e: Entity, f: TitleFilter, asOf = todaySP()) {
  const cond: string[] = []; const params: unknown[] = [];
  if (f.kind) { params.push(f.kind); cond.push(`AND t.kind = $${params.length + 1}`); }
  if (f.from) { params.push(f.from); cond.push(`AND t.due_date >= $${params.length + 1}`); }
  if (f.to) { params.push(f.to); cond.push(`AND t.due_date <= $${params.length + 1}`); }
  if (f.personId === "none") cond.push("AND t.person_id IS NULL");
  else if (f.personId) { params.push(f.personId); cond.push(`AND t.person_id = $${params.length + 1}`); }
  let list = await loadViews(db, e, asOf, cond.join(" "), params);
  if (f.status === "open") list = list.filter(t => t.status !== "SETTLED");
  if (f.status === "settled") list = list.filter(t => t.status === "SETTLED");
  return list;
}

export interface TitleInput {
  kind: Kind; nature: Nature; counterparty: string; category?: string; amountCents: number;
  interestModel?: InterestModel; rateBp?: number; dueDate?: string | null; startDate?: string; notes?: string | null;
  personId?: string | null; mandatory?: boolean | null; negativado?: boolean;
  createdBy?: string;
  loan?: { interestModel: InterestModel; rateBp: number; dueDate?: string | null };
}

function validateNature(kind: Kind, nature: Nature) {
  const ok = kind === "PAYABLE" ? ["EXPENSE", "DEBT", "CARD"].includes(nature) : ["INCOME", "LOAN_IN"].includes(nature);
  if (!ok) throw new AppError(422, "INVALID_NATURE", `Natureza ${nature} não combina com ${kind}.`);
}

export async function createTitle(db: Db, e: Entity, i: TitleInput, asOf = todaySP()) {
  validateNature(i.kind, i.nature);
  if (i.nature !== "DEBT" && (i.interestModel && i.interestModel !== "NONE"))
    throw new AppError(422, "INTEREST_ONLY_ON_DEBT", "Juros só se aplicam a dívidas.");
  await assertPerson(db, e, i.personId);
  return withTx(db, async c => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, interest_model, rate_bp, due_date, start_date, notes, person_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, current_date),$11,$12,$13) RETURNING id`,
      [e, i.kind, i.nature, i.counterparty.trim(), i.category ?? "GERAL", i.amountCents,
       i.interestModel ?? "NONE", i.rateBp ?? 0, i.dueDate ?? null, i.startDate ?? null, i.notes ?? null, i.personId ?? null, i.createdBy ?? null]);
    const id = ins.rows[0]!.id;
    // Regra 4: empréstimo recebido não é receita. Gera a dívida correspondente.
    if (i.nature === "LOAN_IN") {
      const l = i.loan ?? { interestModel: "NONE" as const, rateBp: 0 };
      const debt = await c.query<{ id: string }>(
        `INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, interest_model, rate_bp, due_date, start_date, linked_title_id, notes, person_id, created_by)
         VALUES ($1,'PAYABLE','DEBT',$2,'EMPRESTIMO',$3,$4,$5,$6,COALESCE($7::date, current_date),$8,'Gerada automaticamente pelo empréstimo recebido',$9,$10) RETURNING id`,
        [e, i.counterparty.trim(), i.amountCents, l.interestModel, l.rateBp, l.dueDate ?? null, i.startDate ?? null, id, i.personId ?? null, i.createdBy ?? null]);
      await c.query("UPDATE title SET linked_title_id = $1 WHERE id = $2", [debt.rows[0]!.id, id]);
    }
    return getTitle(c, e, id, asOf);
  });
}

export async function updateTitle(db: Db, e: Entity, id: string, p: Partial<Omit<TitleInput, "kind" | "loan" | "createdBy">>, asOf = todaySP()) {
  const cur = await getTitle(db, e, id, asOf);
  if (p.nature) validateNature(cur.kind, p.nature);
  if ("personId" in p) await assertPerson(db, e, p.personId);
  const map: Record<string, string> = { nature: "nature", counterparty: "counterparty", category: "category", amountCents: "amount_cents",
    interestModel: "interest_model", rateBp: "rate_bp", dueDate: "due_date", startDate: "start_date", notes: "notes", personId: "person_id", mandatory: "mandatory", negativado: "negativado" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push((p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length + 2}`); }
  if (!sets.length) return cur;
  try {
    await db.query(`UPDATE title SET ${sets.join(", ")} WHERE entity_code = $1 AND id = $2 AND deleted_at IS NULL`, [e, id, ...vals]);
  } catch (err) { throw pgToAppError(err); }
  return getTitle(db, e, id, asOf);
}

export async function deleteTitle(db: Db, e: Entity, id: string) {
  const r = await db.query("UPDATE title SET deleted_at = now() WHERE entity_code = $1 AND id = $2 AND deleted_at IS NULL", [e, id]);
  if (!r.rowCount) throw new AppError(404, "TITLE_NOT_FOUND", "Conta não encontrada.");
}

/* ---------- Baixas (pagamentos/recebimentos) ---------- */
export interface SettlementInput { amountCents: number; paidOn?: string; method?: "ACCOUNT" | "CARD"; notes?: string | null; createdBy?: string; accountId?: string | null; cardAccountId?: string | null; }

/** Avisos (não bloqueiam): regra 7 (cartão em dívida) e pagamento acima do saldo. */
export function settlementWarnings(nature: Nature, method: string | undefined, amount: number, open: number): string[] {
  const w: string[] = [];
  if (nature === "DEBT" && method === "CARD") w.push("REGRA_7: cartão usado para pagar dívida");
  if (amount > open) w.push(`PAGO_ACIMA_DO_SALDO: excedeu em ${amount - Math.max(0, open)} centavos`);
  return w;
}

/** Conta de onde sai/entra o dinheiro: precisa ser da mesma entidade e do tipo que guarda saldo. */
async function accountOf(q: Q, e: Entity, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const r = await q.query("SELECT 1 FROM account WHERE id = $1 AND entity_code = $2 AND type IN ('CHECKING','SAVINGS','INVESTMENT','CASH')", [id, e]);
  if (!r.rowCount) throw new AppError(422, "ACCOUNT_NOT_FOUND", "Conta de pagamento inválida.");
  return id;
}

export async function createSettlement(db: Db, e: Entity, titleId: string, i: SettlementInput, idemKey?: string, asOf = todaySP()) {
  if (idemKey) {
    const prev = await db.query("SELECT title_id FROM settlement WHERE idempotency_key = $1", [idemKey]);
    if (prev.rowCount) return { duplicate: true, title: await getTitle(db, e, prev.rows[0].title_id, asOf) };
  }
  const t = await getTitle(db, e, titleId, asOf);
  // Conta "a definir" (valor 0, ex.: luz do mês): o primeiro pagamento define o valor.
  if (t.amountCents === 0 && t.settledCents === 0) {
    await db.query("UPDATE title SET amount_cents = $1 WHERE id = $2", [i.amountCents, titleId]);
    t.openCents = i.amountCents;
  }
  // Nada é bloqueado: regras viram avisos gravados.
  // Conta comum paga num cartão cadastrado: vira compra na fatura certa (despesa agora, dinheiro sai quando a fatura for paga).
  let method = i.method ?? "ACCOUNT", accountId = i.accountId;
  if (i.cardAccountId) {
    if (t.kind !== "PAYABLE" || t.nature !== "EXPENSE") throw new AppError(422, "CARD_ONLY_EXPENSE", "Só conta comum pode ir para a fatura do cartão. Dívida paga com cartão vira outra dívida.");
    const bill = await billFor(db, e, i.cardAccountId, i.paidOn ?? todaySP(), i.amountCents, i.createdBy);
    await db.query("UPDATE title SET card_bill_id = $1 WHERE id = $2", [bill, titleId]);
    method = "CARD"; accountId = null;
  }
  const warnings = settlementWarnings(t.nature, method, i.amountCents, t.openCents);
  await db.query(
    "INSERT INTO settlement (title_id, amount_cents, paid_on, method, notes, idempotency_key, warnings, created_by, account_id) VALUES ($1,$2,COALESCE($3::date, current_date),$4,$5,$6,$7,$8,$9)",
    [titleId, i.amountCents, i.paidOn ?? null, method, i.notes ?? null, idemKey ?? null, warnings, i.createdBy ?? null, await accountOf(db, e, accountId)]);
  return { duplicate: false, title: await getTitle(db, e, titleId, asOf) };
}

async function settlementOwner(db: Db, e: Entity, id: string): Promise<string> {
  const r = await db.query(`SELECT s.title_id FROM settlement s JOIN title t ON t.id = s.title_id
    WHERE s.id = $1 AND s.deleted_at IS NULL AND t.entity_code = $2`, [id, e]);
  if (!r.rowCount) throw new AppError(404, "SETTLEMENT_NOT_FOUND", "Pagamento não encontrado.");
  return r.rows[0].title_id;
}
export async function updateSettlement(db: Db, e: Entity, id: string, p: Partial<SettlementInput>, asOf = todaySP()) {
  const titleId = await settlementOwner(db, e, id);
  const t = await getTitle(db, e, titleId, asOf);
  if (p.method === "CARD" && t.nature === "DEBT")
    await db.query("UPDATE settlement SET warnings = array_append(warnings, $1) WHERE id = $2 AND NOT ($1 = ANY(warnings))", ["REGRA_7: cartão usado para pagar dívida", id]);
  const map: Record<string, string> = { amountCents: "amount_cents", paidOn: "paid_on", method: "method", notes: "notes" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push((p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length}`); }
  if (sets.length) await db.query(`UPDATE settlement SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, id]).catch(err => { throw pgToAppError(err); });
  return getTitle(db, e, titleId, asOf);
}
export async function deleteSettlement(db: Db, e: Entity, id: string, asOf = todaySP()) {
  const titleId = await settlementOwner(db, e, id);
  await db.query("UPDATE settlement SET deleted_at = now() WHERE id = $1", [id]);
  return getTitle(db, e, titleId, asOf);
}

/* ---------- Recorrências (lançamento automático mensal) ---------- */
export interface RecurrenceInput {
  kind: Kind; nature: "EXPENSE" | "INCOME"; description: string; category: string;
  defaultAmountCents?: number | null; dueDay?: number | null; startMonth: string; endMonth?: string | null; active?: boolean;
  personId?: string | null;
}
const REC_COLS = `id, kind, nature, description, category, default_amount_cents AS "defaultAmountCents", due_day AS "dueDay",
  start_month AS "startMonth", end_month AS "endMonth", active, person_id AS "personId",
  (SELECT p.name FROM person p WHERE p.id = recurrence.person_id) AS "personName"`;

export async function listRecurrences(db: Db, e: Entity) {
  return (await db.query(`SELECT ${REC_COLS} FROM recurrence WHERE entity_code = $1 ORDER BY description`, [e])).rows;
}
export async function createRecurrence(db: Db, e: Entity, i: RecurrenceInput) {
  validateNature(i.kind, i.nature);
  await assertPerson(db, e, i.personId);
  const r = await db.query(
    `INSERT INTO recurrence (entity_code, kind, nature, description, category, default_amount_cents, due_day, start_month, end_month, active, person_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${REC_COLS}`,
    [e, i.kind, i.nature, i.description.trim(), i.category, i.defaultAmountCents ?? null, i.dueDay ?? null,
     monthStart(i.startMonth), i.endMonth ? monthStart(i.endMonth) : null, i.active ?? true, i.personId ?? null]).catch(err => { throw pgToAppError(err); });
  return r.rows[0];
}
export async function updateRecurrence(db: Db, e: Entity, id: string, p: Partial<RecurrenceInput>) {
  const map: Record<string, string> = { description: "description", category: "category", defaultAmountCents: "default_amount_cents",
    dueDay: "due_day", endMonth: "end_month", active: "active", personId: "person_id" };
  if ("personId" in p) await assertPerson(db, e, p.personId);
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) {
    let v = (p as Record<string, unknown>)[k]; if (k === "endMonth" && typeof v === "string") v = monthStart(v);
    vals.push(v); sets.push(`${col} = $${vals.length + 2}`);
  }
  const r = sets.length
    ? await db.query(`UPDATE recurrence SET ${sets.join(", ")} WHERE entity_code = $1 AND id = $2 RETURNING ${REC_COLS}`, [e, id, ...vals]).catch(err => { throw pgToAppError(err); })
    : await db.query(`SELECT ${REC_COLS} FROM recurrence WHERE entity_code = $1 AND id = $2`, [e, id]);
  if (!r.rowCount) throw new AppError(404, "RECURRENCE_NOT_FOUND", "Recorrência não encontrada.");
  return r.rows[0];
}

/** Valor estimado: o padrão da recorrência; se não houver, o do último mês lançado; senão 0 (a definir). */
async function estimateFor(q: Q, recurrenceId: string, defaultCents: number | null, month: string): Promise<number> {
  if (defaultCents != null) return defaultCents;
  const r = await q.query<{ amount_cents: number }>(
    `SELECT amount_cents FROM title WHERE recurrence_id = $1 AND competence_month < $2 AND deleted_at IS NULL AND amount_cents > 0
     ORDER BY competence_month DESC LIMIT 1`, [recurrenceId, month]);
  return r.rows[0]?.amount_cents ?? 0;
}

/** Idempotente: gera as contas do mês para cada recorrência ativa. Rodar de novo não duplica. */
export async function generateRecurrences(db: Db, e: Entity, month: string) {
  const m = monthStart(month);
  const recs = (await db.query(
    `SELECT * FROM recurrence WHERE entity_code = $1 AND active AND start_month <= $2 AND (end_month IS NULL OR end_month >= $2)`, [e, m])).rows;
  const created: string[] = [];
  for (const r of recs) {
    const amount = await estimateFor(db, r.id, r.default_amount_cents, m);
    const ins = await db.query(
      `INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, competence_month, recurrence_id, notes, person_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)
       ON CONFLICT (recurrence_id, competence_month) DO NOTHING RETURNING id`,
      [e, r.kind, r.nature, r.description, r.category, amount, r.due_day ? dueDateFor(m, r.due_day) : null, m, r.id,
       amount === 0 ? "Valor a definir: edite quando a conta chegar" : "Valor estimado: edite se mudar", r.person_id]);
    if (ins.rowCount) created.push(r.description);
  }
  return { month: m.slice(0, 7), created };
}

/* ---------- Painel, extrato, projeção ---------- */
const sumOpen = (ts: TitleView[]) => ts.reduce((s, t) => s + Math.max(0, t.openCents), 0);

export async function dashboard(db: Db, e: Entity, asOf = todaySP()) {
  const all = await loadViews(db, e, asOf);
  const open = all.filter(t => t.status !== "SETTLED");
  const pay = open.filter(t => t.kind === "PAYABLE"), rec = open.filter(t => t.kind === "RECEIVABLE");
  const debts = pay.filter(t => t.nature === "DEBT");
  const month = asOf.slice(0, 7);
  const st = await statement(db, e, month, month, asOf);
  return {
    asOf,
    payableOpenCents: sumOpen(pay),
    receivableOpenCents: sumOpen(rec),
    projectedBalanceCents: sumOpen(rec) - sumOpen(pay),
    debtOpenCents: sumOpen(debts),
    debtInterestCents: debts.reduce((s, t) => s + t.interestCents, 0),
    overdue: open.filter(t => t.status === "OVERDUE"),
    missingValue: open.filter(t => t.status === "NO_VALUE"),
    nextDue: open.filter(t => t.dueDate && t.dueDate >= asOf).slice(0, 10),
    debtPriority: [...debts].sort((a, b) => b.rateBp - a.rateBp || a.openCents - b.openCents)
      .map(t => ({ id: t.id, counterparty: t.counterparty, rateBp: t.rateBp, openCents: t.openCents, dueDate: t.dueDate })),
    thisMonth: st.months[0] ?? null,
  };
}

/** Realizado por mês (regime de caixa). */
export async function statement(db: Db, e: Entity, fromMonth: string, toMonth: string, asOf = todaySP()) {
  const views = new Map((await loadViews(db, e, asOf)).map(t => [t.id, t]));
  const { rows } = await db.query<{ title_id: string; amount_cents: number; paid_on: string; method: string }>(
    `SELECT s.title_id, s.amount_cents, s.paid_on, s.method FROM settlement s JOIN title t ON t.id = s.title_id
     WHERE t.entity_code = $1 AND s.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY s.paid_on, s.created_at`, [e]);
  // Compras lançadas uma a uma em cada fatura: essa parte do pagamento da fatura já foi despesa.
  const itemized = new Map((await db.query<{ bill: string; v: number }>(`SELECT card_bill_id AS bill, sum(amount_cents)::bigint AS v FROM title
     WHERE entity_code = $1 AND card_bill_id IS NOT NULL AND deleted_at IS NULL GROUP BY card_bill_id`, [e])).rows.map(r => [r.bill, Number(r.v)]));
  const onBill = new Set((await db.query<{ id: string }>("SELECT id FROM title WHERE entity_code = $1 AND card_bill_id IS NOT NULL", [e])).rows.map(r => r.id));
  const paidBefore = new Map<string, number>();
  const byMonth = new Map<string, Realized>();
  const from = fromMonth.slice(0, 7), to = toMonth.slice(0, 7);
  let cashBefore = 0;
  for (const s of rows) {
    const t = views.get(s.title_id); if (!t) continue;
    const m = s.paid_on.slice(0, 7);
    const before = paidBefore.get(t.id) ?? 0;
    paidBefore.set(t.id, before + s.amount_cents);
    // Só é "via cartão" quando a compra está numa fatura: senão o dinheiro sumiria do caixa sem nunca sair.
    const viaCard = s.method === "CARD" && t.kind === "PAYABLE" && t.nature === "EXPENSE" && onBill.has(t.id);
    let already = 0;
    if (t.nature === "CARD") { already = Math.min(s.amount_cents, itemized.get(t.id) ?? 0); itemized.set(t.id, (itemized.get(t.id) ?? 0) - already); }
    if (m < from) { if (!viaCard) cashBefore += t.kind === "RECEIVABLE" ? s.amount_cents : -s.amount_cents; continue; }
    if (m > to) continue;
    if (!byMonth.has(m)) byMonth.set(m, emptyRealized());
    classifySettlement(t, s.amount_cents, before, byMonth.get(m)!, { viaCard, alreadyExpensedCents: already });
  }
  const months: Array<Realized & { month: string; resultCents: number; cashFlowCents: number; cashBalanceCents: number }> = [];
  let bal = cashBefore;
  for (let m = from; m <= to; m = addMonths(m, 1).slice(0, 7)) {
    const r = byMonth.get(m) ?? emptyRealized();
    const flow = r.cashInCents - r.cashOutCents; bal += flow;
    months.push({ month: m, ...r, resultCents: r.incomeCents - r.expenseCents, cashFlowCents: flow, cashBalanceCents: bal });
  }
  return { from, to, openingCashCents: cashBefore, months };
}

/**
 * Projeção de longo prazo (ESTIMATIVA): contas em aberto por mês de vencimento
 * + recorrências ainda não geradas (pelo valor estimado). Vencidas e sem data entram no mês atual.
 */
export async function projection(db: Db, e: Entity, months: number, asOf = todaySP()) {
  const cur = asOf.slice(0, 7);
  const open = (await loadViews(db, e, asOf)).filter(t => t.status !== "SETTLED" && t.openCents > 0);
  const recs = (await db.query(`SELECT * FROM recurrence WHERE entity_code = $1 AND active`, [e])).rows;
  const generated = new Set((await db.query<{ k: string }>(
    `SELECT recurrence_id || ':' || to_char(competence_month,'YYYY-MM') AS k FROM title WHERE entity_code = $1 AND recurrence_id IS NOT NULL`, [e])).rows.map(r => r.k));
  const lastAmount = new Map<string, number>();
  for (const r of recs) lastAmount.set(r.id, await estimateFor(db, r.id, r.default_amount_cents, addMonths(cur, months)));
  const cash = (await statement(db, e, cur, cur, asOf)).months[0]?.cashBalanceCents ?? 0;
  const out: Array<{ month: string; inCents: number; outCents: number; netCents: number; accumulatedCents: number; estimatedItems: number }> = [];
  let acc = cash;
  for (let i = 0; i < months; i++) {
    const m = addMonths(cur, i).slice(0, 7);
    const inMonth = (t: TitleView) => (t.dueDate ? (t.dueDate.slice(0, 7) < cur ? cur : t.dueDate.slice(0, 7)) : cur) === m;
    let inC = open.filter(t => t.kind === "RECEIVABLE" && inMonth(t)).reduce((s, t) => s + t.openCents, 0);
    let outC = open.filter(t => t.kind === "PAYABLE" && inMonth(t)).reduce((s, t) => s + t.openCents, 0);
    let est = 0;
    for (const r of recs) {
      const sm = String(r.start_month).slice(0, 7), em = r.end_month ? String(r.end_month).slice(0, 7) : null;
      if (sm > m || (em && em < m) || generated.has(`${r.id}:${m}`)) continue;
      const v = lastAmount.get(r.id) ?? 0; est++;
      if (r.kind === "RECEIVABLE") inC += v; else outC += v;
    }
    acc += inC - outC;
    out.push({ month: m, inCents: inC, outCents: outC, netCents: inC - outC, accumulatedCents: acc, estimatedItems: est });
  }
  return { asOf, startingCashCents: cash, note: "Estimativa: contas lançadas + recorrências pelo último valor conhecido.", months: out };
}

/* ---------- Simulador e guardião ---------- */
export async function runSimulation(db: Db, e: Entity, i: { monthlyIncomeCents: number; monthlyFixedCents: number; extraCents: number; initialCashCents: number; rolloverMonthly: boolean; includeCards: boolean }, asOf = todaySP()) {
  const debts = (await loadViews(db, e, asOf))
    .filter(t => t.kind === "PAYABLE" && t.openCents > 0 && (t.nature === "DEBT" || (i.includeCards && t.nature === "CARD")))
    .map(t => ({ name: t.counterparty, balanceCents: t.openCents, rateBp: t.rateBp }));
  const input = { debts, ...i };
  return {
    assumptions: ["Renda e fixos constantes", "Cartões sem juros (taxa não informada)",
      i.rolloverMonthly ? "HIPÓTESE: dívidas com juros cobram a taxa sobre o saldo a cada mês não quitado" : "Sem novos juros"],
    monthlySurplusCents: i.monthlyIncomeCents - i.monthlyFixedCents + i.extraCents,
    totalDebtCents: debts.reduce((s, d) => s + d.balanceCents, 0),
    results: [simulate("AVALANCHE", input), simulate("SNOWBALL", input)],
  };
}

async function settings(q: Q, e: Entity) {
  const r = await q.query<{ key: string; value: unknown }>("SELECT key, value FROM setting WHERE entity_code = $1", [e]);
  const m = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
  return {
    lockUntil: (m.lock_until as string | undefined) ?? null,
    fixedCeilingCents: (m.fixed_ceiling_cents as number | undefined) ?? null,
    fixedCategories: (m.fixed_categories as string[] | undefined) ?? ["MORADIA", "AGUA", "LUZ", "INTERNET", "FIXO"],
  };
}

export async function guard(db: Db, e: Entity, i: { amountCents: number; category: string; date?: string }) {
  const s = await settings(db, e);
  const date = i.date ?? todaySP(), m = date.slice(0, 7);
  const isFixed = s.fixedCategories.includes(i.category);
  const spent = await db.query<{ v: number }>(
    `SELECT COALESCE(sum(s.amount_cents),0)::bigint AS v FROM settlement s JOIN title t ON t.id = s.title_id
     WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'EXPENSE' AND t.category = ANY($2)
       AND to_char(s.paid_on,'YYYY-MM') = $3 AND s.deleted_at IS NULL AND t.deleted_at IS NULL`, [e, s.fixedCategories, m]);
  return guardCheck({ amountCents: i.amountCents, category: isFixed ? "FIXED" : "DISCRETIONARY", date,
    lockUntil: s.lockUntil, fixedCeilingCents: s.fixedCeilingCents, fixedSpentInMonthCents: spent.rows[0]!.v });
}

/** Data de vencimento da fatura em que cai uma compra feita em `date` (considera o dia de fechamento). */
export function billDueDate(date: string, closingDay: number | null, dueDay: number | null): string {
  const dayOf = (iso: string) => Number(iso.slice(8, 10));
  const onOrAfter = (from: string, day: number, strictlyAfter = false) => {
    let m = from.slice(0, 7);
    for (let k = 0; k < 3; k++) { const d = dueDateFor(m, day); if (strictlyAfter ? d > from : d >= from) return d; m = addMonths(m, 1).slice(0, 7); }
    return dueDateFor(m, day);
  };
  if (!dueDay) return new Date(new Date(`${date}T12:00:00Z`).getTime() + 30 * 86400000).toISOString().slice(0, 10);
  if (!closingDay) return onOrAfter(date, dueDay, true);
  // Comprou no dia do fechamento ou depois: vai para a fatura seguinte.
  const close = dayOf(date) < closingDay ? dueDateFor(date.slice(0, 7), closingDay) : dueDateFor(addMonths(date.slice(0, 7), 1).slice(0, 7), closingDay);
  return onOrAfter(close, dueDay, true);
}

/** Encontra (ou cria "em formação") a fatura do cartão em que a compra cai e soma a compra se a fatura ainda está em formação. */
async function billFor(c: Q, e: Entity, cardAccountId: string, date: string, amount: number, createdBy?: string): Promise<string> {
  const a = (await c.query(`SELECT a.type, a.name, a.closing_day, a.due_day, a.owner_person_id, i.name AS inst FROM account a LEFT JOIN institution i ON i.id = a.institution_id
    WHERE a.id = $1 AND a.entity_code = $2`, [cardAccountId, e])).rows[0];
  if (!a || a.type !== "CARD") throw new AppError(422, "CARD_NOT_FOUND", "Cartão não encontrado.");
  const due = billDueDate(date, a.closing_day, a.due_day);
  const ex = (await c.query(`SELECT id, notes FROM title WHERE account_id = $1 AND nature = 'CARD' AND due_date = $2 AND deleted_at IS NULL LIMIT 1`, [cardAccountId, due])).rows[0];
  if (ex) {
    if (ex.notes === "Fatura em formação") await c.query("UPDATE title SET amount_cents = amount_cents + $1 WHERE id = $2", [amount, ex.id]);
    return ex.id;
  }
  const r = await c.query(`INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, person_id, account_id, notes, created_by)
    VALUES ($1,'PAYABLE','CARD',$2,'CARTAO',$3,$4,$5,$6,$7,'Fatura em formação',$8) RETURNING id`,
    [e, `Fatura ${a.inst ? `${a.inst} · ` : ""}${a.name}`, amount, due, date, a.owner_person_id, cardAccountId, createdBy ?? null]);
  return r.rows[0].id;
}

/** "Já gastei": cria a despesa e a baixa juntas. Nunca bloqueia: fora do escopo fica registrado como aviso. */
export async function quickExpense(db: Db, e: Entity, i: { amountCents: number; category: string; description: string; date?: string; method?: "ACCOUNT" | "CARD"; personId?: string | null; createdBy?: string; accountId?: string | null; cardAccountId?: string | null }) {
  await assertPerson(db, e, i.personId);
  const g = await guard(db, e, i);
  const date = i.date ?? todaySP();
  return withTx(db, async c => {
    const t = await c.query<{ id: string }>(
      `INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, notes, person_id, created_by)
       VALUES ($1,'PAYABLE','EXPENSE',$2,$3,$4,$5,$5,$6,$7,$8) RETURNING id`,
      [e, i.description.trim(), i.category, i.amountCents, date, g.allowed ? "Dentro do escopo" : `FORA do escopo: ${g.message}`, i.personId ?? null, i.createdBy ?? null]);
    // No cartão: a compra é despesa hoje e entra na fatura; o dinheiro sai quando a fatura for paga.
    const viaCard = !!i.cardAccountId;
    if (viaCard) await c.query("UPDATE title SET card_bill_id = $1 WHERE id = $2", [await billFor(c, e, i.cardAccountId!, date, i.amountCents, i.createdBy), t.rows[0]!.id]);
    await c.query("INSERT INTO settlement (title_id, amount_cents, paid_on, method, warnings, created_by, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [t.rows[0]!.id, i.amountCents, date, viaCard ? "CARD" : i.method ?? "ACCOUNT", g.allowed ? [] : [`GUARDIAO_${g.rule}: ${g.message}`], i.createdBy ?? null,
       viaCard ? null : await accountOf(c, e, i.accountId)]);
    return { guard: g, title: await getTitle(c, e, t.rows[0]!.id) };
  });
}

/* ---------- Pessoas da casa ---------- */
export interface PersonInput { name: string; relation?: string | null; active?: boolean; }
const PERSON_COLS = `id, name, relation, active, created_at AS "createdAt"`;

/** Garante que a pessoa existe e é da mesma entidade (isolamento PERSONAL/BYTE4TECH). */
async function assertPerson(q: Q, e: Entity, id: string | null | undefined) {
  if (!id) return;
  const r = await q.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = $2", [id, e]);
  if (!r.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
}
export async function listPeople(db: Db, e: Entity) {
  return (await db.query(`SELECT ${PERSON_COLS} FROM person WHERE entity_code = $1 ORDER BY active DESC, name`, [e])).rows;
}
export async function createPerson(db: Db, e: Entity, i: PersonInput) {
  const r = await db.query(`INSERT INTO person (entity_code, name, relation, active) VALUES ($1,$2,$3,$4) RETURNING ${PERSON_COLS}`,
    [e, i.name.trim(), i.relation ?? null, i.active ?? true]).catch(err => { throw pgToAppError(err); });
  return r.rows[0];
}
export async function updatePerson(db: Db, e: Entity, id: string, p: Partial<PersonInput>) {
  const map: Record<string, string> = { name: "name", relation: "relation", active: "active" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push((p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length + 2}`); }
  const r = sets.length
    ? await db.query(`UPDATE person SET ${sets.join(", ")} WHERE entity_code = $1 AND id = $2 RETURNING ${PERSON_COLS}`, [e, id, ...vals]).catch(err => { throw pgToAppError(err); })
    : await db.query(`SELECT ${PERSON_COLS} FROM person WHERE entity_code = $1 AND id = $2`, [e, id]);
  if (!r.rowCount) throw new AppError(404, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  return r.rows[0];
}

/**
 * Custo por pessoa no período (regime de caixa): quanto foi pago em contas vinculadas a ela,
 * quanto ainda está em aberto e quanto está previsto para o período. "Casa / geral" = contas sem pessoa.
 */
export async function peopleSummary(db: Db, e: Entity, fromMonth: string, toMonth: string, asOf = todaySP()) {
  const from = monthStart(fromMonth), toEnd = addMonths(toMonth.slice(0, 7), 1);
  const people = await listPeople(db, e);
  const views = (await loadViews(db, e, asOf)).filter(t => t.kind === "PAYABLE");
  const paid = (await db.query<{ person_id: string | null; v: number }>(
    `SELECT t.person_id, sum(s.amount_cents)::bigint AS v FROM settlement s JOIN title t ON t.id = s.title_id
     WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND s.deleted_at IS NULL AND t.deleted_at IS NULL
       AND s.paid_on >= $2 AND s.paid_on < $3 GROUP BY t.person_id`, [e, from, toEnd])).rows;
  const paidBy = new Map(paid.map(r => [r.person_id ?? "none", r.v]));
  const row = (id: string | null, name: string, active = true) => {
    const mine = views.filter(t => (t.personId ?? null) === id);
    const open = mine.filter(t => t.openCents > 0);
    return {
      personId: id, name, active,
      paidCents: paidBy.get(id ?? "none") ?? 0,
      openCents: open.reduce((s, t) => s + t.openCents, 0),
      openCount: open.length,
      byCategory: Object.entries(mine.reduce<Record<string, number>>((acc, t) => { acc[t.category] = (acc[t.category] ?? 0) + t.settledCents; return acc; }, {}))
        .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([category, cents]) => ({ category, cents })),
    };
  };
  const rows = [...people.map(p => row(p.id, p.name, p.active)), row(null, "Casa / geral")];
  return { from: from.slice(0, 7), to: toMonth.slice(0, 7), totalPaidCents: rows.reduce((s, r) => s + r.paidCents, 0), people: rows };
}

/* ---------- Dono do registro (membro edita só o que lançou) ---------- */
export async function ownerOf(db: Db, table: "title" | "settlement", id: string): Promise<string | null> {
  const r = await db.query(`SELECT created_by FROM ${table} WHERE id = $1`, [id]);
  if (!r.rowCount) throw new AppError(404, "NOT_FOUND", "Registro não encontrado.");
  return r.rows[0].created_by;
}

/* ---------- Ranking semanal do que NÃO era obrigatório ---------- */
export const DEFAULT_MANDATORY = ["MORADIA", "AGUA", "LUZ", "INTERNET", "FIXO", "ALIMENTACAO", "SAUDE", "EDUCACAO", "TRANSPORTE", "DIVIDA", "CARTAO", "MESADA"];
export async function mandatoryCategories(q: Q, e: Entity): Promise<string[]> {
  const r = await q.query("SELECT value FROM setting WHERE entity_code = $1 AND key = 'mandatory_categories'", [e]);
  return (r.rows[0]?.value as string[] | undefined) ?? DEFAULT_MANDATORY;
}
export async function setMandatoryCategories(db: Db, e: Entity, cats: string[]) {
  const clean = [...new Set(cats.map(c => c.trim().toUpperCase()).filter(Boolean))].slice(0, 40);
  await db.query(`INSERT INTO setting (entity_code, key, value) VALUES ($1, 'mandatory_categories', $2::jsonb)
    ON CONFLICT (entity_code, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [e, JSON.stringify(clean)]);
  return clean;
}
/** Semana de segunda a domingo que contém a data. */
export function weekOf(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = segunda
  const start = new Date(d.getTime() - dow * 86400000);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(new Date(start.getTime() + 6 * 86400000)), next: iso(new Date(start.getTime() + 7 * 86400000)) };
}
/**
 * Conta o que SAIU DO CAIXA na semana em despesas (EXPENSE) não obrigatórias.
 * Obrigatório = revisão do admin (title.mandatory) ou, sem revisão, a categoria estar na lista.
 * Dívida e fatura de cartão nunca entram (não dá para saber o que foi comprado).
 * O gasto é de quem está na conta (Pessoa); sem pessoa, vai para "Sem pessoa".
 */
export async function ranking(db: Db, e: Entity, date: string, weeks = 8) {
  const cats = await mandatoryCategories(db, e);
  const w = weekOf(date);
  const histStart = weekOf(new Date(new Date(`${w.start}T12:00:00Z`).getTime() - (weeks - 1) * 7 * 86400000).toISOString().slice(0, 10)).start;
  const { rows } = await db.query<{ title_id: string; counterparty: string; category: string; person_id: string | null; amount_cents: number; paid_on: string; mandatory: boolean | null; by_category: boolean; created_by: string | null }>(
    `SELECT t.id AS title_id, t.counterparty, t.category, t.person_id, s.amount_cents, s.paid_on, t.mandatory,
            (t.category = ANY($2)) AS by_category, t.created_by
     FROM settlement s JOIN title t ON t.id = s.title_id
     WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'EXPENSE'
       AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.paid_on >= $3 AND s.paid_on < $4
     ORDER BY s.paid_on DESC, s.created_at DESC`, [e, cats, histStart, w.next]);
  const isMandatory = (r: { mandatory: boolean | null; by_category: boolean }) => r.mandatory ?? r.by_category;
  const people = (await db.query<{ id: string; name: string; active: boolean; nickname: string | null }>(
    `SELECT p.id, p.name, p.active, u.nickname FROM person p LEFT JOIN app_user u ON u.person_id = p.id AND u.active
     WHERE p.entity_code = $1 ORDER BY p.name`, [e])).rows;
  const prev = weekOf(new Date(new Date(`${w.start}T12:00:00Z`).getTime() - 7 * 86400000).toISOString().slice(0, 10));
  const sum = (from: string, to: string, pid: string | null) => rows
    .filter(r => r.paid_on >= from && r.paid_on < to && !isMandatory(r) && (r.person_id ?? null) === pid)
    .reduce((s, r) => s + r.amount_cents, 0);
  const inWeek = rows.filter(r => r.paid_on >= w.start && r.paid_on < w.next);
  const rowFor = (pid: string | null, name: string, nickname: string | null) => {
    const mine = inWeek.filter(r => !isMandatory(r) && (r.person_id ?? null) === pid);
    const byCat: Record<string, number> = {};
    for (const r of mine) byCat[r.category] = (byCat[r.category] ?? 0) + r.amount_cents;
    const all = inWeek.filter(r => (r.person_id ?? null) === pid);
    return { personId: pid, name, nickname, totalCents: mine.reduce((s, r) => s + r.amount_cents, 0), count: mine.length,
      allCents: all.reduce((s, r) => s + r.amount_cents, 0), mandatoryCents: all.filter(isMandatory).reduce((s, r) => s + r.amount_cents, 0),
      previousCents: sum(prev.start, w.start, pid),
      topCategories: Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category, cents]) => ({ category, cents })) };
  };
  const board = [...people.filter(p => p.active).map(p => rowFor(p.id, p.name, p.nickname)), rowFor(null, "Sem pessoa", null)]
    .filter(r => r.personId !== null || r.allCents > 0)
    .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
  const history: { weekStart: string; byPerson: Record<string, number> }[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const ws = weekOf(new Date(new Date(`${w.start}T12:00:00Z`).getTime() - k * 7 * 86400000).toISOString().slice(0, 10));
    const byPerson: Record<string, number> = {};
    for (const p of people) byPerson[p.id] = sum(ws.start, ws.next, p.id);
    history.push({ weekStart: ws.start, byPerson });
  }
  const names = new Map(people.map(p => [p.id, p.name]));
  return {
    week: { start: w.start, end: w.end }, mandatoryCategories: cats,
    totalCents: board.reduce((s, r) => s + r.totalCents, 0),
    mandatoryCents: inWeek.filter(isMandatory).reduce((s, r) => s + r.amount_cents, 0),
    board,
    items: inWeek.map(r => ({ titleId: r.title_id, counterparty: r.counterparty, category: r.category, personId: r.person_id,
      personName: r.person_id ? names.get(r.person_id) ?? null : null, amountCents: r.amount_cents, paidOn: r.paid_on,
      mandatory: isMandatory(r), reviewed: r.mandatory !== null, createdBy: r.created_by })),
    history,
  };
}

/* ---------- Exportação e auditoria ---------- */
export async function exportCsv(db: Db, e: Entity, asOf = todaySP()) {
  const dec = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const br = (d: string | null) => (d ? d.split("-").reverse().join("/") : "");
  const rows: (string | number)[][] = [["Tipo", "Natureza", "Quem", "Pessoa", "Categoria", "Vencimento", "Valor", "Juros", "Total", "Pago", "Saldo", "Status"]];
  for (const t of await loadViews(db, e, asOf))
    rows.push([t.kind === "PAYABLE" ? "A pagar" : "A receber", t.nature, t.counterparty, t.personName ?? "Casa / geral", t.category, br(t.dueDate),
      dec(t.amountCents), dec(t.interestCents), dec(t.totalCents), dec(t.settledCents), dec(t.openCents), t.status]);
  return "﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
}

/** Log de avisos: tudo o que passou "fora da regra". */
export async function warningsLog(db: Db, e: Entity) {
  return (await db.query(`SELECT s.id, s.paid_on AS "paidOn", s.amount_cents AS "amountCents", s.warnings, t.id AS "titleId", t.counterparty
    FROM settlement s JOIN title t ON t.id = s.title_id
    WHERE t.entity_code = $1 AND cardinality(s.warnings) > 0 AND s.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY s.paid_on DESC, s.created_at DESC`, [e])).rows;
}

export async function audit(db: Db, rowId: string) {
  return (await db.query(`SELECT table_name AS "table", action, old_data AS "old", new_data AS "new", at FROM audit_log WHERE row_id = $1 ORDER BY id`, [rowId])).rows;
}

/* ---------- Erros do Postgres -> erros de domínio ---------- */
export function pgToAppError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === "MTSM1") return new AppError(422, "MONTH_CLOSED", e.message ?? "Mês fechado. Só o root pode corrigir.");
  if (e.code === "23514") return new AppError(422, "CONSTRAINT_VIOLATION", `Valor inválido (${e.constraint ?? "regra do banco"}).`);
  if (e.code === "23505") return new AppError(409, "DUPLICATE", "Registro duplicado.");
  if (e.code === "22P02" || e.code === "22007" || e.code === "22008") return new AppError(400, "INVALID_INPUT", "Formato inválido.");
  return err;
}

export { pctOf };
