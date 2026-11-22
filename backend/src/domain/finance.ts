/**
 * Domínio financeiro: puro, sem banco e sem framework. 100% testável.
 * Dinheiro: inteiros em centavos. Taxa: pontos-base (1500 = 15%).
 * Arredondamento: HALF_UP (padrão comercial no Brasil), aplicado uma única vez por operação de juros.
 */

export type Kind = "PAYABLE" | "RECEIVABLE";
export type Nature = "EXPENSE" | "DEBT" | "CARD" | "INCOME" | "LOAN_IN";
export type InterestModel = "NONE" | "FIXED_ONCE" | "MONTHLY_SIMPLE" | "MONTHLY_COMPOUND";

export interface Title {
  id: string;
  kind: Kind;
  nature: Nature;
  counterparty: string;
  category: string;
  amountCents: number;
  interestModel: InterestModel;
  rateBp: number;
  dueDate: string | null;   // YYYY-MM-DD
  startDate: string;        // YYYY-MM-DD
}
export interface Settlement { titleId: string; amountCents: number; paidOn: string; }

/** cents * bp / 10000 com HALF_UP, sem float acumulado. */
export function pctOf(cents: number, bp: number): number {
  const num = cents * bp;
  if (!Number.isSafeInteger(num)) throw new RangeError("valor fora do intervalo seguro");
  const q = Math.trunc(num / 10000), r = num % 10000;
  return Math.abs(r) * 2 >= 10000 ? q + Math.sign(num) : q;
}

/** Meses cheios entre duas datas ISO (sem pro-rata, ADR 0003). */
export function fullMonthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = to.split("-").map(Number) as [number, number, number];
  let m = (y2 - y1) * 12 + (m2 - m1);
  if (d2 < d1) m--;
  return Math.max(0, m);
}

export function interestCents(t: Pick<Title, "nature" | "amountCents" | "interestModel" | "rateBp" | "startDate">, asOf: string): number {
  if (t.nature !== "DEBT" || t.interestModel === "NONE" || t.rateBp === 0) return 0;
  if (t.interestModel === "FIXED_ONCE") return pctOf(t.amountCents, t.rateBp);
  const n = fullMonthsBetween(t.startDate, asOf);
  if (t.interestModel === "MONTHLY_SIMPLE") return pctOf(t.amountCents, t.rateBp * n);
  let b = t.amountCents;
  for (let i = 0; i < n; i++) b += pctOf(b, t.rateBp);
  return b - t.amountCents;
}

export interface TitleView extends Title {
  interestCents: number;
  totalCents: number;
  settledCents: number;
  openCents: number;
  status: "OPEN" | "OVERDUE" | "SETTLED" | "NO_VALUE";
}

export function viewTitle(t: Title, settledCents: number, asOf: string): TitleView {
  const interest = interestCents(t, asOf);
  const total = t.amountCents + interest;
  const open = total - settledCents;
  const status: TitleView["status"] =
    t.amountCents === 0 && settledCents === 0 ? "NO_VALUE"
    : open <= 0 ? "SETTLED"
    : t.dueDate && t.dueDate < asOf ? "OVERDUE" : "OPEN";
  return { ...t, interestCents: interest, totalCents: total, settledCents, openCents: open, status };
}

/**
 * Classificação do realizado (regime de caixa).
 * - Receita: baixa de INCOME.          - Empréstimo recebido (LOAN_IN): entra no caixa, NÃO é receita.
 * - Despesa: baixa de EXPENSE/CARD.    - Dívida: pagamento quita juros primeiro (juros = despesa), o resto é amortização.
 */
export interface Realized { incomeCents: number; expenseCents: number; interestPaidCents: number; amortizationCents: number; loansInCents: number; cashInCents: number; cashOutCents: number; }
export function emptyRealized(): Realized { return { incomeCents: 0, expenseCents: 0, interestPaidCents: 0, amortizationCents: 0, loansInCents: 0, cashInCents: 0, cashOutCents: 0 }; }

/** Classifica uma baixa, dado quanto já foi pago antes dela no mesmo título. */
/**
 * opts.viaCard: compra paga no cartão — é despesa na data da compra, mas o dinheiro só sai quando a fatura for paga.
 * opts.alreadyExpensedCents: parte do pagamento de uma fatura que já entrou como despesa (compras lançadas uma a uma).
 */
