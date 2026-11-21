import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import * as auth from "./auth.js";
import * as conduct from "./conduct.js";
import * as admin from "./admin.js";
import type { SessionUser } from "./auth.js";
import { z } from "zod";
import type { Db } from "./db.js";
import * as svc from "./service.js";
import { AppError, type Entity } from "./service.js";
import { todaySP, addMonths } from "./domain/finance.js";

/* ---------- Esquemas de entrada (validação em todas as bordas) ---------- */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD");
const isoMonth = z.string().regex(/^\d{4}-\d{2}(-01)?$/, "Use AAAA-MM");
const cents = z.number().int().nonnegative().max(1e12);
const positiveCents = z.number().int().positive().max(1e12);
const kind = z.enum(["PAYABLE", "RECEIVABLE"]);
const nature = z.enum(["EXPENSE", "DEBT", "CARD", "INCOME", "LOAN_IN"]);
const model = z.enum(["NONE", "FIXED_ONCE", "MONTHLY_SIMPLE", "MONTHLY_COMPOUND"]);
const text = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.uuid();
const personRef = uuid.nullable().optional();

const titleCreate = z.object({
  kind, nature, counterparty: text(120), category: text(40).optional(), amountCents: cents,
  interestModel: model.optional(), rateBp: z.number().int().min(0).max(100000).optional(),
  dueDate: isoDate.nullable().optional(), startDate: isoDate.optional(), notes: z.string().max(500).nullable().optional(),
  personId: personRef, mandatory: z.boolean().nullable().optional(),
  loan: z.object({ interestModel: model, rateBp: z.number().int().min(0).max(100000), dueDate: isoDate.nullable().optional() }).optional(),
}).strict();
const titlePatch = titleCreate.omit({ kind: true, loan: true }).partial().strict();
const settlementCreate = z.object({
  amountCents: positiveCents, paidOn: isoDate.optional(), method: z.enum(["ACCOUNT", "CARD"]).optional(),
  notes: z.string().max(500).nullable().optional(),
}).strict();
const settlementPatch = settlementCreate.partial().strict();
const recurrenceCreate = z.object({
  kind, nature: z.enum(["EXPENSE", "INCOME"]), description: text(120), category: text(40),
  defaultAmountCents: cents.nullable().optional(), dueDay: z.number().int().min(1).max(31).nullable().optional(),
  startMonth: isoMonth, endMonth: isoMonth.nullable().optional(), active: z.boolean().optional(), personId: personRef,
}).strict();
const recurrencePatch = recurrenceCreate.omit({ kind: true, nature: true, startMonth: true }).partial().strict();
const simInput = z.object({
  monthlyIncomeCents: positiveCents, monthlyFixedCents: cents, extraCents: z.number().int().default(0),
  initialCashCents: z.number().int().default(0), rolloverMonthly: z.boolean().default(true), includeCards: z.boolean().default(true),
}).strict();
const personCreate = z.object({ name: text(80), relation: z.string().trim().max(40).nullable().optional(), active: z.boolean().optional() }).strict();
const personPatch = personCreate.partial().strict();
const loginInput = z.object({ email: z.string().trim().max(200), password: z.string().min(1).max(200) }).strict();
const passwordInput = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) }).strict();
const userCreate = z.object({ email: z.email().max(200), name: text(80), nickname: z.string().trim().max(30).nullable().optional(),
  role: z.enum(["ADMIN", "MEMBER"]).optional(), personId: personRef, isGuardian: z.boolean().optional(), password: z.string().max(200) }).strict();
const userPatch = userCreate.partial().extend({ active: z.boolean().optional() }).strict();
const ruleCreate = z.object({ kind: z.enum(["HABIT", "INFRACTION"]), name: text(80), points: z.number().int().min(0).max(1000).optional(),
  fineCents: z.number().int().min(0).max(100000000).optional(), sort: z.number().int().min(0).max(999).optional(), active: z.boolean().optional() }).strict();
