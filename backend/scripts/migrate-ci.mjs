// Na Vercel: aplica as migrações no banco do projeto antes de publicar (se DATABASE_URL existir).
import { execSync } from "node:child_process";
const url = ["DATABASE_URL", "DATABASE_POSTGRES_URL", "DATABASE_DATABASE_URL", "POSTGRES_URL", "STORAGE_URL", "STORAGE_POSTGRES_URL", "NEON_DATABASE_URL"].map(n => process.env[n]).find(Boolean);
if (!url) { console.log("Sem DATABASE_URL: migrações puladas (conecte o banco Neon ao projeto)."); process.exit(0); }
execSync("npx tsx scripts/migrate.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
