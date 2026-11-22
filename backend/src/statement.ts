/**
 * Importar extrato (OFX — o arquivo que quase todo banco exporta).
 * Fluxo: prévia (classifica cada movimentação) → o usuário confere/ajusta → grava.
 * Nunca duplica: cada movimentação tem um identificador do banco (FITID) guardado por conta.
 */
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { SessionUser } from "./auth.js";
import { AppError, createTitle, createSettlement, quickExpense, type Entity } from "./service.js";
import { createTransfer } from "./accounts.js";

export interface OfxTxn { fitid: string; date: string; amountCents: number; memo: string; }

/** Lê OFX 1.x (SGML, sem fechar tags) e 2.x (XML). */
export function parseOfx(text: string): { txns: OfxTxn[]; isCard: boolean } {
  const isCard = /<CCSTMTRS>/i.test(text);
  const blocks = text.split(/<STMTTRN>/i).slice(1).map(b => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]!);
  const tag = (b: string, t: string) => (b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, "i"))?.[1] ?? "").trim();
  const txns: OfxTxn[] = [];
  blocks.forEach((b, idx) => {
    const d = tag(b, "DTPOSTED").replace(/\D/g, "").slice(0, 8);
    const rawAmt = tag(b, "TRNAMT").replace(/\s/g, "");
    // Alguns bancos usam vírgula decimal; milhar com ponto é raro em OFX, mas tratamos "1.234,56".
    const norm = rawAmt.includes(",") ? rawAmt.replace(/\./g, "").replace(",", ".") : rawAmt;
    const amount = Math.round(Number(norm) * 100);
    if (d.length !== 8 || !Number.isFinite(amount) || amount === 0) return;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const memo = [tag(b, "NAME"), tag(b, "MEMO")].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ").replace(/\s+/g, " ").slice(0, 120) || "Sem descrição";
    const fitid = tag(b, "FITID") || createHash("sha256").update(`${date}|${amount}|${memo}|${idx}`).digest("hex").slice(0, 32);
    txns.push({ fitid: fitid.slice(0, 120), date, amountCents: amount, memo });
  });
  return { txns, isCard };
}