const rulePatch = ruleCreate.omit({ kind: true }).partial().strict();
const checkInput = z.object({ personId: uuid, ruleId: uuid, day: isoDate, checked: z.boolean() }).strict();
const infractionInput = z.object({ personId: uuid, ruleId: uuid, day: isoDate.optional(), note: z.string().trim().max(200).nullable().optional() }).strict();
const settleInput = z.object({ personId: uuid, kind: z.enum(["PAYMENT", "WAIVER"]), amountCents: positiveCents, note: z.string().trim().max(200).nullable().optional() }).strict();
const categoriesInput = z.object({ categories: z.array(text(40)).max(40) }).strict();
const guardInput = z.object({ amountCents: positiveCents, category: text(40), date: isoDate.optional() }).strict();
const quickInput = guardInput.extend({ description: text(120), method: z.enum(["ACCOUNT", "CARD"]).optional(), personId: personRef }).strict();

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new AppError(400, "INVALID_JSON", "Corpo JSON inválido."); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError(400, "VALIDATION_ERROR", "Dados inválidos.", z.flattenError(r.error));
  return r.data;
}
function param(c: Context, name: string, schema: z.ZodType = uuid): string {
  const v = c.req.param(name);
  if (!schema.safeParse(v).success) throw new AppError(400, "INVALID_PARAM", `Parâmetro inválido: ${name}.`);
  return v as string;
}

/* ---------- App ---------- */
type Vars = { entity: Entity; user: SessionUser; token: string };
const COOKIE = "nf_session";
const NO_ENTITY = new Set(["auth", "admin", "cron"]);

