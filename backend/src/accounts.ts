/**
 * Bancos e produtos financeiros por dono (Marcos, Thaís, dos dois) e a ordem sugerida de pagamento.
 * - Saldo das contas é DERIVADO: saldo informado na carga inicial + recebimentos − pagamentos feitos por ela ± transferências.
 * - Cartão: a fatura atual é uma conta a pagar (CARD) ligada ao cartão; limite livre = limite − faturas abertas.
 * - Empréstimo: as parcelas são contas a pagar (DEBT) ligadas ao produto; atraso é calculado pelo vencimento.
 */
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { AppError, type Entity } from "./service.js";
import type { SessionUser } from "./auth.js";
import { todaySP, dueDateFor, addMonths } from "./domain/finance.js";

export type AccountType = "CHECKING" | "SAVINGS" | "INVESTMENT" | "CARD" | "LOAN" | "CASH";
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000);

async function institutionId(db: Db, e: Entity, name?: string | null): Promise<string | null> {
  const n = name?.trim();
  if (!n) return null;
  const r = await db.query(`INSERT INTO institution (entity_code, name) VALUES ($1, $2)
    ON CONFLICT (entity_code, lower(name)) DO UPDATE SET updated_at = now() RETURNING id`, [e, n]);
  return r.rows[0].id;
}
async function assertOwner(db: Db, e: Entity, personId: string | null | undefined) {
  if (!personId) return;
  const r = await db.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = $2", [personId, e]);
  if (!r.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Dono não encontrado em Pessoas da casa.");
}

export interface AccountInput {
  type: AccountType; name: string; institution?: string | null; ownerPersonId?: string | null;
  openingBalanceCents?: number; creditLimitCents?: number | null; closingDay?: number | null; dueDay?: number | null;
  monthlyRateBp?: number | null; rateSource?: string | null; notes?: string | null; negativado?: boolean;
  /** Cartão: fatura atual em aberto (vira conta a pagar). */
  currentBill?: { amountCents: number; dueDate: string } | null;
  /** Empréstimo: parcelas em aberto a partir da mais antiga não paga (as que já venceram aparecem como atrasadas). */
  loan?: { installmentCents: number; remaining: number; firstOpenDueDate: string; totalInstallments?: number | null } | null;
}

export async function createAccount(db: Db, e: Entity, u: SessionUser, i: AccountInput) {
  await assertOwner(db, e, i.ownerPersonId);
  if (i.type === "LOAN" && !i.loan) throw new AppError(422, "LOAN_REQUIRED", "Informe a parcela, quantas faltam e o vencimento da parcela mais antiga em aberto.");
  const inst = await institutionId(db, e, i.institution);
  return withTx(db, async c => {
    const r = await c.query(`INSERT INTO account (entity_code, institution_id, owner_person_id, type, name, opening_balance_cents, credit_limit_cents,
        closing_day, due_day, monthly_rate_bp, rate_source, notes, created_by, negativado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [e, inst, i.ownerPersonId ?? null, i.type, i.name.trim(), ["CARD", "LOAN"].includes(i.type) ? 0 : i.openingBalanceCents ?? 0,
       i.creditLimitCents ?? null, i.closingDay ?? null, i.dueDay ?? null, i.monthlyRateBp ?? null, i.rateSource?.trim() || null, i.notes?.trim() || null, u.id, i.negativado ?? false]);
    const id = r.rows[0].id as string;
    const label = i.institution?.trim() ? `${i.institution.trim()} · ${i.name.trim()}` : i.name.trim();
    if (i.type === "CARD" && i.currentBill && i.currentBill.amountCents > 0)
      await c.query(`INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, person_id, account_id, notes, created_by)
        VALUES ($1,'PAYABLE','CARD',$2,'CARTAO',$3,$4,current_date,$5,$6,'Fatura informada na carga inicial',$7)`,
        [e, `Fatura ${label}`, i.currentBill.amountCents, i.currentBill.dueDate, i.ownerPersonId ?? null, id, u.id]);
    if (i.type === "LOAN" && i.loan) {
      const { installmentCents, remaining, firstOpenDueDate } = i.loan;
      const total = i.loan.totalInstallments ?? null, day = Number(firstOpenDueDate.slice(8, 10));
      for (let k = 0; k < remaining; k++) {
        const due = dueDateFor(addMonths(firstOpenDueDate.slice(0, 7), k).slice(0, 7), day);
        const no = total ? total - remaining + k + 1 : null;
        await c.query(`INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, person_id, account_id,
            installment_no, installment_total, notes, created_by)
          VALUES ($1,'PAYABLE','DEBT',$2,'DIVIDA',$3,$4,current_date,$5,$6,$7,$8,$9,$10)`,
          [e, `${label}${no && total ? ` · parcela ${no}/${total}` : ` · parcela ${k + 1} de ${remaining}`}`, installmentCents, due, i.ownerPersonId ?? null, id,
           no, total, "Parcela informada na carga inicial", u.id]);
      }
    }
    return { id };
  });
}

export async function updateAccount(db: Db, e: Entity, id: string, p: Partial<Omit<AccountInput, "type" | "currentBill" | "loan">> & { active?: boolean }) {
  if ("ownerPersonId" in p) await assertOwner(db, e, p.ownerPersonId);
  const map: Record<string, string> = { name: "name", ownerPersonId: "owner_person_id", openingBalanceCents: "opening_balance_cents", creditLimitCents: "credit_limit_cents",
    closingDay: "closing_day", dueDay: "due_day", monthlyRateBp: "monthly_rate_bp", rateSource: "rate_source", notes: "notes", active: "active", negativado: "negativado" };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push((p as Record<string, unknown>)[k]); sets.push(`${col} = $${vals.length + 2}`); }
  if (p.institution !== undefined) { vals.push(await institutionId(db, e, p.institution)); sets.push(`institution_id = $${vals.length + 2}`); }
  if (!sets.length) throw new AppError(400, "EMPTY", "Nada para alterar.");
  const r = await db.query(`UPDATE account SET ${sets.join(", ")} WHERE entity_code = $1 AND id = $2 RETURNING id`, [e, id, ...vals]);
  if (!r.rowCount) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Conta não encontrada.");
  // Trocou o dono do cartão/dívida: parcelas e faturas acompanham (as compras continuam de quem comprou).
  if ("ownerPersonId" in p) await db.query("UPDATE title SET person_id = $3 WHERE entity_code = $1 AND account_id = $2 AND nature IN ('DEBT', 'CARD')", [e, id, p.ownerPersonId ?? null]);
  return { id };
}

/** Adiciona/atualiza a fatura atual de um cartão (quando chega a fatura nova). */
export async function addCardBill(db: Db, e: Entity, u: SessionUser, accountId: string, bill: { amountCents: number; dueDate: string }) {
  const a = (await db.query(`SELECT a.type, a.name, a.owner_person_id, i.name AS inst FROM account a LEFT JOIN institution i ON i.id = a.institution_id
    WHERE a.id = $1 AND a.entity_code = $2`, [accountId, e])).rows[0];
  if (!a || a.type !== "CARD") throw new AppError(404, "CARD_NOT_FOUND", "Cartão não encontrado.");
  // Já existe fatura com esse vencimento (ex.: em formação pelas compras lançadas): o valor oficial da fatura substitui.
  const ex = (await db.query(`SELECT id FROM title WHERE account_id = $1 AND nature = 'CARD' AND due_date = $2 AND deleted_at IS NULL LIMIT 1`, [accountId, bill.dueDate])).rows[0];
  if (ex) {
    await db.query(`UPDATE title SET amount_cents = $1, notes = 'Fatura informada' WHERE id = $2`, [bill.amountCents, ex.id]);
    return { id: ex.id as string };
  }
  const r = await db.query(`INSERT INTO title (entity_code, kind, nature, counterparty, category, amount_cents, due_date, start_date, person_id, account_id, created_by)
    VALUES ($1,'PAYABLE','CARD',$2,'CARTAO',$3,$4,current_date,$5,$6,$7) RETURNING id`,
    [e, `Fatura ${a.inst ? `${a.inst} · ` : ""}${a.name}`, bill.amountCents, bill.dueDate, a.owner_person_id, accountId, u.id]);
  return { id: r.rows[0].id };
}

export async function createTransfer(db: Db, e: Entity, u: SessionUser, i: { fromAccountId: string; toAccountId: string; amountCents: number; day?: string; note?: string | null }) {
  const ok = await db.query("SELECT count(*)::int AS n FROM account WHERE id = ANY($1) AND entity_code = $2 AND type IN ('CHECKING','SAVINGS','INVESTMENT','CASH')", [[i.fromAccountId, i.toAccountId], e]);
  if (ok.rows[0].n !== 2) throw new AppError(422, "INVALID_ACCOUNTS", "Transferência só entre contas, poupança, investimento ou dinheiro.");
  const r = await db.query(`INSERT INTO transfer (from_account_id, to_account_id, amount_cents, day, note, created_by) VALUES ($1,$2,$3,COALESCE($4::date, current_date),$5,$6) RETURNING id`,
    [i.fromAccountId, i.toAccountId, i.amountCents, i.day ?? null, i.note?.trim() || null, u.id]);
  return { id: r.rows[0].id };
}

/* ---------- Visões ---------- */
interface OpenTitle { id: string; counterparty: string; nature: string; category: string; amount_cents: number; due_date: string | null; person_id: string | null;
  account_id: string | null; interest_model: string; rate_bp: number; settled: number; installment_no: number | null; installment_total: number | null; negativado: boolean; }
async function openPayables(db: Db, e: Entity): Promise<(OpenTitle & { open: number })[]> {
  const rows = (await db.query(`SELECT t.id, t.counterparty, t.nature, t.category, t.amount_cents, t.due_date::text AS due_date, t.person_id, t.account_id,
      t.interest_model, t.rate_bp, t.installment_no, t.installment_total, t.negativado,
      COALESCE((SELECT sum(s.amount_cents) FROM settlement s WHERE s.title_id = t.id AND s.deleted_at IS NULL), 0)::bigint AS settled
    FROM title t WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.deleted_at IS NULL`, [e])).rows as OpenTitle[];
  return rows.map(r => {
    const interest = r.interest_model === "FIXED_ONCE" ? Math.round(r.amount_cents * r.rate_bp / 10000) : 0; // juros mensais ficam no cálculo completo do título
    return { ...r, open: Number(r.amount_cents) + interest - Number(r.settled) };
  }).filter(r => r.open > 0);
}

export async function listAccounts(db: Db, e: Entity, asOf = todaySP()) {
  const accounts = (await db.query(`SELECT a.*, a.opening_date::text AS opening_date_s, i.name AS institution, p.name AS owner_name
    FROM account a LEFT JOIN institution i ON i.id = a.institution_id LEFT JOIN person p ON p.id = a.owner_person_id
    WHERE a.entity_code = $1 ORDER BY a.active DESC, p.name NULLS LAST, i.name NULLS LAST, a.type, a.name`, [e])).rows;
  const flows = new Map((await db.query(`SELECT s.account_id,
      COALESCE(sum(CASE WHEN t.kind = 'RECEIVABLE' THEN s.amount_cents ELSE -s.amount_cents END), 0)::bigint AS v
    FROM settlement s JOIN title t ON t.id = s.title_id JOIN account a ON a.id = s.account_id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.paid_on >= a.opening_date AND a.entity_code = $1 GROUP BY s.account_id`, [e])).rows.map(r => [r.account_id, Number(r.v)]));
  const tr = (await db.query(`SELECT from_account_id, to_account_id, amount_cents FROM transfer x JOIN account a ON a.id = x.from_account_id
    WHERE x.deleted_at IS NULL AND a.entity_code = $1`, [e])).rows;
  const open = await openPayables(db, e);
  return accounts.map(a => {
    const linked = open.filter(t => t.account_id === a.id);
    const overdue = linked.filter(t => t.due_date && t.due_date < asOf);
    const transfers = tr.reduce((s, x) => s + (x.to_account_id === a.id ? Number(x.amount_cents) : 0) - (x.from_account_id === a.id ? Number(x.amount_cents) : 0), 0);
    const isCash = ["CHECKING", "SAVINGS", "INVESTMENT", "CASH"].includes(a.type);
    const openCents = linked.reduce((s, t) => s + t.open, 0);
    return {
      id: a.id, type: a.type as AccountType, name: a.name, institution: a.institution, ownerPersonId: a.owner_person_id, ownerName: a.owner_name ?? "Dos dois",
      active: a.active, notes: a.notes, monthlyRateBp: a.monthly_rate_bp, rateSource: a.rate_source, negativado: a.negativado,
      creditLimitCents: a.credit_limit_cents == null ? null : Number(a.credit_limit_cents), closingDay: a.closing_day, dueDay: a.due_day,
      openingBalanceCents: Number(a.opening_balance_cents), openingDate: a.opening_date_s,
      balanceCents: isCash ? Number(a.opening_balance_cents) + (flows.get(a.id) ?? 0) + transfers : null,
      openCents, openCount: linked.length,
      availableLimitCents: a.type === "CARD" && a.credit_limit_cents != null ? Number(a.credit_limit_cents) - openCents : null,
      overdueCents: overdue.reduce((s, t) => s + t.open, 0), overdueCount: overdue.length,
      maxDaysOverdue: overdue.reduce((m, t) => Math.max(m, daysBetween(t.due_date!, asOf)), 0),
    };
  });
}

/** Resumo por dono: saldos, investimentos, cartões, dívidas, atrasos e patrimônio. */
export async function overview(db: Db, e: Entity, asOf = todaySP()) {
  const accounts = await listAccounts(db, e, asOf);
  const open = await openPayables(db, e);
  const people = (await db.query(`SELECT id, name FROM person WHERE entity_code = $1 AND active ORDER BY name`, [e])).rows as { id: string; name: string }[];
  const owners = [...people.map(p => ({ id: p.id as string | null, name: p.name })), { id: null, name: "Dos dois / casa" }];
  const rows = owners.map(o => {
    const acc = accounts.filter(a => a.active && (a.ownerPersonId ?? null) === o.id);
    const debts = open.filter(t => (t.person_id ?? null) === o.id && (t.nature === "DEBT" || t.nature === "CARD" || (t.due_date && t.due_date < asOf)));
    const overdue = debts.filter(t => t.due_date && t.due_date < asOf);
    const cash = acc.filter(a => a.type === "CHECKING" || a.type === "CASH").reduce((s, a) => s + (a.balanceCents ?? 0), 0);
    const saved = acc.filter(a => a.type === "SAVINGS" || a.type === "INVESTMENT").reduce((s, a) => s + (a.balanceCents ?? 0), 0);
    const debt = debts.reduce((s, t) => s + t.open, 0);
    return { personId: o.id, name: o.name, cashCents: cash, savedCents: saved,
      cardsOpenCents: debts.filter(t => t.nature === "CARD").reduce((s, t) => s + t.open, 0),
      cardsLimitFreeCents: acc.filter(a => a.type === "CARD").reduce((s, a) => s + Math.max(0, a.availableLimitCents ?? 0), 0),
      debtCents: debt, overdueCents: overdue.reduce((s, t) => s + t.open, 0), overdueCount: overdue.length,
      maxDaysOverdue: overdue.reduce((m, t) => Math.max(m, daysBetween(t.due_date!, asOf)), 0),
      netWorthCents: cash + saved - debt, accounts: acc.length };
  }).filter(r => r.accounts || r.debtCents);
  return { asOf, people: rows };
}

export type Strategy = "juros" | "rapidas" | "nome";
/**
 * Ordem sugerida de pagamento (regra, sem IA), em três estratégias para comparar:
 * - juros   (padrão): atrasados primeiro; depois maior juro. Economiza mais dinheiro.
 * - rapidas : menor saldo primeiro (bola de neve). Fecha dívidas rápido e motiva.
 * - nome    : negativadas primeiro, depois as atrasadas há mais tempo. Limpa o nome antes.
 * Cada item traz o custo estimado de juros por mês (saldo × taxa); juro desconhecido não entra na soma.
 */
export async function payoffOrder(db: Db, e: Entity, personId?: string | null, asOf = todaySP(), strategy: Strategy = "juros") {
  const accounts = new Map((await listAccounts(db, e, asOf)).map(a => [a.id, a]));
  const people = new Map((await db.query("SELECT id, name FROM person WHERE entity_code = $1", [e])).rows.map(r => [r.id, r.name]));
  const items = (await openPayables(db, e))
    .filter(t => t.nature === "DEBT" || t.nature === "CARD" || (t.due_date && t.due_date < asOf))
    .filter(t => personId === undefined || (t.person_id ?? null) === personId)
    .map(t => {
      const acc = t.account_id ? accounts.get(t.account_id) : undefined;
      const rate = acc?.monthlyRateBp ?? (t.rate_bp ? t.rate_bp : null);
      const days = t.due_date && t.due_date < asOf ? daysBetween(t.due_date, asOf) : 0;
      const neg = t.negativado || !!acc?.negativado;
      const reasons: string[] = [];
      if (neg) reasons.push("nome negativado");
      if (days) reasons.push(`atrasado há ${days} dia${days > 1 ? "s" : ""}`);
      reasons.push(rate != null ? `juros de ${(rate / 100).toLocaleString("pt-BR")}% ao mês` : "juros não informado");
      if (t.nature === "CARD") reasons.push("pagar a fatura inteira evita juros");
      return { titleId: t.id, name: t.counterparty, ownerId: t.person_id, ownerName: t.person_id ? people.get(t.person_id) ?? "?" : "Dos dois / casa", nature: t.nature,
        openCents: t.open, dueDate: t.due_date, daysOverdue: days, monthlyRateBp: rate, negativado: neg,
        monthlyInterestCents: rate != null ? Math.round(t.open * rate / 10000) : null, institution: acc?.institution ?? null, reasons };
    });
  const r = (x: { monthlyRateBp: number | null }) => x.monthlyRateBp ?? 1000; // desconhecido ≈ 10% a.m. só para ordenar
  const due = (x: { dueDate: string | null }) => x.dueDate ?? "9";
  if (strategy === "rapidas") items.sort((a, b) => a.openCents - b.openCents || r(b) - r(a));
  else if (strategy === "nome") items.sort((a, b) => Number(b.negativado) - Number(a.negativado) || b.daysOverdue - a.daysOverdue || r(b) - r(a));
  else items.sort((a, b) => (b.daysOverdue > 0 ? 1 : 0) - (a.daysOverdue > 0 ? 1 : 0) || r(b) - r(a) || b.daysOverdue - a.daysOverdue || due(a).localeCompare(due(b)));
  // Resumo por dono: quanto deve, quanto paga de juros por mês, atrasos e negativações.
  const byOwner = new Map<string, { name: string; openCents: number; monthlyInterestCents: number; overdueCount: number; negativados: number; unknownRates: number; count: number }>();
  for (const x of items) {
    const k = x.ownerName, o = byOwner.get(k) ?? { name: k, openCents: 0, monthlyInterestCents: 0, overdueCount: 0, negativados: 0, unknownRates: 0, count: 0 };
    o.openCents += x.openCents; o.monthlyInterestCents += x.monthlyInterestCents ?? 0; o.count++;
    if (x.daysOverdue) o.overdueCount++; if (x.negativado) o.negativados++; if (x.monthlyRateBp == null) o.unknownRates++;
    byOwner.set(k, o);
  }
  return { asOf, strategy, totalCents: items.reduce((s, x) => s + x.openCents, 0),
    monthlyInterestCents: items.reduce((s, x) => s + (x.monthlyInterestCents ?? 0), 0),
    unknownRates: items.filter(x => x.monthlyRateBp == null).length, owners: [...byOwner.values()], items };
}

/**
 * Painel de dívidas: uma linha por dono (Marcos, Thaís...) + Total.
 * - deve agora = empréstimos/dívidas + faturas de cartão em aberto.
 * - progresso = quitado ÷ (quitado + em aberto) considerando SÓ empréstimos/dívidas:
 *   fatura paga todo mês não é "sair das dívidas" e inflaria a barra.
 */
export async function debtSummary(db: Db, e: Entity, asOf = todaySP()) {
  const po = await payoffOrder(db, e, undefined, asOf, "juros");
  const items = po.items.filter(x => x.nature === "DEBT" || x.nature === "CARD");
  const paid = (await db.query<{ person_id: string | null; total: string; month: string }>(
    `SELECT t.person_id, sum(s.amount_cents)::bigint AS total,
            COALESCE(sum(s.amount_cents) FILTER (WHERE s.paid_on >= date_trunc('month', $2::date)), 0)::bigint AS month
     FROM settlement s JOIN title t ON t.id = s.title_id
     WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'DEBT' AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.paid_on <= $2::date
     GROUP BY t.person_id`, [e, asOf])).rows;
  const people = (await db.query<{ id: string; name: string }>("SELECT id, name FROM person WHERE entity_code = $1", [e])).rows;
  const nameOf = (id: string | null) => (id ? people.find(p => p.id === id)?.name ?? "?" : "Casa / dos dois");
  const empty = (personId: string | null, name: string) => ({ personId, name, owedCents: 0, debtOpenCents: 0, cardsOpenCents: 0, paidCents: 0, paidThisMonthCents: 0,
    progressPct: 0, count: 0, overdueCount: 0, overdueCents: 0, negativados: 0, monthlyInterestCents: 0, unknownRates: 0 });
  const rows = new Map<string, ReturnType<typeof empty>>();
  const row = (id: string | null) => { const k = id ?? "none"; if (!rows.has(k)) rows.set(k, empty(id, nameOf(id))); return rows.get(k)!; };
  for (const x of items) {
    const r = row(x.ownerId ?? null);
    r.owedCents += x.openCents; r.count++;
    if (x.nature === "DEBT") r.debtOpenCents += x.openCents; else r.cardsOpenCents += x.openCents;
    if (x.daysOverdue) { r.overdueCount++; r.overdueCents += x.openCents; }
    if (x.negativado) r.negativados++;
    if (x.monthlyRateBp == null) r.unknownRates++; else r.monthlyInterestCents += x.monthlyInterestCents ?? 0;
  }
  for (const p of paid) { const r = row(p.person_id); r.paidCents += Number(p.total); r.paidThisMonthCents += Number(p.month); }
  const pct = (r: { paidCents: number; debtOpenCents: number }) => (r.paidCents + r.debtOpenCents ? Math.round(r.paidCents * 1000 / (r.paidCents + r.debtOpenCents)) / 10 : 0);
  const owners = [...rows.values()].sort((a, b) => (a.personId === null ? 1 : 0) - (b.personId === null ? 1 : 0) || a.name.localeCompare(b.name));
  for (const r of owners) r.progressPct = pct(r);
  const total = owners.reduce((t, r) => {
    for (const k of ["owedCents", "debtOpenCents", "cardsOpenCents", "paidCents", "paidThisMonthCents", "count", "overdueCount", "overdueCents", "negativados", "monthlyInterestCents", "unknownRates"] as const) t[k] += r[k];
    return t;
  }, empty(null, "Total"));
  total.progressPct = pct(total);
  return { asOf, owners, total };
}
