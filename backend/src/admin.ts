/** Painel de administração: status do sistema, sessões abertas e registro de alterações. */
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { AppError } from "./service.js";
import type { SessionUser } from "./auth.js";

export async function status(db: Db) {
  const t0 = Date.now();
  const q = async (sql: string) => Number((await db.query(sql)).rows[0]?.n ?? 0);
  const counts = {
    users: await q("SELECT count(*) n FROM app_user WHERE active"),
    people: await q("SELECT count(*) n FROM person WHERE active"),
    titlesOpen: await q("SELECT count(*) n FROM title WHERE deleted_at IS NULL"),
    settlements30d: await q("SELECT count(*) n FROM settlement WHERE deleted_at IS NULL AND created_at > now() - interval '30 days'"),
    sessions: await q("SELECT count(*) n FROM user_session WHERE expires_at > now()"),
    warnings: await q("SELECT count(*) n FROM settlement WHERE deleted_at IS NULL AND cardinality(warnings) > 0"),
  };
  const migrations = (await db.query("SELECT name, applied_at AS \"appliedAt\" FROM schema_migration ORDER BY name")).rows;
  const dbInfo = (await db.query("SELECT current_setting('server_version') AS version, pg_size_pretty(pg_database_size(current_database())) AS size")).rows[0];
  return { ok: true, dbLatencyMs: Date.now() - t0, database: dbInfo, counts, migrations,
    runtime: { node: process.version, vercel: !!process.env.VERCEL, region: process.env.VERCEL_REGION ?? null, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null } };
}

/** Sessões abertas. O id exposto é o hash do token (não serve para entrar). */
export async function listSessions(db: Db, currentToken: string) {
  const mine = createHash("sha256").update(currentToken).digest("hex");
  const rows = (await db.query(`SELECT s.token_hash AS id, s.created_at AS "createdAt", s.last_seen_at AS "lastSeenAt", s.expires_at AS "expiresAt",
      s.user_agent AS "userAgent", u.name, u.email, u.is_root AS "isRoot"
    FROM user_session s JOIN app_user u ON u.id = s.user_id WHERE s.expires_at > now() ORDER BY s.last_seen_at DESC`)).rows;
  return rows.map(r => ({ ...r, current: r.id === mine, device: device(r.userAgent) }));
}
export async function revokeSession(db: Db, id: string, actor: SessionUser) {
  const r = (await db.query("SELECT u.is_root, u.id FROM user_session s JOIN app_user u ON u.id = s.user_id WHERE s.token_hash = $1", [id])).rows[0];
  if (!r) throw new AppError(404, "NOT_FOUND", "Sessão não encontrada (talvez já tenha expirado).");
  if (r.is_root && r.id !== actor.id) throw new AppError(403, "ROOT_PROTECTED", "Só o root encerra as sessões dele.");
  await db.query("DELETE FROM user_session WHERE token_hash = $1", [id]);
}
function device(ua: string | null) {
  if (!ua) return "Desconhecido";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Outro";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return `${br} · ${os}`;
}

const TABLES: Record<string, string> = { title: "Conta", settlement: "Pagamento", recurrence: "Conta automática", setting: "Configuração",
  person: "Pessoa", app_user: "Usuário", conduct_rule: "Regra (combinados)", conduct_entry: "Combinados" };
const ACTIONS: Record<string, string> = { INSERT: "criou", UPDATE: "alterou", DELETE: "apagou" };
/** Últimas alterações (sem senhas: a auditoria de usuário já exclui o hash). */
export async function audit(db: Db, limit: number) {
  const rows = (await db.query(`SELECT id, table_name, action, row_id, at, old_data, new_data FROM audit_log ORDER BY id DESC LIMIT $1`, [limit * 10])).rows;
  const NOISE = new Set(["updated_at", "last_seen_at", "last_login_at", "failed_attempts", "locked_until", "totp_last_step"]);
  // Fora do registro: faltas geradas automaticamente pelo sistema e atualizações de "último acesso".
  const relevant = rows.filter(r => {
    if (r.table_name === "conduct_entry" && r.action === "INSERT" && !r.new_data?.created_by) return false;
    if (r.action === "UPDATE") {
      const n = r.new_data ?? {}, o = r.old_data ?? {};
      return Object.keys(n).some(k => !NOISE.has(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k]));
    }
    return true;
  }).slice(0, limit);
  return relevant.map(r => {
    const n = r.new_data ?? {}, o = r.old_data ?? {};
    const label = n.counterparty ?? n.name ?? n.description ?? n.note ?? n.email ?? n.key ?? o.counterparty ?? o.name ?? "";
    const changed = r.action === "UPDATE" ? Object.keys(n).filter(k => !NOISE.has(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k])) : [];
    return { id: r.id, at: r.at, what: TABLES[r.table_name] ?? r.table_name, action: ACTIONS[r.action] ?? r.action, label: String(label).slice(0, 80), changed };
  });
}
