/**
 * Teste de ponta a ponta da TELA (navegador de verdade, Playwright pré-instalado no ambiente).
 * Sobe o servidor contra o banco de teste, cria usuários e percorre os fluxos principais.
 * Uso: npm run test:e2e   (depois de npm test, que recria o banco nofinance_test)
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createPool } from "../../src/db.js";
import { createUser } from "../../src/auth.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const DB = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/nofinance_test";
const PORT = 3996, U = `http://localhost:${PORT}`;
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
let failures = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failures++; };

const db = createPool(DB);
const stamp = Date.now().toString(36);
const adminEmail = `e2e-adm-${stamp}@familia.test`, kidEmail = `e2e-kid-${stamp}@familia.test`, PW = "frase-longa-e2e-12345";
await createUser(db, { email: adminEmail, name: "E2E Admin", role: "ADMIN", password: PW });
await db.query("UPDATE app_user SET is_root = false WHERE email = $1", [adminEmail]);
const kidPerson = (await db.query("INSERT INTO person (entity_code, name) VALUES ('PERSONAL', $1) RETURNING id", [`Criança ${stamp}`])).rows[0].id;
await createUser(db, { email: kidEmail, name: "E2E Criança", personId: kidPerson, conductOnly: true, password: PW });
await db.query("UPDATE app_user SET must_change_password = false WHERE email = ANY($1)", [[adminEmail, kidEmail]]);

const srv = spawn("npx", ["tsx", "src/server.ts"], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), SECURE_COOKIES: "false" }, stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`${U}/api/v1/auth/setup`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }

const b = await chromium.launch();
const errors: string[] = [];
async function page(email: string, width = 390) {
  const p = await (await b.newContext({ viewport: { width, height: 900 } })).newPage();
  p.on("pageerror", (e: Error) => errors.push(`${email}: ${e.message}`));
  await p.goto(U); await p.fill("#lg-email", email); await p.fill("#lg-pw", PW); await p.click("#login-form button[type=submit]");
  await p.waitForFunction(() => document.documentElement.dataset.auth === "in");
  return p;
}
try {
  const adm = await page(adminEmail, 1280);
  check(await adm.waitForSelector("#view .kpis", { timeout: 8000 }).then(() => true, () => false), "login e Painel");

  // gasto rápido com conta de origem
  const acc = await adm.evaluate(async () => (await (await fetch("/api/v1/personal/accounts", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "CHECKING", name: "Conta E2E", institution: "Banco E2E", openingBalanceCents: 100000 }) })).json()).id);
  await adm.reload(); await adm.waitForSelector("#quick");
  await adm.fill("#quick [name=v]", "12,34"); await adm.fill("#quick [name=d]", "Padaria E2E");
  await adm.selectOption("#quick [name=src]", `acc:${acc}`); await adm.click("#quick button");
  await adm.waitForTimeout(600);
  const bal = await adm.evaluate(async (id: string) => (await (await fetch("/api/v1/personal/accounts")).json()).find((a: { id: string }) => a.id === id).balanceCents, acc);
  check(bal === 100000 - 1234, "Já gastei desconta da conta escolhida");

  // mesmo formulário: "ainda não paguei" mostra o vencimento e cria conta a pagar (não mexe no saldo)
  await adm.waitForSelector("#quick");
  check(await adm.isHidden("#quick [data-due]"), "vencimento escondido quando já pagou");
  await adm.selectOption("#quick [name=src]", "later");
  check(await adm.isVisible("#quick [data-due]"), "vencimento aparece quando ainda não pagou");
  await adm.fill("#quick [name=v]", "50,00"); await adm.fill("#quick [name=d]", "Conta Futura E2E"); await adm.fill("#quick [name=due]", "2030-01-10");
  await adm.click("#quick button"); await adm.waitForTimeout(600);
  const fut = await adm.evaluate(async () => (await (await fetch("/api/v1/personal/titles?kind=PAYABLE&status=open")).json()).find((t: { counterparty: string }) => t.counterparty === "Conta Futura E2E"));
  const balFut = await adm.evaluate(async (id: string) => (await (await fetch("/api/v1/personal/accounts")).json()).find((a: { id: string }) => a.id === id).balanceCents, acc);
  check(fut?.dueDate === "2030-01-10" && fut?.openCents === 5000 && balFut === bal, "ainda não paguei vira conta a pagar com vencimento");

  // calculadora de juros
  await adm.goto(`${U}/#futuro`); await adm.reload(); await adm.waitForSelector("#juros");
  await adm.fill("#juros [name=pv]", "1.000,00"); await adm.fill("#juros [name=n]", "12"); await adm.fill("#juros [name=pmt]", "100,00"); await adm.fill("#juros [name=left]", "6");
  await adm.click("#juros button");
  const jt = await adm.textContent("#juros-out");
  check(!!jt && jt.includes("2,92%") && /Economia de cerca de/.test(jt), "calculadora de juros acha a taxa e a economia");

  // todas as telas abrem sem erro
  for (const t of ["painel", "pedidos", "combinados", "bancos", "pagar", "receber", "extrato", "indicadores", "ranking", "pessoas", "futuro", "admin", "config"]) {
    await adm.goto(`${U}/#${t}`); await adm.reload();
    // Tela abriu = tem conteúdo e não caiu no aviso de falha da API (o vermelho de "contas vencidas" é legítimo).
    const ok = await adm.waitForFunction(() => { const v = document.getElementById("view")!; return v.children.length > 0 && !/Sem conexão com a API|Erro interno/.test(v.innerText); },
      undefined, { timeout: 8000 }).then(() => true, () => false);
    check(ok, `tela ${t} abre`);
  }

  // perfil só combinados
  const kid = await page(kidEmail);
  await kid.click("#menu-btn"); await kid.waitForTimeout(200);
  const tabs = (await kid.locator("#tabs button:visible").allTextContents()).map((s: string) => s.trim());
  check(JSON.stringify(tabs) === JSON.stringify(["Pedidos", "Combinados"]), "só combinados vê apenas Pedidos e Combinados");
  const blocked = await kid.evaluate(async () => (await fetch("/api/v1/personal/accounts")).status);
  check(blocked === 403, "só combinados é barrado nas finanças pelo servidor");

  // pedido de compra → aprovação
  await kid.click("#tabs [data-tab=pedidos]"); await kid.waitForSelector("#req-f");
  await kid.fill("#req-f [name=d]", "Livro E2E"); await kid.fill("#req-f [name=v]", "40,00");
  await kid.selectOption("#req-f [name=a]", acc); await kid.click("#req-f button"); await kid.waitForTimeout(600);
  await adm.goto(`${U}/#pedidos`); await adm.reload(); await adm.waitForSelector(".pending-card");
  await adm.locator(".pending-card li", { hasText: "Livro E2E" }).locator("[data-reqok]").click(); await adm.waitForTimeout(700);
  const bal2 = await adm.evaluate(async (id: string) => (await (await fetch("/api/v1/personal/accounts")).json()).find((a: { id: string }) => a.id === id).balanceCents, acc);
  check(bal2 === 100000 - 1234 - 4000, "pedido aprovado vira gasto na conta");

  // pagamento com economia
  await adm.evaluate(async (d: string) => { await fetch("/api/v1/personal/accounts", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "LOAN", name: "Dívida E2E", institution: "Credor E2E", loan: { installmentCents: 100000, remaining: 1, firstOpenDueDate: d } }) }); }, today);
  await adm.goto(`${U}/#pagar`); await adm.reload(); await adm.waitForTimeout(600);
  await adm.locator(".item", { hasText: "Credor E2E" }).first().locator("[data-pay]").click(); await adm.waitForSelector("#dlg[open]");
  await adm.fill("#dlg-form [name=v]", "900,00"); await adm.check("#dlg-form [name=disc]"); await adm.waitForTimeout(150);
  const saving = (await adm.locator("[data-save]").textContent())?.replace(/\s/g, " ");
  check(saving === "R$ 100,00", "pagamento mostra a economia ao vivo");
  await adm.click("#dlg-form button[type=submit]"); await adm.waitForTimeout(600);

  // invasão: textos maliciosos não viram HTML em nenhuma tela
  // Script como texto: o compilador do teste não injeta auxiliares que o navegador não conhece.
  await adm.evaluate(`(async () => {
    const X = '<img src=x data-xss="1" onerror="window.__xss=1">', h = { "content-type": "application/json" };
    await fetch("/api/v1/personal/titles", { method: "POST", headers: h, body: JSON.stringify({ kind: "PAYABLE", nature: "EXPENSE", counterparty: X, category: "OUTROS", amountCents: 100, dueDate: "${today}", notes: X }) });
    await fetch("/api/v1/personal/people", { method: "POST", headers: h, body: JSON.stringify({ name: '<img src=x data-xss="1">' }) });
  })()`);
  let injected = 0;
  for (const t of ["painel", "pagar", "pessoas", "bancos", "admin"]) {
    await adm.goto(`${U}/#${t}`); await adm.reload(); await adm.waitForTimeout(500);
    injected += await adm.locator("#view img[data-xss]").count();
  }
  check(injected === 0 && !(await adm.evaluate(() => (window as unknown as { __xss?: number }).__xss)), "nenhum texto malicioso vira HTML");
  check(errors.length === 0, `sem erros de JavaScript${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
} catch (e) {
  failures++; console.error("✗ falhou:", (e as Error).message);
} finally {
  await b.close(); srv.kill(); await db.end();
}
console.log(failures ? `\n${failures} falha(s)` : "\nTudo certo na tela.");
process.exit(failures ? 1 : 0);
