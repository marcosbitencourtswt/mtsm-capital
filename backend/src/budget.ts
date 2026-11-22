/**
 * Orçamento por categoria: teto mensal só nas categorias que a família quer vigiar.
 * Gasto do mês = pagamentos de contas/gastos (EXPENSE) com data no mês, inclusive compras no cartão
 * (que viram despesa na data da compra). Fatura e parcela de dívida não entram: não são consumo.
 */
import type { Db } from "./db.js";
import { todaySP } from "./domain/finance.js";
import type { Entity } from "./service.js";

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const LABEL: Record<string, string> = { ALIMENTACAO: "Alimentação", AGUA: "Água", SAUDE: "Saúde", EDUCACAO: "Educação", DIVIDA: "Dívida", CARTAO: "Cartão",
  PRO_LABORE: "Pró-labore", SERVICOS: "Serviços" };
/** Nome legível da categoria para avisos (DELIVERY → Delivery, SAUDE → Saúde). */
export const categoryLabel = (c: string) => LABEL[c] ?? c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, " ");

async function spent(db: Db, e: Entity, month: string, categories?: string[]) {
  const r = await db.query<{ category: string; v: string }>(`SELECT t.category, sum(s.amount_cents)::bigint AS v FROM settlement s JOIN title t ON t.id = s.title_id
    WHERE t.entity_code = $1 AND t.kind = 'PAYABLE' AND t.nature = 'EXPENSE' AND s.method <> 'DISCOUNT' AND s.deleted_at IS NULL AND t.deleted_at IS NULL
      AND s.paid_on >= $2::date AND s.paid_on < ($2::date + interval '1 month') ${categories ? "AND t.category = ANY($3)" : ""}
    GROUP BY t.category`, categories ? [e, month, categories] : [e, month]);
  return new Map(r.rows.map(x => [x.category, Number(x.v)]));
}

export async function list(db: Db, e: Entity, day = todaySP()) {
  const month = monthStart(day);
  const limits = (await db.query<{ category: string; limit_cents: string }>("SELECT category, limit_cents FROM budget WHERE entity_code = $1 ORDER BY category", [e])).rows;
  const s = await spent(db, e, month);
  // Quanto do mês já passou: ajuda a ler "60% gasto com 40% do mês" (ritmo).
  const [y, m] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(), elapsed = Math.min(daysInMonth, Number(day.slice(8, 10)));
  return {
    month: month.slice(0, 7), monthElapsedPct: Math.round(elapsed * 100 / daysInMonth),
    items: limits.map(l => {
      const limit = Number(l.limit_cents), used = s.get(l.category) ?? 0;
      return { category: l.category, limitCents: limit, spentCents: used, leftCents: limit - used, pct: Math.round(used * 100 / limit) };
    }).sort((a, b) => b.pct - a.pct),
  };
}

export async function setLimit(db: Db, e: Entity, category: string, limitCents: number | null) {
  if (!limitCents) await db.query("DELETE FROM budget WHERE entity_code = $1 AND category = $2", [e, category]);
  else await db.query(`INSERT INTO budget (entity_code, category, limit_cents) VALUES ($1,$2,$3)
    ON CONFLICT (entity_code, category) DO UPDATE SET limit_cents = EXCLUDED.limit_cents, updated_at = now()`, [e, category, limitCents]);
  return { category, limitCents };
}

/** Categorias que acabaram de cruzar 80% ou 100% no mês (cada nível avisa uma vez). */
export async function crossed(db: Db, e: Entity, categories: string[], day = todaySP()) {
  const cats = [...new Set(categories)];
  if (!cats.length) return [];
  const limits = new Map((await db.query("SELECT category, limit_cents FROM budget WHERE entity_code = $1 AND category = ANY($2)", [e, cats])).rows.map(r => [r.category, Number(r.limit_cents)]));
  if (!limits.size) return [];
  const month = monthStart(day), s = await spent(db, e, month, [...limits.keys()]);
  const out: { category: string; level: 80 | 100; spentCents: number; limitCents: number }[] = [];
  for (const [cat, limit] of limits) {
    const used = s.get(cat) ?? 0, pct = used * 100 / limit;
    const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (!level) continue;
    const r = await db.query("INSERT INTO budget_alert (entity_code, category, month, level) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [e, cat, month, level]);
    if (r.rowCount) out.push({ category: cat, level, spentCents: used, limitCents: limit });
  }
  return out;
}
