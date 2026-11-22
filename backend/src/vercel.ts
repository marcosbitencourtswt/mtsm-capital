/**
 * Entrada da API na Vercel. É empacotada por scripts/build-vercel.mjs numa única função Node
 * (Build Output API). O front (public/) vai como arquivo estático.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createPool, databaseUrl } from "./db.js";
import { createApp } from "./app.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Sem banco conectado a função não pode quebrar: responde 503 dizendo exatamente o que fazer. */
function notConfigured(message: string): Handler {
  return (_req, res) => {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "NOT_CONFIGURED", message } }));
  };
}

let handler: Handler;
if (!databaseUrl()) {
  handler = notConfigured("Banco de dados não conectado. Na Vercel: Storage → Create Database → Neon → Connect; depois Deployments → Redeploy.");
} else {
  const db = createPool(); // reaproveitado entre chamadas na mesma instância
  const app = createApp(db, { cronSecret: process.env.CRON_SECRET, secureCookies: true, setupToken: process.env.SETUP_TOKEN });
  handler = getRequestListener(app.fetch);
}
export default handler;