export function classifySettlement(t: TitleView, amount: number, paidBefore: number, acc: Realized, opts: { viaCard?: boolean; alreadyExpensedCents?: number } = {}): Realized {
  if (t.kind === "RECEIVABLE") {
    acc.cashInCents += amount;
    if (t.nature === "LOAN_IN") acc.loansInCents += amount; else acc.incomeCents += amount;
    return acc;
  }
  if (!opts.viaCard) acc.cashOutCents += amount;
  if (t.nature === "DEBT") {
    const interestLeft = Math.max(0, t.interestCents - paidBefore);
    const toInterest = Math.min(amount, interestLeft);
    acc.interestPaidCents += toInterest;
    acc.expenseCents += toInterest;
    acc.amortizationCents += amount - toInterest;
  } else {
    acc.expenseCents += amount - Math.min(amount, opts.alreadyExpensedCents ?? 0);
  }
  return acc;
}

/* ---------- Guardião ---------- */
export interface GuardInput { amountCents: number; category: "FIXED" | "DISCRETIONARY"; date: string; lockUntil: string | null; fixedCeilingCents: number | null; fixedSpentInMonthCents: number; }
export interface GuardResult { allowed: boolean; rule: string; message: string; }
export function guardCheck(i: GuardInput): GuardResult {
  if (!(i.amountCents > 0)) return { allowed: false, rule: "INVALID", message: "Valor deve ser maior que zero." };
  if (i.category === "DISCRETIONARY" && i.lockUntil && i.date <= i.lockUntil)
    return { allowed: false, rule: "LOCK_PERIOD", message: `Gasto discricionário bloqueado até ${i.lockUntil}.` };
  if (i.category === "FIXED" && i.fixedCeilingCents != null && i.fixedSpentInMonthCents + i.amountCents > i.fixedCeilingCents)
    return { allowed: false, rule: "FIXED_CEILING", message: `Estoura o teto de fixos em ${i.fixedSpentInMonthCents + i.amountCents - i.fixedCeilingCents} centavos.` };
  return { allowed: true, rule: "OK", message: "Dentro do escopo." };
}

/* ---------- Simulador ---------- */
export interface SimDebt { name: string; balanceCents: number; rateBp: number; }
export interface SimInput { debts: SimDebt[]; monthlyIncomeCents: number; monthlyFixedCents: number; extraCents: number; initialCashCents: number; rolloverMonthly: boolean; maxMonths?: number; }
export interface SimResult { strategy: "AVALANCHE" | "SNOWBALL"; feasible: boolean; months: number | null; extraInterestCents: number; payoffOrder: string[]; }

export function simulate(strategy: SimResult["strategy"], input: SimInput): SimResult {
  const max = input.maxMonths ?? 120;
  const ds = input.debts.filter(d => d.balanceCents > 0).map(d => ({ ...d }));
  const budget = input.monthlyIncomeCents - input.monthlyFixedCents + input.extraCents;
  let pool = input.initialCashCents, month = 0, extra = 0;
  const order: string[] = [];
  const cmp = strategy === "AVALANCHE"
    ? (a: SimDebt, b: SimDebt) => b.rateBp - a.rateBp || a.balanceCents - b.balanceCents
    : (a: SimDebt, b: SimDebt) => a.balanceCents - b.balanceCents || b.rateBp - a.rateBp;
  while (ds.some(d => d.balanceCents > 0)) {
    if (month > max || (month > 0 && budget <= 0 && pool <= 0)) return { strategy, feasible: false, months: null, extraInterestCents: extra, payoffOrder: order };
    if (month > 0) pool += budget;
    for (const d of ds.filter(x => x.balanceCents > 0).sort(cmp)) {
      const p = Math.min(pool, d.balanceCents);
      d.balanceCents -= p; pool -= p;
      if (d.balanceCents === 0) order.push(d.name);
    }
    if (input.rolloverMonthly) for (const d of ds) if (d.balanceCents > 0 && d.rateBp > 0) { const j = pctOf(d.balanceCents, d.rateBp); d.balanceCents += j; extra += j; }
    month++;
  }
  return { strategy, feasible: true, months: month, extraInterestCents: extra, payoffOrder: order };
}

/* ---------- Datas ---------- */
export function todaySP(): string { return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); }
export function monthStart(isoMonth: string): string { return `${isoMonth.slice(0, 7)}-01`; }
export function addMonths(isoMonth: string, n: number): string {
  const [y, m] = isoMonth.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
/** Dia de vencimento ajustado ao fim do mês (31 em fevereiro vira 28/29). */
export function dueDateFor(month: string, day: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
