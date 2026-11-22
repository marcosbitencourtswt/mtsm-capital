import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPool } from "../src/db.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }

/** Cria o banco se ele não existir (dispensa usar psql na instalação). */
export async function ensureDatabase(url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.STORAGE_URL) {
  if (!url) throw new Error("DATABASE_URL não definida");
  // Se o banco já existe (ex.: Neon na Vercel), não faz nada.
  const probe = createPool(url);
  try { await probe.query("SELECT 1"); return; }
  catch (e) { if ((e as { code?: string }).code !== "3D000") throw e; }
  finally { await probe.end(); }
  const u = new URL(url); const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Nome de banco inválido: ${name}`);
  u.pathname = "/postgres";
  const admin = createPool(u.toString());
  try {
    const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (!r.rowCount) { await admin.query(`CREATE DATABASE ${name}`); console.log(`Banco criado: ${name}`); }
  } finally { await admin.end(); }
}

/** Aplica migrações SQL versionadas em ordem, uma vez cada, dentro de transação. */
export async function migrate(url?: string): Promise<string[]> {
  await ensureDatabase(url ?? process.env.DATABASE_URL);
  const db = createPool(url);
  const applied: string[] = [];
  try {
    await db.query("CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migration")).rows.map(r => r.name));
    const dir = join(import.meta.dirname, "..", "db", "migrations");
    for (const f of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(join(dir, f), "utf8"));
        await c.query("INSERT INTO schema_migration(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        applied.push(f);
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    }
  } finally { await db.end(); }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then(a => console.log(a.length ? `Aplicadas: ${a.join(", ")}` : "Nada a aplicar.")).catch(e => { console.error(e); process.exit(1); });
}