export function createApp(db: Db, opts: { cronSecret?: string; secureCookies?: boolean; setupToken?: string } = {}) {
  const app = new Hono<{ Variables: Vars }>();
  app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } }));

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    const mapped = svc.pgToAppError(err);
    if (mapped instanceof AppError) return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    // Log estruturado sem dados do corpo (podem conter dados pessoais).
    console.error(JSON.stringify({ level: "error", path: c.req.path, method: c.req.method, msg: (err as Error).message }));
    // Banco fora do ar (comum no WSL depois de reiniciar): mensagem que diz o que fazer.
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED" || code === "57P03" || code === "ETIMEDOUT")
      return c.json({ error: { code: "DB_UNAVAILABLE", message: "Banco de dados desligado. No WSL rode: sudo service postgresql start" } }, 503);
    return c.json({ error: { code: "INTERNAL", message: "Erro interno." } }, 500);
  });
  app.notFound(c => c.json({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }, 404));

  // Log de acesso (sem corpo: pode ter dados pessoais).
  app.use("*", async (c, next) => {
    const t0 = performance.now(); await next();
    console.log(JSON.stringify({ level: "info", at: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t0) }));
  });

  app.get("/health", async c => {
    await db.query("SELECT 1");
    return c.json({ status: "ok", time: new Date().toISOString() });
  });

  const v1 = new Hono<{ Variables: Vars }>();

  /* ---- Proteção CSRF: escrita só da mesma origem ---- */
  v1.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && origin) {
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (!host || new URL(origin).host !== host) throw new AppError(403, "FORBIDDEN_ORIGIN", "Origem não permitida.");
    }
    await next();
  });

  /* ---- Rotina agendada (Vercel Cron): gera as contas automáticas ---- */
  v1.get("/cron/recurrences", async c => {
    if (!opts.cronSecret || c.req.header("authorization") !== `Bearer ${opts.cronSecret}`) throw new AppError(403, "FORBIDDEN", "Acesso negado.");
    const cur = todaySP().slice(0, 7), out = [];
    for (const e of ["PERSONAL", "BYTE4TECH"] as const) for (const m of [cur, addMonths(cur, 1).slice(0, 7)]) out.push({ entity: e, ...(await svc.generateRecurrences(db, e, m)) });
    await conduct.materializeMisses(db); // faltas de hábito do dia anterior
    return c.json(out);
  });

  /* ---- Login ---- */
  const cookieOpts = (c: Context) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/",
    secure: opts.secureCookies ?? (c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:")) });
  v1.post("/auth/login", async c => {
    const i = await body(c, loginInput);
    const r = await auth.login(db, i.email, i.password, c.req.header("user-agent"));
    setCookie(c, COOKIE, r.token, { ...cookieOpts(c), maxAge: auth.SESSION_DAYS * 86400 });
    return c.json(r.user);
  });
  v1.get("/auth/setup", async c => c.json({ needed: await auth.setupNeeded(db) }));
  v1.post("/auth/setup", async c => {
    const i = await body(c, z.object({ token: z.string().max(200), email: z.email().max(200), name: text(80), password: z.string().max(200) }).strict());
    const r = await auth.setupFirstAdmin(db, opts.setupToken, i, c.req.header("user-agent"));
    setCookie(c, COOKIE, r.token, { ...cookieOpts(c), maxAge: auth.SESSION_DAYS * 86400 });
    return c.json(r.user, 201);
  });
  v1.post("/auth/logout", async c => { await auth.logout(db, getCookie(c, COOKIE)); deleteCookie(c, COOKIE, { path: "/" }); return c.body(null, 204); });

  /* ---- Daqui para baixo: precisa estar logado ---- */
  v1.use("*", async (c, next) => {
    const token = getCookie(c, COOKIE);
    const user = await auth.sessionUser(db, token);
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Faça login para continuar.");
    c.set("user", user); c.set("token", token!);
    await next();
  });
  const isAdmin = (c: Context<{ Variables: Vars }>) => c.get("user").role === "ADMIN";
  const requireAdmin = (c: Context<{ Variables: Vars }>) => { if (!isAdmin(c)) throw new AppError(403, "ADMIN_ONLY", "Só o administrador pode fazer isso."); };
  /** Membro altera só o que ele mesmo lançou. */
  const requireOwner = async (c: Context<{ Variables: Vars }>, table: "title" | "settlement", id: string) => {
    if (isAdmin(c)) return;
    if ((await svc.ownerOf(db, table, id)) !== c.get("user").id) throw new AppError(403, "NOT_OWNER", "Você só pode alterar o que você lançou.");
  };

  v1.get("/auth/me", c => c.json(c.get("user")));
  v1.post("/auth/password", async c => {
    const i = await body(c, passwordInput);
    await auth.changePassword(db, c.get("user").id, i.current, i.next, c.get("token"));
    return c.body(null, 204);
  });
  v1.get("/admin/users", async c => { requireAdmin(c); return c.json(await auth.listUsers(db)); });
  v1.post("/admin/users", async c => { requireAdmin(c); return c.json(await auth.createUser(db, await body(c, userCreate), c.get("user")), 201); });
  v1.patch("/admin/users/:id", async c => { requireAdmin(c); return c.json(await auth.updateUser(db, param(c, "id"), await body(c, userPatch), c.get("user"))); });
  v1.get("/admin/status", async c => { requireAdmin(c); return c.json(await admin.status(db)); });
  v1.get("/admin/sessions", async c => { requireAdmin(c); return c.json(await admin.listSessions(db, c.get("token"))); });
  v1.delete("/admin/sessions/:id", async c => { requireAdmin(c); await admin.revokeSession(db, param(c, "id", z.string().regex(/^[0-9a-f]{64}$/)), c.get("user")); return c.body(null, 204); });
  v1.get("/admin/audit", async c => { requireAdmin(c); return c.json(await admin.audit(db, Math.min(200, Number(c.req.query("limit") ?? 50) || 50))); });

  /* ---- Entidade: Byte4Tech (PJ) só para o administrador ---- */
  v1.use("/:entity/*", async (c, next) => {
    const raw = c.req.param("entity");
    if (NO_ENTITY.has(raw)) return next();
    const e = raw.toUpperCase();
    if (e !== "PERSONAL" && e !== "BYTE4TECH") throw new AppError(404, "ENTITY_NOT_FOUND", "Entidade inválida. Use personal ou byte4tech.");
    if (e === "BYTE4TECH") requireAdmin(c);
    c.set("entity", e); await next();
  });

  const personFilter = (v: string | undefined) => {
    if (!v || v === "none") return v;
    if (!uuid.safeParse(v).success) throw new AppError(400, "INVALID_PARAM", "person inválido.");
    return v;
  };
  const asOf = (c: Context) => { const d = c.req.query("asOf"); if (d && !isoDate.safeParse(d).success) throw new AppError(400, "INVALID_PARAM", "asOf inválido."); return d ?? todaySP(); };

  // Contas a pagar / a receber
  v1.get("/:entity/titles", async c => {
    const k = c.req.query("kind"), st = c.req.query("status");
    if (k && !kind.safeParse(k).success) throw new AppError(400, "INVALID_PARAM", "kind inválido.");
    if (st && !["open", "settled", "all"].includes(st)) throw new AppError(400, "INVALID_PARAM", "status inválido.");
    return c.json(await svc.listTitles(db, c.get("entity"), { kind: k as never, status: st as never, from: c.req.query("from"), to: c.req.query("to"), personId: personFilter(c.req.query("person")) }, asOf(c)));
  });
  v1.post("/:entity/titles", async c => {
    const i = await body(c, titleCreate);
    if (i.mandatory !== undefined) requireAdmin(c);
    return c.json(await svc.createTitle(db, c.get("entity"), { ...i, createdBy: c.get("user").id }), 201);
  });
  v1.get("/:entity/titles/:id", async c => c.json(await svc.getTitle(db, c.get("entity"), param(c, "id"), asOf(c))));
  v1.patch("/:entity/titles/:id", async c => {
    const id = param(c, "id"), i = await body(c, titlePatch);
    if (i.mandatory !== undefined) requireAdmin(c); // reclassificar para o ranking é do administrador
    else await requireOwner(c, "title", id);
    return c.json(await svc.updateTitle(db, c.get("entity"), id, i));
  });
  v1.delete("/:entity/titles/:id", async c => { const id = param(c, "id"); await requireOwner(c, "title", id); await svc.deleteTitle(db, c.get("entity"), id); return c.body(null, 204); });

  // Baixas (pagar / receber). Idempotency-Key evita lançamento duplicado (duplo toque no celular).
  v1.post("/:entity/titles/:id/settlements", async c => {
    const r = await svc.createSettlement(db, c.get("entity"), param(c, "id"), { ...(await body(c, settlementCreate)), createdBy: c.get("user").id }, c.req.header("idempotency-key") || undefined);
    return c.json(r.title, r.duplicate ? 200 : 201);
  });
  v1.patch("/:entity/settlements/:id", async c => { const id = param(c, "id"); await requireOwner(c, "settlement", id); return c.json(await svc.updateSettlement(db, c.get("entity"), id, await body(c, settlementPatch))); });
  v1.delete("/:entity/settlements/:id", async c => { const id = param(c, "id"); await requireOwner(c, "settlement", id); return c.json(await svc.deleteSettlement(db, c.get("entity"), id)); });

  // Recorrências
  v1.get("/:entity/recurrences", async c => c.json(await svc.listRecurrences(db, c.get("entity"))));
  v1.post("/:entity/recurrences", async c => { requireAdmin(c); return c.json(await svc.createRecurrence(db, c.get("entity"), await body(c, recurrenceCreate)), 201); })
  v1.patch("/:entity/recurrences/:id", async c => { requireAdmin(c); return c.json(await svc.updateRecurrence(db, c.get("entity"), param(c, "id"), await body(c, recurrencePatch))); })
  v1.post("/:entity/recurrences/generate", async c => {
    requireAdmin(c);
    const m = c.req.query("month") ?? todaySP().slice(0, 7);
    if (!isoMonth.safeParse(m).success) throw new AppError(400, "INVALID_PARAM", "month inválido (AAAA-MM).");
    return c.json(await svc.generateRecurrences(db, c.get("entity"), m));
  });

  // Pessoas da casa
  v1.get("/:entity/people", async c => c.json(await svc.listPeople(db, c.get("entity"))));
  v1.post("/:entity/people", async c => { requireAdmin(c); return c.json(await svc.createPerson(db, c.get("entity"), await body(c, personCreate)), 201); })
  v1.patch("/:entity/people/:id", async c => { requireAdmin(c); return c.json(await svc.updatePerson(db, c.get("entity"), param(c, "id"), await body(c, personPatch))); })
  v1.get("/:entity/people/summary", async c => {
    const cur = todaySP().slice(0, 7), from = c.req.query("from") ?? cur, to = c.req.query("to") ?? cur;
    if (!isoMonth.safeParse(from).success || !isoMonth.safeParse(to).success || from > to) throw new AppError(400, "INVALID_PARAM", "from/to inválidos (AAAA-MM).");
    return c.json(await svc.peopleSummary(db, c.get("entity"), from, to));
  });

  // Visões
  v1.get("/:entity/dashboard", async c => c.json(await svc.dashboard(db, c.get("entity"), asOf(c))));
  v1.get("/:entity/statement", async c => {
    const cur = todaySP().slice(0, 7), from = c.req.query("from") ?? cur, to = c.req.query("to") ?? cur;
    if (!isoMonth.safeParse(from).success || !isoMonth.safeParse(to).success || from > to) throw new AppError(400, "INVALID_PARAM", "from/to inválidos (AAAA-MM).");
    return c.json(await svc.statement(db, c.get("entity"), from, to));
  });
  v1.get("/:entity/projection", async c => {
    const n = Number(c.req.query("months") ?? 12);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new AppError(400, "INVALID_PARAM", "months entre 1 e 120.");
    return c.json(await svc.projection(db, c.get("entity"), n, asOf(c)));
  });
  v1.post("/:entity/simulate", async c => c.json(await svc.runSimulation(db, c.get("entity"), await body(c, simInput))));
  v1.post("/:entity/guard/check", async c => c.json(await svc.guard(db, c.get("entity"), await body(c, guardInput))));
  v1.post("/:entity/expenses/quick", async c => {
    const i = await body(c, quickInput), u = c.get("user");
    // Sem pessoa informada, o gasto é de quem lançou.
    const personId = i.personId === undefined && c.get("entity") === "PERSONAL" ? u.personId : i.personId;
    return c.json(await svc.quickExpense(db, c.get("entity"), { ...i, personId, createdBy: u.id }), 201);
  });
  v1.get("/:entity/ranking", async c => {
    const d = c.req.query("date") ?? todaySP();
    if (!isoDate.safeParse(d).success) throw new AppError(400, "INVALID_PARAM", "date inválido (AAAA-MM-DD).");
    return c.json(await svc.ranking(db, c.get("entity"), d));
  });
  // Combinados da família (só no Pessoal)
  const personal = (c: Context<{ Variables: Vars }>) => { if (c.get("entity") !== "PERSONAL") throw new AppError(404, "NOT_FOUND", "Combinados existem só no Pessoal."); return c.get("user"); };
  v1.get("/:entity/conduct/rules", async c => { personal(c); return c.json(await conduct.listRules(db)); });
  v1.post("/:entity/conduct/rules", async c => c.json(await conduct.createRule(db, personal(c), await body(c, ruleCreate)), 201));
  v1.patch("/:entity/conduct/rules/:id", async c => c.json(await conduct.updateRule(db, personal(c), param(c, "id"), await body(c, rulePatch))));
  v1.get("/:entity/conduct/board", async c => {
    personal(c); const d = c.req.query("date") ?? todaySP();
    if (!isoDate.safeParse(d).success) throw new AppError(400, "INVALID_PARAM", "date inválido (AAAA-MM-DD).");
    return c.json(await conduct.board(db, d));
  });
  v1.post("/:entity/conduct/checks", async c => c.json(await conduct.setCheck(db, personal(c), await body(c, checkInput))));
  v1.post("/:entity/conduct/infractions", async c => c.json(await conduct.addInfraction(db, personal(c), await body(c, infractionInput)), 201));
  v1.post("/:entity/conduct/settle", async c => c.json(await conduct.settle(db, personal(c), await body(c, settleInput)), 201));
  v1.delete("/:entity/conduct/entries/:id", async c => { await conduct.deleteEntry(db, personal(c), param(c, "id")); return c.body(null, 204); });

  v1.get("/:entity/settings/mandatory-categories", async c => c.json(await svc.mandatoryCategories(db, c.get("entity"))));
  v1.put("/:entity/settings/mandatory-categories", async c => { requireAdmin(c); return c.json(await svc.setMandatoryCategories(db, c.get("entity"), (await body(c, categoriesInput)).categories)); });
  v1.get("/:entity/export.csv", async c => {
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", `attachment; filename="nofinance-${c.get("entity").toLowerCase()}.csv"`);
    return c.body(await svc.exportCsv(db, c.get("entity")));
  });
  v1.get("/:entity/warnings", async c => c.json(await svc.warningsLog(db, c.get("entity"))));
  v1.get("/:entity/audit/:id",async c => c.json(await svc.audit(db, param(c, "id"))));

  app.route("/api/v1", v1);
  return app;
}
