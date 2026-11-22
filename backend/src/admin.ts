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
  person: "Pessoa", app_user: "Usuário", conduct_rule: "Regra (combinados)", conduct_entry: "Combinados", conduct_check: "Check de tarefa",
  habit_check: "Check de tarefa", conduct_assignment: "Revezamento", conduct_sporadic: "Tarefa avulsa", allowance_plan: "Plano de mesada",
  allowance_closing: "Fechamento de mesada", account: "Banco/cartão/dívida", institution: "Instituição", transfer: "Transferência" };
/** Áreas do filtro → tabelas. */
export const AUDIT_AREAS: Record<string, string[]> = {
  contas: ["title", "recurrence"], pagamentos: ["settlement"], bancos: ["account", "institution"], transferencias: ["transfer"],
  combinados: ["conduct_rule", "conduct_entry", "conduct_check", "habit_check", "conduct_assignment", "conduct_sporadic", "allowance_plan", "allowance_closing"],
  pessoas: ["person", "app_user"], ajustes: ["setting"],
};
const FIELDS: Record<string, string> = { amount_cents: "valor", due_date: "vencimento", paid_on: "data", counterparty: "nome", name: "nome", category: "categoria",
  person_id: "pessoa", account_id: "conta", notes: "observação", note: "observação", active: "ativo", negativado: "negativado", mandatory: "obrigatório",
  rate_bp: "juros", monthly_rate_bp: "juros", credit_limit_cents: "limite", closing_day: "fechamento", due_day: "vencimento", opening_balance_cents: "saldo inicial",
  owner_person_id: "dono", method: "forma", day: "data", from_account_id: "de", to_account_id: "para", role: "perfil", email: "e-mail", must_change_password: "senha provisória",
  totp_enabled_at: "2 etapas", value: "valor", description: "descrição", default_amount_cents: "valor padrão", card_bill_id: "fatura" };
const ACTIONS: Record<string, string> = { INSERT: "criou", UPDATE: "alterou", DELETE: "apagou" };
const NOISE = new Set(["updated_at", "last_seen_at", "last_login_at", "failed_attempts", "locked_until", "totp_last_step"]);
export interface AuditFilter { limit: number; actor?: string; area?: string; from?: string; to?: string; }
/** Registro de alterações com filtros (sem senhas nem segredo do 2FA: os gatilhos já excluem). */
export async function audit(db: Db, f: AuditFilter) {
  const where: string[] = [], vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
  if (f.actor === "system") where.push("a.actor_id IS NULL"); else if (f.actor) add("a.actor_id = ?", f.actor);
  if (f.area && AUDIT_AREAS[f.area]) add("a.table_name = ANY(?)", AUDIT_AREAS[f.area]);
  if (f.from) add("a.at >= ?::date", f.from);
  if (f.to) add("a.at < (?::date + 1)", f.to);
  vals.push(f.limit * 8);
  const rows = (await db.query(`SELECT a.id, a.table_name, a.action, a.at, a.old_data, a.new_data, a.actor_id, u.name AS actor_name
    FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.id DESC LIMIT $${vals.length}`, vals)).rows;
  const diff = (n: Record<string, unknown>, o: Record<string, unknown>) => Object.keys(n).filter(k => !NOISE.has(k) && JSON.stringify(n[k]) !== JSON.stringify(o[k]));
  // Fora do registro: faltas geradas automaticamente e atualizações de "último acesso".
  const relevant = rows.filter(r => {
    if (r.table_name === "conduct_entry" && r.action === "INSERT" && !r.new_data?.created_by) return false;
    return r.action !== "UPDATE" || diff(r.new_data ?? {}, r.old_data ?? {}).length > 0;
  }).slice(0, f.limit);
  const money = (c: unknown) => (typeof c === "number" ? (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "");
  return relevant.map(r => {
    const n = r.new_data ?? {}, o = r.old_data ?? {};
    const changed = r.action === "UPDATE" ? diff(n, o) : [];
    const softDelete = changed.includes("deleted_at") && n.deleted_at;
    const label = n.counterparty ?? n.name ?? n.description ?? n.note ?? n.email ?? n.key ?? o.counterparty ?? o.name ?? "";
    const amount = money(n.amount_cents ?? o.amount_cents);
    const before = changed.includes("amount_cents") ? `${money(o.amount_cents)} → ${money(n.amount_cents)}` : "";
    return { id: r.id, at: r.at, who: r.actor_name ?? "Sistema", what: TABLES[r.table_name] ?? r.table_name,
      action: softDelete ? "excluiu" : ACTIONS[r.action] ?? r.action, label: [String(label).slice(0, 80), amount && !before ? amount : "", before.trim()].filter(Boolean).join(" · "),
      changed: softDelete ? [] : [...new Set(changed.filter(k => k !== "deleted_at").map(k => FIELDS[k] ?? k))] };
  });
}

/** Retenção: tira do banco registros mais velhos que N meses (o backup diário guarda as cópias). */
export async function pruneAudit(db: Db, months: number) {
  if (!months) return 0;
  const r = await db.query("DELETE FROM audit_log WHERE at < now() - make_interval(months => $1)", [months]);
  return r.rowCount ?? 0;
}

/** 0 = sem limite (padrão): o registro é pequeno (~3 MB/ano) e o sistema é para a vida toda. */
export const RETENTION_DEFAULT = 0;
/** Meses que o registro de alterações fica no banco (configuração da família, na entidade pessoal). */
export async function getRetention(db: Db): Promise<number> {
  const r = await db.query("SELECT value FROM setting WHERE entity_code = 'PERSONAL' AND key = 'audit_retention_months'");
  const v = Number(r.rows[0]?.value);
  return Number.isInteger(v) && v >= 0 ? v : RETENTION_DEFAULT;
}
export async function setRetention(db: Db, months: number) {
  await db.query(`INSERT INTO setting (entity_code, key, value) VALUES ('PERSONAL', 'audit_retention_months', to_jsonb($1::int))
    ON CONFLICT (entity_code, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [months]);
  return { months };
}
