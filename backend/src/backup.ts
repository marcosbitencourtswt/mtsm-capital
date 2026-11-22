/**
 * Cópia de segurança sob demanda (botão em Administração, só o root).
 * Exporta os DADOS de todas as tabelas, sem nada que abra portas: senhas, segredos do 2FA,
 * sessões, chaves de aviso e do leitor de cupons, códigos de recuperação e fotos de cupom ficam de fora.
 * O navegador criptografa o arquivo com a senha que a pessoa digitar (o servidor nunca vê essa senha).
 */
import type { Db } from "./db.js";

const SKIP_TABLES = new Set(["user_session", "push_key", "push_subscription", "worker_token", "recovery_code", "mfa_challenge", "login_attempt", "receipt_inbox"]);
const SKIP_COLUMNS: Record<string, string[]> = { app_user: ["password_hash", "totp_secret", "totp_pending", "totp_last_step"] };

export async function dump(db: Db) {
  const tables = (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows.map(r => r.t).filter(t => !SKIP_TABLES.has(t));
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const cols = (await db.query<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t]))
      .rows.map(r => r.c).filter(c => !(SKIP_COLUMNS[t] ?? []).includes(c));
    out[t] = (await db.query(`SELECT ${cols.map(c => `"${c}"`).join(", ")} FROM "${t}"`)).rows;
  }
  return { format: "mtsm-backup", version: 1, createdAt: new Date().toISOString(), tables: out };
}
