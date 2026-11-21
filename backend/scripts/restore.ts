/**
 * Restaura um backup. Uso: npm run restore -- backups/arquivo.dump [URL_DESTINO]
 * Sem URL_DESTINO, restaura no banco principal e pede confirmação digitando RESTAURAR.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { pgTool } from "./pgtools.js";
import { ensureDatabase } from "./migrate.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }
const [file, target = process.env.DATABASE_URL] = process.argv.slice(2);
if (!file || !target) { console.error("Uso: npm run restore -- <arquivo.dump> [URL_DESTINO]"); process.exit(1); }
if (target === process.env.DATABASE_URL) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = await rl.question("Isso SUBSTITUI o banco principal. Digite RESTAURAR para continuar: ");
  rl.close();
  if (ok.trim() !== "RESTAURAR") { console.log("Cancelado."); process.exit(1); }
}
await ensureDatabase(target);
execFileSync(pgTool("pg_restore"), ["--clean", "--if-exists", "--no-owner", `--dbname=${target}`, file], { stdio: "inherit" });
console.log("Restaurado.");
