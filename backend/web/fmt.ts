/** Formatação pt-BR e conversão segura de dinheiro (sem float acumulado). */

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (cents: number) => BRL.format(cents / 100);

/** "1.234,56" | "1234.56" | "R$ 50" -> centavos. NaN se inválido. */
export function parseMoney(input: string): number {
  let s = input.trim().replace(/\s|R\$/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [int = "0", dec = ""] = s.split(".");
  return Number(int) * 100 + Number(dec.padEnd(2, "0"));
}
/** centavos -> "1234,56" para preencher inputs. */
export const moneyInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

export const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
export const br = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "sem data");
export const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
};
export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export const pct = (bp: number) => `${(bp / 100).toLocaleString("pt-BR")}%`;

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
