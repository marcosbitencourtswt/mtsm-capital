/**
 * Criptografia da cópia de segurança, feita no próprio aparelho (navegador) e também usada pelo
 * script de restauração (Node 22 tem a mesma Web Crypto). PBKDF2-SHA256 (600 mil rodadas) + AES-256-GCM,
 * com compressão gzip antes. Sem a senha, o arquivo não abre; senha errada = erro (o GCM detecta).
 */
const ITER = 600_000;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
async function key(pass: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export interface Envelope { format: "mtsm-backup-enc"; v: 1; kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; gzip: boolean; data: string; createdAt: string; }
export async function encryptBackup(json: string, pass: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = new TextEncoder().encode(json);
  const gzip = typeof CompressionStream !== "undefined";
  const plain = gzip ? await pipe(raw, new CompressionStream("gzip")) : raw;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(pass, salt, ITER), plain as BufferSource));
  return { format: "mtsm-backup-enc", v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), gzip, data: b64(ct), createdAt: new Date().toISOString() };
}
export async function decryptBackup(env: Envelope, pass: string): Promise<string> {
  if (env.format !== "mtsm-backup-enc") throw new Error("Arquivo não é uma cópia de segurança do MTSM.");
  let plain: Uint8Array;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) as BufferSource }, await key(pass, unb64(env.salt), env.iter), unb64(env.data) as BufferSource)); }
  catch { throw new Error("Senha errada ou arquivo corrompido."); }
  return new TextDecoder().decode(env.gzip ? await pipe(plain, new DecompressionStream("gzip")) : plain);
}
