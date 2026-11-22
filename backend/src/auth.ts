/**
 * Autenticação: e-mail + senha (scrypt), sessão em cookie HttpOnly guardada no banco (revogável),
 * bloqueio após 5 tentativas erradas. Sem dependências externas (node:crypto).
 */
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db.js";
import { AppError } from "./service.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;
const MAX_FAILS = 5, LOCK_MINUTES = 15;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, s, h] = stored.split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const expected = Buffer.from(h, "base64");
  const got = await scrypt(pw, Buffer.from(s, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}
// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (não revela quais e-mails existem).
const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

export function validatePassword(pw: string) {
  if (pw.length < MIN_PASSWORD) throw new AppError(422, "WEAK_PASSWORD", `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  if (/^(.)\1+$/.test(pw) || /^(\d+|(senha|password|mudar|trocar)\d*)$/i.test(pw)) throw new AppError(422, "WEAK_PASSWORD", "Senha fácil demais. Use uma frase ou misture palavras e números.");
}

export interface SessionUser { id: string; email: string; name: string; nickname: string | null; role: "ADMIN" | "MEMBER"; personId: string | null; mustChangePassword: boolean; isGuardian: boolean; isRoot: boolean; totpEnabled: boolean; }
const USER_COLS = `u.id, u.email, u.name, u.nickname, u.role, u.person_id AS "personId", u.must_change_password AS "mustChangePassword", u.is_guardian AS "isGuardian", u.is_root AS "isRoot", (u.totp_secret IS NOT NULL) AS "totpEnabled"`;

const IP_MAX_FAILS = 20, IP_WINDOW_MIN = 15;
/** Limite por endereço de rede: impede tentar muitas senhas (ou travar contas de outros) a partir do mesmo lugar. */
async function checkIp(db: Db, ip?: string) {
  if (!ip) return;
  const r = await db.query(`SELECT count(*)::int AS n FROM login_attempt WHERE ip = $1 AND NOT ok AND at > now() - interval '${IP_WINDOW_MIN} minutes'`, [ip]);
  if (r.rows[0].n >= IP_MAX_FAILS) throw new AppError(422, "TOO_MANY_ATTEMPTS", `Muitas tentativas deste aparelho. Espere ${IP_WINDOW_MIN} minutos.`);
}
async function recordIp(db: Db, ip: string | undefined, ok: boolean) {
  if (!ip) return;
  await db.query("INSERT INTO login_attempt (ip, ok) VALUES ($1, $2)", [ip, ok]);
  if (Math.random() < 0.05) await db.query("DELETE FROM login_attempt WHERE at < now() - interval '1 day'");
}

export async function login(db: Db, emailRaw: string, pw: string, userAgent?: string, ip?: string) {
  const email = emailRaw.trim().toLowerCase();
  await checkIp(db, ip);
  const r = await db.query(`SELECT ${USER_COLS}, u.password_hash, u.active, u.failed_attempts, u.locked_until FROM app_user u WHERE u.email = $1`, [email]);
  const u = r.rows[0];
  if (!u || !u.active) { await verifyPassword(pw, DUMMY); await recordIp(db, ip, false); throw new AppError(422, "INVALID_LOGIN", "E-mail ou senha incorretos."); }
  if (u.locked_until && new Date(u.locked_until) > new Date())
    throw new AppError(422, "LOCKED", `Muitas tentativas erradas. Tente de novo em ${LOCK_MINUTES} minutos.`);
  if (!(await verifyPassword(pw, u.password_hash))) {
    await recordIp(db, ip, false);
    const fails = u.failed_attempts + 1;
    await db.query(`UPDATE app_user SET failed_attempts = $2, locked_until = CASE WHEN $2 >= ${MAX_FAILS} THEN now() + interval '${LOCK_MINUTES} minutes' END WHERE id = $1`, [u.id, fails]);
    throw new AppError(422, "INVALID_LOGIN", fails >= MAX_FAILS ? `Conta bloqueada por ${LOCK_MINUTES} minutos depois de ${MAX_FAILS} tentativas.` : "E-mail ou senha incorretos.");
  }
  await db.query("UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [u.id]);
  const { password_hash: _h, active: _a, failed_attempts: _f, locked_until: _l, ...user } = u;
  if (u.totpEnabled) {
    // Senha certa, mas falta o código do autenticador: devolve um desafio de 5 minutos, sem sessão.
    const challenge = randomBytes(32).toString("base64url");
    await db.query("DELETE FROM mfa_challenge WHERE expires_at < now()");
    await db.query("INSERT INTO mfa_challenge (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')",
      [sha256(challenge), u.id, (userAgent ?? "").slice(0, 200)]);
    return { mfaRequired: true as const, challenge };
  }
  await recordIp(db, ip, true);
  return { mfaRequired: false as const, token: await newSession(db, u.id, userAgent), user: user as SessionUser };
}

async function newSession(db: Db, userId: string, userAgent?: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO user_session (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days', $3)`,
    [sha256(token), userId, (userAgent ?? "").slice(0, 200)]);
  await db.query("UPDATE app_user SET last_login_at = now() WHERE id = $1", [userId]);
  return token;
}

/* ---------- Verificação em duas etapas (TOTP, RFC 6238) — sem SMS, sem custo ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = "";
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
const nowStep = () => Math.floor(Date.now() / 30000);
/** Aceita 30 s antes/depois (relógio do celular). Devolve o passo usado, ou null. */
function matchTotp(secret: string, code: string, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const n = nowStep();
  for (const st of [n - 1, n, n + 1]) {
    if (lastStep != null && st <= lastStep) continue; // código já usado
    const a = Buffer.from(totpAt(secret, st)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return st;
  }
  return null;
}
const normRecovery = (c: string) => c.replace(/[^a-z0-9]/gi, "").toLowerCase();

export async function loginMfa(db: Db, challenge: string, codeRaw: string, ip?: string) {
  await checkIp(db, ip);
  const r = await db.query(`SELECT c.user_id, c.user_agent, c.attempts, u.totp_secret, u.totp_last_step, u.active FROM mfa_challenge c JOIN app_user u ON u.id = c.user_id
    WHERE c.token_hash = $1 AND c.expires_at > now()`, [sha256(challenge)]);
  const ch = r.rows[0];
  if (!ch || !ch.active || !ch.totp_secret) throw new AppError(422, "MFA_EXPIRED", "O tempo para digitar o código acabou. Entre de novo com e-mail e senha.");
  const code = codeRaw.replace(/\s/g, "");
  let ok = false;
  const st = matchTotp(ch.totp_secret, code, ch.totp_last_step == null ? null : Number(ch.totp_last_step));
  if (st != null) { ok = true; await db.query("UPDATE app_user SET totp_last_step = $2 WHERE id = $1", [ch.user_id, st]); }
  else if (code.length >= 8) {
    const used = await db.query("UPDATE recovery_code SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL", [ch.user_id, sha256(normRecovery(code))]);
    ok = (used.rowCount ?? 0) > 0;
  }
  if (!ok) {
    await recordIp(db, ip, false);
    const left = await db.query("UPDATE mfa_challenge SET attempts = attempts + 1 WHERE token_hash = $1 RETURNING attempts", [sha256(challenge)]);
    if ((left.rows[0]?.attempts ?? 99) >= 5) { await db.query("DELETE FROM mfa_challenge WHERE token_hash = $1", [sha256(challenge)]); throw new AppError(422, "MFA_EXPIRED", "Código errado muitas vezes. Entre de novo com e-mail e senha."); }
    throw new AppError(422, "MFA_INVALID", "Código incorreto. Confira o app autenticador (o código muda a cada 30 segundos).");
  }
  await db.query("DELETE FROM mfa_challenge WHERE token_hash = $1", [sha256(challenge)]);
  await recordIp(db, ip, true);
  const token = await newSession(db, ch.user_id, ch.user_agent);
  return { token, user: (await sessionUser(db, token))! };
}

export async function totpSetup(db: Db, userId: string) {
  const u = (await db.query("SELECT email, totp_secret FROM app_user WHERE id = $1", [userId])).rows[0];
  if (u.totp_secret) throw new AppError(409, "MFA_ALREADY_ON", "A verificação em duas etapas já está ativa.");
  const secret = base32(randomBytes(20));
  await db.query("UPDATE app_user SET totp_pending = $2 WHERE id = $1", [userId, secret]);
  const label = encodeURIComponent(`MTSM Capital:${u.email}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=MTSM%20Capital&algorithm=SHA1&digits=6&period=30` };
}
export async function totpEnable(db: Db, userId: string, code: string) {
  const u = (await db.query("SELECT totp_pending FROM app_user WHERE id = $1", [userId])).rows[0];
  if (!u?.totp_pending) throw new AppError(422, "MFA_NO_SETUP", "Comece de novo: toque em Ativar.");
  const st = matchTotp(u.totp_pending, code.replace(/\s/g, ""), null);
  if (st == null) throw new AppError(422, "MFA_INVALID", "Código incorreto. Confira se o horário do celular está automático.");
  await db.query("UPDATE app_user SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = $2, totp_enabled_at = now() WHERE id = $1", [userId, st]);
  return { recoveryCodes: await newRecoveryCodes(db, userId) };
}
async function newRecoveryCodes(db: Db, userId: string) {
  await db.query("DELETE FROM recovery_code WHERE user_id = $1", [userId]);
  const codes = Array.from({ length: 8 }, () => { const c = base32(randomBytes(7)).slice(0, 10).toLowerCase(); return `${c.slice(0, 5)}-${c.slice(5)}`; });
  for (const c of codes) await db.query("INSERT INTO recovery_code (user_id, code_hash) VALUES ($1, $2)", [userId, sha256(normRecovery(c))]);
  return codes;
}
export async function totpDisable(db: Db, userId: string, password: string) {
  const r = await db.query("SELECT password_hash FROM app_user WHERE id = $1", [userId]);
  if (!(await verifyPassword(password, r.rows[0].password_hash))) throw new AppError(422, "INVALID_LOGIN", "Senha incorreta.");
  await clearTotp(db, userId);
}
async function clearTotp(db: Db, userId: string) {
  await db.query("UPDATE app_user SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, totp_enabled_at = NULL WHERE id = $1", [userId]);
  await db.query("DELETE FROM recovery_code WHERE user_id = $1", [userId]);
}
/** Celular perdido: o admin desliga o 2FA de alguém (root só por ele mesmo; admin só pelo root). */
export async function adminResetTotp(db: Db, id: string, actor: Actor) {
  const t = (await db.query("SELECT role, is_root FROM app_user WHERE id = $1", [id])).rows[0];
  if (!t) throw new AppError(404, "USER_NOT_FOUND", "Usuário não encontrado.");
  if (t.is_root && actor.id !== id) throw new AppError(403, "ROOT_PROTECTED", "O root só pode ser alterado por ele mesmo.");
  if (t.role === "ADMIN" && !actor.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root gerencia administradores.");
  await clearTotp(db, id);
  await db.query("DELETE FROM user_session WHERE user_id = $1", [id]);
}

export async function sessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query(
    `UPDATE user_session s SET last_seen_at = now() FROM app_user u
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.active
     RETURNING ${USER_COLS}`, [sha256(token)]);
  return (r.rows[0] as SessionUser) ?? null;
}

export async function logout(db: Db, token: string | undefined) {
  if (token) await db.query("DELETE FROM user_session WHERE token_hash = $1", [sha256(token)]);
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepToken?: string) {
  validatePassword(next);
  const r = await db.query("SELECT password_hash FROM app_user WHERE id = $1", [userId]);
  if (!r.rowCount || !(await verifyPassword(current, r.rows[0].password_hash))) throw new AppError(422, "INVALID_LOGIN", "Senha atual incorreta.");
  await db.query("UPDATE app_user SET password_hash = $2, must_change_password = false WHERE id = $1", [userId, await hashPassword(next)]);
  // Encerra as outras sessões (ex.: celular perdido), mantém a atual.
  await db.query("DELETE FROM user_session WHERE user_id = $1 AND token_hash <> $2", [userId, keepToken ? sha256(keepToken) : ""]);
}

/* ---------- Administração de usuários (só ADMIN) ---------- */
const PUBLIC_COLS = `id, email, name, nickname, role, person_id AS "personId", is_guardian AS "isGuardian", is_root AS "isRoot", active, must_change_password AS "mustChangePassword", last_login_at AS "lastLoginAt", created_at AS "createdAt", (totp_secret IS NOT NULL) AS "totpEnabled"`;
export async function listUsers(db: Db) {
  return (await db.query(`SELECT ${PUBLIC_COLS} FROM app_user ORDER BY is_root DESC, role, name`)).rows;
}
export interface UserInput { email: string; name: string; nickname?: string | null; role?: "ADMIN" | "MEMBER"; personId?: string | null; isGuardian?: boolean; password: string; }
export type Actor = { id: string; isRoot: boolean };
/** actor ausente = script de linha de comando (quem tem acesso ao banco já é dono do sistema). */
export async function createUser(db: Db, i: UserInput, actor?: Actor) {
  if (actor && i.role === "ADMIN" && !actor.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root cria administradores.");
  validatePassword(i.password);
  if (i.personId) await assertPersonPersonal(db, i.personId);
  try {
    const r = await db.query(
      `INSERT INTO app_user (email, name, nickname, role, person_id, is_guardian, password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PUBLIC_COLS}`,
      [i.email.trim().toLowerCase(), i.name.trim(), i.nickname?.trim() || null, i.role ?? "MEMBER", i.personId ?? null, i.isGuardian ?? i.role === "ADMIN", await hashPassword(i.password)]);
    return r.rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError(409, "DUPLICATE", "Já existe usuário com esse e-mail ou ligado a essa pessoa.");
    throw e;
  }
}
export async function updateUser(db: Db, id: string, p: Partial<Omit<UserInput, "password">> & { active?: boolean; password?: string }, actor: Actor) {
  const t = (await db.query("SELECT role, is_root FROM app_user WHERE id = $1", [id])).rows[0];
  if (!t) throw new AppError(404, "USER_NOT_FOUND", "Usuário não encontrado.");
  if (t.is_root) {
    if (actor.id !== id) throw new AppError(403, "ROOT_PROTECTED", "O root só pode ser alterado por ele mesmo.");
    if (p.active === false || p.role === "MEMBER" || p.isGuardian === false) throw new AppError(422, "ROOT_PROTECTED", "O root não pode ser desativado nem perder o acesso de administrador.");
  }
  if ((t.role === "ADMIN" || p.role === "ADMIN") && !actor.isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root gerencia administradores.");
  if (id === actor.id && (p.active === false || p.role === "MEMBER")) throw new AppError(422, "SELF_LOCKOUT", "Você não pode remover o próprio acesso de administrador.");
  if (p.personId) await assertPersonPersonal(db, p.personId);
  const sets: string[] = []; const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length + 1}`); };
  if (p.email !== undefined) add("email", p.email.trim().toLowerCase());
  if (p.name !== undefined) add("name", p.name.trim());
  if (p.nickname !== undefined) add("nickname", p.nickname?.trim() || null);
  if (p.role !== undefined) add("role", p.role);
  if (p.personId !== undefined) add("person_id", p.personId);
  if (p.active !== undefined) add("active", p.active);
  if (p.isGuardian !== undefined) add("is_guardian", p.isGuardian);
  if (p.password !== undefined) { validatePassword(p.password); add("password_hash", await hashPassword(p.password)); add("must_change_password", true); add("failed_attempts", 0); add("locked_until", null); }
  if (!sets.length) throw new AppError(400, "EMPTY", "Nada para alterar.");
  const r = await db.query(`UPDATE app_user SET ${sets.join(", ")} WHERE id = $1 RETURNING ${PUBLIC_COLS}`, [id, ...vals]).catch(e => {
    if ((e as { code?: string }).code === "23505") throw new AppError(409, "DUPLICATE", "Já existe usuário com esse e-mail ou ligado a essa pessoa.");
    throw e;
  });
  if (!r.rowCount) throw new AppError(404, "USER_NOT_FOUND", "Usuário não encontrado.");
  if (p.active === false || p.password !== undefined) await db.query("DELETE FROM user_session WHERE user_id = $1", [id]);
  return r.rows[0];
}
async function assertPersonPersonal(db: Db, personId: string) {
  const r = await db.query("SELECT 1 FROM person WHERE id = $1 AND entity_code = 'PERSONAL'", [personId]);
  if (!r.rowCount) throw new AppError(422, "PERSON_NOT_FOUND", "Pessoa não encontrada em Pessoas da casa.");
}

/* ---------- Primeiro acesso (instalação pelo navegador) ---------- */
/** Precisa de instalação quando ainda não existe nenhum usuário. */
export async function setupNeeded(db: Db): Promise<boolean> {
  return (await db.query("SELECT 1 FROM app_user LIMIT 1")).rowCount === 0;
}
/**
 * Cria o primeiro administrador. Exige o SETUP_TOKEN (variável de ambiente na Vercel) e só funciona
 * enquanto não houver nenhum usuário: depois disso a rota fica inútil.
 */
export async function setupFirstAdmin(db: Db, expectedToken: string | undefined, i: { token: string; email: string; name: string; password: string }, userAgent?: string) {
  if (!expectedToken) throw new AppError(403, "SETUP_DISABLED", "O servidor ainda não recebeu o SETUP_TOKEN. Confira o nome exato na Vercel (Settings → Environment Variables, ambiente Production) e faça Redeploy.");
  if (expectedToken.length < 16) throw new AppError(403, "SETUP_DISABLED", `O SETUP_TOKEN da Vercel tem ${expectedToken.length} caracteres; use 16 ou mais e faça Redeploy.`);
  const a = Buffer.from(i.token), b = Buffer.from(expectedToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(403, "SETUP_TOKEN", "Código de instalação incorreto.");
  validatePassword(i.password);
  // Trava contra duas instalações simultâneas: só insere se a tabela ainda estiver vazia.
  const r = await db.query(`INSERT INTO app_user (email, name, nickname, role, is_guardian, is_root, must_change_password, password_hash)
    SELECT $1, $2, 'Gastador', 'ADMIN', true, true, false, $3 WHERE NOT EXISTS (SELECT 1 FROM app_user) RETURNING id`,
    [i.email.trim().toLowerCase(), i.name.trim(), await hashPassword(i.password)]);
  if (!r.rowCount) throw new AppError(409, "ALREADY_SETUP", "O sistema já foi instalado. Entre com seu e-mail e senha.");
  const r2 = await login(db, i.email, i.password, userAgent);
  if (r2.mfaRequired) throw new AppError(409, "ALREADY_SETUP", "O sistema já foi instalado.");
  return r2;
}
