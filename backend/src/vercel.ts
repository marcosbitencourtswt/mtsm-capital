/**
 * Entrada da API na Vercel. É empacotada por scripts/build-vercel.mjs numa única função Node
 * (Build Output API). O front (public/) vai como arquivo estático.
 */
import { getRequestListener } from "@hono/node-server";
import { createPool } from "./db.js";
import { createApp } from "./app.js";

const db = createPool(); // reaproveitado entre chamadas na mesma instância
const app = createApp(db, { cronSecret: process.env.CRON_SECRET, secureCookies: true, setupToken: process.env.SETUP_TOKEN });

export default getRequestListener(app.fetch);
