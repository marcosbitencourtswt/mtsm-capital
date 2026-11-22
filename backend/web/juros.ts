/** Conta de juros (tabela Price), pura: sem tela nem servidor. Usada pela calculadora. */
/** Valor presente de k parcelas iguais à taxa i (Price). */
export const pvOf = (pmt: number, i: number, k: number) => (i === 0 ? pmt * k : pmt * (1 - (1 + i) ** -k) / i);
/** Taxa mensal que faz as parcelas valerem o que foi recebido (busca binária; 0 se não há juros). */
export function rateOf(pv: number, pmt: number, n: number) {
  if (pmt * n <= pv) return 0;
  let lo = 0, hi = 1;
  while (pvOf(pmt, hi, n) > pv && hi < 100) hi *= 2;
  for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (pvOf(pmt, mid, n) > pv) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function calcJuros(pvCents: number, n: number, pmtCents: number | null, rateMonth: number | null, left: number | null) {
  const i = pmtCents != null ? rateOf(pvCents, pmtCents, n) : (rateMonth ?? 0);
  const pmt = pmtCents ?? (i === 0 ? pvCents / n : pvCents * i / (1 - (1 + i) ** -n));
  const total = pmt * n;
  const out = { rateMonth: i, rateYear: (1 + i) ** 12 - 1, pmtCents: Math.round(pmt), totalCents: Math.round(total), interestCents: Math.round(total - pvCents),
    payoff: null as null | { left: number; nominalCents: number; todayCents: number; savedCents: number } };
  if (left && left > 0 && left <= n) {
    const nominal = pmt * left, now = pvOf(pmt, i, left);
    out.payoff = { left, nominalCents: Math.round(nominal), todayCents: Math.round(now), savedCents: Math.round(nominal - now) };
  }
  return out;
}
