// Na Vercel: aplica as migrações no banco do projeto antes de publicar (se DATABASE_URL existir).
import { execSync } from "node:child_process";
const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.STORAGE_URL ?? process.env.NEON_DATABASE_URL;
if (!url) { console.log("Sem DATABASE_URL: migrações puladas (conecte o banco Neon ao projeto)."); process.exit(0); }
execSync("npx tsx scripts/migrate.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
