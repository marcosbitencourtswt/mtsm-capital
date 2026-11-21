import pg from "pg";

// BIGINT (centavos) -> number, com verificação de faixa segura. DATE -> string ISO (sem fuso).
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT fora da faixa segura: ${v}`);
  return n;
});
pg.types.setTypeParser(1082, (v: string) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL não definida");
  // Na Vercel cada instância é pequena: poucas conexões e fecha as ociosas (use a URL "pooled" do Neon).
  return new pg.Pool({ connectionString: url, max: process.env.VERCEL ? 2 : 5, idleTimeoutMillis: 10_000 });
}

export async function withTx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
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
