/**
 * Testes de integração: API real + PostgreSQL real (banco nofinance_test, recriado a cada execução).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { migrate, ensureDatabase } from "../scripts/migrate.js";
import { seed } from "../scripts/seed.js";
import { createUser, totpAt } from "../src/auth.js";

try { process.loadEnvFile(".env"); } catch { /* ok */ }
const URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/nofinance_test";
let db: Db; let app: ReturnType<typeof createApp>;
const P = "/api/v1/personal";
let cookie = ""; // sessão do administrador (padrão nos testes)
const ADMIN_PW = "senha-forte-de-teste-1";
const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json", cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, json: text && r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
};
const findTitle = async (name: string) => (await req("GET", `${P}/titles`)).json.find((t: { counterparty: string }) => t.counterparty === name);

beforeAll(async () => {
  await ensureDatabase(URL);
  const admin = createPool(URL);
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
  await migrate(URL); await seed(URL);
  db = createPool(URL); app = createApp(db, { cronSecret: "segredo-cron", secureCookies: false });
  await createUser(db, { email: "admin@familia.test", name: "Marcos", role: "ADMIN", nickname: "Gastador", password: ADMIN_PW });
  // Em produção o administrador principal é o root (o único que corrige mês fechado).
  await db.query("UPDATE app_user SET is_root = true WHERE email = 'admin@familia.test'");
  const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@familia.test", password: ADMIN_PW }) });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => { await db?.end(); });

describe("API", () => {
  it("health", async () => expect((await req("GET", "/health")).json.status).toBe("ok"));

  it("aceite: painel mostra R$ 17.900,00 em dívidas", async () => {
    const d = (await req("GET", `${P}/dashboard?asOf=2026-11-21`)).json;
    expect(d.debtOpenCents).toBe(1790000);
    expect(d.debtInterestCents).toBe(120000);
    expect(d.debtPriority[0].counterparty).toBe("Credor C");
  });

  it("isolamento: Byte4Tech não vê dados pessoais", async () => {
    expect((await req("GET", "/api/v1/byte4tech/titles")).json).toEqual([]);
    const ric = await findTitle("Credor C");
    expect((await req("GET", `/api/v1/byte4tech/titles/${ric.id}`)).status).toBe(404);
  });

  it("pagamento parcial, edição e exclusão recalculam o saldo", async () => {
    const ric = await findTitle("Credor C");
    let r = await req("POST", `${P}/titles/${ric.id}/settlements`, { amountCents: 100000, paidOn: "2026-11-25" });
    expect(r.status).toBe(201); expect(r.json.openCents).toBe(245000);
    const sid = r.json.settlements[0].id;
    r = await req("PATCH", `${P}/settlements/${sid}`, { amountCents: 150000 });
    expect(r.json.openCents).toBe(195000);
    r = await req("DELETE", `${P}/settlements/${sid}`);
    expect(r.json.openCents).toBe(345000);
    const hist = (await req("GET", `${P}/audit/${sid}`)).json;
    expect(hist.map((h: { action: string }) => h.action)).toEqual(["INSERT", "UPDATE", "UPDATE"]);
  });

  it("editar valor da dívida recalcula juros e total", async () => {
    const alc = await findTitle("Credor E");
    const r = await req("PATCH", `${P}/titles/${alc.id}`, { amountCents: 600000 });
    expect(r.json).toMatchObject({ interestCents: 90000, totalCents: 690000 });
    await req("PATCH", `${P}/titles/${alc.id}`, { amountCents: 500000 });
  });

  it("regra 7: cartão em dívida é permitido, mas fica registrado como aviso", async () => {
    const luva = await findTitle("Credor A");
    const r = await req("POST", `${P}/titles/${luva.id}/settlements`, { amountCents: 1000, method: "CARD" });
    expect(r.status).toBe(201);
    expect(r.json.settlements[0].warnings[0]).toMatch(/^REGRA_7/);
  });

  it("pagar acima do saldo é permitido e registra aviso", async () => {
    const tg = await findTitle("Credor B");
    const r = await req("POST", `${P}/titles/${tg.id}/settlements`, { amountCents: 60000 });
    expect(r.status).toBe(201);
    expect(r.json.settlements[0].warnings[0]).toMatch(/PAGO_ACIMA_DO_SALDO: excedeu em 10000/);
  });

  it("idempotência: duplo toque não duplica pagamento", async () => {
    const m = await findTitle("Credor H");
    const h = { "idempotency-key": "tap-123" };
    expect((await req("POST", `${P}/titles/${m.id}/settlements`, { amountCents: 50000 }, h)).status).toBe(201);
    const r2 = await req("POST", `${P}/titles/${m.id}/settlements`, { amountCents: 50000 }, h);
    expect(r2.status).toBe(200); expect(r2.json.openCents).toBe(150000);
  });

  it("empréstimo recebido gera dívida e não vira receita", async () => {
    const r = await req("POST", `${P}/titles`, { kind: "RECEIVABLE", nature: "LOAN_IN", counterparty: "Teste", amountCents: 100000, loan: { interestModel: "FIXED_ONCE", rateBp: 1500 } });
    expect(r.status).toBe(201);
    const debt = (await req("GET", `${P}/titles/${r.json.linkedTitleId}`)).json;
    expect(debt).toMatchObject({ nature: "DEBT", totalCents: 115000 });
    await req("POST", `${P}/titles/${r.json.id}/settlements`, { amountCents: 100000, paidOn: "2026-11-26" });
    const st = (await req("GET", `${P}/statement?from=2026-11&to=2026-11`)).json.months[0];
    expect(st.loansInCents).toBe(100000);
    expect(st.incomeCents).toBe(0);
  });

  it("recorrência: gera uma vez por mês, valor a definir é fixado no 1º pagamento e vira estimativa do mês seguinte", async () => {
    const g1 = (await req("POST", `${P}/recurrences/generate?month=2027-01`)).json;
    expect(g1.created).toEqual(expect.arrayContaining(["Aluguel", "Água", "Luz", "Internet", "Renda mensal"]));
    expect((await req("POST", `${P}/recurrences/generate?month=2027-01`)).json.created).toEqual([]);
    const luz = (await req("GET", `${P}/titles?status=open`)).json.find((t: { counterparty: string; competenceMonth: string }) => t.counterparty === "Luz" && t.competenceMonth === "2027-01-01");
    expect(luz.status).toBe("NO_VALUE");
    const paid = await req("POST", `${P}/titles/${luz.id}/settlements`, { amountCents: 23490 });
    expect(paid.json).toMatchObject({ amountCents: 23490, status: "SETTLED" });
    await req("POST", `${P}/recurrences/generate?month=2027-02`);
    const fev = (await req("GET", `${P}/titles`)).json.find((t: { counterparty: string; competenceMonth: string }) => t.counterparty === "Luz" && t.competenceMonth === "2027-02-01");
    expect(fev.amountCents).toBe(23490);
  });

  it("guardião: não bloqueia; gasto fora do escopo vai para o log de avisos", async () => {
    const b = await req("POST", `${P}/expenses/quick`, { amountCents: 5000, category: "LAZER", description: "Cinema", date: "2026-11-28" });
    expect(b.status).toBe(201); expect(b.json.guard.allowed).toBe(false);
    const log = (await req("GET", `${P}/warnings`)).json;
    expect(log.map((w: { counterparty: string }) => w.counterparty)).toEqual(expect.arrayContaining(["Cinema", "Credor A", "Credor B"]));
    const ok = await req("POST", `${P}/expenses/quick`, { amountCents: 40000, category: "FIXO", description: "Mercado", date: "2026-11-28" });
    expect(ok.status).toBe(201); expect(ok.json.title.status).toBe("SETTLED");
  });

  it("projeção de 24 meses e simulador", async () => {
    const p = (await req("GET", `${P}/projection?months=24&asOf=2026-11-21`)).json;
    expect(p.months).toHaveLength(24);
    const s = (await req("POST", `${P}/simulate`, { monthlyIncomeCents: 1559900, monthlyFixedCents: 325000 })).json;
    expect(s.results[0].strategy).toBe("AVALANCHE");
    expect(s.results[0].feasible).toBe(true);
  });

  it("validação de entrada", async () => {
    expect((await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "INCOME", counterparty: "x", amountCents: 1 })).status).toBe(422);
    expect((await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "x", amountCents: 1.5 })).status).toBe(400);
    expect((await req("GET", `${P}/titles/nao-e-uuid`)).status).toBe(400);
    expect((await req("GET", "/api/v1/outra/titles")).status).toBe(404);
  });

  it("exclusão física é proibida no banco", async () => {
    await expect(db.query("DELETE FROM title")).rejects.toThrow(/proibida/);
  });

  it("exporta CSV", async () => {
    const r = await req("GET", `${P}/export.csv`);
    expect(r.status).toBe(200); expect(String(r.json)).toContain("Credor C");
  });
});

describe("Pessoas da casa", () => {
  it("cadastra, vincula custo, filtra, resume e isola por entidade", async () => {
    const ana = (await req("POST", `${P}/people`, { name: "Ana", relation: "esposa" })).json;
    expect(ana.name).toBe("Ana");
    expect((await req("POST", `${P}/people`, { name: "ana" })).status).toBe(409); // nome único (sem diferenciar maiúsculas)

    const t = await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "Escola", category: "EDUCACAO", amountCents: 80000, dueDate: "2026-11-30", personId: ana.id });
    expect(t.json).toMatchObject({ personId: ana.id, personName: "Ana" });
    await req("POST", `${P}/titles/${t.json.id}/settlements`, { amountCents: 30000, paidOn: "2026-11-25" });
    await req("POST", `${P}/expenses/quick`, { amountCents: 5000, category: "SAUDE", description: "Farmácia", date: "2026-11-26", personId: ana.id });

    const only = (await req("GET", `${P}/titles?person=${ana.id}`)).json;
    expect(only.map((x: { counterparty: string }) => x.counterparty).sort()).toEqual(["Escola", "Farmácia"]);

    const sum = (await req("GET", `${P}/people/summary?from=2026-11&to=2026-11`)).json;
    const a = sum.people.find((x: { name: string }) => x.name === "Ana");
    expect(a).toMatchObject({ paidCents: 35000, openCents: 50000, openCount: 1 });
    expect(sum.people.at(-1).name).toBe("Casa / geral");

    // pessoa de outra entidade não pode ser vinculada
    const b = (await req("POST", "/api/v1/byte4tech/people", { name: "Sócio" })).json;
    const bad = await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "X", amountCents: 100, personId: b.id });
    expect(bad.status).toBe(422);

    // desvincular e desativar
    expect((await req("PATCH", `${P}/titles/${t.json.id}`, { personId: null })).json.personId).toBeNull();
    expect((await req("PATCH", `${P}/people/${ana.id}`, { active: false })).json.active).toBe(false);
  });

  it("conta automática leva a pessoa para as contas geradas", async () => {
    const leo = (await req("POST", `${P}/people`, { name: "Léo", relation: "filho" })).json;
    const r = (await req("POST", `${P}/recurrences`, { kind: "PAYABLE", nature: "EXPENSE", description: "Inglês", category: "EDUCACAO", defaultAmountCents: 35000, dueDay: 10, startMonth: "2027-03", personId: leo.id })).json;
    expect(r.personName).toBe("Léo");
    await req("POST", `${P}/recurrences/generate?month=2027-03`);
    const t = (await req("GET", `${P}/titles?person=${leo.id}`)).json;
    expect(t[0]).toMatchObject({ counterparty: "Inglês", personName: "Léo", amountCents: 35000, dueDate: "2027-03-10" });
  });
});

