// Na Vercel: aplica as migrações no banco do projeto antes de publicar (se DATABASE_URL existir).
import { execSync } from "node:child_process";
if (!process.env.DATABASE_URL) { console.log("Sem DATABASE_URL: migrações puladas (conecte o banco Neon ao projeto)."); process.exit(0); }
execSync("npx tsx scripts/migrate.ts", { stdio: "inherit" });
