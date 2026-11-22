/**
 * Pedidos de compra com autorização.
 * - Qualquer pessoa da casa pede (inclusive o perfil "só combinados"), sugerindo de qual conta/cartão sair.
 * - Aprova ou recusa um responsável que NÃO seja quem pediu (um adulto pede → o outro decide).
 * - Aprovar lança o gasto na conta escolhida, em nome de quem vai usar. Recusar leva um recado
 *   ("sem saldo no Nubank, peça pelo Inter") e a pessoa pode pedir de novo.
 */
import type { Db } from "./db.js";
import type { SessionUser } from "./auth.js";
import { AppError, quickExpense, type Entity } from "./service.js";

const canReview = (u: SessionUser) => !u.conductOnly && (u.role === "ADMIN" || u.isGuardian);
const COLS = `r.id, r.description, r.amount_cents AS "amountCents", r.category, r.status, r.review_note AS "reviewNote", r.created_at AS "createdAt",
  r.reviewed_at AS "reviewedAt", r.requested_by AS "requestedBy", ru.name AS "requestedByName", r.for_person_id AS "forPersonId", p.name AS "forPersonName",
  r.account_id AS "accountId", concat_ws(' · ', ia.name, a.name) AS "accountLabel", r.paid_account_id AS "paidAccountId",
  concat_ws(' · ', ip.name, pa.name) AS "paidAccountLabel", rv.name AS "reviewedByName"`;
const FROM = `FROM purchase_request r JOIN app_user ru ON ru.id = r.requested_by LEFT JOIN person p ON p.id = r.for_person_id
  LEFT JOIN account a ON a.id = r.account_id LEFT JOIN institution ia ON ia.id = a.institution_id
  LEFT JOIN account pa ON pa.id = r.paid_account_id LEFT JOIN institution ip ON ip.id = pa.institution_id
  LEFT JOIN app_user rv ON rv.id = r.reviewed_by`;

/** Opções de "de onde sai": contas e cartões ativos. Quem é só combinados vê só os nomes. */
export async function sources(db: Db, e: Entity) {
  return (await db.query(`SELECT a.id, a.type, concat_ws(' · ', i.name, a.name) AS label, p.name AS "ownerName"
    FROM account a LEFT JOIN institution i ON i.id = a.institution_id LEFT JOIN person p ON p.id = a.owner_person_id
    WHERE a.entity_code = $1 AND a.active AND a.type IN ('CHECKING','SAVINGS','CASH','CARD') ORDER BY p.name NULLS LAST, i.name, a.name`, [e])).rows;
}

async function accountOk(db: Db, e: Entity, id: string | null | undefined) {
  if (!id) return null;
  const a = (await db.query("SELECT id, type FROM account WHERE id = $1 AND entity_code = $2 AND active AND type IN ('CHECKING','SAVINGS','CASH','CARD')", [id, e])).rows[0];
  if (!a) throw new AppError(422, "ACCOUNT_NOT_FOUND", "Conta ou cartão não encontrado.");
  return a as { id: string; type: string };
}

export async function list(db: Db, e: Entity, u: SessionUser) {
  // Responsável vê todos; os demais veem só os próprios pedidos.
  const mine = canReview(u) ? "" : "AND r.requested_by = $2";
  return (await db.query(`SELECT ${COLS} ${FROM} WHERE r.entity_code = $1 ${mine}
    ORDER BY (r.status = 'PENDING') DESC, r.created_at DESC LIMIT 100`, canReview(u) ? [e] : [e, u.id])).rows;
}

