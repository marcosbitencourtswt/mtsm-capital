/**
 * Caixa de cupons. Fluxo sem custo:
 * 1) cada pessoa envia a foto pelo app (fica aqui, como PENDING);
 * 2) o Marcos pede ao Claude, numa conversa, para "carregar os cupons": o Claude usa uma CHAVE LIMITADA
 *    (worker token) que só lista/baixa as fotos pendentes e marca como lidas — nada de saldos, dívidas ou gravação de gastos;
 * 3) o Claude devolve um arquivo de lançamentos, que a família importa e confere (com trava de duplicado).
 * Fotos lidas/descartadas são apagadas depois de 7 dias; pendentes, depois de 60 (o banco é gratuito e pequeno).
 */
import { randomBytes, createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { SessionUser } from "./auth.js";
import { AppError, type Entity } from "./service.js";

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
export const MAX_BYTES = 1_500_000, DAILY_UPLOADS = 40;
const canSeeAll = (u: SessionUser) => !u.conductOnly && (u.role === "ADMIN" || u.isGuardian);

export async function upload(db: Db, e: Entity, u: SessionUser, i: { image: string; accountId?: string | null; note?: string | null; personId?: string | null }) {
  const buf = Buffer.from(i.image, "base64");
  // Só JPEG/PNG/WebP de verdade (confere os primeiros bytes, não a extensão).
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8, isPng = buf.subarray(0, 4).toString("hex") === "89504e47", isWebp = buf.subarray(8, 12).toString() === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new AppError(422, "NOT_IMAGE", "Envie uma foto (JPG, PNG ou WebP).");
  if (buf.length > MAX_BYTES) throw new AppError(422, "TOO_LARGE", "Foto grande demais. Tente de novo (o app reduz automaticamente).");
  const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM receipt_inbox WHERE uploaded_by = $1 AND created_at > now() - interval '1 day'", [u.id])).rows[0]!.n;
  if (n >= DAILY_UPLOADS) throw new AppError(429, "LIMIT", `Limite de ${DAILY_UPLOADS} cupons por dia.`);
  if (i.accountId) {
    const ok = await db.query("SELECT 1 FROM account WHERE id = $1 AND entity_code = $2 AND active", [i.accountId, e]);
    if (!ok.rowCount) throw new AppError(422, "ACCOUNT_NOT_FOUND", "Conta ou cartão não encontrado.");
  }
  // Quem é só combinados envia sempre em nome próprio; os outros podem enviar por alguém (ex.: pela criança pequena).
  const person = u.conductOnly ? u.personId : i.personId === undefined ? u.personId : i.personId;
  const r = await db.query(`INSERT INTO receipt_inbox (entity_code, uploaded_by, person_id, account_id, note, image, byte_size) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at AS "createdAt"`,
    [e, u.id, person ?? null, i.accountId ?? null, i.note?.trim() || null, buf, buf.length]);
  return r.rows[0];
}

const LIST = `SELECT r.id, r.status, r.note, r.created_at AS "createdAt", r.read_at AS "readAt", r.byte_size AS "byteSize", r.uploaded_by AS "uploadedBy",
  u.name AS "uploadedByName", p.name AS "personName", concat_ws(' · ', i.name, a.name) AS "accountLabel", a.type AS "accountType"
  FROM receipt_inbox r JOIN app_user u ON u.id = r.uploaded_by LEFT JOIN person p ON p.id = r.person_id
  LEFT JOIN account a ON a.id = r.account_id LEFT JOIN institution i ON i.id = a.institution_id`;

export async function list(db: Db, e: Entity, u: SessionUser) {
  const all = canSeeAll(u);
  return (await db.query(`${LIST} WHERE r.entity_code = $1 ${all ? "" : "AND r.uploaded_by = $2"} ORDER BY r.created_at DESC LIMIT 60`, all ? [e] : [e, u.id])).rows;
}
export async function image(db: Db, e: Entity, u: SessionUser, id: string) {
  const r = (await db.query("SELECT image, uploaded_by FROM receipt_inbox WHERE id = $1 AND entity_code = $2", [id, e])).rows[0];
  if (!r || (!canSeeAll(u) && r.uploaded_by !== u.id)) throw new AppError(404, "NOT_FOUND", "Cupom não encontrado.");
  return r.image as Buffer;
}
export async function discard(db: Db, e: Entity, u: SessionUser, id: string) {
  const r = await db.query(`UPDATE receipt_inbox SET status = 'DISCARDED', read_at = now() WHERE id = $1 AND entity_code = $2 AND status = 'PENDING'
    ${canSeeAll(u) ? "" : "AND uploaded_by = $3"}`, canSeeAll(u) ? [id, e] : [id, e, u.id]);
  if (!r.rowCount) throw new AppError(409, "CANNOT_DISCARD", "Só dá para descartar cupom que ainda não foi lido.");
}

/* ---------- Chave limitada do leitor ---------- */
export async function createToken(db: Db, u: SessionUser, label: string, days: number) {
  if (!u.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root cria a chave do leitor de cupons.");
  const token = `mtsm_rcpt_${randomBytes(32).toString("base64url")}`;
  const r = await db.query(`INSERT INTO worker_token (token_hash, label, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))
    RETURNING id, label, expires_at AS "expiresAt"`, [sha256(token), label.trim() || "Leitor de cupons", u.id, days]);
  return { ...r.rows[0], token }; // aparece UMA vez; o banco guarda só o hash
}
export async function listTokens(db: Db) {
  return (await db.query(`SELECT id, label, created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"
    FROM worker_token ORDER BY created_at DESC LIMIT 20`)).rows;
}
export async function revokeToken(db: Db, u: SessionUser, id: string) {
  if (!u.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root revoga a chave do leitor de cupons.");
  await db.query("UPDATE worker_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
}
/** Confere a chave do cabeçalho Authorization: Bearer. */
export async function workerAuth(db: Db, header: string | undefined) {
  const t = header?.match(/^Bearer\s+(mtsm_rcpt_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!t) throw new AppError(401, "WORKER_UNAUTHORIZED", "Chave do leitor ausente ou inválida.");
  const r = await db.query("UPDATE worker_token SET last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id", [sha256(t)]);
  if (!r.rowCount) throw new AppError(401, "WORKER_UNAUTHORIZED", "Chave do leitor ausente, vencida ou revogada.");
}
/** O que o leitor enxerga: só metadados dos cupons pendentes (sem saldos, sem dívidas). */
export async function workerPending(db: Db) {
  return (await db.query(`${LIST} WHERE r.status = 'PENDING' ORDER BY r.created_at LIMIT 100`)).rows
    .map(({ uploadedBy: _u, ...x }) => x);
}
export async function workerImage(db: Db, id: string) {
  const r = (await db.query("SELECT image FROM receipt_inbox WHERE id = $1 AND status = 'PENDING'", [id])).rows[0];
  if (!r) throw new AppError(404, "NOT_FOUND", "Cupom não encontrado ou já lido.");
  return r.image as Buffer;
}
export async function workerMarkRead(db: Db, id: string) {
  const r = await db.query("UPDATE receipt_inbox SET status = 'READ', read_at = now() WHERE id = $1 AND status = 'PENDING'", [id]);
  if (!r.rowCount) throw new AppError(404, "NOT_FOUND", "Cupom não encontrado ou já lido.");
}
/** Limpeza diária: o banco grátis não pode encher de fotos. */
export async function purge(db: Db) {
  const r = await db.query(`DELETE FROM receipt_inbox WHERE (status <> 'PENDING' AND read_at < now() - interval '7 days') OR created_at < now() - interval '60 days'`);
  return r.rowCount ?? 0;
}
