import { describe, it, expect } from "vitest";
import { pctOf, interestCents, fullMonthsBetween, viewTitle, classifySettlement, emptyRealized, guardCheck, simulate, dueDateFor, addMonths, type Title } from "../src/domain/finance.js";

const debt = (amount: number, model: Title["interestModel"] = "NONE", rateBp = 0, start = "2026-11-04"): Title => ({
  id: "x", kind: "PAYABLE", nature: "DEBT", counterparty: "c", category: "DIVIDA", amountCents: amount,
  interestModel: model, rateBp, dueDate: "2026-12-04", startDate: start,
});

describe("dinheiro e arredondamento", () => {
  it("HALF_UP em centavos", () => {
    expect(pctOf(300000, 1500)).toBe(45000);
    expect(pctOf(1, 5000)).toBe(1);      // 0,5 centavo -> 1
    expect(pctOf(1, 4999)).toBe(0);
    expect(pctOf(333, 1500)).toBe(50);   // 49,95 -> 50
  });
  it("recusa valores fora da faixa segura", () => expect(() => pctOf(Number.MAX_SAFE_INTEGER, 10000)).toThrow());
});

describe("aceite: fixture de 21/11/2026", () => {
  it("8 dívidas somam R$ 16.700 + R$ 1.200 = R$ 17.900,00 exatos", () => {
    const ds = [debt(100000), debt(50000), debt(300000, "FIXED_ONCE", 1500), debt(400000), debt(500000, "FIXED_ONCE", 1500), debt(20000), debt(100000), debt(200000)];
    const v = ds.map(d => viewTitle(d, 0, "2026-11-21"));
    expect(v.reduce((s, x) => s + x.amountCents, 0)).toBe(1670000);
    expect(v.reduce((s, x) => s + x.interestCents, 0)).toBe(120000);
    expect(v.reduce((s, x) => s + x.totalCents, 0)).toBe(1790000);
  });
});

describe("modelos de juros", () => {
  it("fixo uma vez não cresce com o tempo", () => expect(interestCents(debt(500000, "FIXED_ONCE", 1500), "2027-06-01")).toBe(75000));
  it("mensal simples por mês cheio", () => expect(interestCents(debt(100000, "MONTHLY_SIMPLE", 1000, "2026-01-15"), "2026-04-15")).toBe(30000));
  it("mensal composto", () => expect(interestCents(debt(100000, "MONTHLY_COMPOUND", 1000, "2026-01-15"), "2026-03-15")).toBe(21000));
  it("mês incompleto não conta (sem pro-rata)", () => expect(fullMonthsBetween("2026-01-31", "2026-02-28")).toBe(0));
  it("ano bissexto", () => expect(fullMonthsBetween("2028-01-29", "2028-02-29")).toBe(1));
  it("juros só em dívida", () => expect(interestCents({ ...debt(100000, "FIXED_ONCE", 1500), nature: "EXPENSE" }, "2026-12-01")).toBe(0));
});

describe("saldo e status", () => {
  it("parcial, quitado e vencido", () => {
    expect(viewTitle(debt(300000, "FIXED_ONCE", 1500), 100000, "2026-11-21")).toMatchObject({ openCents: 245000, status: "OPEN" });
    expect(viewTitle(debt(300000, "FIXED_ONCE", 1500), 345000, "2026-11-21").status).toBe("SETTLED");
    expect(viewTitle(debt(100000), 0, "2026-12-05").status).toBe("OVERDUE");
    expect(viewTitle({ ...debt(0), nature: "EXPENSE" }, 0, "2026-11-21").status).toBe("NO_VALUE");
  });
});

describe("classificação do realizado", () => {
  it("dívida: juros primeiro = despesa; resto = amortização", () => {
    const t = viewTitle(debt(300000, "FIXED_ONCE", 1500), 0, "2026-11-21");
    const r = classifySettlement(t, 100000, 0, emptyRealized());
    expect(r).toMatchObject({ expenseCents: 45000, interestPaidCents: 45000, amortizationCents: 55000, cashOutCents: 100000 });
    classifySettlement(t, 245000, 100000, r);
    expect(r.interestPaidCents).toBe(45000);
    expect(r.amortizationCents).toBe(300000);
  });
  it("empréstimo recebido não é receita", () => {
    const t = viewTitle({ ...debt(800000), kind: "RECEIVABLE", nature: "LOAN_IN" }, 0, "2026-11-21");
    expect(classifySettlement(t, 800000, 0, emptyRealized())).toMatchObject({ incomeCents: 0, loansInCents: 800000, cashInCents: 800000 });
  });
});

describe("guardião", () => {
  const base = { lockUntil: "2026-12-04", fixedCeilingCents: 325000, fixedSpentInMonthCents: 300000 };
  it("bloqueia discricionário até a data", () => expect(guardCheck({ ...base, amountCents: 5000, category: "DISCRETIONARY", date: "2026-12-04" }).allowed).toBe(false));
  it("libera discricionário depois", () => expect(guardCheck({ ...base, amountCents: 5000, category: "DISCRETIONARY", date: "2026-12-05" }).allowed).toBe(true));
  it("teto de fixos", () => {
    expect(guardCheck({ ...base, amountCents: 25000, category: "FIXED", date: "2026-11-25" }).allowed).toBe(true);
    expect(guardCheck({ ...base, amountCents: 25001, category: "FIXED", date: "2026-11-25" }).rule).toBe("FIXED_CEILING");
  });
});

describe("simulador", () => {
  const debts = [{ name: "A", balanceCents: 575000, rateBp: 1500 }, { name: "B", balanceCents: 20000, rateBp: 0 }];
  it("avalanche paga juros primeiro; bola de neve, menor saldo", () => {
    const i = { debts, monthlyIncomeCents: 300000, monthlyFixedCents: 0, extraCents: 0, initialCashCents: 0, rolloverMonthly: false };
    expect(simulate("AVALANCHE", i).payoffOrder[0]).toBe("A");
    expect(simulate("SNOWBALL", i).payoffOrder[0]).toBe("B");
  });
  it("inviável quando a sobra é <= 0", () => {
    expect(simulate("AVALANCHE", { debts, monthlyIncomeCents: 100, monthlyFixedCents: 200, extraCents: 0, initialCashCents: 0, rolloverMonthly: true }).feasible).toBe(false);
  });
  it("avalanche nunca paga mais juros que bola de neve", () => {
    const i = { debts, monthlyIncomeCents: 200000, monthlyFixedCents: 0, extraCents: 0, initialCashCents: 0, rolloverMonthly: true };
    expect(simulate("AVALANCHE", i).extraInterestCents).toBeLessThanOrEqual(simulate("SNOWBALL", i).extraInterestCents);
  });
});

describe("datas", () => {
  it("vencimento dia 31 em fevereiro vira último dia", () => {
    expect(dueDateFor("2027-02", 31)).toBe("2027-02-28");
    expect(dueDateFor("2028-02", 31)).toBe("2028-02-29");
  });
  it("virada de ano", () => expect(addMonths("2026-12", 1)).toBe("2027-01-01"));
});