export async function create(db: Db, e: Entity, u: SessionUser, i: { description: string; amountCents: number; category?: string; accountId?: string | null; forPersonId?: string | null }) {
  await accountOk(db, e, i.accountId);
  // Só combinados pede sempre para si; os demais podem pedir para outra pessoa (ex.: um adulto para uma criança pequena).
  const forPerson = u.conductOnly ? u.personId : i.forPersonId === undefined ? u.personId : i.forPersonId;
  if (forPerson) {
    const ok = await db.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = $2 AND active", [forPerson, e]);
    if (!ok.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada.");
  }
  const r = await db.query(`INSERT INTO purchase_request (entity_code, requested_by, for_person_id, description, amount_cents, category, account_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [e, u.id, forPerson ?? null, i.description.trim(), i.amountCents, (i.category || "OUTROS").toUpperCase(), i.accountId ?? null]);
  return get(db, e, r.rows[0].id);
}

export async function get(db: Db, e: Entity, id: string) {
  const r = (await db.query(`SELECT ${COLS} ${FROM} WHERE r.id = $1 AND r.entity_code = $2`, [id, e])).rows[0];
  if (!r) throw new AppError(404, "REQUEST_NOT_FOUND", "Pedido não encontrado.");
  return r;
}

export async function review(db: Db, e: Entity, u: SessionUser, id: string, i: { approve: boolean; accountId?: string | null; note?: string | null; date?: string }) {
  if (!canReview(u)) throw new AppError(403, "GUARDIAN_ONLY", "Só os responsáveis aprovam pedidos.");
  const r = (await db.query("SELECT * FROM purchase_request WHERE id = $1 AND entity_code = $2", [id, e])).rows[0];
  if (!r) throw new AppError(404, "REQUEST_NOT_FOUND", "Pedido não encontrado.");
  if (r.status !== "PENDING") throw new AppError(409, "ALREADY_REVIEWED", "Esse pedido já foi decidido.");
  if (r.requested_by === u.id) throw new AppError(403, "OWN_REQUEST", "Quem pediu não aprova o próprio pedido.");
  if (!i.approve) {
    if (!i.note?.trim()) throw new AppError(422, "NOTE_REQUIRED", "Diga o motivo (ex.: sem saldo no Nubank, peça pelo Inter).");
    await db.query("UPDATE purchase_request SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1 AND status = 'PENDING'", [id, u.id, i.note.trim()]);
    return get(db, e, id);
  }
  const acc = await accountOk(db, e, i.accountId ?? r.account_id);
  if (!acc) throw new AppError(422, "ACCOUNT_REQUIRED", "Escolha de qual conta ou cartão sai o dinheiro.");
  // Marca primeiro (evita aprovar duas vezes em dois aparelhos), depois lança o gasto.
  const claimed = await db.query("UPDATE purchase_request SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), review_note = $3, paid_account_id = $4 WHERE id = $1 AND status = 'PENDING'",
    [id, u.id, i.note?.trim() || null, acc.id]);
  if (!claimed.rowCount) throw new AppError(409, "ALREADY_REVIEWED", "Esse pedido já foi decidido.");
  try {
    const t = await quickExpense(db, e, { amountCents: Number(r.amount_cents), category: r.category, description: `Pedido: ${r.description}`, date: i.date,
      personId: r.for_person_id, createdBy: u.id, ...(acc.type === "CARD" ? { cardAccountId: acc.id } : { accountId: acc.id }) });
    await db.query("UPDATE purchase_request SET title_id = $2 WHERE id = $1", [id, t.title.id]);
  } catch (err) {
    await db.query("UPDATE purchase_request SET status = 'PENDING', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, paid_account_id = NULL WHERE id = $1", [id]);
    throw err;
  }
  return get(db, e, id);
}

export async function cancel(db: Db, e: Entity, u: SessionUser, id: string) {
  const r = await db.query("UPDATE purchase_request SET status = 'CANCELED' WHERE id = $1 AND entity_code = $2 AND requested_by = $3 AND status = 'PENDING'", [id, e, u.id]);
  if (!r.rowCount) throw new AppError(409, "CANNOT_CANCEL", "Só dá para cancelar um pedido seu que ainda está aguardando.");
  return get(db, e, id);
}

/** Quem deve decidir: responsáveis, menos quem pediu. */
export async function reviewersFor(db: Db, requesterId: string): Promise<string[]> {
  return (await db.query("SELECT id FROM app_user WHERE active AND NOT conduct_only AND (role = 'ADMIN' OR is_guardian) AND id <> $1", [requesterId])).rows.map(r => r.id);
}
