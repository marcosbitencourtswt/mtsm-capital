import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

// BIGINT (centavos) -> number, com verificação de faixa segura. DATE -> string ISO (sem fuso).
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT fora da faixa segura: ${v}`);
  return n;
});
pg.types.setTypeParser(1082, (v: string) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** URL do banco: DATABASE_URL, ou os nomes que a integração Neon da Vercel pode criar. */
export const DB_URL_NAMES = ["DATABASE_URL", "DATABASE_POSTGRES_URL", "DATABASE_DATABASE_URL", "POSTGRES_URL", "STORAGE_URL", "STORAGE_POSTGRES_URL", "NEON_DATABASE_URL"];
export const databaseUrl = () => DB_URL_NAMES.map(n => process.env[n]).find(Boolean);

/**
 * Quem está fazendo a requisição. Toda gravação feita dentro de actorStore.run(userId, ...) vai numa
 * transação com app.user_id definido, e o gatilho de auditoria carimba o autor. Fora dele = "sistema".
 */
export const actorStore = new AsyncLocalStorage<string>();
const WRITE = /^\s*(insert|update|delete|with)\b/i;
const setActor = (c: pg.PoolClient, id: string) => c.query("SELECT set_config('app.user_id', $1, true)", [id]);

export function createPool(url = databaseUrl()): Db {
  if (!url) throw new Error("DATABASE_URL não definida");
  // Na Vercel cada instância é pequena: poucas conexões e fecha as ociosas (use a URL "pooled" do Neon).
  const pool = new pg.Pool({ connectionString: url, max: process.env.VERCEL ? 2 : 5, idleTimeoutMillis: 10_000 });
  const plain = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
  pool.query = (async (text: unknown, values?: unknown[]) => {
    const actor = actorStore.getStore();
    if (!actor || typeof text !== "string" || !WRITE.test(text)) return plain(text as string, values);
    const c = await pool.connect();
    try {
      await c.query("BEGIN"); await setActor(c, actor);
      const r = await c.query(text, values);
      await c.query("COMMIT");
      return r;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }) as typeof pool.query;
  return pool;
}

export async function withTx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const actor = actorStore.getStore();
    if (actor) await setActor(c, actor);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
