import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createPool } from "./db.js";
import { createApp } from "./app.js";
import { generateRecurrences } from "./service.js";
import { todaySP, addMonths } from "./domain/finance.js";

/** Servidor local (localhost/WSL). Na Vercel quem atende é api/index.ts. */
try { process.loadEnvFile(".env"); } catch { /* sem .env: usa variáveis do ambiente */ }

const db = createPool();
const app = createApp(db, { cronSecret: process.env.CRON_SECRET || undefined, setupToken: process.env.SETUP_TOKEN || undefined });
// Front (public/): mesma origem da API, sem CORS.
app.use("/*", serveStatic({ root: "./public" }));
const port = Number(process.env.PORT ?? 3333);
const hostname = process.env.HOST ?? "127.0.0.1";

/** Lançamento automático: gera as recorrências do mês atual e do próximo. Idempotente. */
async function autoGenerate() {
  const cur = todaySP().slice(0, 7);
  for (const e of ["PERSONAL", "BYTE4TECH"] as const)
    for (const m of [cur, addMonths(cur, 1).slice(0, 7)]) {
      const r = await generateRecurrences(db, e, m);
      if (r.created.length) console.log(JSON.stringify({ level: "info", msg: "recorrências geradas", entity: e, month: r.month, items: r.created.length }));
    }
}
await autoGenerate().catch(e => console.error(JSON.stringify({ level: "error", msg: "autoGenerate", err: (e as Error).message })));
setInterval(() => autoGenerate().catch(() => {}), 6 * 3600 * 1000).unref();

serve({ fetch: app.fetch, port, hostname }, info => console.log(`NOFINANCE em http://localhost:${info.port}  (API: /api/v1)`));