describe("Login e permissões", () => {
  const login = async (email: string, password: string) => {
    const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]!, setCookie: r.headers.get("set-cookie") ?? "", json: await r.json() };
  };

  it("sem login não entra; com login entra; cookie é HttpOnly", async () => {
    expect((await req("GET", `${P}/dashboard`, undefined, { cookie: "" })).status).toBe(401);
    const ok = await login("ADMIN@familia.test ", ADMIN_PW);
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect(ok.json).not.toHaveProperty("password_hash");
  });

  it("senha errada dá mensagem genérica e bloqueia após 5 tentativas", async () => {
    await createUser(db, { email: "alvo@familia.test", name: "Alvo", password: "senha-correta-123" });
    const inexistente = await login("ninguem@familia.test", "x");
    const errada = await login("alvo@familia.test", "x");
    expect(inexistente.json.error.message).toBe(errada.json.error.message); // não revela se o e-mail existe
    for (let i = 0; i < 4; i++) await login("alvo@familia.test", "x");
    const certa = await login("alvo@familia.test", "senha-correta-123");
    expect(certa.status).toBe(422); expect(certa.json.error.code).toBe("LOCKED");
  });

  it("logout invalida a sessão", async () => {
    const s = await login("admin@familia.test", ADMIN_PW);
    await req("POST", "/api/v1/auth/logout", undefined, { cookie: s.cookie });
    expect((await req("GET", "/api/v1/auth/me", undefined, { cookie: s.cookie })).status).toBe(401);
  });

  it("membro vê tudo do pessoal, lança gasto (vira dele), edita só o que lançou e não vê a Byte4Tech", async () => {
    const thais = (await req("POST", `${P}/people`, { name: "Thaís" })).json;
    const u = await req("POST", "/api/v1/admin/users", { email: "thais@familia.test", name: "Thaís", nickname: "Gastadora", personId: thais.id, password: "senha-inicial-thais" });
    expect(u.status).toBe(201);
    const m = (await login("thais@familia.test", "senha-inicial-thais")).cookie;
    const as = (method: string, path: string, body?: unknown) => req(method, path, body, { cookie: m });

    expect((await as("GET", "/api/v1/auth/me")).json).toMatchObject({ role: "MEMBER", mustChangePassword: true, nickname: "Gastadora" });
    expect((await as("GET", `${P}/titles`)).status).toBe(200);             // vê tudo
    expect((await as("GET", "/api/v1/byte4tech/titles")).status).toBe(403); // PJ só do admin
    expect((await as("GET", "/api/v1/admin/users")).status).toBe(403);
    expect((await as("POST", `${P}/people`, { name: "X" })).status).toBe(403);

    const g = await as("POST", `${P}/expenses/quick`, { amountCents: 8990, category: "LAZER", description: "Delivery", date: "2026-11-25" });
    expect(g.status).toBe(201); expect(g.json.title.personId).toBe(thais.id);
    expect((await as("PATCH", `${P}/titles/${g.json.title.id}`, { counterparty: "Delivery sexta" })).status).toBe(200);
    const doAdmin = await findTitle("Credor A");
    expect((await as("PATCH", `${P}/titles/${doAdmin.id}`, { counterparty: "X" })).status).toBe(403);
    expect((await as("PATCH", `${P}/titles/${g.json.title.id}`, { mandatory: true })).status).toBe(403); // reclassificar é do admin

    expect((await as("POST", "/api/v1/auth/password", { current: "senha-inicial-thais", next: "123" })).status).toBe(422);
    expect((await as("POST", "/api/v1/auth/password", { current: "senha-inicial-thais", next: "nova-senha-da-thais" })).status).toBe(204);
    expect((await as("GET", "/api/v1/auth/me")).json.mustChangePassword).toBe(false);
  });

  it("bloqueia escrita vinda de outro site (CSRF)", async () => {
    const r = await req("POST", `${P}/expenses/quick`, { amountCents: 100, category: "LAZER", description: "x" }, { origin: "https://site-malicioso.com", host: "localhost" });
    expect(r.status).toBe(403);
  });

  it("rotina agendada exige o segredo", async () => {
    expect((await req("GET", "/api/v1/cron/recurrences", undefined, { cookie: "" })).status).toBe(403);
    expect((await req("GET", "/api/v1/cron/recurrences", undefined, { cookie: "", authorization: "Bearer segredo-cron" })).status).toBe(200);
  });
});

describe("Ranking semanal", () => {
  it("conta só o não obrigatório por pessoa; o KPI inclui o obrigatório; admin reclassifica", async () => {
    const people = (await req("GET", `${P}/people`)).json as { id: string; name: string }[];
    const sara = (await req("POST", `${P}/people`, { name: "Sara" })).json;
    const thais = people.find(p => p.name === "Thaís")!;
    const add = (personId: string, amountCents: number, category: string, date: string, description = category) =>
      req("POST", `${P}/expenses/quick`, { amountCents, category, description, date, personId });
    await add(sara.id, 30000, "LAZER", "2026-11-22");          // domingo: mesma semana de seg 16/11
    await add(sara.id, 50000, "EDUCACAO", "2026-11-18");       // obrigatório: fora do ranking, dentro do KPI
    const roupa = (await add(thais.id, 12000, "ROUPAS", "2026-11-16")).json;
    await add(thais.id, 99999, "LAZER", "2026-11-23");         // segunda seguinte: outra semana

    const r = (await req("GET", `${P}/ranking?date=2026-11-20`)).json;
    expect(r.week).toEqual({ start: "2026-11-16", end: "2026-11-22" });
    const s = r.board.find((x: { name: string }) => x.name === "Sara"), t = r.board.find((x: { name: string }) => x.name === "Thaís");
    expect(s).toMatchObject({ totalCents: 30000, allCents: 80000, mandatoryCents: 50000 });
    expect(t.totalCents).toBe(12000); // só a roupa: o delivery de 25/11 é de outra semana
    expect(r.board[0].name).toBe("Sara");

    // admin decide que a roupa era obrigatória (uniforme): sai do ranking
    expect((await req("PATCH", `${P}/titles/${roupa.title.id}`, { mandatory: true })).status).toBe(200);
    const r2 = (await req("GET", `${P}/ranking?date=2026-11-20`)).json;
    expect(r2.board.find((x: { name: string }) => x.name === "Thaís").totalCents).toBe(0);
    expect(r2.items.find((i: { titleId: string }) => i.titleId === roupa.title.id)).toMatchObject({ mandatory: true, reviewed: true });
    expect(r2.history).toHaveLength(8);
  });
});

