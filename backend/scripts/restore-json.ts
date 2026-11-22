/**
 * Restaura a cópia de segurança baixada pelo botão do app (arquivo .mtsm) num banco VAZIO.
 *   BACKUP_PASS='sua senha' DATABASE_URL='postgres://...' npx tsx scripts/restore-json.ts mtsm-backup-AAAA-MM-DD.mtsm
 * Use um PostgreSQL em que você seja superusuário (ex.: o do seu computador); depois, se quiser, leve para o Neon com pg_dump.
 * As senhas não vão no arquivo: todos voltam com senha provisória ("must_change_password") e o root redefine
 * com `npm run user:create` / Administração. 2FA e avisos no celular precisam ser ligados de novo.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createPool } from "../src/db.js";
import { migrate } from "./migrate.js";
import { hashPassword } from "../src/auth.js";
import { decryptBackup, type Envelope } from "../web/backup-crypto.js";

export async function restore(url: string, envelope: Envelope, pass: string) {
  const data = JSON.parse(await decryptBackup(envelope, pass)) as { format: string; tables: Record<string, Record<string, unknown>[]> };
  if (data.format !== "mtsm-backup") throw new Error("Conteúdo inesperado.");
  await migrate(url);
  const db = createPool(url), c = await db.connect();
  const counts: Record<string, number> = {};
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica"); // sem gatilhos/chaves durante a carga (ordem livre)
    const placeholder = await hashPassword(randomBytes(24).toString("base64url"));
    for (const [t, rows] of Object.entries(data.tables)) {
      if (t === "schema_migration") continue;
      await c.query(`DELETE FROM "${t}"`);
      if (!rows.length) { counts[t] = 0; continue; }
      const fixed = t === "app_user" ? rows.map(r => ({ ...r, password_hash: placeholder, must_change_password: true })) : rows;
      for (let i = 0; i < fixed.length; i += 500)
        await c.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, [JSON.stringify(fixed.slice(i, i + 500))]);
      counts[t] = rows.length;
    }
    // Sequências (ex.: audit_log.id) continuam do maior valor restaurado.
    const seqs = (await c.query(`SELECT t.relname AS tbl, a.attname AS col, pg_get_serial_sequence(quote_ident(t.relname), a.attname) AS seq
      FROM pg_class t JOIN pg_attribute a ON a.attrelid = t.oid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relkind = 'r' AND a.attnum > 0 AND pg_get_serial_sequence(quote_ident(t.relname), a.attname) IS NOT NULL`)).rows;
    for (const s of seqs) await c.query(`SELECT setval($1, GREATEST(1, COALESCE((SELECT max("${s.col}") FROM "${s.tbl}"), 0)))`, [s.seq]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); await db.end(); }
  return counts;
}

if (process.argv[1]?.endsWith("restore-json.ts")) {
  const file = process.argv[2], url = process.env.DATABASE_URL, pass = process.env.BACKUP_PASS;
  if (!file || !url || !pass) { console.error("Uso: BACKUP_PASS='...' DATABASE_URL='...' npx tsx scripts/restore-json.ts arquivo.mtsm"); process.exit(1); }
  restore(url, JSON.parse(readFileSync(file, "utf8")), pass)
    .then(c => { console.log("Restaurado:", c); console.log("Todos com senha provisória: redefina pelo app (root) ou npm run user:create."); })
    .catch(e => { console.error("Falhou:", (e as Error).message); process.exit(1); });
}
