import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import * as auth from "./auth.js";
import * as conduct from "./conduct.js";
import * as admin from "./admin.js";
import * as accounts from "./accounts.js";
import * as push from "./push.js";
import * as statement from "./statement.js";
import * as budget from "./budget.js";
import * as requests from "./requests.js";
import type { SessionUser } from "./auth.js";
import { z } from "zod";
import { actorStore, type Db } from "./db.js";
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
  personId: personRef, mandatory: z.boolean().nullable().optional(), negativado: z.boolean().optional(),
  loan: z.object({ interestModel: model, rateBp: z.number().int().min(0).max(100000), dueDate: isoDate.nullable().optional() }).optional(),
}).strict();
const titlePatch = titleCreate.omit({ kind: true, loan: true }).partial().strict();
const settlementCreate = z.object({
  amountCents: positiveCents, paidOn: isoDate.optional(), method: z.enum(["ACCOUNT", "CARD"]).optional(),
  notes: z.string().max(500).nullable().optional(), accountId: uuid.nullable().optional(), cardAccountId: uuid.nullable().optional(),
  discountRest: z.boolean().optional(),
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
  role: z.enum(["ADMIN", "MEMBER"]).optional(), personId: personRef, isGuardian: z.boolean().optional(), conductOnly: z.boolean().optional(), password: z.string().max(200) }).strict();
const userPatch = userCreate.partial().extend({ active: z.boolean().optional() }).strict();
const ruleCreate = z.object({ kind: z.enum(["HABIT", "INFRACTION"]), name: text(80), points: z.number().int().min(0).max(1000).optional(),
  fineCents: z.number().int().min(0).max(100000000).optional(), sort: z.number().int().min(0).max(999).optional(), active: z.boolean().optional(),
  schedule: z.enum(["DAILY", "ROTATION", "SPORADIC"]).optional(), description: z.string().trim().max(200).nullable().optional(),
  assignees: z.array(z.object({ personId: uuid, position: z.number().int().min(0).max(99).optional() }).strict()).max(20).optional() }).strict();
const rulePatch = ruleCreate.omit({ kind: true }).partial().strict();
const checkInput = z.object({ personId: uuid, ruleId: uuid, day: isoDate, checked: z.boolean() }).strict();
const infractionInput = z.object({ personId: uuid, ruleId: uuid, day: isoDate.optional(), note: z.string().trim().max(200).nullable().optional() }).strict();
const sporadicInput = z.object({ ruleId: uuid, personId: uuid, day: isoDate, active: z.boolean() }).strict();
const blameInput = z.object({ ruleId: uuid, day: isoDate, fromPersonId: uuid, toPersonId: uuid, note: z.string().trim().max(200).nullable().optional() }).strict();
const planInput = z.object({ mode: z.enum(["MONEY", "STARS", "NONE"]), amountCents: cents.optional(), consequence: z.string().trim().max(120).nullable().optional(), deductFines: z.boolean().optional() }).strict();
const closeInput = z.object({ personId: uuid, month: isoMonth, deductFines: z.boolean().optional() }).strict();
const quickIncome = z.object({ amountCents: positiveCents, description: text(120), category: text(40), date: isoDate.optional(), personId: personRef, accountId: uuid.nullable().optional() }).strict();
const accountType = z.enum(["CHECKING", "SAVINGS", "INVESTMENT", "CARD", "LOAN", "CASH"]);
const day = z.number().int().min(1).max(31).nullable().optional();
const accountCreate = z.object({ type: accountType, name: text(80), institution: z.string().trim().max(80).nullable().optional(), ownerPersonId: personRef,
  openingBalanceCents: z.number().int().min(-1e11).max(1e11).optional(), creditLimitCents: cents.nullable().optional(), closingDay: day, dueDay: day,
  monthlyRateBp: z.number().int().min(0).max(100000).nullable().optional(), rateSource: z.string().trim().max(80).nullable().optional(), notes: z.string().trim().max(300).nullable().optional(), negativado: z.boolean().optional(),
  currentBill: z.object({ amountCents: cents, dueDate: isoDate }).strict().nullable().optional(),
  loan: z.object({ installmentCents: positiveCents, remaining: z.number().int().min(1).max(480), firstOpenDueDate: isoDate, totalInstallments: z.number().int().min(1).max(480).nullable().optional() }).strict().nullable().optional() }).strict();
