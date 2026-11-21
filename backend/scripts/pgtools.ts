import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Localiza pg_dump/pg_restore: PG_BIN no .env, PATH, ou a instalação padrão do Windows. */
export function pgTool(name: "pg_dump" | "pg_restore"): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (process.env.PG_BIN) return join(process.env.PG_BIN, exe);
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    if (existsSync(base)) {
      const vers = readdirSync(base).filter(v => /^\d+/.test(v)).sort((a, b) => parseFloat(b) - parseFloat(a));
      for (const v of vers) { const p = join(base, v, "bin", exe); if (existsSync(p)) return p; }
    }
  }
  return exe; // confia no PATH
}
