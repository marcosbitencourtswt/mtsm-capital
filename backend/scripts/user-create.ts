/**
 * Cria um usuário (o primeiro administrador, por exemplo). A senha é pedida sem aparecer na tela.
 * Uso: npm run user:create -- --email marcos@exemplo.com --name Marcos --role ADMIN --nickname Gastador
 * Para criar direto no banco da Vercel/Neon: DATABASE_URL=<url do Neon> npm run user:create -- ...
 */
import { createInterface } from "node:readline";
import { createPool } from "../src/db.js";
import { createUser } from "../src/auth.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg("email"), name = arg("name"), role = (arg("role") ?? "MEMBER").toUpperCase(), nickname = arg("nickname");
if (!email || !name || !["ADMIN", "MEMBER"].includes(role)) {
  console.error("Uso: npm run user:create -- --email <email> --name <nome> [--role ADMIN|MEMBER] [--nickname <apelido>]");
  process.exit(1);
}
function askHidden(q: string): Promise<string> {
  return new Promise(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as ReturnType<typeof createInterface> & { _writeToOutput: (s: string) => void };
    let muted = false;
    rl._writeToOutput = s => { if (!muted) process.stdout.write(s); };
    rl.question(q, a => { rl.close(); process.stdout.write("\n"); res(a); });
    muted = true;
  });
}
const pw = await askHidden("Senha (mín. 10 caracteres): ");
const pw2 = await askHidden("Repita a senha: ");
if (pw !== pw2) { console.error("As senhas não conferem."); process.exit(1); }
const db = createPool();
try {
  const u = await createUser(db, { email, name, role: role as "ADMIN" | "MEMBER", nickname: nickname ?? null, password: pw });
  console.log(`Usuário criado: ${u.name} <${u.email}> (${u.role}). No primeiro login ele vai trocar a senha.`);
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await db.end(); }
