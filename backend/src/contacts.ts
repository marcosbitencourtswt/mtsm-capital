/**
 * Credores: bancos, lojas e PESSOAS de fora da família a quem se deve (ex.: um amigo que emprestou).
 * Usa o mesmo cadastro das instituições dos produtos em "Bancos e dívidas" (um credor = uma instituição),
 * então não há dois cadastros para manter. Para cada um: quanto falta, a próxima parcela e quantos dias faltam.
 */
import type { Db } from "./db.js";
import { AppError, type Entity } from "./service.js";
import { todaySP } from "./domain/finance.js";

export interface ContactInput { name?: string; kind?: "EMPRESA" | "PESSOA"; email?: string | null; phone?: string | null; notes?: string | null; }
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000);

export async function listContacts(db: Db, e: Entity, asOf = todaySP()) {
  const rows = (await db.query(`SELECT i.id, i.name, i.kind, i.email, i.phone, i.notes,
      (SELECT count(*) FROM account a WHERE a.institution_id = i.id AND a.active)::int AS products,
      COALESCE(sum(GREATEST(t.amount_cents - COALESCE(s.paid, 0), 0)), 0)::bigint AS open_cents,
      count(t.id) FILTER (WHERE t.amount_cents > COALESCE(s.paid, 0))::int AS open_count,
      min(t.due_date) FILTER (WHERE t.amount_cents > COALESCE(s.paid, 0))::text AS next_due
    FROM institution i
    LEFT JOIN account a ON a.institution_id = i.id
    LEFT JOIN title t ON t.account_id = a.id AND t.kind = 'PAYABLE' AND t.deleted_at IS NULL
    LEFT JOIN LATERAL (SELECT sum(x.amount_cents) AS paid FROM settlement x WHERE x.title_id = t.id AND x.deleted_at IS NULL) s ON true
    WHERE i.entity_code = $1 GROUP BY i.id ORDER BY i.kind DESC, lower(i.name)`, [e])).rows;
  return rows.map(r => ({ id: r.id, name: r.name, kind: r.kind, email: r.email, phone: r.phone, notes: r.notes, products: r.products,
    openCents: Number(r.open_cents), openCount: r.open_count, nextDue: r.next_due as string | null,
    daysToNext: r.next_due ? daysBetween(asOf, r.next_due) : null }));
}

const clean = (v: string | null | undefined) => (v == null ? v : v.trim() || null);
export async function createContact(db: Db, e: Entity, i: ContactInput) {
  if (!i.name?.trim()) throw new AppError(422, "NAME_REQUIRED", "Informe o nome.");
  const r = await db.query(`INSERT INTO institution (entity_code, name, kind, email, phone, notes) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (entity_code, lower(name)) DO NOTHING RETURNING id`, [e, i.name.trim(), i.kind ?? "PESSOA", clean(i.email) ?? null, clean(i.phone) ?? null, clean(i.notes) ?? null]);
  if (!r.rowCount) throw new AppError(409, "DUPLICATE", "Já existe um credor com esse nome.");
  return { id: r.rows[0].id as string };
}
export async function updateContact(db: Db, e: Entity, id: string, p: ContactInput) {
  const map: Record<string, string> = { name: "name", kind: "kind", email: "email", phone: "phone", notes: "notes" };
  const sets: string[] = [], vals: unknown[] = [id, e];
  for (const [k, col] of Object.entries(map)) if (k in p) { vals.push(k === "name" ? p.name?.trim() : clean(p[k as keyof ContactInput] as string | null)); sets.push(`${col} = $${vals.length}`); }
  if (!sets.length) return { id };
  const r = await db.query(`UPDATE institution SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND entity_code = $2`, vals)
    .catch(err => { if ((err as { code?: string }).code === "23505") throw new AppError(409, "DUPLICATE", "Já existe um credor com esse nome."); throw err; });
  if (!r.rowCount) throw new AppError(404, "NOT_FOUND", "Credor não encontrado.");
  return { id };
}