describe("Combinados (hábitos e ocorrências)", () => {
  const login = async (email: string, password: string) => {
    const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const back = (n: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);

  it("regras iniciais: 4 hábitos e 3 ocorrências, multa R$ 0 até o admin definir", async () => {
    const rules = (await req("GET", `${P}/conduct/rules`)).json as { kind: string; name: string; fineCents: number }[];
    expect(rules.filter(r => r.kind === "HABIT").map(r => r.name)).toEqual(["Dormiu na hora", "Estudou", "Treinou", "Orou"]);
    expect(rules.filter(r => r.kind === "INFRACTION")).toHaveLength(3);
    expect(rules.every(r => r.fineCents === 0)).toBe(true);
  });

  it("cada um marca os próprios hábitos (hoje e ontem); dia sem marcar vira falta com multa; responsável registra ocorrência; admin quita", async () => {
    // Maria, membro sem ser responsável
    const maria = (await req("POST", `${P}/people`, { name: "Maria" })).json;
    await db.query("UPDATE person SET created_at = now() - interval '10 days' WHERE id = $1", [maria.id]);
    await req("POST", "/api/v1/admin/users", { email: "maria@familia.test", name: "Maria", nickname: "Gastadora", personId: maria.id, password: "senha-inicial-maria" });
    const m = await login("maria@familia.test", "senha-inicial-maria");
    const asMaria = (method: string, path: string, body?: unknown) => req(method, path, body, { cookie: m });

    const rules = (await req("GET", `${P}/conduct/rules`)).json as { id: string; kind: string; name: string }[];
    const [dormiu, estudou, treinou, orou] = rules.filter(r => r.kind === "HABIT");
    const palavrao = rules.find(r => r.name === "Falou palavrão")!;
    // admin define multa: R$ 2 por hábito não feito (vale daqui em diante) e R$ 5 por palavrão
    await db.query("UPDATE conduct_rule SET starts_on = $1 WHERE kind = 'HABIT'", [back(3)]);
    for (const h of [dormiu, estudou, treinou, orou]) await req("PATCH", `${P}/conduct/rules/${h!.id}`, { assignees: [{ personId: maria.id }] });
    for (const h of [dormiu, estudou, treinou, orou]) await req("PATCH", `${P}/conduct/rules/${h!.id}`, { fineCents: 200 });
    await req("PATCH", `${P}/conduct/rules/${palavrao.id}`, { fineCents: 500 });

    // ontem Maria fez 3 de 4; hoje fez os 4
    for (const h of [dormiu, estudou, treinou]) expect((await asMaria("POST", `${P}/conduct/checks`, { personId: maria.id, ruleId: h!.id, day: back(1), checked: true })).status).toBe(200);
    for (const h of [dormiu, estudou, treinou, orou]) await asMaria("POST", `${P}/conduct/checks`, { personId: maria.id, ruleId: h!.id, day: today, checked: true });
    // limites do membro
    expect((await asMaria("POST", `${P}/conduct/checks`, { personId: maria.id, ruleId: orou!.id, day: back(3), checked: true })).status).toBe(422); // antes de ontem
    const marcos = (await req("GET", `${P}/people`)).json.find((p: { name: string }) => p.name === "Thaís");
    expect((await asMaria("POST", `${P}/conduct/checks`, { personId: marcos.id, ruleId: orou!.id, day: today, checked: true })).status).toBe(403); // de outra pessoa
    expect((await asMaria("POST", `${P}/conduct/infractions`, { personId: maria.id, ruleId: palavrao.id })).status).toBe(403); // não é responsável

    // admin (responsável) registra palavrão
    expect((await req("POST", `${P}/conduct/infractions`, { personId: maria.id, ruleId: palavrao.id, note: "no jantar" })).status).toBe(201);

    const b = (await req("GET", `${P}/conduct/board`)).json;
    const row = b.rows.find((r: { name: string }) => r.name === "Maria");
    // faltas: 3 dias atrás (4 hábitos) + 2 dias atrás (4) + ontem (1: Orou) = 9 faltas x R$ 2 = R$ 18 + palavrão R$ 5 = R$ 23
    expect(row.balanceCents).toBe(9 * 200 + 500);
    expect(row.grid.find((g: { day: string }) => g.day === today).items.every((h: { done: boolean }) => h.done)).toBe(true);

    // responsável corrige: ontem ela orou sim -> a falta some
    const fix = await req("POST", `${P}/conduct/checks`, { personId: maria.id, ruleId: orou!.id, day: back(1), checked: true });
    expect(fix.json).toEqual({ ok: true });
    const b2 = (await req("GET", `${P}/conduct/board`)).json.rows.find((r: { name: string }) => r.name === "Maria");
    expect(b2.balanceCents).toBe(8 * 200 + 500);

    // admin recebe R$ 10 e perdoa o resto; não deixa quitar acima do saldo
    expect((await req("POST", `${P}/conduct/settle`, { personId: maria.id, kind: "PAYMENT", amountCents: 1000 })).status).toBe(201);
    expect((await req("POST", `${P}/conduct/settle`, { personId: maria.id, kind: "WAIVER", amountCents: 999999 })).status).toBe(422);
    expect((await req("POST", `${P}/conduct/settle`, { personId: maria.id, kind: "WAIVER", amountCents: 8 * 200 + 500 - 1000 })).json.balanceCents).toBe(0);
    expect((await asMaria("POST", `${P}/conduct/settle`, { personId: maria.id, kind: "WAIVER", amountCents: 1 })).status).toBe(403);
  });

  it("combinados não existem na Byte4Tech e não entram nas despesas da casa", async () => {
    expect((await req("GET", "/api/v1/byte4tech/conduct/board")).status).toBe(404);
    const titles = (await req("GET", `${P}/titles?status=all`)).json as { counterparty: string }[];
    expect(titles.some(t => /palavr/i.test(t.counterparty))).toBe(false);
  });
});

describe("Instalação pelo navegador", () => {
  it("só cria o primeiro admin com o código certo e só enquanto não há usuários", async () => {
    const fresh = createApp(db, { secureCookies: false, setupToken: "codigo-de-instalacao-123" });
    const call = (b: unknown) => fresh.request("/api/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    // já existem usuários neste banco de teste: instalação recusada mesmo com código certo
    expect((await (await fresh.request("/api/v1/auth/setup")).json()).needed).toBe(false);
    expect((await call({ token: "codigo-de-instalacao-123", email: "x@y.test", name: "X", password: "senha-bem-forte-1" })).status).toBe(409);
    // código errado
    expect((await call({ token: "errado", email: "x@y.test", name: "X", password: "senha-bem-forte-1" })).status).toBe(403);
    // sem SETUP_TOKEN configurado: desativado
    const off = createApp(db, { secureCookies: false });
    expect((await off.request("/api/v1/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "a", email: "x@y.test", name: "X", password: "senha-bem-forte-1" }) })).status).toBe(403);
  });
});

describe("Root e painel de administração", () => {
  const login = async (email: string, password: string) => {
    const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  it("root é protegido; só o root gerencia administradores; painel mostra status, sessões e auditoria", async () => {
    await db.query("UPDATE app_user SET is_root = true WHERE email = 'admin@familia.test'");
    const root = (await req("GET", "/api/v1/auth/me")).json;
    expect(root.isRoot).toBe(true);

    // root cria um segundo administrador
    const adm2 = await req("POST", "/api/v1/admin/users", { email: "adm2@familia.test", name: "Adm Dois", role: "ADMIN", password: "senha-adm-dois-123" });
    expect(adm2.status).toBe(201);
    const c2 = await login("adm2@familia.test", "senha-adm-dois-123");
    const as2 = (m: string, p: string, b?: unknown) => req(m, p, b, { cookie: c2 });

    // admin comum não mexe no root nem cria/promove administradores
    expect((await as2("PATCH", `/api/v1/admin/users/${root.id}`, { active: false })).status).toBe(403);
    expect((await as2("POST", "/api/v1/admin/users", { email: "adm3@familia.test", name: "Adm3", role: "ADMIN", password: "senha-adm-tres-123" })).status).toBe(403);
    const memb = await as2("POST", "/api/v1/admin/users", { email: "membro2@familia.test", name: "Membro Dois", password: "senha-membro-dois-1" });
    expect(memb.status).toBe(201);
    expect((await as2("PATCH", `/api/v1/admin/users/${memb.json.id}`, { role: "ADMIN" })).status).toBe(403);
    // nem o próprio root se desativa
    expect((await req("PATCH", `/api/v1/admin/users/${root.id}`, { active: false })).status).toBe(422);

    // painel
    const st = (await req("GET", "/api/v1/admin/status")).json;
    expect(st.ok).toBe(true); expect(st.migrations.map((m: { name: string }) => m.name)).toContain("006_root.sql");
    const sessions = (await req("GET", "/api/v1/admin/sessions")).json as { id: string; current: boolean; isRoot: boolean; email: string }[];
    expect(sessions.some(s => s.current)).toBe(true);
    // admin comum não derruba sessão do root; root derruba a do adm2
    const rootSess = sessions.find(s => s.isRoot && !s.current)!;
    if (rootSess) expect((await as2("DELETE", `/api/v1/admin/sessions/${rootSess.id}`)).status).toBe(403);
    const s2 = sessions.find(s => s.email === "adm2@familia.test")!;
    expect((await req("DELETE", `/api/v1/admin/sessions/${s2.id}`)).status).toBe(204);
    expect((await as2("GET", "/api/v1/auth/me")).status).toBe(401);
    const audit = (await req("GET", "/api/v1/admin/audit?limit=20")).json as { what: string; action: string }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("scrypt$"); // nunca vaza hash de senha
    // membro não acessa o painel
    const m = await login("membro2@familia.test", "senha-membro-dois-1");
    expect((await req("GET", "/api/v1/admin/status", undefined, { cookie: m })).status).toBe(403);
  });
});

describe("Combinados v2 e mesada", () => {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const back = (n: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
  it("modelo da família, revezamento, avulsa, culpado, mesada proporcional, nota zero e fechamento", async () => {
    // pessoas do modelo (algumas já existem nos testes anteriores)
    const people = async () => (await req("GET", `${P}/people`)).json as { id: string; name: string }[];
    for (const n of ["Marcos", "Thaís", "Sara", "Maria"]) if (!(await people()).some(p => p.name === n)) await req("POST", `${P}/people`, { name: n });
    const id = async (n: string) => (await people()).find(p => p.name === n)!.id;
    const [marcos, thais, sara, maria] = [await id("Marcos"), await id("Thaís"), await id("Sara"), await id("Maria")];
    await db.query("UPDATE person SET created_at = now() - interval '30 days' WHERE id = ANY($1)", [[marcos, thais, sara, maria]]);

    const t = await req("POST", `${P}/conduct/template`);
    expect(t.status).toBe(201);
    expect(t.json.created).toContain("Louça");
    expect((await req("POST", `${P}/conduct/template`)).json.created).toEqual([]); // não duplica
    const rules = (await req("GET", `${P}/conduct/rules`)).json as { id: string; name: string; schedule: string; assignees: { personId: string }[] }[];
    const louca = rules.find(r => r.name === "Louça")!, escola = rules.find(r => r.name === "Chegar na escola na hora")!, irma = rules.find(r => r.name === "Cuidar da irmã")!;
    expect(louca.schedule).toBe("ROTATION"); expect(louca.assignees.map(a => a.personId)).toEqual([sara, marcos, thais]);
    // vale a partir de 3 dias atrás para os testes
    await db.query("UPDATE conduct_rule SET starts_on = $1 WHERE kind = 'HABIT' AND active", [back(3)]);

    // revezamento: a cada dia uma pessoa diferente
    const b = (await req("GET", `${P}/conduct/board`)).json;
    const rot = b.rotations.find((r: { name: string }) => r.name === "Louça");
    expect(rot.today).not.toBe(rot.tomorrow);
    const dueToday = (pid: string) => b.rows.find((r: { personId: string }) => r.personId === pid).grid.find((g: { day: string }) => g.day === today)?.items.map((i: { name: string }) => i.name) ?? [];
    const withLouca = [sara, marcos, thais].filter(p => dueToday(p).includes("Louça"));
    expect(withLouca).toHaveLength(1);
    expect(dueToday(maria)).toEqual(expect.arrayContaining(["Escovar os dentes"]));
    expect(dueToday(sara)).not.toContain("Cuidar da irmã"); // avulsa só quando ativada

    // avulsa ativada hoje para a Sara
    expect((await req("POST", `${P}/conduct/sporadic`, { ruleId: irma.id, personId: sara, day: today, active: true })).status).toBe(200);
    const b2 = (await req("GET", `${P}/conduct/board`)).json;
    expect(b2.rows.find((r: { personId: string }) => r.personId === sara).grid.find((g: { day: string }) => g.day === today).items.map((i: { name: string }) => i.name)).toContain("Cuidar da irmã");

    // culpado: ontem a Thaís atrasou na escola por causa da Sara
    await req("PATCH", `${P}/conduct/rules/${escola.id}`, { fineCents: 300 });
    expect((await req("POST", `${P}/conduct/blame`, { ruleId: escola.id, day: back(1), fromPersonId: thais, toPersonId: sara, note: "demorou para se arrumar" })).status).toBe(201);
    const b3 = (await req("GET", `${P}/conduct/board`)).json;
    const yThais = b3.rows.find((r: { personId: string }) => r.personId === thais).grid.find((g: { day: string }) => g.day === back(1));
    expect(yThais.items.find((i: { name: string }) => i.name === "Chegar na escola na hora").done).toBe(true); // Thaís não perde
    expect(b3.entries.some((e: { personId: string; kind: string; note: string }) => e.personId === sara && e.kind === "INFRACTION" && /causada por Sara/.test(e.note))).toBe(true);

    // mesada: planos do modelo
    const a = (await req("GET", `${P}/conduct/allowance`)).json;
    const s = a.people.find((p: { personId: string }) => p.personId === sara), th = a.people.find((p: { personId: string }) => p.personId === thais), m = a.people.find((p: { personId: string }) => p.personId === maria);
    expect(s).toMatchObject({ mode: "MONEY", baseCents: 20000, consequence: "Sem celular" });
    expect(th).toMatchObject({ mode: "MONEY", baseCents: 200000 });
    expect(m.mode).toBe("STARS");
    expect(s.grossCents).toBe(Math.round(20000 * s.percent / 100)); // proporcional
    expect(s.percent).toBeLessThan(100);

    // Maria (estrelas) com tudo feito ontem
    for (const r of rules.filter(r => r.assignees.some(x => x.personId === maria))) await req("POST", `${P}/conduct/checks`, { personId: maria, ruleId: r.id, day: back(1), checked: true });
    expect((await req("GET", `${P}/conduct/allowance`)).json.people.find((p: { personId: string }) => p.personId === maria).stars).toBeGreaterThanOrEqual(3);

    // nota zero da Sara (nada feito) aplica a consequência; fechamento cria a conta a pagar (se houver valor)
    const close = await req("POST", `${P}/conduct/allowance/close`, { personId: sara, month: today.slice(0, 7) });
    expect(close.status).toBe(201);
    expect((await req("POST", `${P}/conduct/allowance/close`, { personId: sara, month: today.slice(0, 7) })).status).toBe(409);
    if (s.zeroed) expect(close.json.consequence).toBe("Sem celular");
    const c2 = await req("POST", `${P}/conduct/allowance/close`, { personId: thais, month: today.slice(0, 7), deductFines: false });
    expect(c2.status).toBe(201);
    if (c2.json.payoutCents > 0) {
      const title = (await req("GET", `${P}/titles/${c2.json.titleId}`)).json;
      expect(title).toMatchObject({ category: "MESADA", personId: thais, amountCents: c2.json.payoutCents });
    }
  });

  it("já recebi: receita avulsa da Thaís entra como receita recebida", async () => {
    const thais = ((await req("GET", `${P}/people`)).json as { id: string; name: string }[]).find(p => p.name === "Thaís")!.id;
    const r = await req("POST", `${P}/incomes/quick`, { amountCents: 15000, description: "Escova progressiva", category: "SERVICOS", personId: thais });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "RECEIVABLE", nature: "INCOME", status: "SETTLED", personId: thais });
  });
});

describe("Bancos, cartões, empréstimos e ordem de pagamento", () => {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const back = (n: number) => new Date(new Date(`${today}T12:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);
  const fwd = (n: number) => back(-n);
  it("cadastra produtos independentes por dono, calcula saldo, limite, atraso e a ordem sugerida", async () => {
    const ppl = (await req("GET", `${P}/people`)).json as { id: string; name: string }[];
    const marcos = ppl.find(p => p.name === "Marcos")!.id, thais = ppl.find(p => p.name === "Thaís")!.id;

    // Marcos: Inter com conta (saldo) e cartão; um banco só com empréstimo
    const conta = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta", institution: "Inter", ownerPersonId: marcos, openingBalanceCents: 120000 })).json;
    const cartao = await req("POST", `${P}/accounts`, { type: "CARD", name: "Cartão", institution: "Inter", ownerPersonId: marcos, creditLimitCents: 200000,
      closingDay: 1, dueDay: 10, monthlyRateBp: 1612, rateSource: "pesquisa BC", currentBill: { amountCents: 150000, dueDate: fwd(5) } });
    expect(cartao.status).toBe(201);
    const emp = await req("POST", `${P}/accounts`, { type: "LOAN", name: "Empréstimo pessoal", institution: "Banco X", ownerPersonId: marcos, monthlyRateBp: 450,
      loan: { installmentCents: 45000, remaining: 4, firstOpenDueDate: back(40), totalInstallments: 12 } });
    expect(emp.status).toBe(201);
    // Thaís: cartão de loja atrasado, juros desconhecido
    await req("POST", `${P}/accounts`, { type: "CARD", name: "Cartão", institution: "Loja Y", ownerPersonId: thais, creditLimitCents: 300000, currentBill: { amountCents: 302600, dueDate: back(7) } });
    // empréstimo sem os dados obrigatórios
    expect((await req("POST", `${P}/accounts`, { type: "LOAN", name: "X", ownerPersonId: thais })).status).toBe(422);

    const list = (await req("GET", `${P}/accounts`)).json as { id: string; institution: string; type: string; balanceCents: number | null; availableLimitCents: number | null; overdueCount: number; maxDaysOverdue: number; openCents: number; ownerName: string }[];
    const inter = list.find(a => a.institution === "Inter" && a.type === "CARD")!;
    expect(inter.availableLimitCents).toBe(50000);
    const loan = list.find(a => a.institution === "Banco X")!;
    expect(loan.openCents).toBe(4 * 45000);
    expect(loan.overdueCount).toBe(2); // vencidas há 40 e ~10 dias
    expect(list.find(a => a.institution === "Loja Y")!.maxDaysOverdue).toBe(7);

    // pagamento pela conta reduz o saldo; transferência entre contas próprias não é receita nem despesa
    const fatura = (await req("GET", `${P}/titles?status=open`)).json.find((t: { counterparty: string }) => t.counterparty === "Fatura Inter · Cartão");
    await req("POST", `${P}/titles/${fatura.id}/settlements`, { amountCents: 50000, accountId: conta.id });
    const poup = (await req("POST", `${P}/accounts`, { type: "SAVINGS", name: "Reserva", institution: "Inter", ownerPersonId: marcos, openingBalanceCents: 0 })).json;
    expect((await req("POST", `${P}/transfers`, { fromAccountId: conta.id, toAccountId: poup.id, amountCents: 20000 })).status).toBe(201);
    const list2 = (await req("GET", `${P}/accounts`)).json as { id: string; balanceCents: number }[];
    expect(list2.find(a => a.id === conta.id)!.balanceCents).toBe(120000 - 50000 - 20000);
    expect(list2.find(a => a.id === poup.id)!.balanceCents).toBe(20000);
    // pagar com conta de outro tipo é recusado
    expect((await req("POST", `${P}/titles/${fatura.id}/settlements`, { amountCents: 100, accountId: emp.json.id })).status).toBe(422);

    // visão por dono
    const ov = (await req("GET", `${P}/overview`)).json;
    const om = ov.people.find((p: { name: string }) => p.name === "Marcos"), ot = ov.people.find((p: { name: string }) => p.name === "Thaís");
    expect(om.cashCents).toBe(50000); expect(om.savedCents).toBe(20000);
    expect(ot.overdueCount).toBeGreaterThanOrEqual(1);

    // ordem: atrasados primeiro; entre atrasados, o de juro maior (desconhecido conta como ~10%)
    const order = (await req("GET", `${P}/payoff-order`)).json;
    const firstNotOverdue = order.items.findIndex((x: { daysOverdue: number }) => x.daysOverdue === 0);
    expect(order.items.slice(0, firstNotOverdue).every((x: { daysOverdue: number }) => x.daysOverdue > 0)).toBe(true);
    expect(order.items[0].reasons.join(" ")).toMatch(/atrasado/);
    const onlyThais = (await req("GET", `${P}/payoff-order?person=${thais}`)).json;
    expect(onlyThais.items.every((x: { ownerName: string }) => x.ownerName === "Thaís")).toBe(true);
    expect(onlyThais.unknownRates).toBeGreaterThanOrEqual(1);
    // estratégias e custo de juros por mês
    const quick = (await req("GET", `${P}/payoff-order?strategy=rapidas`)).json;
    expect(quick.items.map((x: { openCents: number }) => x.openCents)).toEqual([...quick.items.map((x: { openCents: number }) => x.openCents)].sort((a, b) => a - b));
    await req("PATCH", `${P}/accounts/${emp.json.id}`, { negativado: true });
    const nome = (await req("GET", `${P}/payoff-order?strategy=nome`)).json;
    expect(nome.items[0].negativado).toBe(true);
    const parcela = nome.items.find((x: { monthlyRateBp: number }) => x.monthlyRateBp === 450);
    expect(parcela.monthlyInterestCents).toBe(Math.round(45000 * 450 / 10000));
    expect(nome.owners.find((o: { name: string }) => o.name === "Marcos").negativados).toBeGreaterThan(0);
    expect((await req("GET", `${P}/payoff-order?strategy=xpto`)).status).toBe(400);
  });
});

describe("Cartão sem contagem dupla e segurança do login", () => {
  it("compra no cartão vira despesa na data, cai na fatura certa e o pagamento da fatura não conta de novo", async () => {
    const thais = ((await req("GET", `${P}/people`)).json as { id: string; name: string }[]).find(p => p.name === "Thaís")!.id;
    const conta = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta teste", institution: "Banco Z", ownerPersonId: thais, openingBalanceCents: 100000 })).json;
    const card = (await req("POST", `${P}/accounts`, { type: "CARD", name: "Cartão teste", institution: "Banco Z", ownerPersonId: thais, creditLimitCents: 500000, closingDay: 3, dueDay: 10 })).json;
    // compras em 2027-01-02 (antes do fechamento dia 3) e 2027-01-05 (depois): faturas de 10/01 e 10/02
    const buy = (v: number, d: string) => req("POST", `${P}/expenses/quick`, { amountCents: v, category: "LAZER", description: "Compra cartão", date: d, personId: thais, cardAccountId: card.id });
    expect((await buy(10000, "2027-01-02")).status).toBe(201);
    await buy(5000, "2027-01-02");
    await buy(7000, "2027-01-05");
    const bills = (await req("GET", `${P}/titles?status=open`)).json.filter((t: { counterparty: string }) => t.counterparty === "Fatura Banco Z · Cartão Teste" || t.counterparty === "Fatura Banco Z · Cartão teste");
    const jan = bills.find((b: { dueDate: string }) => b.dueDate === "2027-01-10"), feb = bills.find((b: { dueDate: string }) => b.dueDate === "2027-02-10");
    expect(jan.amountCents).toBe(15000); expect(feb.amountCents).toBe(7000);
    // a compra não tirou dinheiro da conta
    let acc = (await req("GET", `${P}/accounts`)).json.find((a: { id: string }) => a.id === conta.id);
    expect(acc.balanceCents).toBe(100000);
    // fatura oficial de janeiro chega com 16.000 (houve 1.000 de compra não lançada) e é paga pela conta
    await req("POST", `${P}/accounts/${card.id}/bill`, { amountCents: 16000, dueDate: "2027-01-10" });
    await req("POST", `${P}/titles/${jan.id}/settlements`, { amountCents: 16000, paidOn: "2027-01-10", accountId: conta.id });
    acc = (await req("GET", `${P}/accounts`)).json.find((a: { id: string }) => a.id === conta.id);
    expect(acc.balanceCents).toBe(100000 - 16000);
    // extrato de jan/27: despesas = 15.000 (compras) + 1.000 (parte da fatura não lançada) — não 31.000
    const st = (await req("GET", `${P}/statement?from=2027-01&to=2027-01`)).json.months[0];
    expect(st.expenseCents).toBe(10000 + 5000 + 7000 + 1000);
    expect(st.cashOutCents).toBe(16000);
  });

  it("conta comum paga num cartão cadastrado vai para a fatura; cartão sem fatura continua saindo do caixa", async () => {
    const card = (await req("POST", `${P}/accounts`, { type: "CARD", name: "Cartão dois", institution: "Banco Y", creditLimitCents: 100000, closingDay: 20, dueDay: 28 })).json;
    const t = (await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "Farmácia teste", category: "SAUDE", amountCents: 4000, dueDate: "2027-03-05" })).json;
    expect((await req("POST", `${P}/titles/${t.id}/settlements`, { amountCents: 4000, paidOn: "2027-03-05", cardAccountId: card.id })).status).toBe(201);
    const bill = (await req("GET", `${P}/titles?status=open`)).json.find((x: { dueDate: string; counterparty: string }) => x.dueDate === "2027-03-28" && x.counterparty.includes("Banco Y"));
    expect(bill.amountCents).toBe(4000);
    const loose = (await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "Antiga cartão", category: "OUTROS", amountCents: 900, dueDate: "2027-04-02" })).json;
    await req("POST", `${P}/titles/${loose.id}/settlements`, { amountCents: 900, paidOn: "2027-04-02", method: "CARD" });
    const st = (await req("GET", `${P}/statement?from=2027-03&to=2027-04`)).json.months;
    expect(st[0].cashOutCents).toBe(0); expect(st[0].expenseCents).toBe(4000);
    expect(st[1].cashOutCents).toBe(900);
  });

  it("limita tentativas de login por endereço de rede", async () => {
    const tryLogin = (ip: string) => app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email: `naoexiste${Math.random()}@x.test`, password: "errada" }) });
    for (let i = 0; i < 20; i++) await tryLogin("203.0.113.9");
    const blocked = await tryLogin("203.0.113.9");
    expect((await blocked.json()).error.code).toBe("TOO_MANY_ATTEMPTS");
    // outro endereço segue livre
    expect((await (await tryLogin("198.51.100.7")).json()).error.code).toBe("INVALID_LOGIN");
  });
});

describe("Verificação em duas etapas", () => {
  const post = async (path: string, body: unknown, ck = "") => {
    const r = await app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]!, json: t ? JSON.parse(t) : null };
  };
  it("ativa, exige código no login, aceita código de recuperação uma vez e o admin consegue zerar", async () => {
    const u = await createUser(db, { email: "mfa@familia.test", name: "Teste MFA", password: "frase-longa-do-teste" });
    const s1 = await post("/api/v1/auth/login", { email: "mfa@familia.test", password: "frase-longa-do-teste" });
    const ck = s1.cookie;
    const { secret, uri } = (await post("/api/v1/auth/2fa/setup", {}, ck)).json;
    expect(uri).toContain("otpauth://totp/");
    expect((await post("/api/v1/auth/2fa/enable", { code: "000000" }, ck)).status).toBe(422);
    const step = Math.floor(Date.now() / 30000);
    const en = await post("/api/v1/auth/2fa/enable", { code: totpAt(secret, step) }, ck);
    expect(en.json.recoveryCodes).toHaveLength(8);
    // o segredo não vai para o registro de alterações
    const leak = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_user' AND (new_data ? 'totp_secret' OR new_data ? 'totp_pending')");
    expect(leak.rows[0].n).toBe(0);

    const l = await post("/api/v1/auth/login", { email: "mfa@familia.test", password: "frase-longa-do-teste" });
    expect(l.json.mfaRequired).toBe(true); expect(l.cookie).toBe(""); // senha certa ainda não dá sessão
    expect((await post("/api/v1/auth/login/mfa", { challenge: l.json.challenge, code: totpAt(secret, step) })).json.error.code).toBe("MFA_INVALID"); // reuso bloqueado
    const ok = await post("/api/v1/auth/login/mfa", { challenge: l.json.challenge, code: totpAt(secret, step + 1) });
    expect(ok.status).toBe(200); expect(ok.json.totpEnabled).toBe(true); expect(ok.cookie).toMatch(/^nf_session=/);
    expect((await post("/api/v1/auth/login/mfa", { challenge: l.json.challenge, code: totpAt(secret, step + 1) })).json.error.code).toBe("MFA_EXPIRED"); // desafio é de uso único

    const rc = en.json.recoveryCodes[0];
    const l2 = await post("/api/v1/auth/login", { email: "mfa@familia.test", password: "frase-longa-do-teste" });
    expect((await post("/api/v1/auth/login/mfa", { challenge: l2.json.challenge, code: rc.toUpperCase() })).status).toBe(200);
    const l3 = await post("/api/v1/auth/login", { email: "mfa@familia.test", password: "frase-longa-do-teste" });
    expect((await post("/api/v1/auth/login/mfa", { challenge: l3.json.challenge, code: rc })).json.error.code).toBe("MFA_INVALID");

    expect((await post(`/api/v1/admin/users/${u.id}/reset-2fa`, {}, cookie)).status).toBe(204);
    const l4 = await post("/api/v1/auth/login", { email: "mfa@familia.test", password: "frase-longa-do-teste" });
    expect(l4.json.mfaRequired).toBeUndefined(); expect(l4.cookie).toMatch(/^nf_session=/);
  });
});

describe("Painel de dívidas", () => {
  it("separa por dono, soma no total e atualiza ao quitar; trocar o dono leva as parcelas junto", async () => {
    const ppl = (await req("GET", `${P}/people`)).json as { id: string; name: string }[];
    const thais = ppl.find(p => p.name === "Thaís")!.id, marcos = ppl.find(p => p.name === "Marcos")!.id;
    const sum = async () => (await req("GET", `${P}/debts/summary?asOf=2027-06-15`)).json;
    const row = (s: { owners: { personId: string | null }[] }, id: string) => s.owners.find(o => o.personId === id) as { debtOpenCents: number; paidThisMonthCents: number; progressPct: number } | undefined;
    const before = await sum();
    const b0 = { t: row(before, thais)?.debtOpenCents ?? 0, m: row(before, marcos)?.debtOpenCents ?? 0, tot: before.total.debtOpenCents, paid: before.total.paidCents };
    await req("POST", `${P}/accounts`, { type: "LOAN", name: "Empréstimo painel T", institution: "Loja P", ownerPersonId: thais, loan: { installmentCents: 10000, remaining: 3, firstOpenDueDate: "2027-07-10" } });
    const m = (await req("POST", `${P}/accounts`, { type: "LOAN", name: "Empréstimo painel M", institution: "Banco P", ownerPersonId: thais, loan: { installmentCents: 20000, remaining: 2, firstOpenDueDate: "2027-07-20" } })).json;
    // cadastrou no dono errado: corrige para o Marcos, as parcelas acompanham
    await req("PATCH", `${P}/accounts/${m.id}`, { ownerPersonId: marcos });
    let s = await sum();
    expect(row(s, thais)!.debtOpenCents - b0.t).toBe(30000);
    expect(row(s, marcos)!.debtOpenCents - b0.m).toBe(40000);
    expect(s.total.debtOpenCents - b0.tot).toBe(70000);
    // Marcos paga uma parcela
    const parcela = (await req("GET", `${P}/titles?status=open`)).json.find((t: { counterparty: string; dueDate: string }) => t.counterparty.includes("Empréstimo painel M") && t.dueDate === "2027-07-20");
    await req("POST", `${P}/titles/${parcela.id}/settlements`, { amountCents: 20000, paidOn: "2027-06-10" });
    s = await sum();
    expect(row(s, marcos)!.debtOpenCents - b0.m).toBe(20000);
    expect(s.total.paidCents - b0.paid).toBe(20000);
    expect(row(s, marcos)!.paidThisMonthCents).toBeGreaterThanOrEqual(20000);
    expect(row(s, marcos)!.progressPct).toBeGreaterThan(0);
    expect(s.total.owedCents).toBe(s.owners.reduce((a: number, o: { owedCents: number }) => a + o.owedCents, 0));
  });
});

describe("Registro de alterações e transferências", () => {
  it("grava quem alterou, filtra, corrige/exclui transferência com saldo voltando e respeita a retenção", async () => {
    const me = (await req("GET", "/api/v1/auth/me")).json;
    const a = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Origem log", institution: "Banco L", openingBalanceCents: 100000 })).json;
    const b = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Destino log", institution: "Banco L", openingBalanceCents: 0 })).json;
    const bal = async (id: string) => (await req("GET", `${P}/accounts`)).json.find((x: { id: string }) => x.id === id).balanceCents;
    const tr = (await req("POST", `${P}/transfers`, { fromAccountId: a.id, toAccountId: b.id, amountCents: 50000 })).json;
    expect([await bal(a.id), await bal(b.id)]).toEqual([50000, 50000]);
    expect((await req("PATCH", `${P}/transfers/${tr.id}`, { amountCents: 30000 })).status).toBe(200);
    expect([await bal(a.id), await bal(b.id)]).toEqual([70000, 30000]);
    const list = (await req("GET", `${P}/transfers`)).json;
    expect(list.find((x: { id: string }) => x.id === tr.id)).toMatchObject({ amountCents: 30000, createdByName: "Marcos" });

    // autor gravado e filtros funcionando
    const log = (await req("GET", `/api/v1/admin/audit?area=transferencias&actor=${me.id}&limit=10`)).json;
    expect(log[0]).toMatchObject({ who: "Marcos", action: "alterou", what: "Transferência" });
    expect(log[0].label.replace(/\s/g, " ")).toBe("R$ 500,00 → R$ 300,00");
    expect((await req("GET", `/api/v1/admin/audit?area=transferencias&actor=system&limit=10`)).json.find((l: { label: string }) => l.label.includes("300,00"))).toBeUndefined();

    // membro não exclui transferência de outra pessoa
    await createUser(db, { email: "membro-log@familia.test", name: "Membro Log", password: "frase-longa-membro-1" });
    const ml = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "membro-log@familia.test", password: "frase-longa-membro-1" }) });
    const mck = (ml.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await req("DELETE", `${P}/transfers/${tr.id}`, undefined, { cookie: mck })).status).toBe(403);

    expect((await req("DELETE", `${P}/transfers/${tr.id}`)).status).toBe(204);
    expect([await bal(a.id), await bal(b.id)]).toEqual([100000, 0]);
    expect((await req("GET", `/api/v1/admin/audit?area=transferencias&limit=5`)).json[0]).toMatchObject({ who: "Marcos", action: "excluiu" });

    // retenção: padrão 12 meses; só o root muda; o ciclo diário tira o que passou do prazo
    expect((await req("GET", "/api/v1/admin/audit/retention")).json.months).toBe(0);
    expect((await req("PUT", "/api/v1/admin/audit/retention", { months: 2 })).json.months).toBe(2);
    await db.query("INSERT INTO audit_log (table_name, row_id, action, at) VALUES ('title', 'velho', 'INSERT', now() - interval '3 months')");
    const cron = await app.request("/api/v1/cron/recurrences", { headers: { authorization: "Bearer segredo-cron" } });
    expect((await cron.json()).auditPruned).toBeGreaterThanOrEqual(1);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE row_id = 'velho'")).rows[0].n).toBe(0);
  });
});

describe("Importar cadastro", () => {
  it("prévia não grava, cria o que é novo, não duplica e aponta erros", async () => {
    const file = { version: 1, items: [
      { type: "CHECKING", institution: "Banco Imp", name: "Conta", owner: "Thais", openingBalanceCents: 123456 },
      { type: "CARD", institution: "Banco Imp", name: "Cartão", owner: "Marcos", creditLimitCents: 500000, closingDay: 3, dueDay: 10, monthlyRateBp: 1320,
        currentBill: { amountCents: 263500, dueDate: "2027-08-10" } },
      { type: "LOAN", institution: "Pessoa Imp", name: "Empréstimo pessoal", owner: "Marcos", negativado: false,
        loan: { installmentCents: 100000, remaining: 3, firstOpenDueDate: "2027-08-15" } },
      { type: "LOAN", institution: "Loja Imp", name: "Sem parcelas", owner: "Marcos" },
      { type: "CHECKING", institution: "Banco Imp", name: "Fantasma", owner: "Ninguém" },
    ] };
    const pre = (await req("POST", `${P}/import/accounts?dryRun=1`, file)).json;
    expect(pre.rows.map((r: { status: string }) => r.status)).toEqual(["novo", "novo", "novo", "erro", "erro"]);
    expect(pre.rows[1].summary).toContain("juros 13,2% a.m.");
    expect((await req("GET", `${P}/accounts`)).json.some((a: { institution: string }) => a.institution === "Banco Imp")).toBe(false);
    const done = (await req("POST", `${P}/import/accounts`, file)).json;
    expect(done.created).toBe(3);
    const accs = (await req("GET", `${P}/accounts`)).json.filter((a: { institution: string }) => a.institution?.endsWith("Imp"));
    expect(accs).toHaveLength(3);
    expect(accs.find((a: { type: string }) => a.type === "CHECKING")).toMatchObject({ ownerName: "Thaís", balanceCents: 123456 });
    const again = (await req("POST", `${P}/import/accounts`, file)).json;
    expect(again.created).toBe(0);
    expect(again.rows.slice(0, 3).every((r: { status: string }) => r.status === "ja_existe")).toBe(true);
  });
});

describe("Perfil só combinados", () => {
  it("vê e marca só os próprios combinados; finanças são negadas no servidor", async () => {
    const pid = (await req("POST", `${P}/people`, { name: "Membro Combinados" })).json.id;
    const u = (await req("POST", "/api/v1/admin/users", { email: "combinados@familia.test", name: "Combinados", personId: pid, conductOnly: true, password: "frase-longa-combinados-1" })).json;
    expect(u).toMatchObject({ conductOnly: true, isGuardian: false });
    expect((await req("POST", "/api/v1/admin/users", { email: "x@familia.test", name: "X", role: "ADMIN", conductOnly: true, password: "frase-longa-x-12345" })).status).toBeGreaterThanOrEqual(403);
    const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "combinados@familia.test", password: "frase-longa-combinados-1" }) });
    const ck = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const as = (m: string, path: string, body?: unknown) => req(m, path, body, { cookie: ck });
    for (const path of [`${P}/dashboard`, `${P}/accounts`, `${P}/titles`, `${P}/debts/summary`, `${P}/ranking`, `${P}/statement?from=2027-01&to=2027-01`, "/api/v1/byte4tech/titles", "/api/v1/admin/audit"])
      expect((await as("GET", path)).status, path).toBe(403);
    expect((await as("POST", `${P}/expenses/quick`, { amountCents: 100, description: "x", category: "OUTROS" })).status).toBe(403);
    expect((await as("GET", "/api/v1/auth/me")).json.conductOnly).toBe(true);
    expect((await as("GET", `${P}/conduct/board`)).status).toBe(200);
    const al = (await as("GET", `${P}/conduct/allowance`)).json;
    expect(al.people.every((p: { personId: string }) => p.personId === pid)).toBe(true);
    const rule = (await req("POST", `${P}/conduct/rules`, { kind: "HABIT", name: "Arrumar a cama teste", assignees: [{ personId: pid }] })).json;
    expect((await as("POST", `${P}/conduct/checks`, { personId: pid, ruleId: rule.id, day: new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }), checked: true })).status).toBeLessThan(300);
    const other = (await req("POST", `${P}/people`, { name: "Outra Pessoa" })).json.id;
    expect((await as("POST", `${P}/conduct/checks`, { personId: other, ruleId: rule.id, day: "2026-11-22", checked: true })).status).toBe(403);
  });
});

describe("Fechamento do mês e aprovação de checks", () => {
  const login = async (email: string, password: string) => {
    const r = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const sp = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const monthsAgo = (n: number) => { const [y, m] = sp().split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 - n, 10)); return d.toISOString().slice(0, 10); };

  it("mês fechado (a partir do dia 5 do mês seguinte) só aceita correção do root", async () => {
    await createUser(db, { email: "resp@familia.test", name: "Responsável", role: "ADMIN", password: "frase-longa-resp-12" });
    const ck = await login("resp@familia.test", "frase-longa-resp-12");
    const t = (await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "Conta fechamento", category: "OUTROS", amountCents: 5000, dueDate: monthsAgo(2) })).json;
    // não-root: mês de 2 meses atrás está fechado
    const r1 = await req("POST", `${P}/titles/${t.id}/settlements`, { amountCents: 1000, paidOn: monthsAgo(2) }, { cookie: ck });
    expect(r1.status).toBe(422); expect(r1.json.error.code).toBe("MONTH_CLOSED"); expect(r1.json.error.message).toContain("Só o root");
    // não-root no mês atual: ok
    expect((await req("POST", `${P}/titles/${t.id}/settlements`, { amountCents: 1000, paidOn: sp() }, { cookie: ck })).status).toBe(201);
    // root corrige o mês fechado
    expect((await req("POST", `${P}/titles/${t.id}/settlements`, { amountCents: 1000, paidOn: monthsAgo(2) })).status).toBe(201);
    // não-root não altera valor de conta que tem pagamento em mês fechado
    expect((await req("PATCH", `${P}/titles/${t.id}`, { amountCents: 9000 }, { cookie: ck })).json.error.code).toBe("MONTH_CLOSED");
    // gasto rápido com data no mês fechado também é recusado (e nada fica pela metade)
    const before = (await req("GET", `${P}/titles`)).json.length;
    expect((await req("POST", `${P}/expenses/quick`, { amountCents: 700, description: "Esquecido", category: "OUTROS", date: monthsAgo(2) }, { cookie: ck })).status).toBe(422);
    expect((await req("GET", `${P}/titles`)).json.length).toBe(before);
  });

  it("check de quem é só combinados fica pendente até um responsável aprovar; recusado não conta", async () => {
    const pid = (await req("POST", `${P}/people`, { name: "Criança Aprova" })).json.id;
    await req("POST", "/api/v1/admin/users", { email: "aprova@familia.test", name: "Aprova", personId: pid, conductOnly: true, password: "frase-longa-aprova-1" });
    await db.query("UPDATE app_user SET must_change_password = false WHERE email = 'aprova@familia.test'");
    const kid = await login("aprova@familia.test", "frase-longa-aprova-1");
    const r1 = (await req("POST", `${P}/conduct/rules`, { kind: "HABIT", name: "Tarefa aprova 1", assignees: [{ personId: pid }] })).json;
    const r2 = (await req("POST", `${P}/conduct/rules`, { kind: "HABIT", name: "Tarefa aprova 2", assignees: [{ personId: pid }] })).json;
    const day = sp();
    await db.query("UPDATE conduct_rule SET starts_on = $1 WHERE id = ANY($2)", [day, [r1.id, r2.id]]); // tarefa nova vale a partir de amanhã; aqui, já hoje
    expect((await req("POST", `${P}/conduct/checks`, { personId: pid, ruleId: r1.id, day, checked: true }, { cookie: kid })).json.pending).toBe(true);
    await req("POST", `${P}/conduct/checks`, { personId: pid, ruleId: r2.id, day, checked: true }, { cookie: kid });
    const item = async (ruleId: string) => (await req("GET", `${P}/conduct/board`)).json.rows.find((r: { personId: string }) => r.personId === pid)
      .grid.find((g: { day: string }) => g.day === day).items.find((i: { ruleId: string }) => i.ruleId === ruleId);
    expect(await item(r1.id)).toMatchObject({ done: false, pending: true });
    const pend = (await req("GET", `${P}/conduct/pending`)).json.filter((p: { personId: string }) => p.personId === pid);
    expect(pend).toHaveLength(2);
    // a criança não aprova a si mesma
    expect((await req("POST", `${P}/conduct/checks/review`, { personId: pid, ruleId: r1.id, day, approve: true }, { cookie: kid })).status).toBe(403);
    expect((await req("POST", `${P}/conduct/checks/review`, { personId: pid, ruleId: r1.id, day, approve: true })).status).toBe(200);
    expect((await req("POST", `${P}/conduct/checks/review`, { personId: pid, ruleId: r2.id, day, approve: false })).status).toBe(200);
    expect(await item(r1.id)).toMatchObject({ done: true, pending: false });
    expect(await item(r2.id)).toMatchObject({ done: false, pending: false });
    // aprovado: a criança não desfaz sozinha
    expect((await req("POST", `${P}/conduct/checks`, { personId: pid, ruleId: r1.id, day, checked: false }, { cookie: kid })).json.error.code).toBe("ALREADY_APPROVED");
    expect((await req("GET", `${P}/conduct/pending`)).json.filter((p: { personId: string }) => p.personId === pid)).toHaveLength(0);
  });
});

describe("Avisos no celular", () => {
  it("avisa responsáveis no check pendente, a criança na aprovação, contas do dia no cron e limpa aparelho cancelado", async () => {
    const { setSender } = await import("../src/push.js");
    const sent: { endpoint: string; body: { title: string; body: string } }[] = [];
    setSender(async (sub, payload) => { if (sub.endpoint.includes("cancelado")) throw Object.assign(new Error("gone"), { statusCode: 410 }); sent.push({ endpoint: sub.endpoint, body: JSON.parse(payload) }); });
    const k1 = (await req("GET", "/api/v1/push/key")).json.publicKey;
    expect(k1).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await req("GET", "/api/v1/push/key")).json.publicKey).toBe(k1); // chave estável
    const sub = (name: string) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } });
    expect((await req("POST", "/api/v1/push/subscribe", sub("pai"))).status).toBe(201);
    await req("POST", "/api/v1/push/subscribe", sub("pai-cancelado"));

    const pid = (await req("POST", `${P}/people`, { name: "Criança Aviso" })).json.id;
    await req("POST", "/api/v1/admin/users", { email: "aviso@familia.test", name: "Aviso", personId: pid, conductOnly: true, password: "frase-longa-aviso-12" });
    await db.query("UPDATE app_user SET must_change_password = false WHERE email = 'aviso@familia.test'");
    const lr = await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "aviso@familia.test", password: "frase-longa-aviso-12" }) });
    const kid = (lr.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await req("POST", "/api/v1/push/subscribe", sub("crianca"), { cookie: kid })).status).toBe(201);

    const rule = (await req("POST", `${P}/conduct/rules`, { kind: "HABIT", name: "Guardar brinquedos", assignees: [{ personId: pid }] })).json;
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    sent.length = 0;
    await req("POST", `${P}/conduct/checks`, { personId: pid, ruleId: rule.id, day, checked: true }, { cookie: kid });
    expect(sent.find(s => s.endpoint.endsWith("/pai"))?.body).toMatchObject({ title: "Criança Aviso marcou uma tarefa", body: "Guardar brinquedos — toque para aprovar." });
    expect(sent.some(s => s.endpoint.endsWith("/crianca"))).toBe(false);
    // aparelho cancelado (410) é removido
    expect((await db.query("SELECT count(*)::int AS n FROM push_subscription WHERE endpoint LIKE '%cancelado'")).rows[0].n).toBe(0);

    sent.length = 0;
    await req("POST", `${P}/conduct/checks/review`, { personId: pid, ruleId: rule.id, day, approve: true });
    expect(sent.map(s => s.endpoint)).toEqual(["https://push.example/crianca"]);
    expect(sent[0]!.body.title).toBe("Tarefa aprovada ✓");

    // cron: conta que vence hoje vira lembrete para os responsáveis
    await req("POST", `${P}/titles`, { kind: "PAYABLE", nature: "EXPENSE", counterparty: "Conta de hoje", category: "OUTROS", amountCents: 12345, dueDate: day });
    sent.length = 0;
    const cron = await (await app.request("/api/v1/cron/recurrences", { headers: { authorization: "Bearer segredo-cron" } })).json();
    expect(cron.pushed).toBeGreaterThanOrEqual(1);
    expect(sent.find(s => s.endpoint.endsWith("/pai"))!.body.body).toContain("Conta de hoje");
    // a criança não recebe aviso de contas
    expect(sent.some(s => s.endpoint.endsWith("/crianca"))).toBe(false);
  });
});

describe("Importar extrato OFX", () => {
  it("lê OFX 1.x e 2.x, vírgula decimal e cartão", async () => {
    const { parseOfx } = await import("../src/statement.js");
    const sgml = `OFXHEADER:100\nCHARSET:1252\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103120000[-3:BRT]<TRNAMT>-45,90<FITID>A1<MEMO>IFOOD *Restaurante
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105<TRNAMT>1500.00<FITID>A2<NAME>PIX RECEBIDO<MEMO>Cliente
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const a = parseOfx(sgml);
    expect(a.isCard).toBe(false);
    expect(a.txns).toEqual([
      { fitid: "A1", date: "2026-11-03", amountCents: -4590, memo: "IFOOD *Restaurante" },
      { fitid: "A2", date: "2026-11-05", amountCents: 150000, memo: "PIX RECEBIDO · Cliente" },
    ]);
    const xml = `<?xml version="1.0"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261110</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>X9</FITID><MEMO>Uber *Trip</MEMO></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const b = parseOfx(xml);
    expect(b.isCard).toBe(true);
    expect(b.txns[0]).toMatchObject({ fitid: "X9", amountCents: -1234, memo: "Uber *Trip" });
  });

  it("classifica, reconhece o já lançado e a transferência com a família, não duplica e aprende a categoria", async () => {
    const d = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const ymd = d.replace(/-/g, "");
    const ppl = (await req("GET", `${P}/people`)).json as { id: string; name: string }[];
    const marcos = ppl.find(p => p.name === "Marcos")!.id;
    const ofxPerson = (await req("POST", `${P}/people`, { name: "Joana Extrato" })).json.id;
    const minha = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta OFX", institution: "Banco OFX", ownerPersonId: marcos, openingBalanceCents: 500000 })).json;
    const dela = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta da Joana", institution: "Banco J", ownerPersonId: ofxPerson, openingBalanceCents: 0 })).json;
    // lançado à mão antes de importar
    await req("POST", `${P}/expenses/quick`, { amountCents: 8000, description: "Padaria do bairro", category: "ALIMENTACAO", date: d, accountId: minha.id, personId: marcos });
    const ofx = `<OFX><BANKTRANLIST>
<STMTTRN><DTPOSTED>${ymd}<TRNAMT>-80.00<FITID>F1<MEMO>PADARIA BOM PAO
<STMTTRN><DTPOSTED>${ymd}<TRNAMT>-59.90<FITID>F2<MEMO>NETFLIX.COM
<STMTTRN><DTPOSTED>${ymd}<TRNAMT>-300.00<FITID>F3<MEMO>PIX ENVIADO JOANA SILVA
<STMTTRN><DTPOSTED>${ymd}<TRNAMT>-77.77<FITID>F4<MEMO>LOJA QUALQUER 123
</BANKTRANLIST></OFX>`;
    const pre = (await req("POST", `${P}/import/statement/preview`, { accountId: minha.id, text: ofx })).json;
    const by = (id: string) => pre.rows.find((r: { fitid: string }) => r.fitid === id);
    expect(by("F1")).toMatchObject({ status: "ja_lancado", action: "ignorar" });
    expect(by("F2")).toMatchObject({ status: "novo", action: "despesa", category: "ASSINATURAS" });
    expect(by("F3")).toMatchObject({ status: "novo", action: "transferencia", toAccountId: dela.id });
    expect(by("F4")).toMatchObject({ status: "novo", action: "despesa", category: "OUTROS" });

    const rows = pre.rows.map((r: { status: string; fitid: string; category: string; action: string }) => ({ ...r, action: r.status === "novo" ? r.action : "ignorar",
      category: r.fitid === "F4" ? "PRESENTES" : r.category }))
      .map(({ status: _s, hint: _h, ...x }: { status: string; hint: string }) => x);
    const done = (await req("POST", `${P}/import/statement`, { accountId: minha.id, rows })).json;
    expect(done).toMatchObject({ despesas: 2, transferencias: 1, ignorados: 1, erros: [] });
    const bal = async (id: string) => (await req("GET", `${P}/accounts`)).json.find((a: { id: string }) => a.id === id).balanceCents;
    expect(await bal(minha.id)).toBe(500000 - 8000 - 5990 - 30000 - 7777);
    expect(await bal(dela.id)).toBe(30000);

    // reimportar o mesmo arquivo não duplica
    const again = (await req("POST", `${P}/import/statement/preview`, { accountId: minha.id, text: ofx })).json;
    expect(again.rows.every((r: { status: string }) => r.status === "ja_importado")).toBe(true);
    // aprende: mesma loja em outro mês vem com a categoria escolhida
    const novo = `<OFX><STMTTRN><DTPOSTED>${ymd}<TRNAMT>-10.00<FITID>F9<MEMO>LOJA QUALQUER 456</OFX>`;
    expect((await req("POST", `${P}/import/statement/preview`, { accountId: minha.id, text: novo })).json.rows[0]).toMatchObject({ category: "PRESENTES", hint: "como da última vez" });
  });
});

describe("Orçamento por categoria", () => {
  it("mostra gasto x teto no mês e avisa uma vez ao cruzar 80% e 100%", async () => {
    const { setSender } = await import("../src/push.js");
    const sent: string[] = [];
    // conta só o aparelho deste teste (o admin já tem outros inscritos de testes anteriores)
    setSender(async (sub, payload) => { if (sub.endpoint.endsWith("/orc")) sent.push(JSON.parse(payload).title); });
    await req("POST", "/api/v1/push/subscribe", { endpoint: "https://push.example/orc", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } });
    const d = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    expect((await req("PUT", `${P}/budget/DELIVERY`, { limitCents: 10000 })).status).toBe(200);
    const gasto = (v: number) => req("POST", `${P}/expenses/quick`, { amountCents: v, description: "Lanche app", category: "DELIVERY", date: d });
    await gasto(5000);
    expect(sent.filter(t => t.includes("DELIVERY"))).toEqual([]);
    await gasto(3500); // 85%
    await gasto(500);  // 90%: não repete o de 80%
    expect(sent.filter(t => t.includes("DELIVERY"))).toEqual(["Orçamento em 80%: DELIVERY"]);
    await gasto(2000); // 110%
    expect(sent.filter(t => t.includes("DELIVERY"))).toEqual(["Orçamento em 80%: DELIVERY", "Orçamento estourado: DELIVERY"]);
    const b = (await req("GET", `${P}/budget`)).json;
    expect(b.items.find((i: { category: string }) => i.category === "DELIVERY")).toMatchObject({ limitCents: 10000, spentCents: 11000, leftCents: -1000, pct: 110 });
    // membro comum não muda o orçamento; tirar o teto remove da lista
    expect((await req("PUT", `${P}/budget/DELIVERY`, { limitCents: null })).status).toBe(200);
    expect((await req("GET", `${P}/budget`)).json.items.some((i: { category: string }) => i.category === "DELIVERY")).toBe(false);
  });
});

describe("Pedidos de compra", () => {
  it("criança pede, responsável troca a conta e aprova (vira gasto dela); recusa exige motivo; quem pede não aprova", async () => {
    const { setSender } = await import("../src/push.js");
    const sent: { to: string; title: string }[] = [];
    setSender(async (sub, payload) => { sent.push({ to: sub.endpoint, title: JSON.parse(payload).title }); });
    const login = async (email: string, pw: string) => ((await app.request("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) })).headers.get("set-cookie") ?? "").split(";")[0]!;
    const pid = (await req("POST", `${P}/people`, { name: "Criança Pedido" })).json.id;
    await req("POST", "/api/v1/admin/users", { email: "pedido@familia.test", name: "Pedido", personId: pid, conductOnly: true, password: "frase-longa-pedido-12" });
    await db.query("UPDATE app_user SET must_change_password = false WHERE email = 'pedido@familia.test'");
    const kid = await login("pedido@familia.test", "frase-longa-pedido-12");
    await req("POST", "/api/v1/push/subscribe", { endpoint: "https://push.example/pedido-pai", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } });
    await req("POST", "/api/v1/push/subscribe", { endpoint: "https://push.example/pedido-kid", keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }, { cookie: kid });
    const nu = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta pedido A", institution: "Banco PA", openingBalanceCents: 0 })).json;
    const inter = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta pedido B", institution: "Banco PB", openingBalanceCents: 100000 })).json;

    // a criança vê as opções (só nomes) e pede pelo banco A
    const src = (await req("GET", `${P}/requests/sources`, undefined, { cookie: kid })).json;
    expect(src.some((s: { id: string }) => s.id === nu.id)).toBe(true);
    expect(src[0].balanceCents).toBeUndefined();
    sent.length = 0;
    const r1 = (await req("POST", `${P}/requests`, { description: "Caderno", amountCents: 3500, category: "EDUCACAO", accountId: nu.id }, { cookie: kid })).json;
    expect(r1).toMatchObject({ status: "PENDING", forPersonId: pid, accountId: nu.id });
    expect(sent.some(s => s.to.endsWith("pedido-pai") && s.title === "Pedido de Pedido")).toBe(true);
    expect(sent.some(s => s.to.endsWith("pedido-kid"))).toBe(false);
    // a criança não aprova
    expect((await req("POST", `${P}/requests/${r1.id}/review`, { approve: true }, { cookie: kid })).status).toBe(403);
    // recusar sem motivo não pode
    expect((await req("POST", `${P}/requests/${r1.id}/review`, { approve: false })).json.error.code).toBe("NOTE_REQUIRED");
    sent.length = 0;
    const rej = (await req("POST", `${P}/requests/${r1.id}/review`, { approve: false, note: "Sem saldo no A, peça pelo B" })).json;
    expect(rej).toMatchObject({ status: "REJECTED", reviewNote: "Sem saldo no A, peça pelo B" });
    expect(sent.find(s => s.to.endsWith("pedido-kid"))?.title).toBe("Pedido não aprovado");

    // pede de novo; o responsável aprova trocando para o banco B
    const r2 = (await req("POST", `${P}/requests`, { description: "Caderno", amountCents: 3500, category: "EDUCACAO", accountId: nu.id }, { cookie: kid })).json;
    const ok = (await req("POST", `${P}/requests/${r2.id}/review`, { approve: true, accountId: inter.id })).json;
    expect(ok).toMatchObject({ status: "APPROVED", paidAccountId: inter.id });
    expect((await req("POST", `${P}/requests/${r2.id}/review`, { approve: true, accountId: inter.id })).status).toBe(409); // não aprova duas vezes
    const bal = (await req("GET", `${P}/accounts`)).json.find((a: { id: string }) => a.id === inter.id).balanceCents;
    expect(bal).toBe(100000 - 3500);
    const t = (await req("GET", `${P}/titles?person=${pid}`)).json.find((x: { counterparty: string }) => x.counterparty === "Pedido: Caderno");
    expect(t).toMatchObject({ amountCents: 3500, category: "EDUCACAO", personId: pid });

    // a criança só vê os próprios pedidos; o responsável vê todos
    expect((await req("GET", `${P}/requests`, undefined, { cookie: kid })).json.every((x: { requestedBy: string; forPersonId: string }) => x.requestedBy !== undefined && x.forPersonId === pid)).toBe(true);
    // quem pede não aprova o próprio pedido
    const own = (await req("POST", `${P}/requests`, { description: "Fone", amountCents: 9900, accountId: inter.id })).json;
    expect((await req("POST", `${P}/requests/${own.id}/review`, { approve: true })).json.error.code).toBe("OWN_REQUEST");
    expect((await req("POST", `${P}/requests/${own.id}/cancel`)).json.status).toBe("CANCELED");
  });
});

describe("Baixa com desconto", () => {
  it("dívida de 1.800 quitada por 1.500: fecha, sai só 1.500 do caixa e os 300 não viram despesa", async () => {
    const d = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const conta = (await req("POST", `${P}/accounts`, { type: "CHECKING", name: "Conta desconto", institution: "Banco D", openingBalanceCents: 300000 })).json;
    await req("POST", `${P}/accounts`, { type: "LOAN", name: "Dívida desconto", institution: "Credor D", loan: { installmentCents: 180000, remaining: 1, firstOpenDueDate: d } });
    const t = (await req("GET", `${P}/titles?status=open`)).json.find((x: { counterparty: string }) => x.counterparty.startsWith("Credor D · Dívida desconto"));
    const before = (await req("GET", `${P}/statement?from=${d.slice(0, 7)}&to=${d.slice(0, 7)}`)).json.months[0];
    const r = await req("POST", `${P}/titles/${t.id}/settlements`, { amountCents: 150000, paidOn: d, accountId: conta.id, discountRest: true });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "SETTLED", openCents: 0 });
    expect(r.json.settlements.map((s: { method: string; amountCents: number }) => `${s.method}:${s.amountCents}`).sort()).toEqual(["ACCOUNT:150000", "DISCOUNT:30000"]);
    expect((await req("GET", `${P}/accounts`)).json.find((a: { id: string }) => a.id === conta.id).balanceCents).toBe(150000);
    const after = (await req("GET", `${P}/statement?from=${d.slice(0, 7)}&to=${d.slice(0, 7)}`)).json.months[0];
    expect(after.cashOutCents - before.cashOutCents).toBe(150000);
    expect(after.amortizationCents - before.amortizationCents).toBe(150000);
    expect(after.expenseCents - before.expenseCents).toBe(0);
    // painel de dívidas mostra a economia (juros evitados / desconto)
    expect((await req("GET", `${P}/debts/summary`)).json.total.savedCents).toBeGreaterThanOrEqual(30000);
    // receber não aceita desconto por este caminho
    const rec = (await req("POST", `${P}/titles`, { kind: "RECEIVABLE", nature: "INCOME", counterparty: "Cliente D", category: "RENDA", amountCents: 1000, dueDate: d })).json;
    expect((await req("POST", `${P}/titles/${rec.id}/settlements`, { amountCents: 500, paidOn: d, discountRest: true })).json.error.code).toBe("DISCOUNT_PAYABLE_ONLY");
    expect((await req("GET", `${P}/titles/${rec.id}`)).json.settledCents).toBe(0); // nada ficou pela metade
  });
});

describe("Importar contas automáticas", () => {
  it("cria a conta automática, não duplica e aponta erro de campo", async () => {
    const file = { version: 1, items: [
      { type: "RECURRENCE", kind: "PAYABLE", nature: "EXPENSE", description: "Contador teste import", category: "FIXO", defaultAmountCents: 30000, dueDay: 10, startMonth: "2027-01" },
      { type: "RECURRENCE", kind: "PAYABLE", nature: "EXPENSE", description: "Sem mês", category: "FIXO" },
    ] };
    const pre = (await req("POST", `${P}/import/accounts?dryRun=1`, file)).json;
    expect(pre.rows.map((r: { status: string }) => r.status)).toEqual(["novo", "erro"]);
    expect(pre.rows[0].summary.replace(/\s/g, " ")).toBe("a pagar R$ 300,00 todo dia 10 desde 01/2027");
    expect((await req("POST", `${P}/import/accounts`, file)).json.created).toBe(1);
    expect((await req("GET", `${P}/recurrences`)).json.some((r: { description: string }) => r.description === "Contador teste import")).toBe(true);
    expect((await req("POST", `${P}/import/accounts`, file)).json.rows[0].status).toBe("ja_existe");
  });
});
