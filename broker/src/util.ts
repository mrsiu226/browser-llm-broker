import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const SECRET = process.env.SECRET_KEY ?? "";
if (SECRET.length < 16 || /^change[-_ ]?me/i.test(SECRET)) {
  console.error("SECRET_KEY is missing, too short (< 16 chars) or still the placeholder from .env.example.");
  console.error("Generate one with:  openssl rand -hex 32");
  process.exit(1);
}
const KEY = createHash("sha256").update(SECRET).digest();

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (prefix: string, bytes = 32) => prefix + randomBytes(bytes).toString("base64url");

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `s1$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [v, salt, hash] = stored.split("$");
  if (v !== "s1") return false;
  const a = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const sign = (data: string) => createHmac("sha256", KEY).update(data).digest("base64url");
export function signedQuery(path: string, ttlMs = 3600_000): string {
  const exp = Date.now() + ttlMs;
  return `exp=${exp}&sig=${sign(`${path}|${exp}`)}`;
}
export function checkSigned(path: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(`${path}|${exp}`);
  return good.length === sig.length && timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

// ---------------------------------------------------------------- tiny http helpers
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, "invalid JSON"); }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const clientIp = (req: IncomingMessage) =>
  (process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") ||
  req.socket.remoteAddress || "?";

// Simple fixed-window rate limiter (in memory is fine for one node).
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) { hits.set(key, { n: 1, reset: t + windowMs }); return true; }
  return ++h.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, 60_000).unref();
