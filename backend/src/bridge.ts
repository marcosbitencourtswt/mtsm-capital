/**
 * Ponte PJ → PF: um lançamento só para tirar dinheiro da Byte4Tech e pôr na conta pessoal.
 * - Pró-labore: despesa da PJ (categoria PRO_LABORE) + receita da PF (RENDA).
 * - Distribuição de lucros: saída da PJ (categoria LUCROS, não é custo operacional) + receita da PF (RENDA).
 * Se a conta automática do mês já existe (dos dois lados), ela é QUITADA em vez de criar outra (nada em dobro).
 * Também resume os impostos do mês da PJ (DAS, INSS): pago, em aberto ou atrasado.
 */
import type { Db } from "./db.js";
import type { SessionUser } from "./auth.js";
import { AppError, createTitle, createSettlement } from "./service.js";
import { todaySP } from "./domain/finance.js";

export type BridgeKind = "PRO_LABORE" | "LUCROS";
const LABEL: Record<BridgeKind, string> = { PRO_LABORE: "Pró-labore", LUCROS: "Distribuição de lucros" };

/** Contas pessoais que podem receber o repasse (conta/poupança/dinheiro). */
export async function targets(db: Db) {
  return (await db.query(`SELECT a.id, concat_ws(' · ', i.name, a.name) AS label, p.name AS "ownerName", a.owner_person_id AS "ownerPersonId"
    FROM account a LEFT JOIN institution i ON i.id = a.institution_id LEFT JOIN person p ON p.id = a.owner_person_id
    WHERE a.entity_code = 'PERSONAL' AND a.active AND a.type IN ('CHECKING','SAVINGS','CASH') ORDER BY p.name NULLS LAST, i.name, a.name`)).rows;
}

async function account(db: Db, entity: "PERSONAL" | "BYTE4TECH", id: string) {
  const a = (await db.query("SELECT id, owner_person_id FROM account WHERE id = $1 AND entity_code = $2 AND active AND type IN ('CHECKING','SAVINGS','CASH')", [id, entity])).rows[0];
  if (!a) throw new AppError(422, "ACCOUNT_NOT_FOUND", entity === "BYTE4TECH" ? "Conta da PJ não encontrada." : "Conta pessoal não encontrada.");
  return a as { id: string; owner_person_id: string | null };
}

/** Conta automática em aberto do mês que corresponde ao repasse (para quitar em vez de duplicar). */
async function openMatch(db: Db, entity: "PERSONAL" | "BYTE4TECH", kind: "PAYABLE" | "RECEIVABLE", month: string, where: string) {
  return (await db.query(`SELECT t.id FROM title t WHERE t.entity_code = $1 AND t.kind = $2 AND t.deleted_at IS NULL
      AND to_char(COALESCE(t.competence_month, t.due_date), 'YYYY-MM') = $3 AND ${where}
      AND COALESCE((SELECT sum(s.amount_cents) FROM settlement s WHERE s.title_id = t.id AND s.deleted_at IS NULL), 0) = 0
    ORDER BY t.due_date NULLS LAST LIMIT 1`, [entity, kind, month])).rows[0]?.id as string | undefined;
}

export async function transferToPersonal(db: Db, u: SessionUser, i: { kind: BridgeKind; amountCents: number; date?: string; fromAccountId: string; toAccountId: string }) {
  if (!u.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root faz o repasse da PJ para a PF.");
  const date = i.date ?? todaySP(), month = date.slice(0, 7), label = LABEL[i.kind];
  await account(db, "BYTE4TECH", i.fromAccountId);
  const to = await account(db, "PERSONAL", i.toAccountId);
  // PJ: quita a conta automática do mês, se houver; senão cria a saída.
  let pjTitle = i.kind === "PRO_LABORE" ? await openMatch(db, "BYTE4TECH", "PAYABLE", month, "t.category = 'PRO_LABORE'") : undefined;
  let createdPj: string | null = null;
  if (pjTitle) await db.query("UPDATE title SET amount_cents = $2 WHERE id = $1", [pjTitle, i.amountCents]);
  else { pjTitle = (await createTitle(db, "BYTE4TECH", { kind: "PAYABLE", nature: "EXPENSE", counterparty: `${label} → conta pessoal`, category: i.kind, amountCents: i.amountCents, dueDate: date, createdBy: u.id })).id; createdPj = pjTitle; }
  let createdPf: string | null = null;
  try {
    await createSettlement(db, "BYTE4TECH", pjTitle, { amountCents: i.amountCents, paidOn: date, accountId: i.fromAccountId, createdBy: u.id, notes: "Repasse PJ → PF" });
    // PF: quita a receita automática do mês (ex.: "Pró-labore Byte4Tech"), se houver; senão cria.
    let pfTitle = await openMatch(db, "PERSONAL", "RECEIVABLE", month, i.kind === "PRO_LABORE" ? "t.counterparty ILIKE '%pró-labore%'" : "t.counterparty ILIKE '%lucros%'");
    if (pfTitle) await db.query("UPDATE title SET amount_cents = $2 WHERE id = $1", [pfTitle, i.amountCents]);
    else { pfTitle = (await createTitle(db, "PERSONAL", { kind: "RECEIVABLE", nature: "INCOME", counterparty: `${label} Byte4Tech`, category: "RENDA", amountCents: i.amountCents, dueDate: date, personId: to.owner_person_id, createdBy: u.id })).id; createdPf = pfTitle; }
    await createSettlement(db, "PERSONAL", pfTitle, { amountCents: i.amountCents, paidOn: date, accountId: i.toAccountId, createdBy: u.id, notes: "Repasse PJ → PF" });
    return { pjTitleId: pjTitle, pfTitleId: pfTitle, label };
  } catch (e) {
    // Falhou no meio (ex.: mês fechado): desfaz o que este repasse criou e o pagamento da PJ, para nada ficar pela metade.
    await db.query("UPDATE settlement SET deleted_at = now() WHERE title_id = $1 AND notes = 'Repasse PJ → PF' AND deleted_at IS NULL AND paid_on = $2", [pjTitle, date]).catch(() => {});
    for (const id of [createdPj, createdPf]) if (id) await db.query("UPDATE title SET deleted_at = now() WHERE id = $1", [id]).catch(() => {});
    throw e;
  }
}

/** Impostos do mês da PJ: cada conta de imposto/pró-labore do mês com a situação. */
export async function taxStatus(db: Db, month = todaySP().slice(0, 7), asOf = todaySP()) {
  const rows = (await db.query(`SELECT t.id, t.counterparty AS name, t.category, t.amount_cents AS "amountCents", t.due_date::text AS "dueDate",
      COALESCE((SELECT sum(s.amount_cents) FROM settlement s WHERE s.title_id = t.id AND s.deleted_at IS NULL), 0)::bigint AS paid
    FROM title t WHERE t.entity_code = 'BYTE4TECH' AND t.kind = 'PAYABLE' AND t.deleted_at IS NULL AND t.category IN ('IMPOSTOS', 'PRO_LABORE')
      AND to_char(COALESCE(t.competence_month, t.due_date), 'YYYY-MM') = $1 ORDER BY t.due_date`, [month])).rows;
  return rows.map(r => {
    const paid = Number(r.paid), amount = Number(r.amountCents);
    const status = amount > 0 && paid >= amount ? "pago" : r.dueDate && r.dueDate < asOf ? "atrasado" : "em aberto";
    return { id: r.id, name: r.name, category: r.category, amountCents: amount, paidCents: paid, dueDate: r.dueDate, status };
  });
}
