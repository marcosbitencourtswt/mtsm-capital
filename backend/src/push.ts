/**
 * Avisos no celular (Web Push). Padrão aberto dos navegadores: o servidor assina com chaves VAPID e o
 * serviço de push do próprio celular (Google/Apple/Mozilla) entrega. Sem custo, sem conta em terceiros.
 * Envio nunca derruba a operação principal: falha de aviso é registrada e ignorada.
 */
import webpush from "web-push";
import type { Db } from "./db.js";
import { AppError } from "./service.js";

export interface PushPayload { title: string; body: string; url?: string; tag?: string; }
type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
type Sender = (sub: Sub, payload: string, opts: webpush.RequestOptions) => Promise<unknown>;

let sender: Sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
/** Testes trocam o envio real por um coletor. */
export function setSender(s: Sender) { sender = s; }

let cached: { publicKey: string; privateKey: string } | null = null;
export async function keys(db: Db) {
  if (cached) return cached;
  let r = (await db.query("SELECT public_key, private_key FROM push_key WHERE id = 1")).rows[0];
  if (!r) {
    const k = webpush.generateVAPIDKeys();
    await db.query("INSERT INTO push_key (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING", [k.publicKey, k.privateKey]);
    r = (await db.query("SELECT public_key, private_key FROM push_key WHERE id = 1")).rows[0];
  }
  cached = { publicKey: r.public_key, privateKey: r.private_key };
  return cached;
}

export async function subscribe(db: Db, userId: string, s: Sub, userAgent?: string) {
  if (!/^https:\/\//.test(s.endpoint)) throw new AppError(422, "INVALID_SUBSCRIPTION", "Inscrição de aviso inválida.");
  await db.query(`INSERT INTO push_subscription (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, fail_count = 0`,
    [userId, s.endpoint, s.keys.p256dh, s.keys.auth, (userAgent ?? "").slice(0, 200)]);
}
export async function unsubscribe(db: Db, userId: string, endpoint: string) {
  await db.query("DELETE FROM push_subscription WHERE user_id = $1 AND endpoint = $2", [userId, endpoint]);
}
export async function devices(db: Db, userId: string) {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM push_subscription WHERE user_id = $1", [userId])).rows[0]!.n;
}

/** Envia para todos os aparelhos dessas pessoas. Devolve quantos receberam. */
export async function notify(db: Db, userIds: string[], p: PushPayload): Promise<number> {
  if (!userIds.length) return 0;
  const subs = (await db.query(`SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscription s JOIN app_user u ON u.id = s.user_id
    WHERE s.user_id = ANY($1) AND u.active`, [userIds])).rows;
  if (!subs.length) return 0;
  const k = await keys(db);
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const opts: webpush.RequestOptions = {
    TTL: 12 * 3600, urgency: "normal", timeout: 5000,
    vapidDetails: { subject: host ? `https://${host}` : "https://mtsm-capital.invalid", publicKey: k.publicKey, privateKey: k.privateKey },
  };
  const body = JSON.stringify({ title: p.title, body: p.body, url: p.url ?? "/", tag: p.tag });
  let ok = 0;
  await Promise.all(subs.map(async s => {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts);
      ok++;
      await db.query("UPDATE push_subscription SET last_ok_at = now(), fail_count = 0 WHERE id = $1", [s.id]);
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // 404/410: o aparelho cancelou ou trocou a inscrição — remove. Outras falhas: conta e desiste após 5.
      if (status === 404 || status === 410) await db.query("DELETE FROM push_subscription WHERE id = $1", [s.id]);
      else {
        const f = await db.query("UPDATE push_subscription SET fail_count = fail_count + 1 WHERE id = $1 RETURNING fail_count", [s.id]);
        if ((f.rows[0]?.fail_count ?? 0) >= 5) await db.query("DELETE FROM push_subscription WHERE id = $1", [s.id]);
      }
      console.error(JSON.stringify({ level: "warn", msg: "push falhou", status: status ?? null }));
    }
  }));
  return ok;
}

/** Quem cuida da casa (Marcos e Thaís): administradores e responsáveis ativos. */
export async function guardians(db: Db): Promise<string[]> {
  return (await db.query("SELECT id FROM app_user WHERE active AND NOT conduct_only AND (role = 'ADMIN' OR is_guardian)")).rows.map(r => r.id);
}
export async function userOfPerson(db: Db, personId: string): Promise<string[]> {
  return (await db.query("SELECT id FROM app_user WHERE active AND person_id = $1", [personId])).rows.map(r => r.id);
}