const accountPatch = accountCreate.omit({ type: true, currentBill: true, loan: true }).partial().extend({ active: z.boolean().optional() }).strict();
const billInput = z.object({ amountCents: positiveCents, dueDate: isoDate }).strict();
const transferInput = z.object({ fromAccountId: uuid, toAccountId: uuid, amountCents: positiveCents, day: isoDate.optional(), note: z.string().trim().max(200).nullable().optional() }).strict();
const settleInput = z.object({ personId: uuid, kind: z.enum(["PAYMENT", "WAIVER"]), amountCents: positiveCents, note: z.string().trim().max(200).nullable().optional() }).strict();
const categoriesInput = z.object({ categories: z.array(text(40)).max(40) }).strict();
const guardInput = z.object({ amountCents: positiveCents, category: text(40), date: isoDate.optional() }).strict();
const quickInput = guardInput.extend({ description: text(120), method: z.enum(["ACCOUNT", "CARD"]).optional(), personId: personRef, accountId: uuid.nullable().optional(),
  cardAccountId: uuid.nullable().optional() }).strict();

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
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], frameAncestors: ["'none'"] } }));

  /** Erro interno avisa o root no celular (no máximo 1 a cada 10 min por instância; só a rota, sem dados). */
  let lastAlert = 0;
  const alertRoot = (where: string) => {
    if (Date.now() - lastAlert < 10 * 60_000) return;
    lastAlert = Date.now();
    void (async () => {
      try {
        const roots = (await db.query("SELECT id FROM app_user WHERE is_root AND active")).rows.map(r => r.id);
        await push.notify(db, roots, { title: "Erro no sistema", body: `Falha em ${where}. Veja os logs da Vercel.`, url: "/#admin", tag: "erro" });
      } catch { /* aviso de erro nunca gera outro erro */ }
    })();
  };
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    const mapped = svc.pgToAppError(err);
    if (mapped instanceof AppError) return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status);
    // Log estruturado sem dados do corpo (podem conter dados pessoais).
    console.error(JSON.stringify({ level: "error", path: c.req.path, method: c.req.method, msg: (err as Error).message }));
    alertRoot(`${c.req.method} ${c.req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id")}`);
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
    const pruned = await admin.pruneAudit(db, await admin.getRetention(db)); // retenção do registro de alterações
    const pushed = await safePush(() => dailyReminders());
    return c.json({ recurrences: out, auditPruned: pruned, pushed });
  });

  const CONDUCT_ONLY_ALLOWED: [string, RegExp][] = [
    ["GET", /^\/api\/v1\/auth\/me$/], ["POST", /^\/api\/v1\/auth\/password$/], ["POST", /^\/api\/v1\/auth\/2fa\/(setup|enable|disable)$/],
    ["GET", /^\/api\/v1\/personal\/people$/], ["GET", /^\/api\/v1\/personal\/conduct\/(board|rules|allowance)$/], ["POST", /^\/api\/v1\/personal\/conduct\/checks$/],
    ["GET", /^\/api\/v1\/personal\/requests(\/sources)?$/], ["POST", /^\/api\/v1\/personal\/requests$/], ["POST", /^\/api\/v1\/personal\/requests\/[0-9a-f-]{36}\/cancel$/],
    ["GET", /^\/api\/v1\/push\/(key|status)$/], ["POST", /^\/api\/v1\/push\/(subscribe|unsubscribe|test)$/],
  ];
  /** Aviso nunca derruba a operação: erro vira log e segue. */
  async function safePush(fn: () => Promise<number>): Promise<number> {
    try { return await fn(); } catch (e) { console.error(JSON.stringify({ level: "warn", msg: "aviso não enviado", err: (e as Error).message })); return 0; }
  }
  /** Orçamento: avisa Marcos e Thaís quando uma categoria cruza 80% ou 100% no mês (uma vez cada). */
  async function budgetAlerts(e: svc.Entity, categories: string[], day?: string) {
    await safePush(async () => {
      const hits = await budget.crossed(db, e, categories, day);
      if (!hits.length) return 0;
      const brl = (v: number) => (v / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const to = await push.guardians(db);
      let n = 0;
      for (const h of hits) n += await push.notify(db, to, { title: h.level === 100 ? `Orçamento estourado: ${h.category}` : `Orçamento em 80%: ${h.category}`,
        body: `${brl(h.spentCents)} de ${brl(h.limitCents)} no mês.`, url: "/#painel", tag: `orc-${h.category}` });
      return n;
    });
  }
  /** Lembretes da manhã para quem cuida da casa: contas de hoje/amanhã, atrasadas e fechamento do mês. */
  async function dailyReminders(): Promise<number> {
    const today = todaySP(), tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
    const open = (await svc.listTitles(db, "PERSONAL", { status: "open" }, today)).filter(t => t.kind === "PAYABLE" && t.openCents > 0);
    const sum = (l: typeof open) => (l.reduce((s, t) => s + t.openCents, 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    const due0 = open.filter(t => t.dueDate === today), due1 = open.filter(t => t.dueDate === tomorrow), late = open.filter(t => t.dueDate && t.dueDate < today);
    const lines: string[] = [];
    if (due0.length) lines.push(`Hoje: ${due0.slice(0, 3).map(t => t.counterparty).join(", ")}${due0.length > 3 ? ` +${due0.length - 3}` : ""} (${sum(due0)})`);
    if (due1.length) lines.push(`Amanhã: ${due1.length} conta(s), ${sum(due1)}`);
    if (late.length) lines.push(`Atrasadas: ${late.length} (${sum(late)})`);
    const to = await push.guardians(db);
    let n = 0;
    if (lines.length) n += await push.notify(db, to, { title: "Contas da casa", body: lines.join(" · "), url: "/#pagar", tag: "contas" });
    if (today.endsWith("-03")) n += await push.notify(db, to, { title: "O mês anterior fecha dia 5", body: "Lance até dia 4 o que faltou. Depois, só o root corrige.", url: "/#painel", tag: "fechamento" });
    return n;
  }
  /* ---- Login ---- */
  const clientIp = (c: Context) => (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "").split(",")[0]!.trim() || undefined;
  const cookieOpts = (c: Context) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/",
    secure: opts.secureCookies ?? (c.req.header("x-forwarded-proto") === "https" || c.req.url.startsWith("https:")) });
  v1.post("/auth/login", async c => {
    const i = await body(c, loginInput);
    const r = await auth.login(db, i.email, i.password, c.req.header("user-agent"), clientIp(c));
    if (r.mfaRequired) return c.json({ mfaRequired: true, challenge: r.challenge });
    setCookie(c, COOKIE, r.token, { ...cookieOpts(c), maxAge: auth.SESSION_DAYS * 86400 });
    return c.json(r.user);
  });
  v1.post("/auth/login/mfa", async c => {
    const i = await body(c, z.object({ challenge: z.string().min(20).max(100), code: z.string().min(6).max(20) }).strict());
    const r = await auth.loginMfa(db, i.challenge, i.code, clientIp(c));
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
    // Perfil "só combinados": lista fechada do que pode — o resto (finanças) é negado no servidor, não só escondido na tela.
    if (user.conductOnly && !CONDUCT_ONLY_ALLOWED.some(([m, re]) => m === c.req.method && re.test(c.req.path)))
      throw new AppError(403, "CONDUCT_ONLY", "Seu acesso é só aos combinados.");
    await actorStore.run(user.id, next); // gravações desta requisição levam o autor para o registro
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
  v1.post("/auth/2fa/setup", async c => c.json(await auth.totpSetup(db, c.get("user").id)));
  v1.post("/auth/2fa/enable", async c => c.json(await auth.totpEnable(db, c.get("user").id, (await body(c, z.object({ code: z.string().max(20) }).strict())).code)));
  v1.post("/auth/2fa/disable", async c => { await auth.totpDisable(db, c.get("user").id, (await body(c, z.object({ password: z.string().max(200) }).strict())).password); return c.body(null, 204); });
  v1.post("/admin/users/:id/reset-2fa", async c => { requireAdmin(c); await auth.adminResetTotp(db, param(c, "id"), c.get("user")); return c.body(null, 204); });
  v1.get("/push/key", async c => c.json({ publicKey: (await push.keys(db)).publicKey }));
  v1.get("/push/status", async c => c.json({ devices: await push.devices(db, c.get("user").id) }));
  v1.post("/push/subscribe", async c => {
    const i = await body(c, z.object({ endpoint: z.url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }).strict(),
      expirationTime: z.number().nullable().optional() }).strict());
    await push.subscribe(db, c.get("user").id, i, c.req.header("user-agent"));
    return c.json({ devices: await push.devices(db, c.get("user").id) }, 201);
  });
  v1.post("/push/unsubscribe", async c => { await push.unsubscribe(db, c.get("user").id, (await body(c, z.object({ endpoint: z.string().max(1000) }).strict())).endpoint); return c.body(null, 204); });
  v1.post("/push/test", async c => c.json({ sent: await push.notify(db, [c.get("user").id], { title: "MTSM Capital", body: "Avisos ligados neste aparelho. ✓", url: "/", tag: "teste" }) }));
  v1.get("/admin/users", async c => { requireAdmin(c); return c.json(await auth.listUsers(db)); });
  v1.post("/admin/users", async c => { requireAdmin(c); return c.json(await auth.createUser(db, await body(c, userCreate), c.get("user")), 201); });
  v1.patch("/admin/users/:id", async c => { requireAdmin(c); return c.json(await auth.updateUser(db, param(c, "id"), await body(c, userPatch), c.get("user"))); });
  v1.get("/admin/status", async c => { requireAdmin(c); return c.json(await admin.status(db)); });
  v1.get("/admin/sessions", async c => { requireAdmin(c); return c.json(await admin.listSessions(db, c.get("token"))); });
  v1.delete("/admin/sessions/:id", async c => { requireAdmin(c); await admin.revokeSession(db, param(c, "id", z.string().regex(/^[0-9a-f]{64}$/)), c.get("user")); return c.body(null, 204); });
  v1.get("/admin/audit", async c => {
    requireAdmin(c);
    const q = (k: string) => c.req.query(k) || undefined, iso = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const actor = q("actor");
    return c.json(await admin.audit(db, { limit: Math.min(300, Number(q("limit") ?? 50) || 50), area: q("area"), from: iso(q("from")), to: iso(q("to")),
      actor: actor === "system" || (actor && /^[0-9a-f-]{36}$/i.test(actor)) ? actor : undefined }));
  });
  v1.get("/admin/audit/retention", async c => { requireAdmin(c); return c.json({ months: await admin.getRetention(db) }); });
  v1.put("/admin/audit/retention", async c => {
    if (!c.get("user").isRoot) throw new AppError(403, "ROOT_ONLY", "Só o root muda a retenção do registro.");
    return c.json(await admin.setRetention(db, (await body(c, z.object({ months: z.number().int().min(0).max(600) }).strict())).months));
  });

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
    const i = await body(c, settlementCreate);
    const r = await svc.createSettlement(db, c.get("entity"), param(c, "id"), { ...i, createdBy: c.get("user").id }, c.req.header("idempotency-key") || undefined);
    if (!r.duplicate && r.title.kind === "PAYABLE" && r.title.nature === "EXPENSE") await budgetAlerts(c.get("entity"), [r.title.category], i.paidOn);
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
  v1.get("/:entity/dashboard", async c => {
    // Garante as contas automáticas do mês atual e do próximo mesmo se a rotina diária falhar (não duplica).
    const cur = todaySP().slice(0, 7);
    for (const m of [cur, addMonths(cur, 1).slice(0, 7)]) await svc.generateRecurrences(db, c.get("entity"), m);
    return c.json(await svc.dashboard(db, c.get("entity"), asOf(c)));
  });
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
    const r = await svc.quickExpense(db, c.get("entity"), { ...i, personId, createdBy: u.id });
    await budgetAlerts(c.get("entity"), [i.category], i.date);
    return c.json(r, 201);
  });
  v1.post("/:entity/incomes/quick", async c => {
    const i = await body(c, quickIncome), u = c.get("user");
    const personId = i.personId === undefined && c.get("entity") === "PERSONAL" ? u.personId : i.personId;
    const t = await svc.createTitle(db, c.get("entity"), { kind: "RECEIVABLE", nature: "INCOME", counterparty: i.description, category: i.category,
      amountCents: i.amountCents, dueDate: i.date ?? todaySP(), personId, createdBy: u.id });
    const r = await svc.createSettlement(db, c.get("entity"), t.id, { amountCents: i.amountCents, paidOn: i.date, createdBy: u.id, accountId: i.accountId ?? null });
    return c.json(r.title, 201);
  });
  // Bancos, cartões e empréstimos
  v1.get("/:entity/debts/summary", async c => c.json(await accounts.debtSummary(db, c.get("entity"), asOf(c))));
  v1.get("/:entity/accounts", async c => c.json(await accounts.listAccounts(db, c.get("entity"), asOf(c))));
  v1.post("/:entity/accounts", async c => c.json(await accounts.createAccount(db, c.get("entity"), c.get("user"), await body(c, accountCreate)), 201));
  v1.patch("/:entity/accounts/:id", async c => c.json(await accounts.updateAccount(db, c.get("entity"), param(c, "id"), await body(c, accountPatch))));
  v1.post("/:entity/accounts/:id/bill", async c => c.json(await accounts.addCardBill(db, c.get("entity"), c.get("user"), param(c, "id"), await body(c, billInput)), 201));
  // Extrato OFX: prévia (classifica) e gravação (o que o usuário conferiu).
  v1.post("/:entity/import/statement/preview", async c => {
    const i = await body(c, z.object({ accountId: uuid, text: z.string().min(20).max(3_000_000) }).strict());
    return c.json(await statement.previewStatement(db, c.get("entity"), i.accountId, i.text));
  });
  v1.post("/:entity/import/statement", async c => {
    const row = z.object({ fitid: z.string().min(1).max(120), date: isoDate, amountCents: z.number().int().refine(v => v !== 0), memo: z.string().trim().min(1).max(120),
      action: z.enum(["despesa", "receita", "transferencia", "ignorar"]), category: z.string().trim().max(40).optional(), personId: uuid.nullable().optional(), toAccountId: uuid.nullable().optional() }).strict();
    const i = await body(c, z.object({ accountId: uuid, rows: z.array(row).min(1).max(1500) }).strict());
    const r = await statement.commitStatement(db, c.get("entity"), c.get("user"), i.accountId, i.rows);
    const byMonth = new Map<string, string[]>();
    for (const x of i.rows) if (x.action === "despesa" && x.category) byMonth.set(x.date.slice(0, 7), [...(byMonth.get(x.date.slice(0, 7)) ?? []), x.category]);
    for (const [m, cats] of byMonth) await budgetAlerts(c.get("entity"), cats, `${m}-28`);
    return c.json(r);
  });
  // Pedidos de compra com autorização
  v1.get("/:entity/requests/sources", async c => c.json(await requests.sources(db, c.get("entity"))));
  v1.get("/:entity/requests", async c => c.json(await requests.list(db, c.get("entity"), c.get("user"))));
  v1.post("/:entity/requests", async c => {
    const i = await body(c, z.object({ description: text(120), amountCents: positiveCents, category: z.string().trim().max(40).optional(), accountId: uuid.nullable().optional(),
      forPersonId: uuid.nullable().optional() }).strict());
    const u = c.get("user"), r = await requests.create(db, c.get("entity"), u, i);
    await safePush(async () => push.notify(db, await requests.reviewersFor(db, u.id), { title: `Pedido de ${u.name}`,
      body: `${r.description} · ${(r.amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}${r.accountLabel ? ` · pelo ${r.accountLabel}` : ""}`, url: "/#pedidos", tag: "pedido" }));
    return c.json(r, 201);
  });
  v1.post("/:entity/requests/:id/review", async c => {
    const i = await body(c, z.object({ approve: z.boolean(), accountId: uuid.nullable().optional(), note: z.string().trim().max(200).nullable().optional(), date: isoDate.optional() }).strict());
    const r = await requests.review(db, c.get("entity"), c.get("user"), param(c, "id"), i);
    await safePush(async () => push.notify(db, [r.requestedBy], r.status === "APPROVED"
      ? { title: "Pedido aprovado ✓", body: `${r.description}${r.paidAccountLabel ? ` · pelo ${r.paidAccountLabel}` : ""}${r.reviewNote ? ` — ${r.reviewNote}` : ""}`, url: "/#pedidos", tag: "pedido" }
      : { title: "Pedido não aprovado", body: `${r.description} — ${r.reviewNote}`, url: "/#pedidos", tag: "pedido" }));
    return c.json(r);
  });
  v1.post("/:entity/requests/:id/cancel", async c => c.json(await requests.cancel(db, c.get("entity"), c.get("user"), param(c, "id"))));
  // Orçamento por categoria (Marcos e Thaís definem; todos veem)
  v1.get("/:entity/budget", async c => c.json(await budget.list(db, c.get("entity"), asOf(c))));
  v1.put("/:entity/budget/:category", async c => {
    const u = c.get("user");
    if (u.role !== "ADMIN" && !u.isGuardian) throw new AppError(403, "GUARDIAN_ONLY", "Só os responsáveis definem o orçamento.");
    const cat = param(c, "category", z.string().max(40)).toUpperCase();
    if (!/^[A-Z_]{2,40}$/.test(cat)) throw new AppError(400, "INVALID_PARAM", "Categoria inválida.");
    return c.json(await budget.setLimit(db, c.get("entity"), cat, (await body(c, z.object({ limitCents: cents.nullable() }).strict())).limitCents));
  });
  v1.post("/:entity/import/accounts", async c => {
    requireAdmin(c);
    const i = await body(c, z.object({ version: z.literal(1), items: z.array(z.record(z.string(), z.unknown())).min(1).max(200) }).strict());
    return c.json(await accounts.importAccounts(db, c.get("entity"), c.get("user"), i.items as unknown as accounts.ImportItem[], c.req.query("dryRun") === "1",
      x => accountCreate.parse(x) as accounts.AccountInput, x => recurrenceCreate.parse(x) as svc.RecurrenceInput));
  });
  v1.get("/:entity/transfers", async c => c.json(await accounts.listTransfers(db, c.get("entity"), Math.min(200, Number(c.req.query("limit") ?? 50) || 50))));
  v1.patch("/:entity/transfers/:id", async c => c.json(await accounts.updateTransfer(db, c.get("entity"), c.get("user"), param(c, "id"), await body(c, transferInput.partial().strict()))));
  v1.delete("/:entity/transfers/:id", async c => { await accounts.deleteTransfer(db, c.get("entity"), c.get("user"), param(c, "id")); return c.body(null, 204); });
  v1.post("/:entity/transfers", async c => c.json(await accounts.createTransfer(db, c.get("entity"), c.get("user"), await body(c, transferInput)), 201));
  v1.get("/:entity/overview", async c => c.json(await accounts.overview(db, c.get("entity"), asOf(c))));
  v1.get("/:entity/payoff-order", async c => {
    const p = c.req.query("person");
    if (p && p !== "none" && !uuid.safeParse(p).success) throw new AppError(400, "INVALID_PARAM", "person inválido.");
    const st = c.req.query("strategy") ?? "juros";
    if (!["juros", "rapidas", "nome"].includes(st)) throw new AppError(400, "INVALID_PARAM", "strategy: juros, rapidas ou nome.");
    return c.json(await accounts.payoffOrder(db, c.get("entity"), p === undefined ? undefined : p === "none" ? null : p, asOf(c), st as accounts.Strategy));
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
  v1.get("/:entity/conduct/pending", async c => { personal(c); return c.json(await conduct.pendingChecks(db)); });
  v1.post("/:entity/conduct/checks/review", async c => {
    const i = await body(c, checkInput.omit({ checked: true }).extend({ approve: z.boolean() }).strict());
    const r = await conduct.reviewCheck(db, personal(c), i);
    await safePush(async () => {
      const task = (await db.query("SELECT name FROM conduct_rule WHERE id = $1", [i.ruleId])).rows[0]?.name ?? "Tarefa";
      return push.notify(db, await push.userOfPerson(db, i.personId), i.approve
        ? { title: "Tarefa aprovada ✓", body: `${task} já conta na sua nota.`, url: "/#combinados", tag: "revisao" }
        : { title: "Tarefa não aprovada", body: `${task} não foi aprovada. Fale com um responsável.`, url: "/#combinados", tag: "revisao" });
    });
    return c.json(r);
  });
  v1.post("/:entity/conduct/checks", async c => {
    const i = await body(c, checkInput);
    const r = await conduct.setCheck(db, personal(c), i);
    if ("pending" in r && r.pending) await safePush(async () => {
      const n = (await db.query("SELECT p.name AS who, r.name AS task FROM person p, conduct_rule r WHERE p.id = $1 AND r.id = $2", [i.personId, i.ruleId])).rows[0];
      return push.notify(db, await push.guardians(db), { title: `${n?.who ?? "Alguém"} marcou uma tarefa`, body: `${n?.task ?? "Tarefa"} — toque para aprovar.`, url: "/#painel", tag: "aprovar" });
    });
    return c.json(r);
  });
  v1.post("/:entity/conduct/infractions", async c => c.json(await conduct.addInfraction(db, personal(c), await body(c, infractionInput)), 201));
  v1.post("/:entity/conduct/settle", async c => c.json(await conduct.settle(db, personal(c), await body(c, settleInput)), 201));
  v1.post("/:entity/conduct/sporadic", async c => c.json(await conduct.setSporadic(db, personal(c), await body(c, sporadicInput))));
  v1.post("/:entity/conduct/blame", async c => c.json(await conduct.blame(db, personal(c), await body(c, blameInput)), 201));
  v1.post("/:entity/conduct/template", async c => c.json(await conduct.applyFamilyTemplate(db, personal(c)), 201));
  v1.get("/:entity/conduct/allowance", async c => {
    personal(c); const m = c.req.query("month") ?? todaySP().slice(0, 7);
    if (!isoMonth.safeParse(m).success) throw new AppError(400, "INVALID_PARAM", "month inválido (AAAA-MM).");
    const r = await conduct.allowance(db, m);
    // "Só combinados" vê só a própria mesada (a dos outros adultos é finança da casa).
    const u = c.get("user");
    return c.json(u.conductOnly ? { ...r, people: r.people.filter((x: { personId: string }) => x.personId === u.personId) } : r);
  });
  v1.put("/:entity/conduct/allowance/plan/:personId", async c => c.json(await conduct.setPlan(db, personal(c), param(c, "personId"), await body(c, planInput))));
  v1.post("/:entity/conduct/allowance/close", async c => c.json(await conduct.closeMonth(db, personal(c), await body(c, closeInput)), 201));
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
