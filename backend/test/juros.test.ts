import { describe, it, expect } from "vitest";
import { calcJuros, rateOf } from "../web/juros.js";

describe("Calculadora de juros", () => {
  it("acha a taxa a partir da parcela (Price)", () => {
    // 1.000 em 12x de 100 → ~2,92% a.m.
    expect(rateOf(100000, 10000, 12)).toBeCloseTo(0.029229, 5);
    expect(rateOf(100000, 8000, 12)).toBe(0); // paga menos que recebeu: sem juros
  });
  it("calcula parcela a partir da taxa e a economia ao quitar antes", () => {
    const r = calcJuros(100000, 12, null, 0.03, 6);
    expect(r.pmtCents).toBe(10046); // 1.000 a 3% em 12x ≈ 100,46
    expect(r.interestCents).toBe(r.totalCents - 100000);
    expect(r.payoff!.nominalCents).toBe(Math.round(10046.2 * 6));
    expect(r.payoff!.todayCents).toBeLessThan(r.payoff!.nominalCents);
    expect(r.rateYear).toBeCloseTo(1.03 ** 12 - 1, 10);
  });
});
