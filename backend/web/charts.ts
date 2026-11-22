/**
 * Gráficos em SVG puro (sem biblioteca): linha de 2 séries com cruz de leitura, barras horizontais e verticais.
 * Regras do design de dados: marcas finas, um eixo só, grade discreta, legenda + rótulo direto,
 * texto na cor do texto (nunca na cor da série) e dica (tooltip) em toda marca.
 * O texto vem escapado por quem chama; aqui só entram números e rótulos já tratados.
 */
import { money, monthLabel, esc } from "./fmt.js";

const short = (m: string) => monthLabel(m).replace(/ de /, "/").slice(0, 3) + "/" + m.slice(2, 4);
const compact = (c: number) => {
  const v = Math.abs(c) / 100, s = c < 0 ? "−" : "";
  return v >= 1000 ? `${s}${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : `${s}${Math.round(v)}`;
};
/** Marcas do eixo em números redondos (0, 1 mil, 2 mil... nunca 1,3 mil). */
function niceTicks(max: number) {
  const lead = max / 10 ** Math.floor(Math.log10(max));
  const n = lead === 2 || lead === 10 ? 4 : lead === 2.5 || lead === 5 || lead === 1 ? 5 : 4;
  return Array.from({ length: n + 1 }, (_, i) => (i * max) / n);
}
/** Escala "redonda" para o eixo (0, 2 mil, 4 mil...). */
function niceMax(v: number) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export interface Series { name: string; cls: "s1" | "s2"; values: number[]; }

/** Linhas ao longo dos meses (ex.: receitas × despesas). */
export function lineChart(months: string[], series: Series[], title: string, W = 640) {
  const H = Math.round(Math.min(260, Math.max(180, W * 0.42))), L = 44, R = 78, T = 16, B = 30, iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...series.flatMap(s => s.values), 0));
  const x = (i: number) => L + (months.length <= 1 ? iw / 2 : (i * iw) / (months.length - 1));
  const y = (v: number) => T + ih - (Math.max(0, v) / max) * ih;
  const ticks = niceTicks(max);
  const grid = ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join("");
  const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(iw / 56))));
  const xl = months.map((m, i) => ((months.length - 1 - i) % every ? "" : `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${short(m)}</text>`)).join("");
  // Rótulo direto no fim de cada linha: limita à área do gráfico e garante 16px entre eles (nunca sobrepõe).
  const last = months.length - 1;
  const ly = series.map(s => Math.min(T + ih + 4, y(s.values[last] ?? 0) + 4));
  const order = ly.map((v, k) => ({ v, k })).sort((a, b) => b.v - a.v); // de baixo para cima
  for (let n = 1; n < order.length; n++) if (order[n - 1]!.v - order[n]!.v < 16) order[n]!.v = order[n - 1]!.v - 16;
  for (const o of order) ly[o.k] = o.v;
  const lines = series.map((s, k) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return `<polyline class="line ${s.cls}" points="${pts}"/>
      <circle class="dot ${s.cls}" cx="${x(last)}" cy="${y(s.values[last] ?? 0)}" r="4"/>
      <text class="dlabel" x="${x(last) + 8}" y="${ly[k]!}">${esc(s.name)}</text>`;
  }).join("");
  // Colunas invisíveis por mês: alvo de toque grande e dica com os dois valores.
  const step = months.length > 1 ? iw / (months.length - 1) : iw;
  const hits = months.map((m, i) => `<rect class="hit" x="${x(i) - step / 2}" y="${T}" width="${step}" height="${ih}" tabindex="0"
    data-x="${x(i)}" data-tip="${esc(`${monthLabel(m)}\n${series.map(s => `${s.name}: ${money(s.values[i] ?? 0)}`).join("\n")}`)}"/>`).join("");
  return `<figure class="viz"><figcaption>${esc(title)}</figcaption>
    <div class="legend">${series.map(s => `<span><i class="sw ${s.cls}"></i>${esc(s.name)}</span>`).join("")}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${xl}<line class="cross" y1="${T}" y2="${T + ih}" x1="0" x2="0" visibility="hidden"/>${lines}${hits}</svg></figure>`;
}

/** Barras horizontais (ranking: gasto por categoria). Uma série só = uma cor. */
export function hBars(items: { label: string; cents: number; tip?: string }[], title: string, max = 8, W = 640) {
  const rows = items.slice(0, max), top = Math.max(...rows.map(r => r.cents), 1);
  const H = rows.length * 34 + 8, L = Math.min(120, W * 0.3), R = 92, iw = W - L - R;
  const bars = rows.map((r, i) => {
    const w = Math.max(3, (r.cents / top) * iw), yy = 6 + i * 34;
    return `<text class="axis" x="${L - 8}" y="${yy + 16}" text-anchor="end">${esc(r.label)}</text>
      <path class="bar" d="M${L},${yy + 4} h${w - 4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h${-(w - 4)} z"/>
      <text class="vlabel" x="${L + w + 6}" y="${yy + 16}">${money(r.cents)}</text>
      <rect class="hit" x="0" y="${yy}" width="${W}" height="30" tabindex="0" data-tip="${esc(r.tip ?? `${r.label}: ${money(r.cents)}`)}"/>`;
  }).join("");
  return `<figure class="viz"><figcaption>${esc(title)}</figcaption>${rows.length ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${bars}</svg>`
    : `<p class="muted">Sem gastos no período.</p>`}${items.length > max ? `<p class="muted">+ ${items.length - max} categorias menores</p>` : ""}</figure>`;
}

/** Barras verticais por mês (ex.: quanto de dívida foi quitado). */
export function vBars(months: string[], values: number[], title: string, W = 640) {
  const H = 200, L = 48, R = 12, T = 12, B = 30, iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...values, 0)), slot = iw / Math.max(1, months.length), bw = Math.min(28, slot - 6);
  const y = (v: number) => T + ih - (Math.max(0, v) / max) * ih;
  const grid = [0, 0.5, 1].map(f => f * max).map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`).join("");
  const bars = months.map((m, i) => {
    const v = values[i] ?? 0, cx = L + slot * i + slot / 2, h = T + ih - y(v);
    const mark = v > 0 ? `<path class="bar" d="M${cx - bw / 2},${T + ih} v${-(Math.max(h, 4) - 4)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${Math.max(h, 4) - 4} z"/>` : "";
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(iw / 56))));
    return `${mark}${(months.length - 1 - i) % every ? "" : `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${short(m)}</text>`}
      <rect class="hit" x="${cx - slot / 2}" y="${T}" width="${slot}" height="${ih}" tabindex="0" data-tip="${esc(`${monthLabel(m)}: ${money(v)}`)}"/>`;
  }).join("");
  return `<figure class="viz"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${bars}</svg></figure>`;
}

/** Dica flutuante única + cruz de leitura nos gráficos de linha. Liga uma vez. */
export function wireTooltips(root: HTMLElement) {
  let tip = document.getElementById("viz-tip");
  if (!tip) { tip = document.createElement("div"); tip.id = "viz-tip"; tip.setAttribute("role", "tooltip"); document.body.appendChild(tip); }
  const show = (el: Element, cx: number, cy: number) => {
    const text = el.getAttribute("data-tip"); if (!text) return;
    tip!.textContent = text; tip!.style.display = "block";
    const r = tip!.getBoundingClientRect();
    tip!.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, cx + 12))}px`;
    tip!.style.top = `${Math.max(8, cy - r.height - 12)}px`;
    const svg = el.closest("svg"), cross = svg?.querySelector<SVGLineElement>(".cross"), dx = el.getAttribute("data-x");
    if (cross && dx) { cross.setAttribute("x1", dx); cross.setAttribute("x2", dx); cross.setAttribute("visibility", "visible"); }
  };
  const hide = () => { tip!.style.display = "none"; root.querySelectorAll<SVGLineElement>(".cross").forEach(c => c.setAttribute("visibility", "hidden")); };
  root.addEventListener("pointermove", e => { const el = (e.target as Element).closest?.("[data-tip]"); if (el && root.contains(el)) show(el, e.clientX, e.clientY); else hide(); });
  root.addEventListener("pointerleave", hide);
  root.addEventListener("focusin", e => { const el = (e.target as Element).closest?.("[data-tip]"); if (el) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); } });
  root.addEventListener("focusout", hide);
}

/** Gráficos desenhados na largura REAL do espaço (texto sempre em tamanho legível). */
const slots = new Map<string, (w: number) => string>();
let seq = 0;
export function chartSlot(draw: (w: number) => string) {
  const id = `c${++seq}`; slots.set(id, draw);
  return `<div class="viz-slot" data-chart="${id}"></div>`;
}
/** Chamado antes de montar uma tela nova: esquece os gráficos da tela anterior. */
export function resetCharts() { slots.clear(); }
export function paintCharts(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(".viz-slot[data-chart]").forEach(el => {
    const draw = slots.get(el.dataset.chart!); if (!draw) return;
    const w = Math.max(280, Math.round(el.clientWidth));
    if (el.dataset.w !== String(w)) { el.innerHTML = draw(w); el.dataset.w = String(w); }
  });
}
let resizeT = 0;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = window.setTimeout(() => paintCharts(), 150); });
