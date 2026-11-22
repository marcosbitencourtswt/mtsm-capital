/**
 * Dashboard de indicadores: um mês em foco + os 12 meses anteriores para tendência.
 * Tudo derivado do que já existe (extrato, dívidas, gastos). Nada aqui grava.
 */
import type { Db } from "./db.js";
import { statement, type Entity } from "./service.js";
import { debtSummary } from "./accounts.js";
import { addMonths, todaySP } from "./domain/finance.js";

export async function report(db: Db, e: Entity, month = todaySP().slice(0, 7), asOf = todaySP()) {
  const m = month.slice(0, 7), from = addMonths(m, -11).slice(0, 7);
  const start = `${m}-01`, end = addMonths(m, 1).slice(0, 10);
  const [st, debts] = await Promise.all([statement(db, e, from, m, asOf), debtSummary(db, e, asOf)]);
  const cur = st.months.find(x => x.month === m) ?? st.months.at(-1)!;
  const spendQ = (group: string) => db.query(`SELECT ${group} AS k, sum(s.amount_cents)::bigint AS v, count(*)::int AS n FROM settlement s JOIN title t ON t.id = s.title_id
    LEFT JOIN person p ON p.id = t.person_id
    WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'EXPENSE' AND s.method <> 'DISCOUNT' AND s.deleted_at IS NULL AND t.deleted_at IS NULL
      AND s.paid_on >= $2::date AND s.paid_on < $3::date GROUP BY 1 ORDER BY 2 DESC`, [e, start, end]);
  const [byCat, byPerson, top, dueDebt] = await Promise.all([
    spendQ("t.category"), spendQ("COALESCE(p.name, 'Casa / geral')"),
    db.query(`SELECT t.counterparty AS what, t.category, s.amount_cents AS v, s.paid_on::text AS day, p.name AS who FROM settlement s JOIN title t ON t.id = s.title_id
      LEFT JOIN person p ON p.id = t.person_id
      WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'EXPENSE' AND s.method <> 'DISCOUNT' AND s.deleted_at IS NULL AND t.deleted_at IS NULL
        AND s.paid_on >= $2::date AND s.paid_on < $3::date ORDER BY s.amount_cents DESC LIMIT 5`, [e, start, end]),
    // Parcelas de dívida e faturas que vencem no mês: quanto da renda já nasce comprometido.
    db.query(`SELECT COALESCE(sum(t.amount_cents), 0)::bigint AS v FROM title t WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature IN ('DEBT','CARD')
      AND t.deleted_at IS NULL AND t.due_date >= $2::date AND t.due_date < $3::date`, [e, start, end]),
  ]);
  const income = cur?.incomeCents ?? 0, expense = cur?.expenseCents ?? 0, debtDue = Number(dueDebt.rows[0].v);
  const pct = (a: number, b: number) => (b > 0 ? Math.round(a * 1000 / b) / 10 : null);
  return {
    month: m,
    kpis: {
      incomeCents: income, expenseCents: expense, resultCents: income - expense,
      savingsRatePct: pct(income - expense, income),           // quanto da receita sobrou
      debtOwedCents: debts.total.owedCents, debtPaidCents: debts.total.paidCents, debtProgressPct: debts.total.progressPct,
      debtDueThisMonthCents: debtDue, debtLoadPct: pct(debtDue, income), // renda comprometida com dívida/fatura do mês
      interestPaidCents: cur?.interestPaidCents ?? 0, savedByEarlyPayCents: debts.total.savedCents,
    },
    trend: st.months.map(x => ({ month: x.month, incomeCents: x.incomeCents, expenseCents: x.expenseCents, resultCents: x.resultCents, amortizationCents: x.amortizationCents })),
    byCategory: byCat.rows.map(r => ({ category: r.k as string, cents: Number(r.v), count: r.n as number })),
    byPerson: byPerson.rows.map(r => ({ name: r.k as string, cents: Number(r.v), count: r.n as number })),
    topExpenses: top.rows.map(r => ({ what: r.what as string, category: r.category as string, cents: Number(r.v), day: r.day as string, who: (r.who as string | null) ?? null })),
  };
}
