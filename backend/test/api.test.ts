/**
 * Testes de integração: API real + PostgreSQL real (banco nofinance_test, recriado a cada execução).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { migrate, ensureDatabase } from "../scripts/migrate.js";
import { seed } from "../scripts/seed.js";
import { createUser } from "../src/auth.js";

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
    expect(row.grid.find((g: { day: string }) => g.day === today).habits.every((h: { done: boolean }) => h.done)).toBe(true);

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
