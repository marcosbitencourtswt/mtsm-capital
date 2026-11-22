/**
 * Foto do cupom → rascunho de despesa (OCR com o Claude, visão + saída estruturada).
 * - Só lê e devolve um RASCUNHO: quem grava é a pessoa, depois de conferir (nada entra sozinho).
 * - A foto não é guardada em lugar nenhum; vai direto para a API da Anthropic e é descartada.
 * - Desligado se ANTHROPIC_API_KEY não estiver configurada na Vercel (custo só quando alguém liga).
 * - Limite diário por pessoa para o custo não fugir do controle.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Db } from "./db.js";
import { AppError } from "./service.js";

export const OCR_CATEGORIES = ["ALIMENTACAO", "MORADIA", "AGUA", "LUZ", "INTERNET", "TRANSPORTE", "SAUDE", "EDUCACAO", "DELIVERY", "RESTAURANTE",
  "LAZER", "ROUPAS", "BELEZA", "PRESENTES", "ASSINATURAS", "OUTROS"] as const;
export const DAILY_LIMIT = Number(process.env.OCR_DAILY_LIMIT ?? 30);
/** Modelo padrão: o mais preciso. Para baratear, troque na Vercel por OCR_MODEL=claude-haiku-5-5 (decisão de custo é do dono). */
const MODEL = process.env.OCR_MODEL || "claude-opus-5-5";

const Receipt = z.object({
  is_receipt: z.boolean().describe("true se a imagem for cupom, nota fiscal, recibo ou comprovante de pagamento"),
  total_brl: z.number().nullable().describe("valor TOTAL pago em reais (ex.: 45.9). null se não der para ler"),
  date: z.string().nullable().describe("data da compra no formato AAAA-MM-DD. null se não aparecer"),
  merchant: z.string().nullable().describe("nome do estabelecimento, curto (ex.: 'Supermercado Big Box')"),
  category: z.enum(OCR_CATEGORIES).describe("categoria que melhor descreve a compra"),
  confidence: z.enum(["alta", "media", "baixa"]).describe("o quanto o valor total está legível"),
});
export type ReceiptDraft = { amountCents: number | null; date: string | null; description: string; category: string; confidence: string; model: string };

type Scanner = (imageBase64: string, mediaType: "image/jpeg" | "image/png" | "image/webp") => Promise<z.infer<typeof Receipt> & { model: string }>;

const PROMPT = `Leia a imagem de um comprovante de compra brasileiro e extraia os dados.
Regras: use o valor TOTAL efetivamente pago (depois de descontos), não subtotais nem troco; datas no Brasil vêm como DD/MM/AAAA — converta para AAAA-MM-DD;
se algo não estiver legível, devolva null em vez de adivinhar. Se a imagem não for um comprovante, is_receipt = false.`;

/** Chamada real à API. Em teste, é trocada por um simulador (setScanner). */
const realScanner: Scanner = async (imageBase64, mediaType) => {
  const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente da Vercel
  const ask = (model: string) => client.messages.parse({
    model, max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Receipt) },
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: PROMPT },
    ] }],
  });
  let r = await ask(MODEL);
  // Recusa por política é rara num cupom; se acontecer, tenta uma vez num modelo alternativo.
  if (r.stop_reason === "refusal") r = await ask("claude-opus-4-8");
  if (r.stop_reason === "refusal" || !r.parsed_output) throw new AppError(422, "OCR_UNREADABLE", "Não consegui ler esta foto. Tente outra, mais perto e com luz.");
  return { ...r.parsed_output, model: r.model };
};
let scanner: Scanner = realScanner;
export function setScanner(s: Scanner | null) { scanner = s ?? realScanner; }
export const ocrEnabled = () => !!process.env.ANTHROPIC_API_KEY || scanner !== realScanner;

export async function scanReceipt(db: Db, userId: string, imageBase64: string, mediaType: "image/jpeg" | "image/png" | "image/webp"): Promise<ReceiptDraft> {
  if (!ocrEnabled()) throw new AppError(503, "OCR_DISABLED", "Leitura de foto desligada: falta a chave ANTHROPIC_API_KEY nas configurações da Vercel.");
  const used = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ocr_usage WHERE user_id = $1 AND at > now() - interval '1 day'", [userId])).rows[0]!.n;
  if (used >= DAILY_LIMIT) throw new AppError(429, "OCR_LIMIT", `Limite de ${DAILY_LIMIT} fotos por dia atingido. Lance à mão ou tente amanhã.`);
  await db.query("INSERT INTO ocr_usage (user_id) VALUES ($1)", [userId]); // conta a tentativa (a API cobra mesmo se a foto for ruim)
  let r: Awaited<ReturnType<Scanner>>;
  try { r = await scanner(imageBase64, mediaType); }
  catch (e) {
    if (e instanceof AppError) throw e;
    console.error(JSON.stringify({ level: "warn", msg: "ocr falhou", err: (e as Error).message?.slice(0, 200) }));
    throw new AppError(503, "OCR_FAILED", "O serviço de leitura não respondeu agora. Tente de novo em instantes ou lance à mão.");
  }
  if (!r.is_receipt) throw new AppError(422, "NOT_A_RECEIPT", "Isso não parece um cupom ou comprovante. Tire a foto do comprovante inteiro.");
  const cents = r.total_brl != null && r.total_brl > 0 && r.total_brl < 1_000_000 ? Math.round(r.total_brl * 100) : null;
  const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !Number.isNaN(Date.parse(r.date)) ? r.date : null;
  return { amountCents: cents, date, description: (r.merchant ?? "Compra").slice(0, 120), category: r.category, confidence: r.confidence, model: r.model };
}