const KEYWORDS: [RegExp, string][] = [
  [/IFOOD|RAPPI|ZE DELIVERY|AIQFOME/i, "DELIVERY"],
  [/RESTAUR|LANCHON|BURGER|PIZZ|OUTBACK|MC ?DONALD|BOB'?S|SUBWAY|CHURRAS/i, "RESTAURANTE"],
  [/SUPERMERC|MERCADO|ATACAD|ASSAI|CARREFOUR|EXTRA |PAO DE ACUCAR|PADARIA|HORTIFRUTI|ACOUGUE|SACOLAO/i, "ALIMENTACAO"],
  [/UBER|99 ?APP|99POP|CABIFY|POSTO|COMBUST|SHELL|IPIRANGA|PETROBRAS|ESTACION|PEDAGIO|SEM PARAR|CONECTCAR|METRO|ONIBUS/i, "TRANSPORTE"],
  [/FARMA|DROGA|DROGASIL|RAIA|PAGUE MENOS|PANVEL|HOSPITAL|CLINICA|LABORAT|ODONTO|UNIMED|HAPVIDA/i, "SAUDE"],
  [/NETFLIX|SPOTIFY|DISNEY|PRIME VIDEO|AMAZON PRIME|HBO|MAX\b|GLOBOPLAY|YOUTUBE|APPLE\.COM|GOOGLE ?\*|ICLOUD|DEEZER|PARAMOUNT/i, "ASSINATURAS"],
  [/ENEL|LIGHT S|CEMIG|COPEL|CELESC|COELBA|ENERGISA|EQUATORIAL|NEOENERGIA|CPFL/i, "LUZ"],
  [/SABESP|CEDAE|COPASA|SANEPAR|EMBASA|COMPESA|CAGECE|SANEAGO|AGUAS DE/i, "AGUA"],
  [/VIVO|CLARO|TIM |\bOI\b|NET SERV|ALGAR|BRISANET|INTERNET|FIBRA/i, "INTERNET"],
  [/ESCOLA|COLEGIO|FACULD|CURSO|UDEMY|ALURA|LIVRARIA|PAPELARIA/i, "EDUCACAO"],
  [/RENNER|RIACHUELO|C&A|CEA |ZARA|SHEIN|HERING|MARISA|CENTAURO|NETSHOES|CALCAD/i, "ROUPAS"],
  [/BOTICARIO|NATURA|EUDORA|AVON|SALAO|BARBEAR|COSMET|SEPHORA|BELEZA/i, "BELEZA"],
  [/CINEMA|INGRESSO|SHOW|BAR |CERVEJ|STEAM|PLAYSTATION|XBOX|NINTENDO/i, "LAZER"],
  [/ALUGUEL|CONDOMIN|IPTU/i, "MORADIA"],
];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const memoKey = (s: string) => norm(s).replace(/\d+/g, "").replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const TRANSFER_HINT = /\bPIX\b|TRANSF|\bTED\b|\bDOC\b/i;

export interface PreviewRow extends OfxTxn {
  status: "novo" | "ja_importado" | "ja_lancado";
  action: "despesa" | "receita" | "transferencia" | "ignorar";
  category: string; personId: string | null; toAccountId: string | null; hint: string;
}

async function loadAccount(db: Db, e: Entity, accountId: string) {
  const a = (await db.query("SELECT id, type, owner_person_id, name FROM account WHERE id = $1 AND entity_code = $2 AND active", [accountId, e])).rows[0];
  if (!a) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Conta não encontrada.");
  if (a.type === "LOAN") throw new AppError(422, "INVALID_ACCOUNT", "Extrato se importa em conta, poupança, investimento ou cartão.");
  return a as { id: string; type: string; owner_person_id: string | null; name: string };
}

export async function previewStatement(db: Db, e: Entity, accountId: string, text: string): Promise<{ isCard: boolean; rows: PreviewRow[] }> {
  const acc = await loadAccount(db, e, accountId);
  const { txns, isCard } = parseOfx(text);
  if (!txns.length) throw new AppError(422, "EMPTY_STATEMENT", "Não achei movimentações no arquivo. Confira se é OFX (no app do banco: exportar extrato → OFX/Money).");
  if (txns.length > 1500) throw new AppError(422, "TOO_BIG", "Arquivo grande demais. Exporte um mês por vez.");
  const card = acc.type === "CARD";
  const imported = new Set((await db.query("SELECT fitid FROM bank_txn WHERE account_id = $1 AND fitid = ANY($2)", [accountId, txns.map(t => t.fitid)])).rows.map(r => r.fitid));
  const from = txns.reduce((m, t) => (t.date < m ? t.date : m), "9999"), to = txns.reduce((m, t) => (t.date > m ? t.date : m), "0000");
  // Já lançado à mão: mesmo valor na mesma conta (ou cartão), até 3 dias de diferença. Cada lançamento casa uma vez só.
  const manual = card
    ? (await db.query(`SELECT s.id, s.amount_cents AS v, s.paid_on::text AS d, -1 AS sign FROM settlement s JOIN title t ON t.id = s.title_id JOIN title b ON b.id = t.card_bill_id
        WHERE b.account_id = $1 AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.paid_on BETWEEN $2::date - 3 AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.title_id = t.id)`, [accountId, from, to])).rows
    : (await db.query(`SELECT s.id, s.amount_cents AS v, s.paid_on::text AS d, CASE WHEN t.kind = 'RECEIVABLE' THEN 1 ELSE -1 END AS sign FROM settlement s JOIN title t ON t.id = s.title_id
        WHERE s.account_id = $1 AND s.deleted_at IS NULL AND t.deleted_at IS NULL AND s.paid_on BETWEEN $2::date - 3 AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.title_id = t.id)
        UNION ALL
        SELECT x.id, x.amount_cents, x.day::text, CASE WHEN x.to_account_id = $1 THEN 1 ELSE -1 END FROM transfer x
        WHERE (x.from_account_id = $1 OR x.to_account_id = $1) AND x.deleted_at IS NULL AND x.day BETWEEN $2::date - 3 AND $3::date + 3
        AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.transfer_id = x.id)`, [accountId, from, to])).rows;
  const used = new Set<string>();
  const learned = new Map((await db.query(`SELECT DISTINCT ON (memo_key) memo_key, category, person_id FROM bank_txn
    WHERE memo_key IS NOT NULL AND category IS NOT NULL ORDER BY memo_key, created_at DESC`)).rows.map(r => [r.memo_key, r]));
  const people = (await db.query("SELECT id, name FROM person WHERE entity_code = $1 AND active", [e])).rows as { id: string; name: string }[];
  const cashOf = (await db.query(`SELECT id, owner_person_id FROM account WHERE entity_code = $1 AND active AND id <> $2 AND type IN ('CHECKING','SAVINGS','INVESTMENT','CASH')
    ORDER BY type = 'CHECKING' DESC, created_at`, [e, accountId])).rows as { id: string; owner_person_id: string | null }[];
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

  const rows = txns.map((t): PreviewRow => {
    const base = { ...t, personId: acc.owner_person_id, toAccountId: null as string | null, category: "OUTROS", hint: "" };
    if (imported.has(t.fitid)) return { ...base, status: "ja_importado", action: "ignorar", hint: "já importado antes" };
    const sign = t.amountCents < 0 ? -1 : 1, abs = Math.abs(t.amountCents);
    const m = manual.find(x => !used.has(x.id) && Number(x.v) === abs && Number(x.sign) === sign && days(x.d, t.date) <= 3);
    if (m) { used.add(m.id); return { ...base, status: "ja_lancado", action: "ignorar", hint: `já lançado em ${m.d.split("-").reverse().join("/")}` }; }
    // Cartão: crédito na fatura é o pagamento dela (lançado pela conta que pagou) ou estorno.
    if (card && sign > 0) return { ...base, status: "novo", action: "ignorar", hint: "pagamento da fatura ou estorno" };
    const key = memoKey(t.memo), l = learned.get(key);
    const kw = KEYWORDS.find(([re]) => re.test(norm(t.memo)))?.[1];
    // Pix/transferência com o nome de alguém da casa → transferência entre contas de vocês.
    const person = TRANSFER_HINT.test(t.memo) ? people.find(p => p.id !== acc.owner_person_id && norm(t.memo).includes(norm(p.name.split(" ")[0]!))) : undefined;
    if (person && !card) {
      const other = cashOf.find(a => a.owner_person_id === person.id);
      if (other) return { ...base, status: "novo", action: "transferencia", toAccountId: other.id, hint: `transferência com ${person.name}` };
    }
    if (sign > 0) return { ...base, status: "novo", action: "receita", category: l?.category ?? "RENDA", hint: l ? "como da última vez" : "" };
    return { ...base, status: "novo", action: "despesa", category: l?.category ?? kw ?? "OUTROS", personId: l?.person_id ?? acc.owner_person_id,
      hint: l ? "como da última vez" : kw ? "pela descrição" : "" };
  });
  return { isCard, rows };
}

export interface CommitRow { fitid: string; date: string; amountCents: number; memo: string; action: PreviewRow["action"]; category?: string; personId?: string | null; toAccountId?: string | null; }

export async function commitStatement(db: Db, e: Entity, u: SessionUser, accountId: string, rows: CommitRow[]) {
  const acc = await loadAccount(db, e, accountId);
  const card = acc.type === "CARD";
  const done = new Set((await db.query("SELECT fitid FROM bank_txn WHERE account_id = $1 AND fitid = ANY($2)", [accountId, rows.map(r => r.fitid)])).rows.map(r => r.fitid));
  const out = { despesas: 0, receitas: 0, transferencias: 0, ignorados: 0, jaImportados: 0, erros: [] as { memo: string; erro: string }[] };
  for (const r of rows) {
    if (done.has(r.fitid)) { out.jaImportados++; continue; }
    const abs = Math.abs(r.amountCents);
    try {
      let titleId: string | null = null, transferId: string | null = null;
      if (r.action === "despesa") {
        const t = await quickExpense(db, e, { amountCents: abs, category: r.category || "OUTROS", description: r.memo, date: r.date, personId: r.personId ?? acc.owner_person_id,
          createdBy: u.id, ...(card ? { cardAccountId: accountId } : { accountId }) });
        titleId = t.title.id; out.despesas++;
      } else if (r.action === "receita") {
        const t = await createTitle(db, e, { kind: "RECEIVABLE", nature: "INCOME", counterparty: r.memo, category: r.category || "RENDA", amountCents: abs, dueDate: r.date,
          personId: r.personId ?? acc.owner_person_id, createdBy: u.id });
        await createSettlement(db, e, t.id, { amountCents: abs, paidOn: r.date, createdBy: u.id, accountId });
        titleId = t.id; out.receitas++;
      } else if (r.action === "transferencia") {
        if (!r.toAccountId) throw new AppError(422, "NO_TARGET", "Escolha a conta de destino.");
        const [fromId, toId] = r.amountCents < 0 ? [accountId, r.toAccountId] : [r.toAccountId, accountId];
        transferId = (await createTransfer(db, e, u, { fromAccountId: fromId, toAccountId: toId, amountCents: abs, day: r.date, note: r.memo })).id; out.transferencias++;
      } else out.ignorados++;
      await db.query(`INSERT INTO bank_txn (account_id, fitid, posted_on, amount_cents, memo, memo_key, action, category, person_id, title_id, transfer_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (account_id, fitid) DO NOTHING`,
        [accountId, r.fitid, r.date, r.amountCents, r.memo, memoKey(r.memo) || null, r.action, r.action === "despesa" || r.action === "receita" ? r.category || null : null,
         r.personId ?? null, titleId, transferId, u.id]);
    } catch (err) {
      out.erros.push({ memo: `${r.date.split("-").reverse().join("/")} ${r.memo}`, erro: err instanceof AppError ? err.message : (err as Error).message });
    }
  }
  return out;
}
