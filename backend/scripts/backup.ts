/** Backup do banco (pg_dump formato custom), validado e com retenção dos últimos 30. Uso: npm run backup */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pgTool } from "./pgtools.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL não definida"); process.exit(1); }

const dir = join(import.meta.dirname, "..", "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const file = join(dir, `nofinance-${stamp}.dump`);
execFileSync(pgTool("pg_dump"), ["--format=custom", "--no-owner", `--dbname=${url}`, `--file=${file}`], { stdio: "inherit" });
execFileSync(pgTool("pg_restore"), ["--list", file], { stdio: "ignore" }); // valida que o arquivo é legível
const old = readdirSync(dir).filter(f => f.endsWith(".dump")).sort().reverse().slice(30);
for (const f of old) rmSync(join(dir, f));
console.log(`Backup: ${file} (${Math.round(statSync(file).size / 1024)} KB)`);
